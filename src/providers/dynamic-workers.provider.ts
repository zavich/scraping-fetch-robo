import { Provider } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericProcessoWorker } from '../modules/pje/queues/wokers/processos-trt.worker';

export function createDynamicWorkers(): Provider[] {
  const queues = [...ALL_TRT_QUEUES, 'pje-tst'];

  return queues.map((queueName) => {
    const concurrency = 3;

    const processorOptions = {
      concurrency,
      lockDuration: 120000,
      stalledInterval: 30000,
      limiter: {
        max: 6,
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
