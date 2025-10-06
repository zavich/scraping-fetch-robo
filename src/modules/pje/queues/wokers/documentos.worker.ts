// workers/documentos.worker.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';

import axios from 'axios';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';

@Processor('pje-documentos', { concurrency: 1 }) // 1 por vez
export class DocumentosWorker extends WorkerHost {
  private readonly logger = new Logger(DocumentosWorker.name);

  constructor(
    private readonly processDocumentsFindService: ProcessDocumentsFindService,
  ) {
    super();
  }

  async process(job: Job<{ numero: string }>) {
    const { numero } = job.data;
    this.logger.log(`🔎 Consultando documentos para ${numero}`);
    const response = await this.processDocumentsFindService.execute(numero);

    const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;

    await axios.post(webhookUrl, response, {
      headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
    });
  }
}
