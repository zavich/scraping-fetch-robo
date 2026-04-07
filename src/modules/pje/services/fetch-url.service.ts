/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { DetalheProcesso, ProcessosResponse } from 'src/interfaces';
import { CaptchaService } from 'src/services/captcha.service';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class FetchUrlMovimentService {
  private readonly logger = new Logger(FetchUrlMovimentService.name);

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // Delay aleatório maior para TRT15 (10-15s)
  private getRandomDelay() {
    return Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
  }

  private async buildHeaders(
    numeroDoProcesso: string,
    instance: string,
    regionTRT: number,
    userAgent?: string,
  ) {
    const redisKey = `aws-waf-token:${numeroDoProcesso}`;
    const aws =
      (await this.redis.get(redisKey)) ||
      'ASSINADOR_PJE=PJEOFFICE; MO=PJEOFFICE; aws-waf-token=f3047ae1-0ffb-4401-9ce8-58baa0ddad6f:EAoAjWRzM25ZAAAA:8SZGMzM84zRUNgX5RmW/cv9CrrZFGiTBDP8nOjCGT7csBoOw82mMrNel5LuGFUtbwUq5iFgNsFDpCdigTNsLkZwNVF+Gqtv6yWPrHb9DJBsGFT0iegUMJ2EDn94FWvTOz7wO5tjNDh9iLF5e7HP7+AnO/JzHxBsCnTRexnE4vMUCDXYE/VDZTdFVoPG/r32txYE=';

    return {
      accept: 'application/json, text/plain, */*',
      'content-type': 'application/json',
      'x-grau-instancia': instance,
      cookie: `${aws}`,
      origin: `https://pje.trt${regionTRT}.jus.br`,
      referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
      'user-agent':
        userAgent ||
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-ch-ua':
        '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    };
  }

  async execute(
    numeroDoProcesso: string,
    origem?: string,
  ): Promise<ProcessosResponse[]> {
    const regionTRT = numeroDoProcesso?.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const instances: ProcessosResponse[] = [];

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

          // const headers = this.buildHeaders(
          //   numeroDoProcesso,
          //   i.toString(),
          //   regionTRT,
          // );
          const headers = await this.redis.get('headers');
          if (!headers) {
            throw new Error('Headers not found in Redis');
          }
          const parsedHeaders = JSON.parse(headers) as Record<string, string>;
          const headersParams = {
            ...parsedHeaders,
            'x-grau-instancia': i.toString(),
          };

          const { data } = await axios.get<DetalheProcesso[]>(
            `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            { headers: headersParams },
          );

          const detalheProcesso = data[0];
          if (!detalheProcesso) continue;

          // Delay aleatório para evitar bloqueios
          const delayMs = this.getRandomDelay();
          this.logger.debug(
            `⏱ Delay de ${delayMs}ms antes de buscar a ${i}ª instância`,
          );
          await this.delay(delayMs);

          let processoResponse = await this.fetchProcess(
            numeroDoProcesso,
            detalheProcesso.id,
            i.toString(),
            tokenCaptcha,
          );

          // Caso retorne captcha
          if (
            'imagem' in processoResponse &&
            'tokenDesafio' in processoResponse
          ) {
            const resposta = await this.fetchCaptcha(processoResponse.imagem);
            processoResponse = await this.fetchProcess(
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
          this.logger.error(
            `Erro ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.data?.message || err.message}`,
          );

          if (i === 1) {
            this.logger.error(
              `Erro ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
            );
            break;
          }
          this.logger.warn(
            `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
          );
          continue;
        }
      }

      return instances;
    } catch (error: any) {
      this.logger.error(`Erro ao buscar processo ${numeroDoProcesso}`, error);
      return [];
    }
  }

  async fetchProcess(
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
      // TROCAR USER-AGENT a cada tentativa TRT15
      const userAgent =
        regionTRT === 15
          ? userAgents[Math.floor(Math.random() * userAgents.length)]
          : undefined;
      const headers = await this.redis.get('headers');
      if (!headers) {
        throw new Error('Headers not found in Redis');
      }
      const parsedHeaders = JSON.parse(headers) as Record<string, string>;
      const headersParams = {
        ...parsedHeaders,
        'x-grau-instancia': instance,
      };
      const response = await axios.get<ProcessosResponse>(url, {
        headers: headersParams,
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
        // Delay maior e randomizado para TRT15
        const baseDelay = isTRT15 ? 10000 : 1000;
        const delay =
          Math.pow(2, attempt) * baseDelay + Math.floor(Math.random() * 3000);
        this.logger.warn(
          `Rate limit ou bloqueio detectado (tentativa ${attempt}) ${
            isTRT15 ? '[TRT15]' : ''
          }, aguardando ${Math.round(delay / 1000)}s antes de tentar novamente...`,
        );
        await this.delay(delay);

        // REFRESH token CAPTCHA a cada tentativa TRT15
        const newTokenCaptcha =
          isTRT15 && attempt > 1 ? undefined : tockenCaptcha;

        return this.fetchProcess(
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
}
