import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { ScheduleModule } from '@nestjs/schedule';

import { PjeModule } from './modules/pje/pje.module';
import { ReceitaFederalModule } from './modules/receita-federal/receita-federal.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
    }),
    PjeModule,
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST,
        port: Number(process.env.REDIS_PORT),
      },
    }),
    ScheduleModule.forRoot(),
    ReceitaFederalModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
