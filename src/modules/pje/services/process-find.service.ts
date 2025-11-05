/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { DetalheProcesso, ProcessosResponse } from 'src/interfaces';
import { CaptchaService } from 'src/services/captcha.service';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class ProcessFindService {
  private readonly logger = new Logger(ProcessFindService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

  constructor(private readonly captchaService: CaptchaService) {}

  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  // Delay aleatório maior para TRT15 (10-15s)
  private getRandomDelay(regionTRT: number) {
    if (regionTRT === 15) {
      return Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
    }
    return Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
  }

  private buildHeaders(
    numeroDoProcesso: string,
    instance: string,
    regionTRT: number,
    userAgent?: string,
  ) {
    const ua =
      userAgent || userAgents[Math.floor(Math.random() * userAgents.length)];
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'x-grau-instancia': instance,
      cookie: 'ASSINADOR_PJE=PJEOFFICE; MO=PJEOFFICE',
      origin: `https://pje.trt${regionTRT}.jus.br`,
      referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
      'user-agent': ua,
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-ch-ua': '"Chromium";v="120", "Not A(Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
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
          const delayMs = this.getRandomDelay(regionTRT);
          this.logger.debug(
            `⏱ Delay de ${delayMs}ms antes de buscar a ${i}ª instância`,
          );
          await this.delay(delayMs);

          const tokenCaptcha =
            regionTRT === 15
              ? undefined
              : ((await this.redis.get(
                  `pje:token:captcha:${numeroDoProcesso}:${i}`,
                )) as string);

          const headers = this.buildHeaders(
            numeroDoProcesso,
            i.toString(),
            regionTRT,
          );

          const { data } = await axios.get<DetalheProcesso[]>(
            `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            { headers },
          );

          const detalheProcesso = data[0];
          if (!detalheProcesso) continue;

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
          this.logger.warn(
            `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
          );
          continue;
        }
      }

      return instances;
    } catch (error: any) {
      this.logger.error(`Erro ao buscar processo ${numeroDoProcesso}`, error);
      if ([401, 403].includes(error?.response?.status)) {
        this.logger.warn(
          `Sessão expirada no TRT-${regionTRT}, refazendo login...`,
        );
        return this.execute(numeroDoProcesso, origem); // reprocessa com novo login
      }
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

      const response = await axios.get<ProcessosResponse>(url, {
        headers: this.buildHeaders(
          numeroDoProcesso,
          instance,
          regionTRT,
          userAgent,
        ),
      });

      const tokenCaptcha = response.headers['captchatoken'] as string;
      if (tokenCaptcha)
        await this.redis.set(
          `pje:token:captcha:${numeroDoProcesso}:${instance}`,
          tokenCaptcha,
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
    try {
      const captcha = await this.captchaService.resolveCaptcha(imagem);
      return captcha.resposta;
    } catch (error: any) {
      this.logger.error('Erro ao buscar captcha:', error.message);
      return '';
    }
  }
}
