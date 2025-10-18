/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
// src/modules/pje/process-find.service.ts
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
  delayMs = Math.floor(Math.random() * (5000 - 1000 + 1)) + 5000; // 5 a 10s
  async execute(
    numeroDoProcesso: string,
    origem?: string,
  ): Promise<ProcessosResponse[]> {
    const regionTRT = numeroDoProcesso?.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;

    try {
      // 🔹 Escolhe a conta atual
      const balance = await this.captchaService.getBalance();
      if (balance < 0.001) {
        // valor mínimo depende do serviço (ex: 0.001 USD)
        this.logger.warn(`Saldo insuficiente no 2Captcha: ${balance}`);
        throw new Error('Saldo insuficiente no 2Captcha');
      }
      const instances: ProcessosResponse[] = [];
      // Percorre 1ª e 2ª instância
      if (origem === 'TST') {
        // Apenas grau 3 para TST
        try {
          const grau = 3;
          const tokenCaptcha = await this.redis.get(
            `pje:token:captcha:${numeroDoProcesso}:${grau}`,
          );
          // const responseDadosBasicos = await axios.get<DetalheProcesso[]>(
          //   `https://pje.tst.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
          //   {
          //     headers: {
          //       accept: 'application/json, text/plain, */*',
          //       'content-type': 'application/json',
          //       'x-grau-instancia': grau.toString(),
          //       referer: `https://pje.tst.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${grau}`,
          //       'user-agent':
          //         userAgents[Math.floor(Math.random() * userAgents.length)],
          //     },
          //   },
          // );

          // const detalheProcesso = responseDadosBasicos.data[0];
          const baseConfig = {
            headers: {
              accept: 'application/json, text/plain, */*',
              'content-type': 'application/json',
              'x-grau-instancia': grau.toString(),
              referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${grau}`,
              'user-agent':
                userAgents[Math.floor(Math.random() * userAgents.length)],
            },
            timeout: 10000,
          };

          const { data: detalheProcessos } = await this.axiosGetWithScraperApi<
            DetalheProcesso[]
          >(
            `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            baseConfig,
          );
          const detalheProcesso = detalheProcessos[0];

          if (detalheProcesso) {
            let processoResponse: ProcessosResponse = await this.fetchProcess(
              numeroDoProcesso,
              detalheProcesso.id,
              grau.toString(),
              tokenCaptcha as string,
              undefined,
              undefined,
            );

            if (
              'imagem' in processoResponse &&
              'tokenDesafio' in processoResponse
            ) {
              const resposta = await this.fetchCaptcha(processoResponse.imagem);

              processoResponse = await this.fetchProcess(
                numeroDoProcesso,
                detalheProcesso.id,
                grau.toString(),
                undefined,
                processoResponse.tokenDesafio,
                resposta,
              );
            }

            instances.push(processoResponse);
          }
        } catch (err) {
          this.logger.warn(
            `Falha ao buscar instância 3 para o processo ${numeroDoProcesso}: ${err.message}`,
          );
        }
      } else {
        // 1ª e 2ª instância para outros casos
        for (let i = 1; i <= 3; i++) {
          try {
            this.logger.debug(
              `⏱ Delay de ${this.delayMs}ms antes de buscar a ${i}ª instância`,
            );
            await this.delay(this.delayMs);
            const tokenCaptcha = await this.redis.get(
              `pje:token:captcha:${numeroDoProcesso}:${i}`,
            );
            const baseConfig = {
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-grau-instancia': i.toString(),
                referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${i}`,
                'user-agent':
                  userAgents[Math.floor(Math.random() * userAgents.length)],
              },
              timeout: 10000,
            };

            const { data: detalheProcessos } =
              await this.axiosGetWithScraperApi<DetalheProcesso[]>(
                `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
                baseConfig,
              );
            const detalheProcesso = detalheProcessos[0];

            if (!detalheProcesso) continue;

            let processoResponse: ProcessosResponse = await this.fetchProcess(
              numeroDoProcesso,
              detalheProcesso.id,
              i.toString(),
              tokenCaptcha as string,
              undefined,
              undefined,
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
          } catch (err) {
            console.log(err.response.data);

            this.logger.warn(
              `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
            );
            continue;
          }
        }
      }
      return instances;
    } catch (error) {
      this.logger.error(`Erro ao buscar processo ${numeroDoProcesso}`, error);

      // ⚠️ Se foi 401/403 → sessão expirada → refaz login
      if ([401, 403].includes(error?.response?.status)) {
        this.logger.warn(
          `Sessão expirada no TRT-${regionTRT}, refazendo login...`,
        );
        return this.execute(numeroDoProcesso, origem); // reprocessa com novo login
      }
      return [];

      throw error;
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
    const regionTRT = numeroDoProcesso?.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (regionTRT === null) {
      throw new Error(`Invalid process number format: ${numeroDoProcesso}`);
    }
    const typeUrl = instance === '3' ? 'tst' : `trt${regionTRT}`; // --- IGNORE ---
    try {
      let url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${detalheProcessoId}`;
      if (tockenCaptcha) {
        url += `?tokenCaptcha=${tockenCaptcha}`;
      } else if (tokenDesafio && resposta) {
        url += `?tokenDesafio=${tokenDesafio}&resposta=${resposta}`;
      }

      // const response = await axios.get<ProcessosResponse>(url, {
      //   headers: {
      //     accept: 'application/json, text/plain, */*',
      //     'content-type': 'application/json',
      //     'x-grau-instancia': instance,
      //     referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
      //     'user-agent':
      //       userAgents[Math.floor(Math.random() * userAgents.length)],
      //   },
      // });

      // const tokenCaptcha: string = response.headers['captchatoken'] as string;
      // if (tokenCaptcha) {
      //   const captchaKey = `pje:token:captcha:${numeroDoProcesso}:${instance}`;

      //   await this.redis.set(captchaKey, tokenCaptcha);
      // }
      // return response.data;
      const baseConfig = {
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-grau-instancia': instance,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
        },
        timeout: 12000,
      };

      const { data: responseData, headers } =
        await this.axiosGetWithScraperApi<ProcessosResponse>(url, baseConfig);

      const tokenCaptcha: string = headers['captchatoken'] as string;
      if (tokenCaptcha) {
        const captchaKey = `pje:token:captcha:${numeroDoProcesso}:${instance}`;
        await this.redis.set(captchaKey, tokenCaptcha);
      }
      return responseData;
    } catch (error: any) {
      if (error.response?.status === 429 && attempt < 5) {
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, 8s, 16s
        this.logger.warn(
          `Rate limit detectado (tentativa ${attempt}), aguardando ${delay / 1000}s...`,
        );
        await new Promise((r) => setTimeout(r, delay));
        return this.fetchProcess(
          numeroDoProcesso,
          detalheProcessoId,
          instance,
          tockenCaptcha,
          tokenDesafio,
          resposta,
          attempt + 1,
        );
      }
      console.error('Erro fetching process:', error.message);
      throw error;
    }
  }

  async fetchCaptcha(imagem: string): Promise<string> {
    try {
      const captcha = await this.captchaService.resolveCaptcha(imagem);
      return captcha.resposta;
    } catch (error) {
      console.error('Erro ao buscar captcha:', error.message);
      return '';
    }
  }

  // dentro da class ProcessFindService
  private async axiosGetWithScraperApi<T>(
    url: string,
    baseConfig: any,
    maxAttempts = 2,
  ): Promise<{ data: T; headers: any }> {
    try {
      const res = await axios.get<T>(url, baseConfig);
      return { data: res.data, headers: res.headers };
    } catch (err: any) {
      const isCloudFront =
        err?.response?.status === 403 ||
        (typeof err?.response?.data === 'string' &&
          err.response.data?.includes?.('CloudFront'));

      if (!isCloudFront) throw err;

      this.logger.warn(
        `🔁 Requisição bloqueada (CloudFront). Reenviando via ScraperAPI...`,
      );

      // Tenta novamente via ScraperAPI
      const { applyScraperApiProxy } = await import('src/utils/proxy.helper');
      const cfgWithProxy = applyScraperApiProxy({
        ...baseConfig,
        url,
      });

      const proxiedUrl = (cfgWithProxy as any).url;
      delete (cfgWithProxy as any).url;

      const res = await axios.get<T>(proxiedUrl, cfgWithProxy);
      return { data: res.data, headers: res.headers };
    }
  }
}
