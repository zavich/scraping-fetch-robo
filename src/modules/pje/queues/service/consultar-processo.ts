// pje.service.ts
import { InjectQueue } from '@nestjs/bullmq';
import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { Queue } from 'bullmq';

@Injectable()
export class ConsultarProcessoQueue {
  private readonly logger = new Logger(ConsultarProcessoQueue.name);

  constructor(@InjectQueue('pje-processos') private readonly pjeQueue: Queue) {}

  async execute(
    numero: string,
    origem?: string,
    documents = false,
    webhook?: string,
  ) {
    this.logger.log(`Enfileirando processo ${numero} (origem: ${origem})`);
    if (documents && origem) {
      throw new BadRequestException(
        'Parâmetro documents não pode ser usado junto com origem',
      );
    }
    await this.pjeQueue.add(
      'consulta-processo',
      { numero, origem, documents, webhook },
      {
        jobId: numero,
        attempts: 3, // até 3 tentativas
        backoff: { type: 'fixed', delay: 5000 }, // espera 5s antes de tentar de novo
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    return { status: 'enfileirado', numero, origem };
  }
}
