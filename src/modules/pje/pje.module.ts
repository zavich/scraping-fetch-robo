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
import { DocumentoService } from './services/documents.service';
import { PdfExtractService } from './services/extract.service';
import { LoginPoolService } from './services/login-pool.service';
import { PjeLoginService } from './services/login.service';
import { ProcessDocumentsFindService } from './services/process-documents-find.service';
import { ScrapingService } from '../../helpers/scraping.service';
import { WebScrapingMovimentService } from './services/web-scraping-moviment.service';
import { FetchUrlMovimentService } from './services/fetch-url.service';
import { QueueModule } from 'src/connection/queue.module';

@Module({
  imports: [
    HttpModule,
    // ✅ registra filas de documentos por TRT

    // BullModule.registerQueue(
    //   // fila geral
    //   { name: 'pje-tst' },

    //   // filas de processos por TRT
    //   ...ALL_TRT_QUEUES.map((q) => ({ name: q })),

    //   // filas de documentos por TRT
    //   ...ALL_TRT_DOCUMENT_QUEUES.map((q) => ({ name: q })),
    // ),
    QueueModule,
  ],
  controllers: [PjeController],
  providers: [
    PjeLoginService,
    CaptchaService,
    WebScrapingMovimentService,
    FetchUrlMovimentService,
    DocumentoService,
    ConsultarProcessoQueue,
    AwsS3Service,
    PdfExtractService,
    // DocumentosWorker,
    LoginPoolService,
    ScrapingService,
    // ✅ queue-service ANTES dos geradores de workers
    ConsultarProcessoDocumentoQueue,
    ProcessDocumentsFindService,
    // workers de processos dinâmicos
    ...createDynamicWorkers(),

    // workers de documentos dinâmicos
    ...createDynamicDocumentsWorkers(),
  ],
  exports: [],
})
export class PjeModule {}
