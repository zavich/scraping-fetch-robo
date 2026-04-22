/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { DetalheProcesso, ProcessosResponse } from 'src/interfaces';
import { CaptchaService } from 'src/services/captcha.service';
import { FetchDocumentoService } from './fetch-documents-url.service';
import { userAgents } from 'src/utils/user-agents';

// Configura um timeout global para o axios
axios.defaults.timeout = 10000; // 10 segundos

@Injectable()
export class FetchUrlMovimentService {
  private readonly logger = new Logger(FetchUrlMovimentService.name);

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly fetchDocumentoService: FetchDocumentoService,
  ) {}
  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
  delayMs = Math.floor(Math.random() * (15000 - 5000 + 1)) + 5000;
  async execute(
    numeroDoProcesso: string,
    origem?: string,
  ): Promise<Partial<ProcessosResponse>[]> {
    const regionTRT = numeroDoProcesso?.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const instances: Partial<ProcessosResponse>[] = [];

    try {
      const balance = await this.captchaService.getBalance();
      if (balance < 0.001)
        throw new Error(`Saldo insuficiente no 2Captcha: ${balance}`);

      const grauMax = origem === 'TST' ? 3 : 2;
      const initialGrau = origem === 'TST' ? 3 : 1;
      for (let i = initialGrau; i <= grauMax; i++) {
        try {
          const tokenCaptcha = (await this.redis.get(
            `pje:token:captcha:${numeroDoProcesso}:${i}`,
          )) as string;
          const headersRedisRaw = await this.redis.get(`headers:${regionTRT}`);
          let headersRedis: Record<string, string> = {};
          if (headersRedisRaw) {
            try {
              headersRedis = JSON.parse(headersRedisRaw) as Record<
                string,
                string
              >;
            } catch (error: any) {
              this.logger.warn(
                'Falha ao fazer parse dos headers do Redis, usando objeto vazio.',
              );
              headersRedis = {};
            }
          } else {
            headersRedis = {
              'x-grau-instancia': i.toString(),
              referer: `https://pje.${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${i}`,
              accept: 'application/json, text/plain, */*',
              userAgents:
                userAgents[Math.floor(Math.random() * userAgents.length)],
            };
          }
          const awsWafTokenKey = `aws-waf-token:${numeroDoProcesso}`;
          const awsWafToken = await this.redis.get(awsWafTokenKey);
          const url = `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`;
          const headers = {
            ...headersRedis,
            referer: url,
            Cookie: `${awsWafToken || ''}`,
          };
          const { data } = await axios.get<DetalheProcesso[]>(
            `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            { headers },
          );

          const detalheProcesso = data[0];
          if (!detalheProcesso?.id) {
            continue;
          }

          let processoResponse = await this.fetchProcess(
            headers,
            numeroDoProcesso,
            detalheProcesso.id,
            i.toString(),
            tokenCaptcha,
          );

          // Caso retorne captcha
          if (
            processoResponse &&
            typeof processoResponse === 'object' &&
            'imagem' in processoResponse &&
            'tokenDesafio' in processoResponse
          ) {
            const resposta = await this.fetchCaptcha(processoResponse.imagem);
            processoResponse = await this.fetchProcess(
              headers,
              numeroDoProcesso,
              detalheProcesso.id,
              i.toString(),
              undefined,
              processoResponse.tokenDesafio,
              resposta,
            );
          }

          instances.push(processoResponse);
        } catch (err: any) {
          if (i === 1) {
            this.logger.error(
              `Erro ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err}`,
            );
            break;
          }
          this.logger.warn(
            `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err}`,
          );
          continue;
        }
      }
      // for (let i = initialGrau; i <= grauMax; i++) {
      //   try {
      //     const delayMs = 1000;
      //     this.logger.debug(
      //       `Iniciando delay de ${delayMs}ms antes de buscar instância ${i}`,
      //     );
      //     await this.delay(delayMs);

      //     this.logger.log(
      //       `Executando scraping para instância ${i}, processo: ${numeroDoProcesso}`,
      //     );
      //     const {
      //       data: processoResponse,
      //       multipleInstances,
      //       segredoJusticaDetected,
      //     } = await this.scrapingProcessService.execute(
      //       numeroDoProcesso,
      //       regionTRT,
      //       i,
      //     );

      //     if (segredoJusticaDetected) {
      //       this.logger.warn(
      //         `⚠️ Segredo de Justiça detectado para o processo ${numeroDoProcesso}`,
      //       );
      //       instances.push({
      //         numeroProcesso: numeroDoProcesso,
      //         mensagemErro: 'segredo de justiça',
      //       } as Partial<ProcessosResponse>);
      //       break;
      //     }
      //     instances.push(processoResponse);

      //     if (!multipleInstances) {
      //       this.logger.debug(`Instância única detectada, encerrando loop.`);
      //       break;
      //     }
      //   } catch (err: any) {
      //     if (i === 1) {
      //       this.logger.error(
      //         `Erro ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
      //       );
      //       this.logger.debug(
      //         `Detalhes do erro: ${JSON.stringify(err.response?.data || err)}`,
      //       );
      //       break;
      //     }
      //     this.logger.warn(
      //       `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
      //     );
      //     continue;
      //   }
      // }
      return instances;
    } catch (error: any) {
      this.logger.error(`Erro ao buscar processo ${numeroDoProcesso}`, error);
      return [];
    }
  }

  async fetchProcess(
    headers: Record<string, string>,
    numeroDoProcesso: string,
    detalheProcessoId: string,
    instance: string,
    tockenCaptcha?: string,
    tokenDesafio?: string,
    resposta?: string,
    attempt = 1,
  ): Promise<ProcessosResponse> {
    const regionTRT = numeroDoProcesso.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const typeUrl = instance === '3' ? 'tst' : `trt${regionTRT}`;
    let url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${detalheProcessoId}`;
    if (tockenCaptcha) url += `?tokenCaptcha=${tockenCaptcha}`;
    else if (tokenDesafio && resposta)
      url += `?tokenDesafio=${tokenDesafio}&resposta=${resposta}`;

    try {
      const response = await axios.get<ProcessosResponse>(url, {
        headers,
      });
      const captchaToken = response.headers['captchatoken'] as string;
      this.logger.debug(
        `Token CAPTCHA recebido para ${numeroDoProcesso} (instância ${instance}): ${captchaToken}`,
      );
      const catchaTokenRedisKey = `tokencaptcha:${numeroDoProcesso}:${instance}`;
      await this.redis.set(
        catchaTokenRedisKey,
        captchaToken,
        'EX',
        60 * 60 * 24, // expira em 24 horas
      );
      return response.data;
    } catch (error: any) {
      const isTRT15 = regionTRT === 15;
      const retryStatus = [429, 403];
      const maxAttempts = isTRT15 ? 7 : 5;

      if (
        retryStatus.includes(error.response?.status) &&
        attempt < maxAttempts
      ) {
        // REFRESH token CAPTCHA a cada tentativa TRT15
        const newTokenCaptcha =
          isTRT15 && attempt > 1 ? undefined : tockenCaptcha;

        return this.fetchProcess(
          headers,
          numeroDoProcesso,
          detalheProcessoId,
          instance,
          newTokenCaptcha,
          tokenDesafio,
          resposta,
          attempt + 1,
        );
      }

      throw error;
    }
  }

  async fetchCaptcha(imagem: string): Promise<string> {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const captcha = await this.captchaService.resolveCaptcha(imagem);

        if (captcha?.resposta) {
          return captcha.resposta;
        }

        this.logger.warn(
          `Captcha vazio ou inválido na tentativa ${attempt}/${MAX_RETRIES}`,
        );
      } catch (error: any) {
        // Erro clássico do DNS do Railway
        if (error.code === 'ENOTFOUND') {
          this.logger.warn(
            `⚠️ DNS falhou ao resolver 2captcha.com (ENOTFOUND) — tentativa ${attempt}/${MAX_RETRIES}`,
          );
        } else {
          this.logger.error(
            `Erro ao buscar captcha (tentativa ${attempt}/${MAX_RETRIES}):`,
            error.message,
          );
          throw error;
        }

        // Última tentativa → retorna vazio
        if (attempt === MAX_RETRIES) {
          return '';
        }

        // Pequeno delay entre os retries
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    // fallback final
    return '';
  }
  async fetchDocuments(
    processNumber: string,
    instances: ProcessosResponse[],
    regionTRT: number,
  ) {
    try {
      const movimentsInstances = instances.map((inst, index) => {
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
          instance: (index + 1).toString(),
          ultimaMovimentacao,
        };
      });
      const ultimaInstancia = movimentsInstances.reduce(
        (maisRecente, atual) => {
          if (!maisRecente) return atual;
          if (!atual) return maisRecente;

          const dataMaisRecente = new Date(maisRecente.ultimaMovimentacao.data);
          const dataAtual = new Date(atual.ultimaMovimentacao.data);

          // se a data atual for mais recente, retorna ela
          if (dataAtual > dataMaisRecente) return atual;

          // se for igual ou menor, mantém a maisRecente
          return maisRecente;
        },
        null,
      );
      this.logger.debug(
        `⏱ Delay de ${this.delayMs}ms antes de buscar documento da ${ultimaInstancia?.instance}ª instância`,
      );
      if (!ultimaInstancia) {
        this.logger.warn(
          `⚠️ Nenhuma movimentação encontrada para ${processNumber}`,
        );
        return;
      }

      await this.delay(this.delayMs);
      const filePath = await this.fetchDocumentoService.execute(
        ultimaInstancia.id,
        regionTRT,
        ultimaInstancia.instance,
        processNumber,
      );
      if (!filePath) {
        throw new Error('filePath não gerado');
      }
      return filePath;
    } catch (error) {
      this.logger.error(
        `Erro ao buscar documentos para ${processNumber}:`,
        error,
      );
    }
  }
}
