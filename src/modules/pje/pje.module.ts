import { HttpModule } from '@nestjs/axios';

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import { ALL_TRT_QUEUES } from 'src/helpers/getTRTQueue';
import { ScrapingService } from 'src/helpers/scraping.service';
import { createDynamicWorkers } from 'src/providers/dynamic-workers.provider';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { BedrockCaptchaService } from 'src/services/bedrock-captcha.service';
import { CaptchaService } from 'src/services/captcha.service';
import { LambdaCaptchaService } from 'src/services/lambda-captcha.service';
import { PjeController } from './pje.controller';
import { BenchmarkDocumentoService } from './services/benchmark-documento.service';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';
import { PdfExtractService } from './services/extract.service';
import { FetchDocumentoService } from './services/fetch-documents-url.service';
import { FetchPublicDocumentsService } from './services/fetch-public-documents.service';
import { FetchUrlMovimentService } from './services/fetch-url.service';
import { LambdaDocumentExtractorService } from './services/lambda-document-extractor.service';
import { LoginPoolService } from './services/login-pool.service';
import { PjeLoginService } from './services/login.service';
import { ProcessDocumentsFindService } from './services/process-documents-find.service';
import { QueueMetricsReporterService } from './services/queue-metrics-reporter.service';
import { RedisService } from 'src/services/redis.service';

const defaultQueueOptions = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 5000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 100, age: 3 * 24 * 3600 },
};

@Module({
  imports: [
    HttpModule,

    BullModule.registerQueue(
      // fila geral
      { name: 'pje-tst', defaultJobOptions: defaultQueueOptions },

      // filas de processos por TRT
      ...ALL_TRT_QUEUES.map((q) => ({
        name: q,
        defaultJobOptions: defaultQueueOptions,
      })),
    ),
  ],
  controllers: [PjeController],
  providers: [
    PjeLoginService,
    CaptchaService,
    LambdaCaptchaService,
    BedrockCaptchaService,
    FetchUrlMovimentService,
    FetchPublicDocumentsService,
    ConsultarProcessoQueue,
    AwsS3Service,
    PdfExtractService,
    LoginPoolService,
    ProcessDocumentsFindService,
    FetchDocumentoService,
    LambdaDocumentExtractorService,
    ScrapingService,
    BenchmarkDocumentoService,
    RedisService,
    QueueMetricsReporterService,
    ...createDynamicWorkers(),
  ],
  exports: [],
})
export class PjeModule {}
