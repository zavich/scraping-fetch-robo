// src/modules/pje/services/process-find.service.ts

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Documento, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { regexDocumentos } from 'src/utils/regex-documents';
import { PdfExtractService } from './extract.service';
import pLimit from 'p-limit';
@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);
  constructor(
    private readonly awsS3Service: AwsS3Service,
    private readonly pdfExtractService: PdfExtractService,
  ) {}

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
    pdfBase64: string,
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
    } catch (error) {
      this.logger.error(
        `Error uploading restricted documents: ${error.message}`,
      );
      throw new BadGatewayException(
        `Error uploading restricted documents: ${error.message}`,
      );
    }
  }

  async uploadDocumentosRestritos(
    processNumber: string,
    pdfBase64: string,
  ): Promise<Documento[]> {
    this.logger.debug(`🔒 Iniciando upload de documentos restritos...`);
    const uploadedDocuments: Documento[] = [];
    const processedDocumentIds = new Set<string>();
    try {
      const fileBuffer = Buffer.from(pdfBase64, 'base64');

      // tenta extrair bookmarks e processar
      try {
        interface Bookmark {
          id: string;
          index: number;
          title: string;
          data?: string;
        }

        const bookmarks: Bookmark[] =
          await this.pdfExtractService.extractBookmarks(fileBuffer);

        if (!bookmarks || bookmarks.length === 0) {
          this.logger.warn(
            `⚠️ Nenhum bookmark encontrado no arquivo. Verifique o conteúdo do PDF.`,
          );
          return uploadedDocuments;
        }

        const bookmarksFiltrados = bookmarks.filter((b: Bookmark) =>
          regexDocumentos.some((r) => r.test(normalizeString(b.title))),
        );

        if (bookmarksFiltrados.length === 0) {
          this.logger.warn(
            `⚠️ Nenhum bookmark relevante encontrado no arquivo`,
          );
          return uploadedDocuments;
        }

        const processarBookmark = async (bookmark: Bookmark) => {
          const extractedPdfBuffer =
            await this.pdfExtractService.extractPagesByIndex(
              fileBuffer,
              bookmark.id,
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

        const limit = pLimit(4); // 4 simultâneos

        const tasks: Promise<void>[] = [];

        for (const bookmark of bookmarksFiltrados) {
          if (processedDocumentIds.has(bookmark.id)) continue;

          const index = bookmarks.findIndex((b) => b.id === bookmark.id);

          tasks.push(
            limit(async () => {
              await processarBookmark(bookmark);
            }),
          );

          const proximo = bookmarks[index + 1];

          if (proximo && !processedDocumentIds.has(proximo.id)) {
            this.logger.debug(
              `📎 Pegando também o documento seguinte a "${bookmark.title}": "${proximo.title}"`,
            );

            tasks.push(
              limit(async () => {
                await processarBookmark(proximo);
              }),
            );
          }
        }

        await Promise.all(tasks);
      } catch (pdfError: any) {
        this.logger.error(
          `❌ Erro ao processar PDF da instância: ${(pdfError as Error).message}`,
        );
        throw new BadGatewayException(
          `Erro ao processar PDF da instância: ${(pdfError as Error).message}`,
        );
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Erro desconhecido';
      this.logger.error(
        `❌ Erro ao baixar PDF do processo ${processNumber}: ${errorMessage}`,
      );
      throw new BadGatewayException(
        `Não foi possível baixar documentos restritos para o processo ${processNumber}: ${errorMessage}`,
      );
    }

    return uploadedDocuments;
  }
}
