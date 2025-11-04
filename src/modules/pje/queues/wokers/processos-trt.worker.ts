import { getQueueToken, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job, Queue } from 'bullmq';
import { normalizeResponse } from 'src/utils/normalizeResponse';
import { ProcessFindService } from '../../services/process-find.service';

export class GenericProcessoWorker extends WorkerHost {
  private readonly logger = new Logger(GenericProcessoWorker.name);
  private readonly documentosQueues: Record<string, Queue> = {};
  constructor(
    @Inject(ProcessFindService)
    private readonly processFindService: ProcessFindService,

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
    }>,
  ) {
    const { numero, origem, documents = false, webhook } = job.data;

    this.logger.log(`📄 [${job.queueName}] Consultando processo ${numero}`);

    const webhookUrl = webhook ?? `${process.env.WEBHOOK_URL}/process/webhook`;

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
          true,
        );

        await axios.post(webhookUrl, response);
        return;
      }

      // --------------------------
      // 🔍 Buscar processo
      // --------------------------
      const instances = await this.processFindService.execute(numero, origem);
      const result = instances.slice(0, 2);

      if (!instances || instances.length === 0) {
        this.logger.warn(
          `⚠️ Nenhum resultado encontrado para o processo ${numero}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Nenhum resultado encontrado',
          true,
          origem,
        );

        await axios.post(webhookUrl, response);
        return;
      }

      // --------------------------
      // 🔐 Segredo de Justiça
      // --------------------------
      const segredo = instances.some(
        (i) => 'mensagemErro' in i && i.juizoDigital === false,
      );

      if (segredo) {
        this.logger.warn(`⚠️ Segredo de justiça ${numero}`);
        const response = normalizeResponse(
          numero,
          [],
          `O processo ${numero} está em segredo de justiça`,
          true,
          origem,
        );

        await axios.post(webhookUrl, response);
        return;
      }

      // --------------------------
      // ✅ Resposta final
      // --------------------------
      const response = normalizeResponse(numero, result, '', false, origem);

      // --------------------------
      // 📄 Enfileirar documentos
      // --------------------------
      if (documents) {
        const queueName = `trt${regionTRT}`;
        const documentosQueue = this.documentosQueues[queueName];

        const existing = (await documentosQueue.getJob(numero)) as
          | Job
          | undefined;

        if (existing && (await existing.isFailed())) {
          await existing.remove();
        }

        if (!documentosQueue) {
          this.logger.error(`Fila de documentos não encontrada: ${queueName}`);
          return;
        }

        await documentosQueue.add(
          'consulta-processo-documento',
          { numero, instances },
          {
            jobId: numero,
            attempts: 2,
            backoff: { type: 'fixed', delay: 5000 },
            removeOnFail: false,
            removeOnComplete: true,
          },
        );
      }

      // --------------------------
      // ✅ POST final
      // --------------------------
      console.log('RESPONSE', response);
      await axios.post(webhookUrl, response);

      this.logger.log(`✅ [${job.queueName}] Finalizado ${numero}`);
    } catch (error) {
      this.logger.error(error);

      if (axios.isAxiosError(error) && error.status === 503) {
        const response = normalizeResponse(
          numero,
          [],
          'Erro temporário, tente novamente mais tarde',
          true,
        );
        await axios.post(webhookUrl, response);
      }
    }
  }
}
