import { Processor } from '@nestjs/bullmq';
import { Provider } from '@nestjs/common';
import { ALL_TRT_DOCUMENT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericDocumentosWorker } from 'src/modules/pje/queues/wokers/documentos-trt.worker';

export function createDynamicDocumentsWorkers(): Provider[] {
  const queues = [...ALL_TRT_DOCUMENT_QUEUES];

  return queues.map((queueName) => {
    // Configura concurrency e rate limiter para TRT15
    const processorOptions =
      queueName === 'pje-documentos-trt15'
        ? {
            concurrency: 1,
            lockDuration: 120_000,
            limiter: {
              max: 1, // 1 job
              duration: 3 * 60 * 1000, // a cada 3 minutos
            },
          }
        : {
            concurrency: 2,
            lockDuration: 120_000,
          };

    @Processor(queueName, processorOptions)
    class WorkerForQueue extends GenericDocumentosWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
