import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { RedisModule } from './redis.module';
import {
  ALL_TRT_QUEUES,
  ALL_TRT_DOCUMENT_QUEUES,
} from 'src/helpers/getTRTQueue';

@Module({
  imports: [
    RedisModule,

    // fila geral
    BullModule.registerQueueAsync({
      name: 'pje-tst',
      useFactory: (redisClient: any) => ({ connection: redisClient }),
      inject: ['REDIS_CLIENT'],
    }),

    // filas de processos por TRT
    ...ALL_TRT_QUEUES.map((name) =>
      BullModule.registerQueueAsync({
        name,
        useFactory: (redisClient: any) => ({ connection: redisClient }),
        inject: ['REDIS_CLIENT'],
      }),
    ),

    // filas de documentos por TRT
    ...ALL_TRT_DOCUMENT_QUEUES.map((name) =>
      BullModule.registerQueueAsync({
        name,
        useFactory: (redisClient: any) => ({ connection: redisClient }),
        inject: ['REDIS_CLIENT'],
      }),
    ),
  ],
  exports: [
    // exporta o BullModule para outros módulos
    BullModule,
  ],
})
export class QueueModule {}
