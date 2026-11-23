import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { ItensProcesso } from 'src/interfaces';
import { comConcorrenciaLimitada } from 'src/utils/concurrency';
import { flattenItensProcesso } from 'src/utils/flatten-itens-processo';
import { sniffContentType } from 'src/utils/sniff-content-type';
import { userAgents } from 'src/utils/user-agents';
import { LambdaDocumentExtractorService } from './lambda-document-extractor.service';
import { DocumentTextCacheService } from './document-text-cache.service';

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
    private readonly textCache: DocumentTextCacheService,
  ) {}

  // Só documento público entra no cache — restrito (documents:true) nunca é
  // persistido fora do fluxo que o pediu.
  private ehCacheavel(item: ItensProcesso): boolean {
    return Boolean(item.publico && !item.documentoSigiloso);
  }

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
    // Pausa antes da primeira requisição ao PJe (ritmo anti-bloqueio de quem
    // chama). Fica aqui, e não no chamador, para ser pulada quando todos os
    // documentos vêm do cache e o PJe nem é consultado.
    delayAntesDoPjeMs = 0,
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

    // Recoleta de processo já coletado: a maior parte dos documentos é a mesma
    // da vez anterior. Consulta ao S3 é bem mais barata que PJe + Lambda.
    const CONCORRENCIA_CACHE = 10;
    const doCache = await comConcorrenciaLimitada(
      targetDocs,
      CONCORRENCIA_CACHE,
      async (item) =>
        this.ehCacheavel(item)
          ? this.textCache.get(
              typeUrl,
              processNumber,
              item.id,
              item.idUnicoDocumento,
            )
          : null,
    );
    const hits: DocumentoExtraido[] = [];
    const pendentes: ItensProcesso[] = [];
    targetDocs.forEach((item, indice) => {
      const texto = doCache[indice];
      if (texto !== null) {
        hits.push({ idUnicoDocumento: item.idUnicoDocumento, texto });
      } else {
        pendentes.push(item);
      }
    });

    if (pendentes.length === 0) {
      this.logger.log(
        `✅ Instância ${instance} (${processNumber}): ${hits.length}/${targetDocs.length} documento(s) vindos do cache — PJe não consultado`,
      );
      return hits;
    }

    this.logger.debug(
      `⏱ Delay de ${delayAntesDoPjeMs}ms antes de buscar ${pendentes.length} documento(s) da ${instance}ª instância no PJe (${hits.length} do cache)`,
    );
    await this.delay(delayAntesDoPjeMs);

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
      pendentes,
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

          // Texto vazio não entra: o extrator devolve '' quando a resposta da
          // Lambda vem num formato inesperado, e gravar isso no cache tornaria
          // permanente uma falha que pode ser transitória.
          if (this.ehCacheavel(item) && texto.trim().length > 0) {
            await this.textCache.set(
              typeUrl,
              processNumber,
              item.id,
              item.idUnicoDocumento,
              texto,
            );
          }

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
      `✅ Instância ${instance} (${processNumber}): ${extracted.length + hits.length}/${targetDocs.length} documento(s) extraído(s) com sucesso (${hits.length} do cache)`,
    );

    return [...hits, ...extracted];
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
