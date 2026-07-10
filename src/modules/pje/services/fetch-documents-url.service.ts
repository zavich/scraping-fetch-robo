import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import Redis from 'ioredis';
import { LoginErrorTrt } from 'src/utils/trt-validate';

export interface DocumentoRequestContext {
  typeUrl: string;
  tokenCaptcha: string;
  headers: Record<string, string>;
}

// Erro pra quando o PJe responde 200 com um conteúdo que genuinamente não é
// o documento e a causa não é clara (provável tokenCaptcha rejeitado).
// Diferenciado de erros de rede/parâmetro pra quem chama poder decidir
// renovar o token e tentar de novo, em vez de desistir direto.
export class InvalidPjeDocumentResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidPjeDocumentResponseError';
  }
}

// Erro pra quando o PJe diz explicitamente, num JSON de erro de verdade, que
// aquele ID de documento não existe naquele processo — não tem token que
// resolva isso, renovar captcha e tentar de novo é desperdício.
export class DocumentoNaoEncontradoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DocumentoNaoEncontradoError';
  }
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

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async fetchDocumento(
    context: DocumentoRequestContext,
    processId: number,
    documentId: number,
    processNumber: string,
    titulo: string,
    tentativa = 1,
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

      // Com `responseType: 'arraybuffer'`, o axios no Node pode devolver um
      // ArrayBuffer puro (não um Buffer) — `Buffer.isBuffer` sozinho rejeitava
      // esses casos válidos. `Buffer.from` abaixo já sabe converter os dois.
      const isBufferConvertible =
        Buffer.isBuffer(response.data) ||
        response.data instanceof ArrayBuffer ||
        ArrayBuffer.isView(response.data);
      if (!isBufferConvertible) {
        this.logger.error(
          'Erro: O conteúdo retornado pela API não é um arquivo válido.',
        );
        throw new Error('Invalid document structure.');
      }
      const contentTypeHeader =
        (response.headers['content-type'] as string) ?? 'application/pdf';
      const buffer = Buffer.from(response.data);
      this.logger.debug(
        `📦 Documento "${titulo}" (id=${documentId}): content-type=${contentTypeHeader} size=${buffer.length}bytes`,
      );

      // O PJe às vezes manda o documento de verdade (HTML com o conteúdo
      // real) com o header `content-type: application/json` errado — sem
      // olhar o corpo, esses documentos válidos eram rejeitados. `%PDF`/`<`
      // no início do buffer é bem mais confiável que o header nesse caso.
      const inicioBuffer = buffer.toString('utf-8', 0, 50).trimStart();
      const pareceHtml = inicioBuffer.startsWith('<');
      const parecePdf = buffer.subarray(0, 4).toString('latin1') === '%PDF';
      const contentTypeReal = /pdf|html/.test(contentTypeHeader)
        ? contentTypeHeader
        : parecePdf
          ? 'application/pdf'
          : pareceHtml
            ? 'text/html'
            : contentTypeHeader;

      // Documentos reais podem ser bem curtos (ex.: uma petição de juntada
      // de uma linha só, ~100 bytes) — um piso mínimo de tamanho rejeitava
      // esses documentos válidos. Quem decide validade agora é só o
      // sniffing de conteúdo acima (contentTypeReal), e a checagem de JSON
      // de erro abaixo, não o tamanho do buffer.
      const isDocumentoValido = /pdf|html/.test(contentTypeReal);
      if (!isDocumentoValido) {
        // Não loga o corpo — essa rota também serve documentos restritos, e
        // o conteúdo pode ser sensível. Só metadados (content-type/size)
        // vão pro log; o corpo em si só é inspecionado em memória abaixo
        // pra decidir se é um JSON de erro de "documento não encontrado".
        this.logger.error(
          `Resposta inválida do PJe pro documento "${titulo}" (id=${documentId}, processo=${processNumber}): content-type=${contentTypeHeader} size=${buffer.length}bytes`,
        );

        // JSON de erro de verdade dizendo que o documento não existe — não é
        // problema de token, renovar captcha não resolve.
        try {
          const parsed = JSON.parse(buffer.toString('utf-8')) as {
            mensagemErro?: string;
          };
          if (parsed?.mensagemErro) {
            throw new DocumentoNaoEncontradoError(parsed.mensagemErro);
          }
        } catch (parseError) {
          if (parseError instanceof DocumentoNaoEncontradoError) {
            throw parseError;
          }
          // não era JSON de verdade — segue como InvalidPjeDocumentResponseError
        }

        throw new InvalidPjeDocumentResponseError(
          `Resposta inválida do PJe para o documento (content-type=${contentTypeHeader}, size=${buffer.length}bytes)`,
        );
      }

      return { buffer, contentType: contentTypeReal };
    } catch (error) {
      if (
        error instanceof InvalidPjeDocumentResponseError ||
        error instanceof DocumentoNaoEncontradoError
      ) {
        // Já logado com o corpo da resposta acima — relança como está, sem
        // embrulhar, pra quem chamou poder identificar esse caso específico
        // (`instanceof`) e decidir se vale a pena renovar o tokenCaptcha e
        // tentar de novo, ou desistir direto (documento não encontrado).
        throw error;
      }

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
        `Erro ao buscar documento "${titulo}" (id=${documentId}) para processo ${processNumber}: HTTP ${status ?? 'n/a'} — ${error instanceof Error ? error.message : String(error)} | body=${responseData ? responseData.slice(0, 2000) : null}`,
      );

      // 5xx do PJe (ex.: ARQ-509 "Erro inesperado na consulta ao banco de
      // dados") costuma ser sobrecarga/contenção transitória no backend
      // deles, e 429 é bloqueio explícito por excesso de requisições — os
      // dois valem retry com espera, diferente de 404/tokenCaptcha inválido,
      // que não se resolvem tentando de novo. 429 espera mais (é bloqueio de
      // taxa, não só um hiccup pontual) e respeita o header `retry-after`
      // quando o PJe manda um.
      const isRateLimited = status === 429;
      const isServerError = !!status && status >= 500;
      const MAX_TENTATIVAS = 3;
      if ((isRateLimited || isServerError) && tentativa < MAX_TENTATIVAS) {
        const retryAfterHeader = axios.isAxiosError(error)
          ? error.response?.headers?.['retry-after']
          : undefined;
        const retryAfterMs = retryAfterHeader
          ? Number(retryAfterHeader) * 1000
          : undefined;
        const esperaMs =
          retryAfterMs || (isRateLimited ? 5000 : 2000) * tentativa;
        this.logger.warn(
          `🔄 HTTP ${status} do PJe pro documento "${titulo}" (id=${documentId}) — tentativa ${tentativa}/${MAX_TENTATIVAS}, retry em ${esperaMs}ms`,
        );
        await this.delay(esperaMs);
        return this.fetchDocumento(
          context,
          processId,
          documentId,
          processNumber,
          titulo,
          tentativa + 1,
        );
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
