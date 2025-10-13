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

  async execute(
    numeroDoProcesso: string,
    origem?: string,
  ): Promise<ProcessosResponse[]> {
    const regionTRT = Number(numeroDoProcesso.split('.')[3]);

    try {
      const tokenCaptcha = await this.redis.get('pje:token:captcha');
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
          const responseDadosBasicos = await axios.get<DetalheProcesso[]>(
            `https://pje.tst.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            {
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                'x-grau-instancia': grau.toString(),
                referer: `https://pje.tst.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${grau}`,
                'user-agent':
                  userAgents[Math.floor(Math.random() * userAgents.length)],
              },
            },
          );

          const detalheProcesso = responseDadosBasicos.data[0];
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
            const responseDadosBasicos = await axios.get<DetalheProcesso[]>(
              `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
              {
                headers: {
                  accept: 'application/json, text/plain, */*',
                  'content-type': 'application/json',
                  'x-grau-instancia': i.toString(),
                  referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${i}`,
                  'user-agent':
                    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
                },
              },
            );

            const detalheProcesso = responseDadosBasicos.data[0];
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
            this.logger.warn(
              `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
            );
            continue;
          }
        }
      }

      const erroIndex = instances.findIndex(
        (instance) => 'mensagemErro' in instance && instance.mensagemErro,
      );
      if (erroIndex !== -1) {
        return [];
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
        },
      });

      const tokenCaptcha: string = response.headers['captchatoken'] as string;
      if (tokenCaptcha) {
        const captchaKey = `pje:token:captcha:${numeroDoProcesso}:${instance}`;

        await this.redis.set(captchaKey, tokenCaptcha);
      }
      return response.data;
    } catch (error: any) {
      if (error.response?.status === 429) {
        // 🔹 Retry exponencial: 1s, 2s, 4s, 8s, 16s
        return await this.fetchProcess(
          numeroDoProcesso,
          detalheProcessoId,
          instance,
          tockenCaptcha,
          tokenDesafio,
          resposta,
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
}
