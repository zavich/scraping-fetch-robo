import { HttpModule } from '@nestjs/axios';

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import {
  ALL_TRT_DOCUMENT_QUEUES,
  ALL_TRT_QUEUES,
} from 'src/helpers/getTRTQueue';
import { ScrapingService } from 'src/helpers/scraping.service';
import { createDynamicDocumentsWorkers } from 'src/providers/dynamic-document-workers.provider';
import { createDynamicWorkers } from 'src/providers/dynamic-workers.provider';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { CaptchaService } from 'src/services/captcha.service';
import { PjeController } from './pje.controller';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';
import { ConsultarProcessoDocumentoQueue } from './queues/service/consultar-processo-documento';
import { PdfExtractService } from './services/extract.service';
import { FetchDocumentoService } from './services/fetch-documents-url.service';
import { FetchUrlMovimentService } from './services/fetch-url.service';
import { LoginPoolService } from './services/login-pool.service';
import { PjeLoginService } from './services/login.service';
import { ProcessDocumentsFindService } from './services/process-documents-find.service';
import { RedisService } from 'src/services/redis.service';

const defaultQueueOptions = {
  attempts: 3,
  backoff: { type: 'fixed' as const, delay: 5000 },
  removeOnComplete: { count: 1000 },
  removeOnFail: { count: 500, age: 7 * 24 * 3600 },
};

@Module({
  imports: [
    HttpModule,
    // ✅ registra filas de documentos por TRT

    BullModule.registerQueue(
      // fila geral
      { name: 'pje-tst', defaultJobOptions: defaultQueueOptions },

      // filas de processos por TRT
      ...ALL_TRT_QUEUES.map((q) => ({
        name: q,
        defaultJobOptions: defaultQueueOptions,
      })),

      // filas de documentos por TRT
      ...ALL_TRT_DOCUMENT_QUEUES.map((q) => ({
        name: q,
        defaultJobOptions: defaultQueueOptions,
      })),
    ),
  ],
  controllers: [PjeController],
  providers: [
    PjeLoginService,
    CaptchaService,
    FetchUrlMovimentService,
    ConsultarProcessoQueue,
    AwsS3Service,
    PdfExtractService,
    LoginPoolService,
    ConsultarProcessoDocumentoQueue,
    ProcessDocumentsFindService,
    FetchDocumentoService,
    ScrapingService,
    RedisService,
    ...createDynamicWorkers(),
    ...createDynamicDocumentsWorkers(),
  ],
  exports: [],
})
export class PjeModule {}
