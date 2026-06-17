import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job } from 'bullmq';
import { normalizeResponse } from 'src/utils/normalizeResponse';

import { ProcessosResponse } from 'src/interfaces';
import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';
import { deleteByPattern } from 'src/utils/redis-delete-keys';
import Redis from 'ioredis';
import { AwsS3Service } from 'src/services/aws-s3.service';

export class GenericDocumentosWorker extends WorkerHost {
  protected readonly logger = new Logger(GenericDocumentosWorker.name);

  @Inject(ProcessDocumentsFindService)
  protected readonly processDocsService!: ProcessDocumentsFindService;
  @Inject(LoginPoolService)
  protected readonly loginPoolService!: LoginPoolService;
  @Inject('REDIS_CLIENT') private readonly redis: Redis;
  @Inject(AwsS3Service)
  protected readonly awsS3Service!: AwsS3Service;

  async process(
    job: Job<{
      numero: string;
      instances: ProcessosResponse[];
      pdfS3Key?: string;
      pdfBase64?: string;
      correlationId?: string;
    }>,
  ) {
    const {
      numero,
      instances,
      pdfS3Key,
      pdfBase64,
      correlationId: parentCorrelationId,
    } = job.data;
    const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;
    // Usa numero como fallback determinístico para manter idempotência entre retries
    const correlationId =
      parentCorrelationId ?? String(job.id ?? `doc-${numero}`);
    const webhookHeaders = {
      'x-correlation-id': correlationId,
      ...(process.env.WEBHOOK_SERVICE_KEY
        ? { 'x-service-key': process.env.WEBHOOK_SERVICE_KEY }
        : {}),
    };
    let completed = false;
    // Impede que o catch externo envie um segundo webhook quando um path de erro
    // específico já enviou o seu próprio (double-webhook bug).
    let webhookAlreadySent = false;

    this.logger.log(`📄 [${job.queueName}] Documentos → ${numero}`);

    try {
      // Extrai TRT do número do processo
      const match = numero.match(/\.(\d{2})\./);
      const regionTRT = match ? Number(match[1]) : null;

      if (!regionTRT) {
        const resp = normalizeResponse(
          numero,
          [],
          `Número inválido para consulta de documentos`,
          {
            autos: true,
            webhookId: `${correlationId}:invalid-number`,
            status: 'ERRO',
            motivoErro: 'NUMERO_INVALIDO',
          },
        );
        await axios.post(webhookUrl, resp, { headers: webhookHeaders });
        webhookAlreadySent = true;
        throw new Error(
          `Número inválido para consulta de documentos: ${numero}`,
        );
      }

      if (!pdfS3Key && !pdfBase64) {
        this.logger.error(`❌ pdfS3Key ausente para ${numero}`);
        const resp = normalizeResponse(
          numero,
          [],
          `Erro ao gerar arquivo para consulta de documentos, tente novamente mais tarde.`,
          {
            autos: true,
            webhookId: `${correlationId}:pdf-missing`,
            status: 'ERRO',
            motivoErro: 'PDF_NAO_GERADO',
          },
        );
        await axios.post(webhookUrl, resp, { headers: webhookHeaders });
        webhookAlreadySent = true;
        throw new Error(`pdfS3Key ausente para ${numero}`);
      }

      // Baixa o PDF do S3 — o payload do job contém apenas a chave, não o binário,
      // para não estourar a memória do Redis com PDFs de dezenas de MB.
      // Aceita pdfBase64 como fallback para jobs enfileirados antes do deploy.
      let pdfBuffer: Buffer;
      if (pdfS3Key) {
        pdfBuffer = await this.awsS3Service.getS3Object(
          process.env.AWS_S3_BUCKET_NAME as string,
          pdfS3Key,
        );
      } else {
        this.logger.warn(
          `⚠️ Usando fallback pdfBase64 para ${numero} (job legado)`,
        );
        pdfBuffer = Buffer.from(pdfBase64 as string, 'base64');
      }

      // Executa consulta de documentos
      const documentos = await this.processDocsService.execute(
        numero,
        instances,
        pdfBuffer,
      );
      if (documentos.length === 0 || documentos[0].documentos.length === 0) {
        this.logger.warn(`⚠️ Nenhum documento encontrado para ${numero}`);
        const resp = normalizeResponse(
          numero,
          [],
          `Nenhum documento encontrado, tente novamente mais tarde.`,
          {
            autos: true,
            webhookId: `${correlationId}:docs-empty`,
            status: 'ERRO',
            motivoErro: 'DOCUMENTOS_NAO_ENCONTRADOS',
          },
        );
        await axios.post(webhookUrl, resp, { headers: webhookHeaders });
        webhookAlreadySent = true;
        throw new Error(`Nenhum documento encontrado para ${numero}`);
      }
      const result = documentos.slice(0, 2);
      const response = normalizeResponse(numero, result, '', {
        autos: true,
        webhookId: `${correlationId}:autos-success`,
      });
      await axios.post(webhookUrl, response, { headers: webhookHeaders });
      webhookAlreadySent = true;
      completed = true;
    } catch (error: unknown) {
      this.logger.error(error);

      if (!webhookAlreadySent) {
        const resp = normalizeResponse(
          numero,
          [],
          'Erro ao consultar documentos, tente novamente mais tarde.',
          {
            autos: true,
            webhookId: `${correlationId}:autos-error`,
            status: 'ERRO',
            motivoErro: 'DOCUMENTOS_ERRO',
          },
        );
        try {
          await axios.post(webhookUrl, resp, { headers: webhookHeaders });
        } catch (webhookError) {
          this.logger.error(
            `Falha crítica: erro no processamento E no envio do webhook para ${numero}:`,
            webhookError,
          );
          throw webhookError; // deixa BullMQ marcar como falha para retry
        }
      }

      throw error instanceof Error ? error : new Error(String(error));
    } finally {
      this.logger.log(`✅ Documentos finalizados → ${numero}`);
      const maxAttempts = job.opts.attempts ?? 1;
      const isLastAttempt = job.attemptsMade + 1 >= maxAttempts;

      if (completed || isLastAttempt) {
        // Remove o arquivo temporário do S3 ao finalizar (sucesso ou última tentativa).
        // O arquivo só é deletado na última tentativa para permitir retries.
        if (pdfS3Key) {
          this.awsS3Service
            .deleteS3Object(process.env.AWS_S3_BUCKET_NAME as string, pdfS3Key)
            .catch((err) =>
              this.logger.error(
                `Falha ao deletar PDF temporário ${pdfS3Key}: ${err instanceof Error ? err.message : String(err)}`,
              ),
            );
        }

        try {
          await deleteByPattern(this.redis, `pje:token:captcha:${numero}*`, {
            log: (msg) => this.logger.debug(msg),
          });
          await deleteByPattern(this.redis, `tokencaptcha:${numero}*`, {
            log: (msg) => this.logger.debug(msg),
          });
        } catch (cleanupError) {
          this.logger.error(
            `Falha na limpeza de tokens para ${numero}: ${cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)}`,
          );
        }
      }
    }
  }
}
