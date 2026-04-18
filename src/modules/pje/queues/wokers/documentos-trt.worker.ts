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

export class GenericDocumentosWorker extends WorkerHost {
  protected readonly logger = new Logger(GenericDocumentosWorker.name);

  @Inject(ProcessDocumentsFindService)
  protected readonly processDocsService!: ProcessDocumentsFindService;
  @Inject(LoginPoolService)
  protected readonly loginPoolService!: LoginPoolService;
  @Inject('REDIS_CLIENT') private readonly redis: Redis;

  async process(
    job: Job<{
      numero: string;
      instances: ProcessosResponse[];
      filePath: string;
    }>,
  ) {
    const { numero, instances, filePath } = job.data;
    const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;

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
          true,
        );
        await axios.post(webhookUrl, resp);
        return;
      }

      if (!filePath) {
        this.logger.error(`❌ filePath undefined para ${numero}`);
        const resp = normalizeResponse(
          numero,
          [],
          `Erro ao gerar arquivo para consulta de documentos, tente novamente mais tarde.`,
          true,
        );
        await axios.post(webhookUrl, resp);
        return;
      }

      // Executa consulta de documentos
      const documentos = await this.processDocsService.execute(
        numero,
        instances,
        filePath,
      );
      if (documentos[0].documentos.length === 0) {
        this.logger.warn(`⚠️ Nenhum documento encontrado para ${numero}`);
        const resp = normalizeResponse(
          numero,
          [],
          `Nenhum documento encontrado, tente novamente mais tarde.`,
          true,
        );
        await axios.post(webhookUrl, resp);
        return;
      }
      const result = documentos.slice(0, 2);
      const response = normalizeResponse(numero, result, '', true);
      this.logger.log(`✅ Documentos finalizados → ${numero}`);
      await deleteByPattern(this.redis, `pje:token:captcha:${numero}*`, {
        log: (msg) => this.logger.debug(msg),
      });

      await deleteByPattern(this.redis, `tokencaptcha:${numero}*`, {
        log: (msg) => this.logger.debug(msg),
      });
      await axios.post(webhookUrl, response);
    } catch (error: any) {
      this.logger.error(error);

      const resp = normalizeResponse(
        numero,
        [],
        'Erro ao consultar documentos, tente novamente mais tarde.',
        true,
      );
      await axios.post(webhookUrl, resp);
    }
  }
}
