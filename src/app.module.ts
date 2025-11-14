import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { PjeModule } from './modules/pje/pje.module';
import { ReceitaFederalModule } from './modules/receita-federal/receita-federal.module';
import { RedisModule } from './connection/redis.module';
import { BullModule } from '@nestjs/bullmq';
import { QueueModule } from './connection/queue.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PjeModule,
    // BullModule.forRoot({
    //   connection: {
    //     host: process.env.REDIS_HOST,
    //     port: Number(process.env.REDIS_PORT),
    //     password: process.env.REDIS_PASSWORD || undefined,
    //   },
    // }),

    // BullModule.forRoot({
    //   connection: redis,
    // }),
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: ['REDIS_CLIENT'],
      useFactory: (redisClient: any) => ({
        connection: redisClient,
      }),
    }),
    RedisModule,
    QueueModule,
    ScheduleModule.forRoot(),
    ReceitaFederalModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
