import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

import { PjeModule } from './modules/pje/pje.module';
import { ReceitaFederalModule } from './modules/receita-federal/receita-federal.module';
import Redis from 'ioredis';

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

    BullModule.forRoot({
      connection: new Redis(process.env.REDIS_URL as string, {
        tls: {
          rejectUnauthorized: false,
        },
      }),
    }),

    ScheduleModule.forRoot(),
    ReceitaFederalModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
