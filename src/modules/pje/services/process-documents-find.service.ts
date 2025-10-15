// src/modules/pje/services/process-find.service.ts

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import Redis from 'ioredis';
import { Documento, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { DocumentoService } from './documents.service';
import { PdfExtractService } from './extract.service';
import { ProcessFindService } from './process-find.service';
@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });
  constructor(
    private readonly documentoService: DocumentoService,
    private readonly awsS3Service: AwsS3Service,
    private readonly pdfExtractService: PdfExtractService,
    private readonly processFindService: ProcessFindService,
  ) {}
  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
  delayMs = Math.floor(Math.random() * (5000 - 1000 + 1)) + 5000; // 5 a 10s

  async execute(
    numeroDoProcesso: string,
    cookies: string,
  ): Promise<ProcessosResponse[]> {
    const regionTRT = Number(numeroDoProcesso.split('.')[3]);
    try {
      const instances = (
        await this.processFindService.execute(numeroDoProcesso)
      ).map((instance, i) => {
        const instanceNumber = i + 1;
        return {
          ...instance,
          grau: instanceNumber === 1 ? 'PRIMEIRO_GRAU' : 'SEGUNDO_GRAU',
          instance: instanceNumber.toString(),
        };
      });
      if (!instances || instances.length === 0) return [];
      const documentosRestritos = await this.uploadDocumentosRestritos(
        regionTRT,
        instances,
        numeroDoProcesso,
        cookies,
      );

      const newInstances = instances.map((instance) => ({
        ...instance,
        documentos: documentosRestritos,
      }));
      return newInstances;
    } catch (error) {
      this.logger.error(
        `Error uploading restricted documents: ${error.message}`,
      );
      return [];
    }
  }

  async uploadDocumentosRestritos(
    regionTRT: number,
    instances: ProcessosResponse[],
    processNumber: string,
    cookies: string,
  ): Promise<Documento[]> {
    this.logger.debug(`🔒 Iniciando upload de documentos restritos...`);

    const uploadedDocuments: Documento[] = [];
    const processedDocumentIds = new Set<string>();

    const regexDocumentos = [
      /.*peticao.*inicial.*/i,
      /.*sentenca.*/i,
      /.*embargos.*de.*declaracao.*/i,
      /.*recurso.*ordinario.*/i,
      /.*acordao.*/i,
      /.*recurso.*de.*revista.*/i,
      /.*decisao.*de.*admissibilidade.*/i,
      /.*agravo.*de.*instrumento.*/i,
      /.*decisao.*/i,
      /.*agravo.*interno.*/i,
      /.*recurso.*extraordinario.*/i,
      /.*planilha.*de.*calculo.*/i,
      /.*embargos.*a.*execucao.*/i,
      /.*agravo.*de.*peticao.*/i,
      /.*procuracao.*/i,
      /.*habilitacao.*/i,
      /.*substabelecimento.*/i,
      /.*manifestacao.*/i,
      /.*ccb.*/i,
      /.*cessao.*/i,
      /.*alvara.*/i,
      /.*transito.*em.*julgado.*/i,
      /.*peticionamentos.*avulsos.*/i,
      /.*decisoes.*/i,
      /.*despachos.*/i,
      /.*intimacoes.*/i,
      /.*prevencao.*/i,
    ];

    const buffersPorInstancia: Record<string, Buffer> = {};
    const lastInstance = instances[instances.length - 1];

    try {
      this.logger.debug(
        `⏱ Delay de ${this.delayMs}ms antes de buscar documento da ${lastInstance.instance}ª instância`,
      );
      await this.delay(this.delayMs);

      const filePath = await this.documentoService.execute(
        lastInstance.id,
        regionTRT,
        lastInstance.instance,
        cookies,
        processNumber,
      );

      const fileBuffer = fs.readFileSync(filePath);
      buffersPorInstancia[lastInstance.id] = fileBuffer;

      // remove o arquivo temporário
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
        const bookmarks =
          await this.pdfExtractService.extractBookmarks(fileBuffer);

        const bookmarksFiltrados = bookmarks.filter((b) =>
          regexDocumentos.some((r) => r.test(normalizeString(b.title))),
        );

        for (const bookmark of bookmarksFiltrados) {
          if (processedDocumentIds.has(bookmark.id)) continue;

          const extractedPdfBuffer =
            await this.pdfExtractService.extractPagesByIndex(
              fileBuffer,
              bookmark.id,
            );

          if (!extractedPdfBuffer) {
            this.logger.warn(
              `⚠️ Não foi possível extrair o buffer PDF para o bookmark "${bookmark.title}" (id: ${bookmark.id})`,
            );
            continue;
          }

          const fileName = `${bookmark.title.replace(/\s+/g, '_')}_${bookmark.index}_${Date.now()}_${Math.random()
            .toString(36)
            .slice(2, 8)}.pdf`;

          const url = await this.awsS3Service.uploadPdf(
            extractedPdfBuffer,
            fileName,
          );

          uploadedDocuments.push({
            title: bookmark.title,
            temp_link: url,
            uniqueName: bookmark.id,
            date: bookmark.data,
          });

          processedDocumentIds.add(bookmark.id);
        }
      } catch (pdfError: any) {
        // Captura erros específicos do pdfjs-dist
        const msg =
          pdfError?.message || pdfError?.toString() || 'Erro desconhecido';
        if (msg.includes('PasswordException') || msg.includes('Encryption')) {
          this.logger.error(
            `🔐 PDF protegido por senha na instância ${lastInstance.instance}`,
          );
        } else {
          this.logger.error(
            `❌ Erro ao processar PDF da instância ${lastInstance.instance}: ${msg}`,
          );
        }
        // continue; // ignora esse PDF e vai pro próximo
      }
    } catch (err) {
      this.logger.error(
        `❌ Erro inesperado ao processar documentos da instância ${lastInstance.instance} no processo ${processNumber}: ${err.message}`,
      );
      throw new BadGatewayException(
        'Erro ao processar documentos restritos, tente novamente mais tarde',
      );
    }
    const captchaKey = `pje:token:captcha:${processNumber}`;
    const keys = await this.redis.keys(`${captchaKey}*`);

    if (keys.length) {
      const deleted = await this.redis.del(...keys);
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
}
