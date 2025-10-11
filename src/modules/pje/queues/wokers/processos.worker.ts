// workers/processos.worker.ts
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import axios from 'axios';
import { ProcessFindService } from '../../services/process-find.service';
import { normalizeResponse } from 'src/utils/normalizeResponse';

@Processor('pje-processos', { concurrency: 10, lockDuration: 600000 }) // paralelo
export class ProcessosWorker extends WorkerHost {
  private readonly logger = new Logger(ProcessosWorker.name);

  constructor(private readonly processFindService: ProcessFindService) {
    super();
  }

  async process(job: Job<{ numero: string; origem: string }>) {
    try {
      const { numero, origem } = job.data;
      this.logger.log(`📄 Consultando processo ${numero}`);
      const instances = await this.processFindService.execute(numero, origem);
      const result = instances.slice(0, 2);
      const response = normalizeResponse(numero, result, '', false, origem);

      const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;
      await axios.post(webhookUrl, response, {
        headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
      });
    } catch (error) {
      this.logger.error(`Error processing job ${job.id}: ${error.message}`);
    }
  }
}
