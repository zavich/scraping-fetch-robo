import { getQueueToken, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { normalizeResponse } from 'src/utils/normalizeResponse';
import { LoginErrorTrt } from 'src/utils/trt-validate';
import { FetchUrlMovimentService } from '../../services/fetch-url.service';
import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessosResponse } from 'src/interfaces';
import { DocumentoExtraido } from '../../services/fetch-public-documents.service';
import { ScrapingService } from 'src/helpers/scraping.service';
import { Root } from 'src/interfaces/normalize';
import { AwsS3Service } from 'src/services/aws-s3.service';

export class GenericProcessoWorker extends WorkerHost {
  private readonly logger = new Logger(GenericProcessoWorker.name);
  private readonly documentosQueues: Record<string, Queue> = {};
  constructor(
    @Inject(LoginPoolService)
    private readonly loginPool: LoginPoolService,
    @Inject(FetchUrlMovimentService)
    private readonly fetchUrlMovimentService: FetchUrlMovimentService,
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    @Inject(AwsS3Service)
    private readonly awsS3Service: AwsS3Service,

    // ✅ injeta todas as filas TRT
    @Inject(getQueueToken('pje-documentos-trt1')) trt1: Queue,
    @Inject(getQueueToken('pje-documentos-trt2')) trt2: Queue,
    @Inject(getQueueToken('pje-documentos-trt3')) trt3: Queue,
    @Inject(getQueueToken('pje-documentos-trt4')) trt4: Queue,
    @Inject(getQueueToken('pje-documentos-trt5')) trt5: Queue,
    @Inject(getQueueToken('pje-documentos-trt6')) trt6: Queue,
    @Inject(getQueueToken('pje-documentos-trt7')) trt7: Queue,
    @Inject(getQueueToken('pje-documentos-trt8')) trt8: Queue,
    @Inject(getQueueToken('pje-documentos-trt9')) trt9: Queue,
    @Inject(getQueueToken('pje-documentos-trt10')) trt10: Queue,
    @Inject(getQueueToken('pje-documentos-trt11')) trt11: Queue,
    @Inject(getQueueToken('pje-documentos-trt12')) trt12: Queue,
    @Inject(getQueueToken('pje-documentos-trt13')) trt13: Queue,
    @Inject(getQueueToken('pje-documentos-trt14')) trt14: Queue,
    @Inject(getQueueToken('pje-documentos-trt15')) trt15: Queue,
    @Inject(getQueueToken('pje-documentos-trt16')) trt16: Queue,
    @Inject(getQueueToken('pje-documentos-trt17')) trt17: Queue,
    @Inject(getQueueToken('pje-documentos-trt18')) trt18: Queue,
    @Inject(getQueueToken('pje-documentos-trt19')) trt19: Queue,
    @Inject(getQueueToken('pje-documentos-trt20')) trt20: Queue,
    @Inject(getQueueToken('pje-documentos-trt21')) trt21: Queue,
    @Inject(getQueueToken('pje-documentos-trt22')) trt22: Queue,
    @Inject(getQueueToken('pje-documentos-trt23')) trt23: Queue,
    @Inject(getQueueToken('pje-documentos-trt24')) trt24: Queue,
  ) {
    super();

    this.documentosQueues = {
      trt1: trt1,
      trt2: trt2,
      trt3: trt3,
      trt4: trt4,
      trt5: trt5,
      trt6: trt6,
      trt7: trt7,
      trt8: trt8,
      trt9: trt9,
      trt10: trt10,
      trt11: trt11,
      trt12: trt12,
      trt13: trt13,
      trt14: trt14,
      trt15: trt15,
      trt16: trt16,
      trt17: trt17,
      trt18: trt18,
      trt19: trt19,
      trt20: trt20,
      trt21: trt21,
      trt22: trt22,
      trt23: trt23,
      trt24: trt24,
    };
  }

  async process(
    job: Job<{
      numero: string;
      origem?: string;
      documents?: boolean;
      webhook?: string;
      correlationId?: string;
    }>,
  ) {
    const { numero, origem, documents = false, webhook } = job.data;

    this.logger.log(`📄 [${job.queueName}] Consultando processo ${numero}`);

    const webhookUrl = webhook ?? `${process.env.WEBHOOK_URL}/process/webhook`;
    // ARQ-005: propagate correlation ID across services
    // Usa numero como fallback determinístico para manter idempotência entre retries
    const correlationId = job.data.correlationId ?? String(job.id ?? numero);
    const webhookHeaders = {
      'x-correlation-id': correlationId,
      ...(process.env.WEBHOOK_SERVICE_KEY
        ? { 'x-service-key': process.env.WEBHOOK_SERVICE_KEY }
        : {}),
    };
    let successWebhookSent = false;

    // Extrai TRT do CNJ
    const match = numero.match(/^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/);
    const regionTRT = match ? Number(match[1]) : null;

    try {
      // --------------------------
      // 🔍 Validação TRT
      // --------------------------
      if (regionTRT === null) {
        this.logger.warn(`⚠️ Número inválido ${numero}`);

        const response = normalizeResponse(
          numero,
          [],
          'Número do processo inválido',
          {
            status: 'ERRO',
            motivoErro: 'NUMERO_INVALIDO',
            webhookId: `${correlationId}:invalid-number`,
          },
        );

        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }
      if (regionTRT === 3 || regionTRT === 9) {
        await this.scrapingService.execute(numero, regionTRT, 1);
      }
      const instances = await this.fetchUrlMovimentService.execute(
        numero,
        origem,
      );

      const result = instances.slice(0, 2);

      if (!instances || instances.length === 0) {
        this.logger.warn(
          `⚠️ Nenhum resultado encontrado para o processo ${numero}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Nenhum resultado encontrado',
          {
            origem,
            webhookId: `${correlationId}:not-found`,
          },
        );

        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      // --------------------------
      // 🔐 Segredo de Justiça
      // --------------------------
      const segredo = result.some((i) => {
        if (!i) return false; // protege contra null/undefined
        const maybeMsg: unknown = i.mensagemErro;
        if (typeof maybeMsg !== 'string') return false;
        const msg = maybeMsg;
        if (!msg) return false;
        const normalized = msg
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        return /segredo(?:.*justica)?/.test(normalized);
      });

      if (segredo) {
        this.logger.warn(`⚠️ Segredo de justiça ${numero}`);
        const response = normalizeResponse(
          numero,
          [],
          `O processo ${numero} está em segredo de justiça`,
          {
            origem,
            webhookId: `${correlationId}:secrecy`,
            status: 'ERRO',
            motivoErro: 'SEGREDO_JUSTICA',
          },
        );
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      const erroMensagem = result.find(
        (i) =>
          i && typeof i.mensagemErro === 'string' && i.mensagemErro.length > 0,
      );

      if (erroMensagem) {
        this.logger.warn(
          `⚠️ Mensagem de erro para o processo ${numero}: ${erroMensagem.mensagemErro}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          erroMensagem.mensagemErro,
          {
            origem,
            webhookId: `${correlationId}:message-error`,
            status: 'ERRO',
            motivoErro: 'PJE_ERRO',
          },
        );
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      // --------------------------
      // 📄 Documentos públicos (best-effort — enriquece as movimentações antes do webhook)
      // --------------------------
      try {
        this.logger.log(
          `📄 [${job.queueName}] Extraindo documentos públicos para ${numero} (TRT-${regionTRT})`,
        );
        const publicDocs: DocumentoExtraido[] =
          await this.fetchUrlMovimentService.fetchPublicDocuments(
            numero,
            instances as ProcessosResponse[],
            regionTRT,
          );

        for (const instance of instances as ProcessosResponse[]) {
          if (!instance.itensProcesso?.length) continue;
          for (const item of instance.itensProcesso) {
            const found = publicDocs.find(
              (d) => d.idUnicoDocumento === item.idUnicoDocumento,
            );
            if (found) item.texto = found.texto;
          }
        }

        this.logger.log(
          `✅ [${job.queueName}] ${publicDocs.length} documento(s) público(s) extraído(s) para ${numero}`,
        );
      } catch (publicDocError) {
        this.logger.warn(
          `⚠️ Falha ao extrair documentos públicos para ${numero}: ${publicDocError instanceof Error ? publicDocError.message : String(publicDocError)}`,
        );
      }

      // --------------------------
      // ✅ Resposta final (inclui texto dos docs públicos se extraídos)
      // --------------------------
      const response = normalizeResponse(
        numero,
        result as ProcessosResponse[],
        '',
        {
          origem,
          webhookId: `${correlationId}:movements-success`,
        },
      );

      this.logger.debug(
        `RESPONSE: numero=${numero} status=${response?.resposta ?? 'n/a'}`,
      );
      this.logger.log(`✅ [${job.queueName}] Finalizado ${numero}`);

      // Evita re-envio em retries do BullMQ: checa se o webhook de sucesso já foi
      // enviado numa tentativa anterior (correlationId é estável por estar no job data).
      const movementsOkKey = `scraper:movements-ok:${correlationId}`;
      const alreadySentMovements = await this.redis.get(movementsOkKey);
      if (!alreadySentMovements) {
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        successWebhookSent = true;
        await this.redis.set(movementsOkKey, '1', 'EX', 86400);
      }
      successWebhookSent = true;

      if (documents) {
        await new Promise((resolve) => setTimeout(resolve, 2000));
        this.logger.log(
          `🔐 [${job.queueName}] Consulta de documentos para ${numero} (TRT-${regionTRT})`,
        );
        let docsWebhookSent = false;
        try {
          const regionTRTValidate = LoginErrorTrt.includes(regionTRT)
            ? 2
            : regionTRT;

          const { cookies, account } = await this.loginPool.getCookies(
            regionTRTValidate,
            numero,
          );

          // Se não tiver cookies, significa que nenhuma conta está disponível
          if (!cookies || !account) {
            const resp = normalizeResponse(
              numero,
              [],
              `TRT-${regionTRT} indisponível ou todas as contas bloqueadas`,
              {
                status: 'ERRO',
                motivoErro: 'LOGIN_UNAVAILABLE',
                webhookId: `${correlationId}:docs-login-unavailable`,
                origem,
              },
            );
            docsWebhookSent = true;
            await axios.post(webhookUrl, resp, { headers: webhookHeaders });
            throw new Error(
              `TRT-${regionTRT} indisponível ou todas as contas bloqueadas`,
            );
          }
          const pdfBuffer = await this.fetchUrlMovimentService.fetchDocuments(
            numero,
            instances as ProcessosResponse[],
            regionTRT,
          );
          if (!pdfBuffer) {
            throw new Error(
              `fetchDocuments retornou undefined para ${numero} (TRT-${regionTRT})`,
            );
          }

          // Valida que a fila existe antes de fazer o upload para evitar
          // objetos órfãos no S3 caso a fila não seja encontrada.
          const queueName = `trt${regionTRT}`;
          const documentosQueue = this.documentosQueues[queueName];
          if (!documentosQueue) {
            throw new Error(
              `Fila de documentos nao encontrada para trt${regionTRT} (${numero})`,
            );
          }

          // Salva o PDF no S3 como arquivo temporário para não trafegar o
          // buffer pelo Redis (cada PDF pode ter dezenas de MB no payload do job).
          const pdfS3Key = `temp-pdf/${numero}/${correlationId}.pdf`;
          await this.awsS3Service.uploadS3Object(
            process.env.AWS_S3_BUCKET_NAME as string,
            pdfS3Key,
            pdfBuffer,
            'application/pdf',
          );

          try {
            await documentosQueue.add(
              'consulta-processo-documento',
              { numero, instances, pdfS3Key, correlationId },
              {
                jobId: `${numero}:${correlationId}`,
                attempts: 3,
                backoff: { type: 'exponential', delay: 5000 },
              },
            );
          } catch (enqueueError) {
            // Remove o arquivo temporário do S3 para evitar objetos órfãos
            // quando o enqueue falha após o upload já ter sido feito.
            try {
              await this.awsS3Service.deleteS3Object(
                process.env.AWS_S3_BUCKET_NAME as string,
                pdfS3Key,
              );
            } catch (deleteErr) {
              this.logger.error(
                `Falha ao limpar PDF temporário ${pdfS3Key} após erro de enqueue: ${deleteErr instanceof Error ? deleteErr.message : String(deleteErr)}`,
              );
            }
            throw enqueueError;
          }
        } catch (docError) {
          if (!docsWebhookSent) {
            const mensagem = axios.isAxiosError(docError)
              ? `Erro ao buscar documentos (HTTP ${docError.response?.status ?? 'sem status'}): ${docError.message}`
              : `Erro ao processar documentos: ${docError instanceof Error ? docError.message : String(docError)}`;
            const resp: Root = normalizeResponse(numero, [], mensagem, {
              status: 'ERRO',
              motivoErro: 'PJE_ERRO',
              webhookId: `${correlationId}:docs-error`,
              origem,
            });
            await axios
              .post(webhookUrl, resp, { headers: webhookHeaders })
              .catch((webhookErr) => {
                this.logger.error(
                  `Falha ao enviar webhook de erro de documentos para ${numero}: ${webhookErr instanceof Error ? webhookErr.stack : String(webhookErr)}`,
                );
                throw webhookErr;
              });
          }
          throw docError instanceof Error
            ? docError
            : new Error(String(docError));
        }
      }
    } catch (error) {
      this.logger.error(error);

      if (successWebhookSent) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const mensagem = axios.isAxiosError(error)
        ? `Erro PJE (HTTP ${error.response?.status ?? 'sem status'}): ${error.message}`
        : `Erro inesperado: ${error instanceof Error ? error.message : String(error)}`;

      const response: Root = normalizeResponse(numero, [], mensagem, {
        status: 'ERRO',
        motivoErro: 'PJE_ERRO',
        webhookId: `${correlationId}:process-error`,
        origem,
      });

      try {
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
      } catch (webhookError) {
        this.logger.error(
          `Falha ao enviar webhook de erro para ${numero}: ${webhookError instanceof Error ? webhookError.stack : String(webhookError)}`,
        );
        // Não relança webhookError — preserva o erro original de scraping
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
