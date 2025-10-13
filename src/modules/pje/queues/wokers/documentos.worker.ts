// workers/documentos.worker.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import axios from 'axios';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';
import { LoginPoolService } from '../../services/login-pool.service';
import { normalizeResponse } from 'src/utils/normalizeResponse';

@Processor('pje-documentos', { concurrency: 4, lockDuration: 120000 }) // 1 por vez
export class DocumentosWorker extends WorkerHost {
  private readonly logger = new Logger(DocumentosWorker.name);

  constructor(
    private readonly processDocumentsFindService: ProcessDocumentsFindService,
    private readonly loginPool: LoginPoolService,
  ) {
    super();
  }

  async process(job: Job<{ numero: string }>) {
    const { numero } = job.data;
    const regionTRT = Number(numero.split('.')[3]);
    const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;
    try {
      const cookies = await this.loginPool.getCookies(Number(regionTRT));
      this.logger.log(`🔎 CONSULTANDO ${numero}`);
      const instances = await this.processDocumentsFindService.execute(
        numero,
        cookies,
      );
      const result = instances.slice(0, 2);

      this.logger.log(`🔎 CONSULTA FINALIZADA PARA ${numero}`);
      if (!instances || instances.length === 0) {
        const response = normalizeResponse(
          numero,
          [],
          'Processo não encontrado, tente novamente mais tarde',
          true,
        );
        await axios.post(webhookUrl, response, {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        });
        return response;
      }
      const response = normalizeResponse(numero, result, '', true);

      await axios.post(webhookUrl, response, {
        headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
      });
      return response;
    } catch (error) {
      if (error.status === 503) {
        this.logger.warn(`⚠️ TRT-${regionTRT} está fora do ar`);
        const response = normalizeResponse(
          numero,
          [],
          'Error ao consultar documentos, tente novamente mais tarde',
          true,
        );
        await axios.post(webhookUrl, response, {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        });
      }
      this.logger.error(`Error processing job ${job.id}: ${error.message}`);
    }
  }
}
