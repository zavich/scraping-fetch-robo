// pje.service.ts
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class ConsultarProcessoDocumentoQueue {
  private readonly logger = new Logger(ConsultarProcessoDocumentoQueue.name);

  constructor(
    @InjectQueue('pje-documentos') private readonly pjeQueue: Queue,
  ) {}

  async execute(numero: string) {
    this.logger.log(
      `Enfileirando consulta de documentos para o processo: ${numero}`,
    );

    await this.pjeQueue.add(
      'consulta-processo-documento',
      { numero },
      {
        jobId: numero,
        attempts: 2, // até 1 tentativas
        backoff: { type: 'fixed', delay: 5000 }, // espera 5s entre tentativas
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { status: 'enfileirado', numero };
  }
}
