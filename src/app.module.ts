import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';

import { BullModule } from '@nestjs/bullmq';
import Redis from 'ioredis';
import { AppController } from './app.controller';
import { RedisModule } from './connection/redis.module';
import { ReceitaFederalModule } from './modules/receita-federal/receita-federal.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      envFilePath: process.env.NODE_ENV === 'local' ? '.env' : undefined,
    }),
    BullModule.forRootAsync({
      imports: [RedisModule],
      inject: ['REDIS_CLIENT'],
      useFactory: (redis: Redis) => ({
        connection: redis,
      }),
    }),
    RedisModule,
    ScheduleModule.forRoot(),
    ReceitaFederalModule,
  ],
  controllers: [AppController],
  providers: [],
})
export class AppModule {}
