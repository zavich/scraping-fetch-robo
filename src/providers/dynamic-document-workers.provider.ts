import { Processor } from '@nestjs/bullmq';
import { Provider } from '@nestjs/common';
import { ALL_TRT_DOCUMENT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericDocumentosWorker } from 'src/modules/pje/queues/wokers/documentos-trt.worker';

export function createDynamicDocumentsWorkers(): Provider[] {
  const queues = [...ALL_TRT_DOCUMENT_QUEUES];

  return queues.map((queueName) => {
    // PERF-002: concurrency reduzida para não saturar o browser pool (capacity ~15)
    const browserPoolSize = Number(process.env.BROWSER_POOL_SIZE ?? 3);
    const processorOptions = {
      lockDuration: 10 * 60 * 1000, // 10 minutos
      concurrency: browserPoolSize * 5, // 5 páginas por browser instance
    };

    @Processor(queueName, processorOptions)
    class WorkerForQueue extends GenericDocumentosWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
