// src/modules/pje/services/process-find.service.ts

import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import Redis from 'ioredis';
import { Documento, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { DocumentoService } from './documents.service';
import { PdfExtractService } from './extract.service';

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
  ) {}
  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
  delayMs = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
  ): Promise<ProcessosResponse[]> {
    const regionTRT = Number(numeroDoProcesso.split('.')[3]);
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
        regionTRT,
        instancesWithGrau,
        numeroDoProcesso,
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
    regionTRT: number,
    instances: ProcessosResponse[],
    processNumber: string,
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
      /\bdespachos?\b/i,
      /.*intimacoes.*/i,
      /.*prevencao.*/i,

      // CTPS / TRCT
      /.*carteira.*trabalho.*/i,
      /.*trct.*/i,

      // Demonstrativos de Pagamento
      /.*holerite.*/i,
      /.*contracheque.*/i,
      /.*ficha.*financeira.*/i,
      /.*recibo.*salario.*/i,

      // Ficha Registro
      /.*ficha.*registro.*/i,

      // Contrato de Trabalho
      /.*contrato.*trabalho.*/i,

      // Cartão de Ponto / Frequência
      /.*demonstrativo.*frequencia.*/i,
      /.*relatorio.*ponto.*/i,
      /.*relatorio.*frequencia.*/i,

      // Acórdão de Embargos
      /.*acordao.*embargos.*/i,

      // Acórdão TST
      /.*acordao.*tst.*/i,

      // Decisão Monocrática mais específica
      /.*decisao.*individual.*/i,
      /.*decisao.*relator.*/i,

      // 🧮 Documentos de Cálculo
      /.*planilha(?:s)?.*c[aá]lculo(?:s)?.*/i,
      /.*c[aá]lculo(?:s)?.*apresenta[cç][aã]o(?:ões)?.*/i,
      /.*apresenta[cç][aã]o(?:ões)?.*c[aá]lculo(?:s)?.*/i,
      /.*relat[oó]rio(?:s)?.*c[aá]lculo(?:s)?.*/i,

      // Apenas "cálculo(s)"
      /\bc[aá]lculo(?:s)?\b/i,
    ];

    const buffersPorInstancia: Record<string, Buffer> = {};

    const movimentsInstances = instances.map((inst) => {
      // garante que há movimentações
      if (!inst.itensProcesso?.length) return null;

      // encontra a movimentação mais recente
      const ultimaMovimentacao = inst.itensProcesso.reduce(
        (maisRecente, atual) => {
          const dataMaisRecente = new Date(maisRecente.data);
          const dataAtual = new Date(atual.data);
          return dataAtual > dataMaisRecente ? atual : maisRecente;
        },
      );

      return {
        id: inst.id,
        instance: inst.instance,
        ultimaMovimentacao,
      };
    });
    const ultimaInstancia = movimentsInstances.reduce((maisRecente, atual) => {
      if (!maisRecente) return atual;
      if (!atual) return maisRecente;

      const dataMaisRecente = new Date(maisRecente.ultimaMovimentacao.data);
      const dataAtual = new Date(atual.ultimaMovimentacao.data);

      // se a data atual for mais recente, retorna ela
      if (dataAtual > dataMaisRecente) return atual;

      // se for igual ou menor, mantém a maisRecente
      return maisRecente;
    }, null);
    //caso haja mais de uma instancia com a mesma data de moviemntação, pegar a primeira instancia
    try {
      this.logger.debug(
        `⏱ Delay de ${this.delayMs}ms antes de buscar documento da ${ultimaInstancia?.instance}ª instância`,
      );
      await this.delay(this.delayMs);

      const filePath = await this.documentoService.execute(
        processNumber,
        regionTRT,
        Number(ultimaInstancia?.instance),
      );

      const fileBuffer = fs.readFileSync(filePath);
      buffersPorInstancia[ultimaInstancia?.id as number] = fileBuffer;

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
        // Captura erros específicos do pdfjs-dist
        const msg =
          pdfError?.message || pdfError?.toString() || 'Erro desconhecido';
        if (msg.includes('PasswordException') || msg.includes('Encryption')) {
          this.logger.error(
            `🔐 PDF protegido por senha na instância ${ultimaInstancia?.instance}`,
          );
        } else {
          this.logger.error(
            `❌ Erro ao processar PDF da instância ${ultimaInstancia?.instance}: ${pdfError}`,
          );
        }
        // continue; // ignora esse PDF e vai pro próximo
      }
    } catch (error) {
      this.logger.error(
        `❌ Erro ao baixar PDF do processo ${processNumber} (instância ${ultimaInstancia?.instance}): ${error.message}`,
      );
      throw new BadGatewayException(
        `Não foi possível baixar documentos restritos para o processo ${processNumber}`,
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
