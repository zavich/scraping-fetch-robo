// pje.service.ts
import { InjectQueue } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { Queue, Job } from 'bullmq';

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

    // Verifica se já existe job com o mesmo jobId
    const existingJob: Job | null = await this.pjeQueue.getJob(numero);

    if (existingJob) {
      const state = await existingJob.getState();
      this.logger.log(`Job existente para ${numero} está em estado: ${state}`);

      // Só remove se falhou
      if (state === 'failed') {
        await existingJob.remove();
        this.logger.log(`Job antigo falhado removido para: ${numero}`);
      } else {
        // Se não falhou, apenas retorna
        return { status: 'já enfileirado', numero };
      }
    }
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
