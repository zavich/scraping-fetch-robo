// src/modules/pje/services/process-find.service.ts

import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import * as fs from 'fs';
import { DetalheProcesso, Documento, ProcessosResponse } from 'src/interfaces';
import { Root } from 'src/interfaces/normalize';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { normalizeString } from 'src/utils/normalize-string';
import { normalizeResponse } from 'src/utils/normalizeResponse';
import { userAgents } from 'src/utils/user-agents';
import { DocumentoService } from './documents.service';
import { PdfExtractService } from './extract.service';
import { PjeLoginService } from './login.service';
import { CaptchaService } from 'src/services/captcha.service';
import Redis from 'ioredis';
@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });
  constructor(
    private readonly loginService: PjeLoginService,
    private readonly captchaService: CaptchaService,
    private readonly documentoService: DocumentoService,
    private readonly awsS3Service: AwsS3Service,
    private readonly pdfExtractService: PdfExtractService,
  ) {}
  // 🔹 Contas disponíveis
  private contas = [
    {
      username: process.env.PJE_USER_FIRST as string,
      password: process.env.PJE_PASS_FIRST as string,
    },
    {
      username: process.env.PJE_USER_SECOND as string,
      password: process.env.PJE_PASS_SECOND as string,
    },
  ];

  // 🔹 Controle de alternância
  private contaIndex = 0;
  private contadorProcessos = 0;
  // Função auxiliar para delay
  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  /**
   * 🔹 Alterna conta a cada 5 processos processados
   * @param force força a troca de conta imediatamente
   */
  private getConta(force = false): { username: string; password: string } {
    if (force || this.contadorProcessos >= 5) {
      this.contaIndex = (this.contaIndex + 1) % this.contas.length;
      this.contadorProcessos = 0;
      this.logger.debug(
        `🔄 Alternando para a conta: ${this.contas[this.contaIndex].username}`,
      );
    }
    this.contadorProcessos++;
    return this.contas[this.contaIndex];
  }
  delayMs = Math.floor(Math.random() * (5000 - 1000 + 1)) + 5000; // 5 a 10s

  async execute(numeroDoProcesso: string, tentativas = 0): Promise<Root> {
    const regionTRT = Number(numeroDoProcesso.split('.')[3]);
    const { username, password } = this.getConta();
    console.log({ regionTRT, username, password });
    try {
      const tokenCaptcha = await this.redis.get('pje:token:captcha');
      // 🔹 Escolhe a conta atual

      let cookies = await this.redis.get(
        `pje:session:${regionTRT}:${username}`,
      );
      if (!cookies) {
        this.logger.debug(
          `Nenhum cookie em cache para ${username}, realizando login...`,
        );
        const loginResult = await this.loginService.execute(
          regionTRT,
          username,
          password,
        );
        cookies = loginResult.cookies;
      }

      await axios.get(
        `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
        {
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-grau-instancia': '1',
            referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/1`,
            'user-agent':
              userAgents[Math.floor(Math.random() * userAgents.length)],
            cookie: cookies,
          },
        },
      );

      const instances: ProcessosResponse[] = [];
      for (let i = 1; i <= 3; i++) {
        try {
          // Delay antes da requisição de dados básicos
          this.logger.debug(
            `⏱ Delay de ${this.delayMs}ms antes de dar inicio a ${i}ª instância`,
          );
          await this.delay(this.delayMs);
          const typeUrl = i === 3 ? 'tst' : `trt${regionTRT}`; // --- IGNORE ---

          const responseDadosBasicos = await axios.get<DetalheProcesso[]>(
            `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            {
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-grau-instancia': i.toString(),
                referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${i}`,
                'user-agent':
                  userAgents[Math.floor(Math.random() * userAgents.length)],
                cookie: cookies,
              },
            },
          );

          const detalheProcesso = responseDadosBasicos.data[0];
          if (!detalheProcesso) continue;

          this.logger.debug(
            `⏱ Delay de ${this.delayMs}ms antes de processar a ${i}ª instância`,
          );
          await this.delay(this.delayMs);
          let processoResponse: ProcessosResponse = await this.fetchProcess(
            numeroDoProcesso,
            detalheProcesso.id,
            i.toString(),
            tokenCaptcha as string,
            undefined,
            undefined,
            cookies,
          );

          if (
            'imagem' in processoResponse &&
            'tokenDesafio' in processoResponse
          ) {
            const resposta = await this.fetchCaptcha(
              processoResponse.imagem,
              processoResponse.tokenDesafio,
            );
            processoResponse = await this.fetchProcess(
              numeroDoProcesso,
              detalheProcesso.id,
              i.toString(),
              undefined,
              processoResponse.tokenDesafio,
              resposta,
              cookies,
            );
          }

          instances.push({
            ...processoResponse,
            grau: i === 1 ? 'PRIMEIRO_GRAU' : 'SEGUNDO_GRAU',
            instance: i.toString(),
          });
        } catch (err) {
          this.logger.warn(
            `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
          );
          continue;
        }
      }

      const documentosRestritos = await this.uploadDocumentosRestritos(
        regionTRT,
        cookies,
        instances,
        numeroDoProcesso,
      );
      const newInstances = instances.map((instance) => {
        return {
          ...instance,
          documentos: documentosRestritos,
        };
      });

      return normalizeResponse(numeroDoProcesso, newInstances, '', true);
    } catch (error) {
      console.log(error);

      if (error.response?.data?.codigoErro === 'ARQ-028') {
        this.logger.warn(
          `Erro ARQ-028 com ${username}, tentando novamente mesma conta...`,
        );
        this.logger.warn(
          `Erro ARQ-028 com ${username}, tentando novamente mesma conta...`,
        );

        if (tentativas >= 1) {
          return normalizeResponse(
            numeroDoProcesso,
            [],
            'ANÁLISE - FALHA AO TENTAR ACESSAR INFORMAÇÕES, TENTE NOVAMENTE MAIS TARDE',
          );
        }

        // 🔹 Tenta executar novamente usando o cookie existente
        return await this.execute(numeroDoProcesso, tentativas + 1);
      }

      // 🔹 Para outros erros → troca de conta
      if (tentativas < this.contas.length) {
        this.logger.warn(
          `⚠️ Erro com a conta ${username}, tentando próxima conta...`,
        );

        // força troca de conta
        const { username: newUser, password: newPass } = this.getConta(true);
        if (username === newUser) {
          // se só tiver uma conta configurada, não entra em loop infinito
          return normalizeResponse(
            numeroDoProcesso,
            [],
            'ANÁLISE - FALHA AO TENTAR ACESSAR INFORMAÇÕES, TENTE NOVAMENTE MAIS TARDE',
          );
        }
        await this.loginService.execute(regionTRT, newUser, newPass);
        return await this.execute(numeroDoProcesso, tentativas + 1);
      }

      // 🔹 Se já tentou todas as contas, falha de vez
      return normalizeResponse(
        numeroDoProcesso,
        [],
        'ANÁLISE - FALHA AO TENTAR ACESSAR INFORMAÇÕES, TENTE NOVAMENTE MAIS TARDE',
      );
    }
  }

  async fetchProcess(
    numeroDoProcesso: string,
    detalheProcessoId: string,
    instance: string,
    tockenCaptcha?: string,
    tokenDesafio?: string,
    resposta?: string,
    cookies?: string,
    tentativas = 0,
  ): Promise<ProcessosResponse> {
    const regionTRT = Number(numeroDoProcesso.split('.')[3]);
    const typeUrl = instance === '3' ? 'tst' : `trt${regionTRT}`; // --- IGNORE ---
    try {
      let url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${detalheProcessoId}`;
      if (tockenCaptcha) {
        url += `?tokenCaptcha=${tockenCaptcha}`;
      } else if (tokenDesafio && resposta) {
        url += `?tokenDesafio=${tokenDesafio}&resposta=${resposta}`;
      }

      const response = await axios.get<ProcessosResponse>(url, {
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-grau-instancia': instance,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
          cookie: cookies,
        },
      });

      const tokenCaptcha: string = response.headers['captchatoken'] as string;
      if (tokenCaptcha) {
        const captchaKey = `pje:token:captcha:${instance}`;

        await this.redis.set(captchaKey, tokenCaptcha);
      }
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 429 && tentativas < 5) {
        // 🔹 Retry exponencial: 1s, 2s, 4s, 8s, 16s
        const waitTime = Math.pow(2, tentativas) * 1000;
        console.warn(
          `429 recebido, esperando ${waitTime}ms antes de tentar novamente...`,
        );
        await new Promise((res) => setTimeout(res, waitTime));
        return await this.fetchProcess(
          numeroDoProcesso,
          detalheProcessoId,
          instance,
          tockenCaptcha,
          tokenDesafio,
          resposta,
          cookies,
          tentativas + 1,
        );
      }
      console.error('Erro fetching process:', error.message);
      throw error;
    }
  }

  async fetchCaptcha(imagem: string, tokenDesafio: string): Promise<string> {
    try {
      const redisCaptchaKey = `pje:captcha`;

      const captcha = await this.captchaService.resolveCaptcha(imagem);
      const captchaDetalheProcesso = {
        resposta: captcha.resposta,
        tokenDesafio: tokenDesafio,
      };
      // Salva no Redis por 5 minutos
      await this.redis.set(
        redisCaptchaKey,
        JSON.stringify(captchaDetalheProcesso),
      );
      return captcha.resposta;
    } catch (error) {
      console.error('Erro ao buscar captcha:', error.message);
      return '';
    }
  }
  async uploadDocumentosRestritos(
    regionTRT: number,
    cookies: string,
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
      /.*despachos.*/i,
      /.*intimacoes.*/i,
      /.*prevencao.*/i,
    ];

    const buffersPorInstancia: Record<string, Buffer> = {};

    for (const instance of instances) {
      try {
        this.logger.debug(
          `⏱ Delay de ${this.delayMs}ms antes de buscar documento da ${instance.instance}ª instância`,
        );
        await this.delay(this.delayMs);

        const filePath = await this.documentoService.execute(
          instance.id,
          regionTRT,
          instance.instance,
          cookies,
          processNumber,
        );

        const fileBuffer = fs.readFileSync(filePath);
        buffersPorInstancia[instance.id] = fileBuffer;

        // remove o arquivo temporário
        try {
          fs.unlinkSync(filePath);
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
              `🔐 PDF protegido por senha na instância ${instance.instance}`,
            );
          } else {
            this.logger.error(
              `❌ Erro ao processar PDF da instância ${instance.instance}: ${msg}`,
            );
          }
          continue; // ignora esse PDF e vai pro próximo
        }
      } catch (err) {
        this.logger.error(
          `❌ Erro inesperado ao processar documentos da instância ${instance.instance}: ${err.message}`,
        );
      }
    }

    return uploadedDocuments;
  }
}
