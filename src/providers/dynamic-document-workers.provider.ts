import { Processor } from '@nestjs/bullmq';
import { Provider } from '@nestjs/common';
import { ALL_TRT_DOCUMENT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericDocumentosWorker } from 'src/modules/pje/queues/wokers/documentos-trt.worker';

export function createDynamicDocumentsWorkers(): Provider[] {
  const queues = [...ALL_TRT_DOCUMENT_QUEUES];

  return queues.map((queueName) => {
    const concurrency = queueName === 'pje-documentos-trt15' ? 1 : 2;

    @Processor(queueName, { concurrency, lockDuration: 120000 })
    class WorkerForQueue extends GenericDocumentosWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
