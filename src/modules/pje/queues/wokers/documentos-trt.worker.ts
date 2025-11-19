import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job } from 'bullmq';
import { normalizeResponse } from 'src/utils/normalizeResponse';

import { ProcessosResponse } from 'src/interfaces';
import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';

export class GenericDocumentosWorker extends WorkerHost {
  protected readonly logger = new Logger(GenericDocumentosWorker.name);

  @Inject(LoginPoolService)
  protected readonly loginPool!: LoginPoolService;

  @Inject(ProcessDocumentsFindService)
  protected readonly processDocsService!: ProcessDocumentsFindService;
  @Inject(LoginPoolService)
  protected readonly loginPoolService!: LoginPoolService;

  async process(job: Job<{ numero: string; instances: ProcessosResponse[] }>) {
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

      // Obtém cookies e conta usada
      const { cookies, account } = await this.loginPool.getCookies(regionTRT);

      // Se não tiver cookies, significa que nenhuma conta está disponível
      if (!cookies || !account) {
        const resp = normalizeResponse(
          numero,
          [],
          `TRT-${regionTRT} indisponível ou todas as contas bloqueadas`,
          true,
        );
        await axios.post(webhookUrl, resp);
        return;
      }

      // Executa consulta de documentos
      const documentos = await this.processDocsService.execute(
        numero,
        instances,
      );

      const result = documentos.slice(0, 2);
      const response = normalizeResponse(numero, result, '', true);
      this.logger.log(`✅ Documentos finalizados → ${numero}`);

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
