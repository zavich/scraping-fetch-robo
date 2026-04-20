import { HttpModule } from '@nestjs/axios';

import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';
import {
  ALL_TRT_DOCUMENT_QUEUES,
  ALL_TRT_QUEUES,
} from 'src/helpers/getTRTQueue';
import { createDynamicDocumentsWorkers } from 'src/providers/dynamic-document-workers.provider';
import { createDynamicWorkers } from 'src/providers/dynamic-workers.provider';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { CaptchaService } from 'src/services/captcha.service';
import { PjeController } from './pje.controller';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';
import { ConsultarProcessoDocumentoQueue } from './queues/service/consultar-processo-documento';
import { PdfExtractService } from './services/extract.service';
import { LoginPoolService } from './services/login-pool.service';
import { PjeLoginService } from './services/login.service';
import { ProcessDocumentsFindService } from './services/process-documents-find.service';
import { FetchUrlMovimentService } from './services/fetch-url.service';
import { FetchDocumentoService } from './services/fetch-documents-url.service';
import { ScrapingProcessService } from './services/scraping-process.service';
import { ScrapingService } from 'src/helpers/scraping.service';

@Module({
  imports: [
    HttpModule,
    // ✅ registra filas de documentos por TRT

    BullModule.registerQueue(
      // fila geral
      { name: 'pje-tst' },

      // filas de processos por TRT
      ...ALL_TRT_QUEUES.map((q) => ({ name: q })),

      // filas de documentos por TRT
      ...ALL_TRT_DOCUMENT_QUEUES.map((q) => ({ name: q })),
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
    ScrapingProcessService,
    ScrapingService,
    ...createDynamicWorkers(),
    ...createDynamicDocumentsWorkers(),
  ],
  exports: [],
})
export class PjeModule {}
