import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { ItensProcesso } from 'src/interfaces';
import { comConcorrenciaLimitada } from 'src/utils/concurrency';
import { userAgents } from 'src/utils/user-agents';
import { LambdaDocumentExtractorService } from './lambda-document-extractor.service';

export interface DocumentoExtraido {
  idUnicoDocumento: string;
  texto: string;
}

@Injectable()
export class FetchPublicDocumentsService {
  private readonly logger = new Logger(FetchPublicDocumentsService.name);

  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly lambdaExtractorService: LambdaDocumentExtractorService,
  ) {}

  async execute(
    processId: number,
    regionTRT: number,
    instance: string,
    processNumber: string,
    itensProcesso: ItensProcesso[],
    filter: (item: ItensProcesso) => boolean = (item) =>
      Boolean(
        item.publico &&
          !item.documentoSigiloso &&
          item.documento &&
          item.idUnicoDocumento,
      ),
  ): Promise<DocumentoExtraido[]> {
    const targetDocs = itensProcesso.filter(filter);

    if (targetDocs.length === 0) {
      this.logger.warn(`⚠️ Nenhum documento encontrado para ${processNumber}`);
      return [];
    }

    const publicos = targetDocs.filter(
      (item) => item.publico && !item.documentoSigiloso,
    ).length;
    this.logger.log(
      `📊 Instância ${instance} (${processNumber}): ${targetDocs.length} documento(s) pra buscar (${publicos} público(s), ${targetDocs.length - publicos} restrito(s))`,
    );

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

    // Limita a concorrência real contra o PJe (mesmo padrão usado pros
    // documentos restritos em process-documents-find.service.ts) — disparar
    // uma requisição por documento simultaneamente derruba o PJe com erros
    // 429/5xx em processos com muitos documentos.
    const CONCORRENCIA_MAXIMA = 3;
    const INTERVALO_ENTRE_REQUESTS_MS = 300;

    const results = await comConcorrenciaLimitada(
      targetDocs,
      CONCORRENCIA_MAXIMA,
      async (item) => {
        try {
          await this.delay(INTERVALO_ENTRE_REQUESTS_MS);

          const tokenQuery = tokenCaptcha
            ? `?tokenCaptcha=${tokenCaptcha}`
            : '';
          const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/documentos/${item.id}${tokenQuery}`;

          this.logger.debug(
            `📄 GET ${url} (documento="${item.titulo}", idUnico=${item.idUnicoDocumento})`,
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
            `📦 Documento "${item.titulo}" (id=${item.id}): content-type=${contentType} size=${buffer.length}bytes`,
          );

          const texto = await this.lambdaExtractorService.extractText(
            buffer,
            contentType,
            {
              titulo: item.titulo,
              idUnicoDocumento: item.idUnicoDocumento,
              processNumber,
            },
          );

          const documento: DocumentoExtraido = {
            idUnicoDocumento: item.idUnicoDocumento,
            texto,
          };
          return documento;
        } catch (err) {
          const status = axios.isAxiosError(err) ? err.response?.status : null;
          let responseData: string | null = null;
          if (axios.isAxiosError(err) && err.response?.data) {
            const raw: unknown = err.response.data;
            if (Buffer.isBuffer(raw)) {
              responseData = raw.toString('utf-8');
            } else if (raw instanceof ArrayBuffer) {
              responseData = Buffer.from(raw).toString('utf-8');
            } else {
              responseData = JSON.stringify(raw);
            }
          }
          // Trunca o body no log — essa rota também serve documentos
          // restritos, e o corpo pode conter conteúdo sensível além de
          // inflar o tamanho do log.
          this.logger.error(
            `Erro ao processar documento público "${item.titulo}" (id=${item.id}, idUnico=${item.idUnicoDocumento}) para ${processNumber}: HTTP ${status ?? 'n/a'} — ${err instanceof Error ? err.message : String(err)} | body=${responseData ? responseData.slice(0, 2000) : null}`,
          );
          return null;
        }
      },
    );

    const extracted = results.filter(
      (documento): documento is DocumentoExtraido => documento !== null,
    );

    this.logger.log(
      `✅ Instância ${instance} (${processNumber}): ${extracted.length}/${targetDocs.length} documento(s) extraído(s) com sucesso`,
    );

    return extracted;
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
