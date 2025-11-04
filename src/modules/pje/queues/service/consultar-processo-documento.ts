import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';
import { getTRTQueue } from 'src/helpers/getTRTQueue';

@Injectable()
export class ConsultarProcessoDocumentoQueue {
  private readonly logger = new Logger(ConsultarProcessoDocumentoQueue.name);

  private readonly queues: Record<string, Queue> = {};

  constructor(
    @InjectQueue('pje-documentos-trt1') private readonly trt1: Queue,
    @InjectQueue('pje-documentos-trt2') private readonly trt2: Queue,
    @InjectQueue('pje-documentos-trt3') private readonly trt3: Queue,
    @InjectQueue('pje-documentos-trt4') private readonly trt4: Queue,
    @InjectQueue('pje-documentos-trt5') private readonly trt5: Queue,
    @InjectQueue('pje-documentos-trt6') private readonly trt6: Queue,
    @InjectQueue('pje-documentos-trt7') private readonly trt7: Queue,
    @InjectQueue('pje-documentos-trt8') private readonly trt8: Queue,
    @InjectQueue('pje-documentos-trt9') private readonly trt9: Queue,
    @InjectQueue('pje-documentos-trt10') private readonly trt10: Queue,
    @InjectQueue('pje-documentos-trt11') private readonly trt11: Queue,
    @InjectQueue('pje-documentos-trt12') private readonly trt12: Queue,
    @InjectQueue('pje-documentos-trt13') private readonly trt13: Queue,
    @InjectQueue('pje-documentos-trt14') private readonly trt14: Queue,
    @InjectQueue('pje-documentos-trt15') private readonly trt15: Queue,
    @InjectQueue('pje-documentos-trt16') private readonly trt16: Queue,
    @InjectQueue('pje-documentos-trt17') private readonly trt17: Queue,
    @InjectQueue('pje-documentos-trt18') private readonly trt18: Queue,
    @InjectQueue('pje-documentos-trt19') private readonly trt19: Queue,
    @InjectQueue('pje-documentos-trt20') private readonly trt20: Queue,
    @InjectQueue('pje-documentos-trt21') private readonly trt21: Queue,
    @InjectQueue('pje-documentos-trt22') private readonly trt22: Queue,
    @InjectQueue('pje-documentos-trt23') private readonly trt23: Queue,
    @InjectQueue('pje-documentos-trt24') private readonly trt24: Queue,
  ) {
    // ✅ AQUI ESTAVA O PROBLEMA — PRECISA POPULAR O MAP
    this.queues = {
      'pje-documentos-trt1': trt1,
      'pje-documentos-trt2': trt2,
      'pje-documentos-trt3': trt3,
      'pje-documentos-trt4': trt4,
      'pje-documentos-trt5': trt5,
      'pje-documentos-trt6': trt6,
      'pje-documentos-trt7': trt7,
      'pje-documentos-trt8': trt8,
      'pje-documentos-trt9': trt9,
      'pje-documentos-trt10': trt10,
      'pje-documentos-trt11': trt11,
      'pje-documentos-trt12': trt12,
      'pje-documentos-trt13': trt13,
      'pje-documentos-trt14': trt14,
      'pje-documentos-trt15': trt15,
      'pje-documentos-trt16': trt16,
      'pje-documentos-trt17': trt17,
      'pje-documentos-trt18': trt18,
      'pje-documentos-trt19': trt19,
      'pje-documentos-trt20': trt20,
      'pje-documentos-trt21': trt21,
      'pje-documentos-trt22': trt22,
      'pje-documentos-trt23': trt23,
      'pje-documentos-trt24': trt24,
    };
  }

  async execute(numero: string, instances: any[]) {
    if (!instances?.length) {
      throw new BadRequestException(
        'Sem instâncias para consultar documentos.',
      );
    }

    const queueName = `pje-documentos-${getTRTQueue(numero)}`;

    const queue = this.queues[queueName];

    if (!queue) {
      throw new BadRequestException(`Fila não encontrada: ${queueName}`);
    }

    this.logger.log(
      `📄 Enfileirando documentos → ${numero} na fila ${queueName}`,
    );

    await queue.add(
      'consulta-documentos',
      { numero, instances },
      {
        jobId: `${numero}-docs`,
        attempts: 3,
        backoff: { type: 'fixed', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { fila: queueName, numero };
  }
}
