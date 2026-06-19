// src/modules/pje/services/process-find.service.ts

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import { Documento, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { regexDocumentos } from 'src/utils/regex-documents';
import { BookmarkItem, PdfExtractService } from './extract.service';

@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);

  // Limita PDFs processados simultaneamente para evitar OOM.
  // Cada job usa ~150 MB de pico; com mem_limit=2g e ~400 MB de base, 8 slots = ~1.6 GB máximo.
  private static readonly MAX_CONCURRENT_PDF = parseInt(
    process.env.MAX_CONCURRENT_PDF_JOBS ?? '8',
    10,
  );
  private static activeJobs = 0;
  private static waitQueue: Array<() => void> = [];

  private acquirePdfSlot(): Promise<void> {
    if (
      ProcessDocumentsFindService.activeJobs <
      ProcessDocumentsFindService.MAX_CONCURRENT_PDF
    ) {
      ProcessDocumentsFindService.activeJobs++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      ProcessDocumentsFindService.waitQueue.push(() => {
        ProcessDocumentsFindService.activeJobs++;
        resolve();
      });
    });
  }

  private releasePdfSlot(): void {
    ProcessDocumentsFindService.activeJobs--;
    const next = ProcessDocumentsFindService.waitQueue.shift();
    if (next) next();
  }

  constructor(
    private readonly awsS3Service: AwsS3Service,
    private readonly pdfExtractService: PdfExtractService,
  ) {}

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro desconhecido';
  }

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
    pdfBase64: string | Buffer,
  ): Promise<ProcessosResponse[]> {
    try {
      const instancesWithGrau = instances.map((instance, i) => {
        const instanceNumber = i + 1;
        return {
          ...instance,
          grau: instanceNumber === 1 ? 'PRIMEIRO_GRAU' : 'SEGUNDO_GRAU',
          instance: instanceNumber.toString(),
        };
      });
      if (!instancesWithGrau || instancesWithGrau.length === 0) return [];
      const documentosRestritos = await this.uploadDocumentosRestritos(
        numeroDoProcesso,
        pdfBase64,
      );

      const newInstances = instancesWithGrau.map((instance) => ({
        ...instance,
        documentos: documentosRestritos,
      }));
      return newInstances;
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.error(
        `Error uploading restricted documents: ${errorMessage}`,
      );
      throw new BadGatewayException(
        `Error uploading restricted documents: ${errorMessage}`,
      );
    }
  }

  async uploadDocumentosRestritos(
    processNumber: string,
    pdfBase64: string | Buffer,
  ): Promise<Documento[]> {
    await this.acquirePdfSlot();
    this.logger.debug(
      `🔒 Iniciando upload de documentos restritos... (slots ativos: ${ProcessDocumentsFindService.activeJobs}/${ProcessDocumentsFindService.MAX_CONCURRENT_PDF})`,
    );
    try {
      return await this._uploadDocumentosRestritos(processNumber, pdfBase64);
    } finally {
      this.releasePdfSlot();
    }
  }

  private async _uploadDocumentosRestritos(
    processNumber: string,
    pdfBase64: string | Buffer,
  ): Promise<Documento[]> {
    this.logger.debug(`🔒 Processando documentos restritos...`);
    const uploadedDocuments: Documento[] = [];
    const processedDocumentIds = new Set<string>();
    try {
      const fileBuffer = Buffer.isBuffer(pdfBase64)
        ? pdfBase64
        : Buffer.from(pdfBase64, 'base64');

      // tenta extrair bookmarks e processar
      try {
        const { bookmarks, totalPages } =
          await this.pdfExtractService.extractBookmarks(fileBuffer);

        if (!bookmarks || bookmarks.length === 0) {
          this.logger.warn(
            `⚠️ Nenhum bookmark encontrado no arquivo. Verifique o conteúdo do PDF.`,
          );
          return uploadedDocuments;
        }

        const bookmarksFiltrados = bookmarks.filter((b) =>
          regexDocumentos.some((r) => r.test(normalizeString(b.title))),
        );

        if (bookmarksFiltrados.length === 0) {
          this.logger.warn(
            `⚠️ Nenhum bookmark relevante encontrado no arquivo`,
          );
          return uploadedDocuments;
        }

        // Carrega o PDFDocument uma única vez e compartilha entre todas as extrações
        // concorrentes — evita recarregar o PDF inteiro a cada chamada de extractPagesByIndex.
        const pdfDoc = await PDFDocument.load(fileBuffer);

        const processarBookmark = async (bookmark: BookmarkItem) => {
          const extractedPdfBuffer =
            await this.pdfExtractService.extractPagesByIndex(
              pdfDoc,
              totalPages,
              bookmark.id,
              bookmarks,
            );

          if (!extractedPdfBuffer) {
            this.logger.warn(
              `⚠️ Não foi possível extrair PDF para o bookmark "${bookmark.title}" (id: ${bookmark.id})`,
            );
            return;
          }

          const fileKey = `${normalizeString(bookmark.title)}_${bookmark.index}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}.pdf`;
          await this.awsS3Service.uploadS3Object(
            process.env.AWS_S3_BUCKET_NAME as string,
            fileKey,
            extractedPdfBuffer,
            'application/pdf',
          );
          uploadedDocuments.push({
            title: bookmark.title,
            temp_link: fileKey,
            uniqueName: bookmark.id,
            date: bookmark.data ?? '',
          });

          processedDocumentIds.add(bookmark.id);
        };

        const tasks: (() => Promise<void>)[] = [];

        for (const bookmark of bookmarksFiltrados) {
          if (processedDocumentIds.has(bookmark.id)) continue;

          const index = bookmarks.findIndex((b) => b.id === bookmark.id);

          tasks.push(async () => {
            await processarBookmark(bookmark);
          });

          const proximo = bookmarks[index + 1];

          if (proximo && !processedDocumentIds.has(proximo.id)) {
            tasks.push(async () => {
              await processarBookmark(proximo);
            });
          }
        }

        await this.runInBatches(tasks, 4);
      } catch (pdfError: unknown) {
        const errorMessage = this.getErrorMessage(pdfError);
        this.logger.error(
          `❌ Erro ao processar PDF da instância: ${errorMessage}`,
        );
        throw new BadGatewayException(
          `Erro ao processar PDF da instância: ${errorMessage}`,
        );
      }
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.error(
        `❌ Erro ao baixar PDF do processo ${processNumber}: ${errorMessage}`,
      );
      throw new BadGatewayException(
        `Não foi possível baixar documentos restritos para o processo ${processNumber}: ${errorMessage}`,
      );
    }

    return uploadedDocuments;
  }
  private async runInBatches(
    tasks: (() => Promise<void>)[],
    limit = 4,
  ): Promise<void> {
    for (let i = 0; i < tasks.length; i += limit) {
      const batch = tasks.slice(i, i + limit);
      await Promise.all(batch.map((task) => task()));
    }
  }
}
