import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import * as fs from 'fs';
import Redis from 'ioredis';
import * as path from 'path';
import { DetalheProcesso, ProcessosResponse } from 'src/interfaces';
import { CaptchaService } from 'src/services/captcha.service';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class FetchDocumentoService {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly captchaService: CaptchaService,
  ) {}
  private readonly logger = new Logger(FetchDocumentoService.name);
  async execute(
    processId: number,
    regionTRT: number,
    instancia: string,
    processNumber: string,
  ): Promise<string> {
    try {
      if (!processId || !regionTRT || !instancia) {
        this.logger.error('Parâmetros inválidos fornecidos');
        return '';
      }
      const redisKey = `pje:session:${regionTRT}`;
      const cookies = (await this.redis.get(redisKey)) as string;
      // 🔹 Recupera tokenCaptcha específico do processo
      const tokenCaptcha = await this.fetchTokenCaptcha(
        processNumber,
        instancia,
        regionTRT,
      );
      const redisKeyAWS = `aws-waf-token:${processNumber}`;
      const aws = await this.redis.get(redisKeyAWS);
      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;
      const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/integra?tokenCaptcha=${tokenCaptcha || ''}`;

      // 🔹 Extrai access_token_1g do cookie
      const match = cookies.match(/access_token_1g=([^;]+)/);
      const accessToken1g = match ? match[1] : null;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken1g}`,
          Cookie: `${aws}`,
          'x-grau-instancia': instancia,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instancia}`,
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
        },
        timeout: 300000,
        responseType: 'arraybuffer',
        withCredentials: true,
      });

      const buffer = Buffer.from(response.data);

      // cria pasta temp se não existir
      const tempDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const sanitizedProcessNumber = processNumber.replace(/\D+/g, '');

      const fileName = `proc_${sanitizedProcessNumber}_${instancia}_${processId}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.pdf`;

      const filePath = path.join(tempDir, fileName);

      // salva no disco
      fs.writeFileSync(filePath, buffer);

      this.logger.log(`PDF salvo em: ${filePath}`);

      return filePath;
    } catch (error) {
      this.logger.error('Erro ao executar DocumentoService', error);
      throw error; // deixa o Nest lançar 500 mas logado corretamente
    }
  }
  private async buildHeaders(
    numeroDoProcesso: string,
    instance: string,
    regionTRT: number,
    userAgent?: string,
  ) {
    const ua =
      userAgent || userAgents[Math.floor(Math.random() * userAgents.length)];
    const redisKey = `aws-waf-token:${numeroDoProcesso}`;
    const aws = await this.redis.get(redisKey);
    return {
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'content-type': 'application/json',
      'x-grau-instancia': instance,
      cookie: `${aws}`,
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
  async fetchTokenCaptcha(
    numeroDoProcesso: string,
    instance: string,
    regionTRT: number,
  ) {
    try {
      const headers = this.buildHeaders(numeroDoProcesso, instance, regionTRT);

      const { data } = await axios.get<DetalheProcesso[]>(
        `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
        { headers: await headers },
      );

      const detalheProcesso = data[0];
      if (!detalheProcesso) return;

      let processoResponse = await this.fetchProcess(
        numeroDoProcesso,
        detalheProcesso.id,
        instance,
      );

      // Caso retorne captcha
      if (
        'imagem' in processoResponse.data &&
        'tokenDesafio' in processoResponse.data
      ) {
        const resposta = await this.fetchCaptcha(processoResponse.data.imagem);
        processoResponse = await this.fetchProcess(
          numeroDoProcesso,
          detalheProcesso.id,
          instance,
          undefined,
          processoResponse.data.tokenDesafio,
          resposta,
        );
      }

      return processoResponse.tokenCaptcha;
    } catch (err: any) {
      this.logger.warn(
        `Falha ao buscar documento da instância ${instance} para o processo ${numeroDoProcesso}: ${err.message}`,
      );
      return;
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
  ): Promise<{ data: ProcessosResponse; tokenCaptcha?: string }> {
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
        headers: await this.buildHeaders(
          numeroDoProcesso,
          instance,
          regionTRT,
          userAgent,
        ),
      });

      const tokenCaptcha = response.headers['captchatoken'] as string;

      return { data: response.data, tokenCaptcha };
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
