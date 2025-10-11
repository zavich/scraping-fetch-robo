import { HttpModule } from '@nestjs/axios';

import { Module } from '@nestjs/common';
import { PjeController } from './pje.controller';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';
import { DocumentoService } from './services/documents.service';
import { PjeLoginService } from './services/login.service';
import { ProcessDocumentsFindService } from './services/process-documents-find.service';
import { ProcessFindService } from './services/process-find.service';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { ConsultarProcessoDocumentoQueue } from './queues/service/consultar-processo-documento';
import { PdfExtractService } from './services/extract.service';
import { BullModule } from '@nestjs/bullmq';
import { ProcessosWorker } from './queues/wokers/processos.worker';
import { DocumentosWorker } from './queues/wokers/documentos.worker';
import { CaptchaService } from 'src/services/captcha.service';
import { LoginPoolService } from './services/login-pool.service';

@Module({
  imports: [
    HttpModule,
    BullModule.registerQueue({ name: 'pje-documentos' }),
    BullModule.registerQueue({ name: 'pje-processos' }),
  ],
  controllers: [PjeController],
  providers: [
    PjeLoginService,
    ProcessDocumentsFindService,
    CaptchaService,
    ProcessFindService,
    DocumentoService,
    ConsultarProcessoQueue,
    ConsultarProcessoDocumentoQueue,
    AwsS3Service,
    PdfExtractService,
    ProcessosWorker,
    DocumentosWorker,
    LoginPoolService,
  ],
  exports: [],
})
export class PjeModule {}
