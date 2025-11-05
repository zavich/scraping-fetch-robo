import {
  Injectable,
  Inject,
  Logger,
  BadRequestException,
} from '@nestjs/common';
import { getQueueToken } from '@nestjs/bullmq';
import { Queue, Job } from 'bullmq';
import { getTRTQueue } from 'src/helpers/getTRTQueue';

@Injectable()
export class ConsultarProcessoQueue {
  private readonly logger = new Logger(ConsultarProcessoQueue.name);

  private readonly queues: Record<string, Queue> = {};

  constructor(
    // TRT 1 a 24
    @Inject(getQueueToken('pje-trt1')) trt1: Queue,
    @Inject(getQueueToken('pje-trt2')) trt2: Queue,
    @Inject(getQueueToken('pje-trt3')) trt3: Queue,
    @Inject(getQueueToken('pje-trt4')) trt4: Queue,
    @Inject(getQueueToken('pje-trt5')) trt5: Queue,
    @Inject(getQueueToken('pje-trt6')) trt6: Queue,
    @Inject(getQueueToken('pje-trt7')) trt7: Queue,
    @Inject(getQueueToken('pje-trt8')) trt8: Queue,
    @Inject(getQueueToken('pje-trt9')) trt9: Queue,
    @Inject(getQueueToken('pje-trt10')) trt10: Queue,
    @Inject(getQueueToken('pje-trt11')) trt11: Queue,
    @Inject(getQueueToken('pje-trt12')) trt12: Queue,
    @Inject(getQueueToken('pje-trt13')) trt13: Queue,
    @Inject(getQueueToken('pje-trt14')) trt14: Queue,
    @Inject(getQueueToken('pje-trt15')) trt15: Queue,
    @Inject(getQueueToken('pje-trt16')) trt16: Queue,
    @Inject(getQueueToken('pje-trt17')) trt17: Queue,
    @Inject(getQueueToken('pje-trt18')) trt18: Queue,
    @Inject(getQueueToken('pje-trt19')) trt19: Queue,
    @Inject(getQueueToken('pje-trt20')) trt20: Queue,
    @Inject(getQueueToken('pje-trt21')) trt21: Queue,
    @Inject(getQueueToken('pje-trt22')) trt22: Queue,
    @Inject(getQueueToken('pje-trt23')) trt23: Queue,
    @Inject(getQueueToken('pje-trt24')) trt24: Queue,

    @Inject(getQueueToken('pje-tst')) private readonly tstQueue: Queue,
  ) {
    // Monta dicionário dinâmico
    this.queues = {
      'pje-trt1': trt1,
      'pje-trt2': trt2,
      'pje-trt3': trt3,
      'pje-trt4': trt4,
      'pje-trt5': trt5,
      'pje-trt6': trt6,
      'pje-trt7': trt7,
      'pje-trt8': trt8,
      'pje-trt9': trt9,
      'pje-trt10': trt10,
      'pje-trt11': trt11,
      'pje-trt12': trt12,
      'pje-trt13': trt13,
      'pje-trt14': trt14,
      'pje-trt15': trt15,
      'pje-trt16': trt16,
      'pje-trt17': trt17,
      'pje-trt18': trt18,
      'pje-trt19': trt19,
      'pje-trt20': trt20,
      'pje-trt21': trt21,
      'pje-trt22': trt22,
      'pje-trt23': trt23,
      'pje-trt24': trt24,
      'pje-tst': this.tstQueue,
    };
  }

  async execute(
    numero: string,
    origem?: string,
    documents = false,
    webhook?: string,
  ) {
    const queueName = origem === 'TST' ? 'pje-tst' : getTRTQueue(numero);

    if (!queueName) {
      throw new BadRequestException('Número de processo inválido');
    }

    const queue = this.queues[queueName];

    if (!queue) {
      throw new BadRequestException('Fila não encontrada');
    }

    // ✅ Se job existir, remove antes de reprocessar
    const existing = (await queue.getJob(numero)) as Job | undefined;
    if (existing) {
      await existing.remove();
      this.logger.warn(`♻️ Job removido para reprocessamento: ${numero}`);
    }

    // ✅ Agora pode adicionar novamente
    await queue.add(
      'consulta-processo',
      { numero, origem, documents, webhook },
      {
        jobId: numero,
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnFail: false,
        removeOnComplete: true,
      },
    );

    this.logger.log(`✅ Processo ${numero} enviado para fila: ${queueName}`);
    return { fila: queueName, numero, origem };
  }
}
