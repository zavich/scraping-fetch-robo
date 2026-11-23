import { Logger, Provider } from '@nestjs/common';
import { Processor } from '@nestjs/bullmq';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { GenericProcessoWorker } from '../modules/pje/queues/wokers/processos-trt.worker';

const logger = new Logger('DynamicWorkers');

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

// Concorrência por fila sem novo deploy de código: WORKER_CONCURRENCY_OVERRIDES
// no formato "pje-trt2=6,pje-trt15=4". Existe porque o TRT2 concentra a maior
// parte dos pedidos e o job é quase todo espera de rede (captcha, PJe, Lambda
// de extração) — CPU fica em 1-3% —, então 3 por task virava fila. Sobe aos
// poucos: o limite real é quanto o PJe do tribunal aguenta antes de responder
// 429/bloquear. Entrada inválida é ignorada com aviso, nunca derruba o boot.
function parseConcurrencyOverrides(): Map<string, number> {
  const overrides = new Map<string, number>();
  const raw = process.env.WORKER_CONCURRENCY_OVERRIDES;
  if (!raw) return overrides;

  for (const entry of raw.split(',')) {
    const [queueName, value] = entry.split('=').map((part) => part.trim());
    const concurrency = Number(value);
    if (!queueName || !Number.isInteger(concurrency) || concurrency < 1) {
      logger.warn(
        `WORKER_CONCURRENCY_OVERRIDES: entrada inválida "${entry}" — ignorada`,
      );
      continue;
    }
    overrides.set(queueName, concurrency);
  }
  return overrides;
}

function defaultConcurrency(queueName: string): number {
  // TRT3/TRT9 (passam por browser) e TST com 1, demais TRTs com 3.
  return queueName === 'pje-trt3' ||
    queueName === 'pje-trt9' ||
    queueName === 'pje-tst'
    ? 1
    : 3;
}

export function createDynamicWorkers(): Provider[] {
  const queues = queuesForMode(resolveWorkerQueueMode());
  const overrides = parseConcurrencyOverrides();

  return queues.map((queueName) => {
    const concurrency =
      overrides.get(queueName) ?? defaultConcurrency(queueName);
    if (overrides.has(queueName)) {
      logger.log(`Concorrência de ${queueName}: ${concurrency} (override)`);
    }

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
