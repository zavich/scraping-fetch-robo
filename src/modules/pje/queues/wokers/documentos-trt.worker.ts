import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job } from 'bullmq';
import { normalizeResponse } from 'src/utils/normalizeResponse';

import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';

export class GenericDocumentosWorker extends WorkerHost {
  protected readonly logger = new Logger(GenericDocumentosWorker.name);

  @Inject(LoginPoolService)
  protected readonly loginPool!: LoginPoolService;

  @Inject(ProcessDocumentsFindService)
  protected readonly processDocsService!: ProcessDocumentsFindService;

  async process(job: Job<{ numero: string; instances: any[] }>) {
    const { numero, instances } = job.data;
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

      // Tenta obter cookies
      const cookies = await this.loginPool.getCookies(regionTRT);

      if (!cookies) {
        const resp = normalizeResponse(
          numero,
          [],
          `TRT-${regionTRT} indisponível para consulta de documentos`,
          true,
        );
        await axios.post(webhookUrl, resp);
        return;
      }

      // Executa consulta via serviço principal
      const documentos = await this.processDocsService.execute(
        numero,
        cookies,
        instances,
      );

      const result = documentos.slice(0, 2);

      const response = normalizeResponse(numero, result, '', true);
      console.log(
        'RESPONSE DOCUMENTS:',
        response.resposta?.instancias?.[0]?.documentos,
      );
      await axios.post(webhookUrl, response);

      this.logger.log(`✅ Documentos finalizados → ${numero}`);
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
