import { Provider } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericProcessoWorker } from '../modules/pje/queues/wokers/processos-trt.worker';

export function createDynamicWorkers(): Provider[] {
  const queues = [...ALL_TRT_QUEUES, 'pje-tst'];

  return queues.map((queueName) => {
    const concurrency =
      queueName === 'pje-trt3' ||
      queueName === 'pje-trt9' ||
      queueName === 'pje-tst'
        ? 1
        : 3; // TST com concorrência 1, TRT com 3

    const processorOptions = {
      concurrency,
      lockDuration: 120000,
      stalledInterval: 30000,
      limiter: {
        max: 3,
        duration: 1000,
      },
    };

    @Processor(queueName, processorOptions)
    class WorkerForQueue extends GenericProcessoWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
