// workers/processos.worker.ts
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import axios from 'axios';
import { ProcessFindService } from '../../services/process-find.service';
import { normalizeResponse } from 'src/utils/normalizeResponse';

@Processor('pje-processos', {
  concurrency: 5, // processa até 5 processos ao mesmo tempo
  lockDuration: 120000,
  limiter: { max: 10, duration: 5 * 60 * 1000 }, // no máximo 10 requests a cada 5 min
})
// paralelo
export class ProcessosWorker extends WorkerHost {
  private readonly logger = new Logger(ProcessosWorker.name);

  constructor(
    private readonly processFindService: ProcessFindService,
    @InjectQueue('pje-documentos') private readonly pjeQueue: Queue,
  ) {
    super();
  }

  async process(
    job: Job<{ numero: string; origem: string; documents: boolean }>,
  ) {
    const webhookUrl = `${process.env.WEBHOOK_URL}/process/webhook`;
    const { numero, origem, documents = false } = job.data;

    const match = numero.match(/^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/);
    const regionTRT = match ? Number(match[1]) : null;

    try {
      if (regionTRT === null) {
        this.logger.warn(
          `⚠️ Error ao consultar documentos para o processo ${numero} ${regionTRT}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Error ao consultar documentos, verifique o número e tente novamente mais tarde',
          true,
        );
        await axios.post(webhookUrl, response, {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        });
        return;
      }
      this.logger.log(
        `📄 Consultando processo ${numero} params: ${JSON.stringify({ origem, documents })}`,
      );
      const instances = await this.processFindService.execute(numero, origem);
      const result = instances.slice(0, 2);
      this.logger.log(`🔍 Resultados encontrados para o processo ${numero}`);
      if (!instances || instances.length === 0) {
        this.logger.warn(
          `⚠️ Nenhum resultado encontrado para o processo ${numero} (origem: ${origem})`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Nenhum resultado encontrado para o processo, verifique o número e tente novamente mais tarde',
          true,
          origem,
        );
        await axios.post(webhookUrl, response, {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        });
        return response;
      }
      const segredoJustica = instances.some(
        (instance) =>
          'mensagemErro' in instance && instance.juizoDigital === false,
      );

      if (result && segredoJustica) {
        this.logger.warn(
          `⚠️ O processo ${numero} se encontra em segredo de justiça`,
        );
        const response = normalizeResponse(
          numero,
          [],
          `O processo ${numero} se encontra em segredo de justiça`,
          true,
          origem,
        );
        await axios.post(webhookUrl, response, {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        });
        return;
      }

      const response = normalizeResponse(numero, result, '', false, origem);
      if (documents) {
        await this.pjeQueue.add(
          'consulta-processo-documento',
          { numero, instances },
          {
            jobId: numero,
            attempts: 2, // até 1 tentativas
            backoff: { type: 'fixed', delay: 5000 }, // espera 5s entre tentativas
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
      }
      this.logger.log(`🔎 CONSULTA FINALIZADA PARA ${numero}`);
      await axios.post(webhookUrl, response, {
        headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
      });
    } catch (error) {
      if (axios.isAxiosError(error) && error.status === 503) {
        console.log('ERROR DOCUMENTOS WORKER', error);
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
      this.logger.error(`Error processing job ${job.id}: ${error}`);
    }
  }
}
