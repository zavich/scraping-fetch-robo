import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { ItensProcesso } from 'src/interfaces';
import { comConcorrenciaLimitada } from 'src/utils/concurrency';
import { flattenItensProcesso } from 'src/utils/flatten-itens-processo';
import { sniffContentType } from 'src/utils/sniff-content-type';
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
    // Achata antes de filtrar — documentos anexados (ex: procuração, estatuto,
    // CNPJ) vêm aninhados em `item.anexos` e também precisam ser extraídos
    // via Lambda, não só os itens de topo de `itensProcesso`.
    const targetDocs = flattenItensProcesso(itensProcesso).filter(filter);

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
            ? `?tokenCaptcha=${encodeURIComponent(tokenCaptcha)}`
            : '';
          const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/documentos/${item.id}${tokenQuery}`;
          const urlForLog = tokenQuery
            ? url.replace(/tokenCaptcha=[^&]+/, 'tokenCaptcha=REDACTED')
            : url;

          this.logger.debug(
            `📄 GET ${urlForLog} (documento="${item.titulo}", idUnico=${item.idUnicoDocumento})`,
          );

          const docResponse = await axios.get<ArrayBuffer>(url, {
            headers,
            responseType: 'arraybuffer',
            timeout: 60000,
          });

          const contentTypeHeader =
            (docResponse.headers['content-type'] as string) ?? '';
          const buffer = Buffer.from(docResponse.data);
          const contentType = sniffContentType(buffer, contentTypeHeader);
          this.logger.debug(
            `📦 Documento "${item.titulo}" (id=${item.id}): content-type=${contentType} size=${buffer.length}bytes`,
          );

          // Nem o header nem o sniffing do buffer indicam PDF/HTML — não é um
          // documento de verdade (ex.: JSON de erro do PJe). Não vale mandar
          // pra Lambda, só geraria falha/ruído e gasto desnecessário.
          if (!/pdf|html/i.test(contentType)) {
            this.logger.warn(
              `⚠️ Documento "${item.titulo}" (id=${item.id}, idUnico=${item.idUnicoDocumento}) para ${processNumber}: content-type=${contentType} não parece PDF/HTML, pulando extração.`,
            );
            return null;
          }

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
          const contentType = axios.isAxiosError(err)
            ? (err.response?.headers?.['content-type'] as string | undefined)
            : undefined;
          // Não loga o body — essa rota também serve documentos restritos,
          // e o corpo pode conter conteúdo sensível. Só metadados (status,
          // content-type) vão pro log.
          this.logger.error(
            `Erro ao processar documento público "${item.titulo}" (id=${item.id}, idUnico=${item.idUnicoDocumento}) para ${processNumber}: HTTP ${status ?? 'n/a'} content-type=${contentType ?? 'n/a'} — ${err instanceof Error ? err.message : String(err)}`,
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
