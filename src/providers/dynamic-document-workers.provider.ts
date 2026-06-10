import { Processor } from '@nestjs/bullmq';
import { Provider } from '@nestjs/common';
import { ALL_TRT_DOCUMENT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericDocumentosWorker } from 'src/modules/pje/queues/wokers/documentos-trt.worker';

export function createDynamicDocumentsWorkers(): Provider[] {
  const queues = [...ALL_TRT_DOCUMENT_QUEUES];

  return queues.map((queueName) => {
    const browserPoolSize = Math.max(1, parseInt(process.env.BROWSER_POOL_SIZE ?? '3', 10) || 3);
    // Limita concorrência por fila distribuindo a capacidade total do pool.
    // Nota: como é clamped a >= 1, o total efetivo pode chegar a queues.length
    // quando queues.length > browserPoolSize*5 (ex.: pool=3 → 1 por fila × 24 = 24).
    const processorOptions = {
      lockDuration: 10 * 60 * 1000, // 10 minutos
      concurrency: Math.max(1, Math.floor((browserPoolSize * 5) / queues.length)),
    };

    @Processor(queueName, processorOptions)
    class WorkerForQueue extends GenericDocumentosWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
