import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { ItensProcesso } from 'src/interfaces';
import { userAgents } from 'src/utils/user-agents';

export interface DocumentoExtraido {
  idUnicoDocumento: string;
  texto: string;
}

@Injectable()
export class FetchPublicDocumentsService {
  private readonly logger = new Logger(FetchPublicDocumentsService.name);

  private readonly LAMBDA_URL =
    process.env.LAMBDA_DOCUMENT_EXTRACTOR_URL as string;
  private readonly LAMBDA_API_KEY =
    process.env.LAMBDA_DOCUMENT_EXTRACTOR_API_KEY as string;

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  async execute(
    processId: number,
    regionTRT: number,
    instance: string,
    processNumber: string,
    itensProcesso: ItensProcesso[],
  ): Promise<DocumentoExtraido[]> {
    const publicDocs = itensProcesso.filter(
      (item) => item.publico && item.documento && item.idUnicoDocumento,
    );

    if (publicDocs.length === 0) {
      this.logger.warn(
        `⚠️ Nenhum documento público encontrado para ${processNumber}`,
      );
      return [];
    }

    const typeUrl = instance === '3' ? 'tst' : `trt${regionTRT}`;
    const awsWafToken =
      (await this.redis.get(`aws-waf-token:${processNumber}`)) ?? '';

    let tokenCaptcha = await this.redis.get(
      `tokencaptcha:${processNumber}:${instance}`,
    );
    if (!tokenCaptcha) {
      for (const inst of ['1', '2', '3']) {
        if (inst === instance) continue;
        tokenCaptcha = await this.redis.get(
          `tokencaptcha:${processNumber}:${inst}`,
        );
        if (tokenCaptcha) break;
      }
    }

    const headers: Record<string, string> = {
      Cookie: awsWafToken,
      'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
      accept: 'application/json, text/plain, */*',
      'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      'x-grau-instancia': instance,
      referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instance}`,
    };

    const extracted: DocumentoExtraido[] = [];

    for (const item of publicDocs) {
      try {
        const tokenQuery = tokenCaptcha ? `?tokenCaptcha=${tokenCaptcha}` : '';
        const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/documentos/${item.id}${tokenQuery}`;

        this.logger.debug(
          `📄 GET ${url} (idUnico=${item.idUnicoDocumento})`,
        );

        const docResponse = await axios.get<ArrayBuffer>(url, {
          headers,
          responseType: 'arraybuffer',
          timeout: 60000,
        });

        const contentType =
          (docResponse.headers['content-type'] as string) ?? '';
        const buffer = Buffer.from(docResponse.data);
        this.logger.debug(
          `📦 Documento ${item.id}: content-type=${contentType} size=${buffer.length}bytes`,
        );

        const contentB64 = buffer.toString('base64');

        const texto = await this.extractTextFromLambda(
          contentB64,
          contentType,
          item.idUnicoDocumento,
          processNumber,
        );

        extracted.push({ idUnicoDocumento: item.idUnicoDocumento, texto });
      } catch (err) {
        const status = axios.isAxiosError(err) ? err.response?.status : null;
        let responseData: string | null = null;
        if (axios.isAxiosError(err) && err.response?.data) {
          const raw = err.response.data as Buffer | ArrayBuffer | unknown;
          if (Buffer.isBuffer(raw)) {
            responseData = raw.toString('utf-8');
          } else if (raw instanceof ArrayBuffer) {
            responseData = Buffer.from(raw).toString('utf-8');
          } else {
            responseData = JSON.stringify(raw);
          }
        }
        this.logger.error(
          `Erro ao processar documento público ${item.idUnicoDocumento} (id=${item.id}) para ${processNumber}: HTTP ${status ?? 'n/a'} — ${err instanceof Error ? err.message : String(err)} | body=${responseData}`,
        );
      }
    }

    return extracted;
  }

  private async extractTextFromLambda(
    contentB64: string,
    pjeContentType: string,
    idUnicoDocumento: string,
    processNumber: string,
  ): Promise<string> {
    if (!this.LAMBDA_URL || !this.LAMBDA_API_KEY) {
      throw new Error(
        'LAMBDA_DOCUMENT_EXTRACTOR_URL e LAMBDA_DOCUMENT_EXTRACTOR_API_KEY são obrigatórios',
      );
    }

    const lambdaContentType = pjeContentType.includes('pdf') ? 'pdf' : 'html';

    const response = await axios.post<Record<string, unknown>>(
      this.LAMBDA_URL,
      {
        api_key: this.LAMBDA_API_KEY,
        content_type: lambdaContentType,
        content_b64: contentB64,
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      },
    );

    this.logger.debug(
      `🔍 Lambda response para ${idUnicoDocumento} (content_type=${lambdaContentType}): keys=${Object.keys(response.data ?? {}).join(',')}`,
    );

    const texto =
      (response.data?.texto as string) ??
      (response.data?.text as string) ??
      (response.data?.result as string) ??
      (response.data?.content as string) ??
      '';

    this.logger.debug(
      `✅ Texto extraído para documento ${idUnicoDocumento} de ${processNumber} (${texto.length} chars)`,
    );

    return texto;
  }
}
