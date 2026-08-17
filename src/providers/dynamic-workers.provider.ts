import { Provider } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericProcessoWorker } from '../modules/pje/queues/wokers/processos-trt.worker';

// Isola o TRT3 (fila com custo fixo de captcha via clique real no AWS WAF —
// bem mais lento que os demais) do resto das filas, sem duplicar a
// aplicação: o mesmo container roda em 3 modos possíveis, escolhido só por
// env var (WORKER_QUEUE_MODE), sem mudar nada em quem PRODUZ job (
// BullModule.registerQueue em pje.module.ts continua registrando as 25
// filas em todo processo — qualquer instância recebe o HTTP e enfileira
// pra fila certa; só quem CONSOME muda).
//   - 'all' (default, comportamento de sempre): consome as 25 filas.
//   - 'trt3-only': só consome pje-trt3 — serviço dedicado.
//   - 'exclude-trt3': consome as outras 24, nunca pje-trt3 — serviço
//     principal, depois de o dedicado existir.
type WorkerQueueMode = 'all' | 'trt3-only' | 'exclude-trt3';

function resolveWorkerQueueMode(): WorkerQueueMode {
  const raw = process.env.WORKER_QUEUE_MODE;
  if (raw === 'trt3-only' || raw === 'exclude-trt3') return raw;
  return 'all';
}

function queuesForMode(mode: WorkerQueueMode): string[] {
  const allQueues = [...ALL_TRT_QUEUES, 'pje-tst'];
  if (mode === 'trt3-only') return allQueues.filter((q) => q === 'pje-trt3');
  if (mode === 'exclude-trt3') return allQueues.filter((q) => q !== 'pje-trt3');
  return allQueues;
}

export function createDynamicWorkers(): Provider[] {
  const queues = queuesForMode(resolveWorkerQueueMode());

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
