// src/modules/pje/services/process-find.service.ts

import {
  BadGatewayException,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import * as fs from 'fs';
import Redis from 'ioredis';
import { Documento, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { regexDocumentos } from 'src/utils/regex-documents';
import { PdfExtractService } from './extract.service';

@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);
  constructor(
    private readonly awsS3Service: AwsS3Service,
    private readonly pdfExtractService: PdfExtractService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
    filePath: string,
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
        filePath,
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
    filePath: string,
  ): Promise<Documento[]> {
    this.logger.debug(`🔒 Iniciando upload de documentos restritos...`);
    const uploadedDocuments: Documento[] = [];
    const processedDocumentIds = new Set<string>();
    try {
      if (!filePath || !fs.existsSync(filePath)) {
        throw new BadGatewayException(
          `O arquivo ${filePath} não foi encontrado.`,
        );
      }
      const fileBuffer = fs.readFileSync(filePath);

      // Validação do PDF antes de processar
      if (!fileBuffer || fileBuffer.length === 0) {
        this.logger.error(
          `❌ O arquivo ${filePath} está vazio ou corrompido. Não é possível processar.`,
        );
        throw new BadGatewayException(
          `O arquivo ${filePath} está vazio ou corrompido. Não é possível processar.`,
        );
      }

      // remove o arquivo temporário
      try {
        await fs.promises.unlink(filePath);
        this.logger.debug(
          `🗑️ Arquivo temporário ${filePath} deletado com sucesso`,
        );
      } catch (err) {
        this.logger.warn(
          `⚠️ Não foi possível deletar ${filePath}: ${(err as Error).message}`,
        );
      }

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
            `⚠️ Nenhum bookmark encontrado no arquivo ${filePath}. Verifique o conteúdo do PDF.`,
          );
          return uploadedDocuments;
        }

        const bookmarksFiltrados = bookmarks.filter((b: Bookmark) =>
          regexDocumentos.some((r) => r.test(normalizeString(b.title))),
        );

        if (bookmarksFiltrados.length === 0) {
          this.logger.warn(
            `⚠️ Nenhum bookmark relevante encontrado no arquivo ${filePath}.`,
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

        for (const bookmark of bookmarksFiltrados) {
          if (processedDocumentIds.has(bookmark.id)) continue;

          // ✅ 1. Encontrar índice real do bookmark na lista original
          const index = bookmarks.findIndex((b) => b.id === bookmark.id);

          // ✅ 2. Extrair o bookmark atual
          await processarBookmark(bookmark);

          // ✅ 3. Tentar pegar o próximo bookmark (se existir)
          const proximo = bookmarks[index + 1];
          if (proximo && !processedDocumentIds.has(proximo.id)) {
            this.logger.debug(
              `📎 Pegando também o documento seguinte a "${bookmark.title}": "${proximo.title}"`,
            );
            await processarBookmark(proximo);
          }
        }
      } catch (pdfError: any) {
        this.logger.error(
          `❌ Erro ao processar PDF da instância ${filePath}: ${(pdfError as Error).message}`,
        );
        throw new BadGatewayException(
          `Erro ao processar PDF da instância ${filePath}: ${(pdfError as Error).message}`,
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
