import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import Redis from 'ioredis';
import { LoginErrorTrt } from 'src/utils/trt-validate';

export interface DocumentoRequestContext {
  typeUrl: string;
  tokenCaptcha: string;
  headers: Record<string, string>;
}

@Injectable()
export class FetchDocumentoService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}
  private readonly logger = new Logger(FetchDocumentoService.name);

  // Monta uma única vez os headers de sessão logada (Authorization, cookies,
  // tokenCaptcha) para depois buscar todos os documentos restritos de um
  // processo sem repetir login/redis a cada requisição.
  async buildContext(
    regionTRT: number,
    instancia: string,
    processNumber: string,
  ): Promise<DocumentoRequestContext> {
    if (!regionTRT || !instancia) {
      throw new Error('Parâmetros inválidos fornecidos');
    }
    const regionTRTValidate = LoginErrorTrt.includes(regionTRT) ? 2 : regionTRT;

    const redisKey = `pje:session:${regionTRTValidate}`;
    const cookies = (await this.redis.get(redisKey)) || '';
    const awsWafTokenKey = `aws-waf-token:${processNumber}`;
    const awsWafToken = await this.redis.get(awsWafTokenKey);

    this.logger.debug(
      `Iniciando busca do tokenCaptcha para o processo ${processNumber}, instância ${instancia}`,
    );

    const catchaTokenRedisKey = `tokencaptcha:${processNumber}:${instancia}`;
    let tokenCaptcha = await this.redis.get(catchaTokenRedisKey);

    // fallback entre instâncias
    if (!tokenCaptcha) {
      this.logger.warn(
        `⚠️ Nenhum tokenCaptcha para ${processNumber} (instância ${instancia}), tentando fallback...`,
      );

      for (const inst of ['1', '2', '3']) {
        if (inst === instancia) continue;

        const alternativaKey = `tokencaptcha:${processNumber}:${inst}`;
        tokenCaptcha = await this.redis.get(alternativaKey);

        if (tokenCaptcha) {
          this.logger.debug(
            `Token encontrado na instância ${inst}: ${tokenCaptcha}`,
          );
          break;
        }
      }
    }

    if (!tokenCaptcha) {
      this.logger.warn(
        `⚠️ Nenhum tokenCaptcha encontrado para ${processNumber}`,
      );
    }

    const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;

    // 🔹 extrai token do cookie
    const match = cookies.match(/access_token_1g=([^;]+)/);
    const accessToken1g = match?.[1];

    if (!accessToken1g) {
      this.logger.error(`❌ access_token_1g não encontrado no cookie`);
      throw new Error('Sessão inválida (sem access_token_1g)');
    }

    // 🔹 o cookie de sessão salvo no Redis (com access_token_1g e demais
    // cookies da sessão logada) precisa ir junto no header Cookie da request
    // de /documentos — só extrair o access_token_1g pro Authorization não
    // basta, essa rota também valida a sessão via cookie.
    const headers: Record<string, string> = {
      Authorization: `Bearer ${accessToken1g}`,
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      Cookie: [cookies, awsWafToken].filter(Boolean).join('; '),
      'x-grau-instancia': instancia,
      referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instancia}`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      accept: 'application/json, text/plain, */*',
      'sec-fetch-site': 'same-origin',
      'sec-fetch-mode': 'cors',
      'sec-fetch-dest': 'empty',
      'sec-ch-ua': '"Chromium";v="146", "Not A(Brand";v="99"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
    };

    return { typeUrl, tokenCaptcha: tokenCaptcha || '', headers };
  }

  async fetchDocumento(
    context: DocumentoRequestContext,
    processId: number,
    documentId: number,
    processNumber: string,
    titulo: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      if (!processId || !documentId) {
        throw new Error('Parâmetros inválidos fornecidos');
      }

      const url = `https://pje.${context.typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/documentos/${documentId}?tokenCaptcha=${context.tokenCaptcha}`;
      this.logger.debug(`📄 GET ${url} (documento="${titulo}")`);

      const response = await axios.get(url, {
        headers: context.headers,
        timeout: 180000, // Aumente para 180 segundos para casos mais complexos
        responseType: 'arraybuffer',
        withCredentials: true,
      });

      if (!Buffer.isBuffer(response.data)) {
        this.logger.error(
          'Erro: O conteúdo retornado pela API não é um arquivo válido.',
        );
        throw new Error('Invalid document structure.');
      }
      const contentType =
        (response.headers['content-type'] as string) ?? 'application/pdf';
      const buffer = Buffer.from(response.data);
      this.logger.debug(
        `📦 Documento "${titulo}" (id=${documentId}): content-type=${contentType} size=${buffer.length}bytes`,
      );

      // O PJe responde 200 mesmo quando rejeita o tokenCaptcha (ex.: token de
      // uma instância usado em outra) — devolve um JSON de erro pequeno em vez
      // do PDF/HTML real. Sem essa checagem isso subia pro S3 como se fosse o
      // documento de verdade.
      const isDocumentoValido =
        /pdf|html/.test(contentType) && buffer.length > 1024;
      if (!isDocumentoValido) {
        throw new Error(
          `Resposta inválida do PJe para o documento (content-type=${contentType}, size=${buffer.length}bytes) — provável tokenCaptcha rejeitado`,
        );
      }

      return { buffer, contentType };
    } catch (error) {
      const status = axios.isAxiosError(error) ? error.response?.status : null;
      let responseData: string | null = null;
      if (axios.isAxiosError(error) && error.response?.data) {
        const raw: unknown = error.response.data;
        if (Buffer.isBuffer(raw)) {
          responseData = raw.toString('utf-8');
        } else if (raw instanceof ArrayBuffer) {
          responseData = Buffer.from(raw).toString('utf-8');
        } else {
          responseData = JSON.stringify(raw);
        }
      }
      this.logger.error(
        `Erro ao buscar documento "${titulo}" (id=${documentId}) para processo ${processNumber}: HTTP ${status ?? 'n/a'} — ${error instanceof Error ? error.message : String(error)} | body=${responseData}`,
      );
      throw new Error('Erro ao executar DocumentoService');
    }
  }
}
