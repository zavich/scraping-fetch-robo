import { Provider } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericProcessoWorker } from '../modules/pje/queues/wokers/processos-trt.worker';

export function createDynamicWorkers(): Provider[] {
  const queues = [...ALL_TRT_QUEUES, 'pje-tst'];

  return queues.map((queueName) => {
    const concurrency = queueName === 'pje-trt15' ? 1 : 20;

    // Configuração de rate limiter apenas para TRT 15
    const processorOptions =
      queueName === 'pje-trt15'
        ? {
            concurrency: 1,
            limiter: {
              max: 1, // 1 job
              duration: 3 * 60 * 1000, // a cada 3 minutos
            },
          }
        : { concurrency };

    @Processor(queueName, processorOptions)
    class WorkerForQueue extends GenericProcessoWorker {}

    return {
      provide: `Worker_${queueName}`,
      useClass: WorkerForQueue,
    };
  });
}
