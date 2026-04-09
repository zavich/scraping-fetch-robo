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
import { PdfExtractService } from './extract.service';
import { regexDocumentos } from 'src/utils/regex-documents';

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

      // // remove o arquivo temporário
      try {
        fs.promises
          .unlink(filePath)
          .catch((err) =>
            this.logger.warn(`Não foi possível deletar: ${err.message}`),
          );

        this.logger.debug(
          `🗑️ Arquivo temporário ${filePath} deletado com sucesso`,
        );
      } catch (err) {
        this.logger.warn(
          `⚠️ Não foi possível deletar ${filePath}: ${err.message}`,
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

        const bookmarksFiltrados = bookmarks.filter((b: Bookmark) =>
          regexDocumentos.some((r) => r.test(normalizeString(b.title))),
        );
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

          const fileKey = `${this.normalize(bookmark.title)}_${bookmark.index}_${Date.now()}_${Math.random()
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

        // ✅ Função auxiliar para evitar duplicação
      } catch (pdfError: any) {
        this.logger.error(`❌ Erro ao processar PDF da instância: ${pdfError}`);
        // continue; // ignora esse PDF e vai pro próximo
      }
    } catch (error) {
      this.logger.error(
        `❌ Erro ao baixar PDF do processo ${processNumber}: ${error.message}`,
      );
      throw new BadGatewayException(
        `Não foi possível baixar documentos restritos para o processo ${processNumber}`,
      );
    }
    const captchaKey = `pje:token:captcha:${processNumber}`;
    const keys = await this.redis.keys(`${captchaKey}*`);
    const captchaTokenRedisKey = `tokencaptcha:${processNumber}*`;
    const captchaTokenKeys = await this.redis.keys(captchaTokenRedisKey);
    if (keys.length) {
      const deleted = await this.redis.del(...keys);
      await this.redis.del(...captchaTokenKeys);
      this.logger.debug(
        `🧹 ${deleted} tokenCaptcha(s) removidos para ${processNumber}`,
      );
    } else {
      this.logger.warn(
        `⚠️ Nenhum tokenCaptcha encontrado para ${processNumber}`,
      );
    }

    return uploadedDocuments;
  }
  normalize = (str: string) =>
    str
      .normalize('NFD') // separa acentos
      .replace(/[\u0300-\u036f]/g, '') // remove acentos
      .replace(/[^\w\s-]/g, '') // remove caracteres especiais
      .trim()
      .replace(/\s+/g, '_');
}
