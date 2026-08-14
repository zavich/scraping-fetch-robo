import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getQueueToken } from '@nestjs/bullmq';
import { Cron, CronExpression } from '@nestjs/schedule';
import { Queue } from 'bullmq';
import {
  CloudWatchClient,
  PutMetricDataCommand,
} from '@aws-sdk/client-cloudwatch';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';

// Autoscaling do scraping-task-service (Frente 1 do diagnóstico de
// capacidade) precisa de um sinal de "fila lotada" pra escalar — CPU não
// serve aqui, o worker fica em 1-3% justamente quando mais sobrecarregado
// (o tempo é de espera de rede/captcha, não de processamento). Reporta
// duas métricas agregadas (não por fila — 25 filas x métricas por fila
// multiplicaria custo de métrica customizada no CloudWatch sem necessidade
// pra uma política de autoscaling, que olha só o agregado):
//   - QueueOldestJobAgeMinutes: idade do job mais antigo esperando, o MAIOR
//     entre todas as 25 filas (pje-trt1..24 + pje-tst) — é essa que
//     alimenta o target tracking do autoscaling.
//   - QueueWaitingTotal: soma de jobs esperando em todas as filas — só
//     visibilidade/dashboard, não usada pra decisão de scaling.
const QUEUE_NAMES = [...ALL_TRT_QUEUES, 'pje-tst'];
const METRIC_NAMESPACE = 'ScrapingRoboApi/Queues';

@Injectable()
export class QueueMetricsReporterService implements OnModuleInit {
  private readonly logger = new Logger(QueueMetricsReporterService.name);
  private queues: Queue[] = [];
  private readonly cloudwatch = new CloudWatchClient({
    region: process.env.AWS_REGION || 'sa-east-1',
  });

  constructor(private readonly moduleRef: ModuleRef) {}

  // Resolve as instâncias de Queue já registradas por BullModule.registerQueue
  // (pje.module.ts) via o token que @nestjs/bullmq usa internamente — mesma
  // ideia de createDynamicWorkers (dynamic-workers.provider.ts), sem precisar
  // injetar as 25 filas uma a uma no construtor.
  onModuleInit(): void {
    this.queues = QUEUE_NAMES.map((name) => {
      try {
        return this.moduleRef.get<Queue>(getQueueToken(name), {
          strict: false,
        });
      } catch {
        this.logger.warn(`Fila ${name} não encontrada — pulando na métrica.`);
        return null;
      }
    }).filter((queue): queue is Queue => queue !== null);
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async reportQueueMetrics(): Promise<void> {
    // Nunca pode derrubar o processo por conta própria — é só observabilidade.
    try {
      const now = Date.now();
      let totalWaiting = 0;
      let oldestAgeMs = 0;

      for (const queue of this.queues) {
        const [waitingCount, oldestWaitingJobs] = await Promise.all([
          queue.getWaitingCount(),
          // Índice 0 é o próximo a ser processado (FIFO) — o mais antigo da
          // fila. Pega só 1 item, não a lista inteira (fila pode ter
          // milhares de jobs em pico).
          queue.getWaiting(0, 0),
        ]);

        totalWaiting += waitingCount;

        const oldestJob: unknown = oldestWaitingJobs[0];
        const timestamp =
          oldestJob && typeof oldestJob === 'object' && 'timestamp' in oldestJob
            ? (oldestJob as { timestamp: unknown }).timestamp
            : null;
        if (typeof timestamp === 'number') {
          oldestAgeMs = Math.max(oldestAgeMs, now - timestamp);
        }
      }

      const oldestAgeMinutes = oldestAgeMs / 60000;

      await this.cloudwatch.send(
        new PutMetricDataCommand({
          Namespace: METRIC_NAMESPACE,
          MetricData: [
            {
              MetricName: 'QueueOldestJobAgeMinutes',
              Value: oldestAgeMinutes,
              Unit: 'None',
              Timestamp: new Date(now),
            },
            {
              MetricName: 'QueueWaitingTotal',
              Value: totalWaiting,
              Unit: 'Count',
              Timestamp: new Date(now),
            },
          ],
        }),
      );

      this.logger.debug(
        `📊 Métricas de fila: waitingTotal=${totalWaiting}, oldestAgeMinutes=${oldestAgeMinutes.toFixed(1)}`,
      );
    } catch (err) {
      this.logger.error(
        `Falha ao reportar métricas de fila: ${err instanceof Error ? err.stack : String(err)}`,
      );
    }
  }
}
