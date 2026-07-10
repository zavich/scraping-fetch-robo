import { BadGatewayException, Injectable, Logger } from '@nestjs/common';
import { Documento, ItensProcesso, ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { comConcorrenciaLimitada } from 'src/utils/concurrency';
import { normalizeString } from 'src/utils/normalize-string';
import {
  DocumentoRequestContext,
  FetchDocumentoService,
  InvalidPjeDocumentResponseError,
} from './fetch-documents-url.service';
import { FetchUrlMovimentService } from './fetch-url.service';
import { LambdaDocumentExtractorService } from './lambda-document-extractor.service';

@Injectable()
export class ProcessDocumentsFindService {
  logger = new Logger(ProcessDocumentsFindService.name);

  constructor(
    private readonly awsS3Service: AwsS3Service,
    private readonly fetchDocumentoService: FetchDocumentoService,
    private readonly lambdaExtractorService: LambdaDocumentExtractorService,
    private readonly fetchUrlMovimentService: FetchUrlMovimentService,
  ) {}

  private getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : 'Erro desconhecido';
  }

  async execute(
    numeroDoProcesso: string,
    instances: ProcessosResponse[],
    regionTRT: number,
  ): Promise<ProcessosResponse[]> {
    try {
      const instancesWithGrau = instances.map((instance) => ({
        ...instance,
        grau:
          instance.instance === '1'
            ? 'PRIMEIRO_GRAU'
            : instance.instance === '3'
              ? 'TERCEIRO_GRAU'
              : 'SEGUNDO_GRAU',
      }));
      if (!instancesWithGrau || instancesWithGrau.length === 0) return [];

      const documentosRestritos = await this.fetchDocumentosRestritos(
        numeroDoProcesso,
        instances,
        regionTRT,
      );

      const newInstances = instancesWithGrau.map((instance) => ({
        ...instance,
        documentos: documentosRestritos,
      }));
      return newInstances;
    } catch (error: unknown) {
      const errorMessage = this.getErrorMessage(error);
      this.logger.error(`Error fetching restricted documents: ${errorMessage}`);
      throw new BadGatewayException(
        `Error fetching restricted documents: ${errorMessage}`,
      );
    }
  }

  private async fetchDocumentosRestritos(
    processNumber: string,
    instances: ProcessosResponse[],
    regionTRT: number,
  ): Promise<Documento[]> {
    // `instancia` vem do campo carimbado em `FetchUrlMovimentService.execute`
    // (o grau real da consulta), não da posição no array — quando uma
    // instância é pulada (ex.: Ação Rescisória sem 1º grau), a posição não
    // corresponde mais ao grau real, e usar `(i + 1)` aqui mandava o
    // tokenCaptcha/x-grau-instancia errado pro PJe (que rejeita o request).
    const instanceEntries = instances
      .map((instance, index) => ({
        id: instance.id,
        // Mesmo fallback usado em normalizeResponse — sem ele, uma instância
        // sem `instance.instance` (vazio/fora do esperado) usaria essa chave
        // vazia/undefined no Map abaixo, colapsando com outra instância no
        // mesmo bucket e buscando documentos com processId/contexto errado.
        instancia: instance.instance ?? (index + 1).toString(),
        itensProcesso: instance.itensProcesso ?? [],
      }))
      .filter((entry) => entry.itensProcesso.length > 0);

    if (instanceEntries.length === 0) {
      this.logger.warn(
        `⚠️ Nenhuma movimentação encontrada para ${processNumber}`,
      );
      return [];
    }

    // O PJe ecoa o mesmo documento na listagem de mais de uma instância (ex:
    // um documento do TST aparece referenciado também na listagem do 1º/2º
    // grau). O atributo `item.instancia` desse item ecoado costuma apontar
    // pra instância "de origem" do documento — mas usar esse atributo pra
    // decidir ONDE buscar o documento (em vez da instância cuja LISTAGEM
    // realmente trouxe esse item) faz o fetch usar o processId/contexto
    // errado, que o PJe rejeita como "documento não encontrado". Cada
    // instância que lista um item tem, por definição, um processId válido
    // pra buscá-lo — por isso agrupa por `entry.instancia` (onde o item foi
    // encontrado), não por `item.instancia` (pra onde ele aponta). Isso pode
    // buscar o mesmo documento mais de uma vez quando ele é ecoado em mais
    // de uma instância, mas garante que ele apareça associado a TODAS as
    // instâncias que o referenciam nas movimentações — antes, ao colapsar
    // pra uma única instância "dona", o documento sumia da instância que não
    // "ganhou" o dedup (era assim que o TST ficava sem documentos nas
    // movimentações mesmo tendo itens que os referenciavam).
    const itensPorInstanciaReal = new Map<string, ItensProcesso[]>();

    for (const entry of instanceEntries) {
      const relevantes = entry.itensProcesso.filter((item) => item.documento);

      // Dedup só dentro da própria listagem — evita repetir o mesmo item
      // duas vezes se ele aparecer duplicado dentro da resposta de UMA
      // instância, mas não colapsa ocorrências de instâncias diferentes.
      const vistosNestaInstancia = new Set<string>();
      for (const item of relevantes) {
        const chave = item.idUnicoDocumento || String(item.id);
        if (vistosNestaInstancia.has(chave)) continue;
        vistosNestaInstancia.add(chave);

        const lista = itensPorInstanciaReal.get(entry.instancia) ?? [];
        lista.push(item);
        itensPorInstanciaReal.set(entry.instancia, lista);
      }
    }

    const processIdPorInstancia = new Map(
      instanceEntries.map((entry) => [entry.instancia, entry.id]),
    );

    // Achata os itens de TODAS as instâncias numa lista só, pra buscar com um
    // único limite de concorrência GLOBAL — antes cada instância rodava sua
    // própria leva de N em paralelo, e com 3 instâncias ativas ao mesmo tempo
    // a concorrência real contra o PJe somava N×instâncias, passando do
    // limite de taxa deles e derrubando tudo em HTTP 429.
    const todosOsItens: {
      grau: string;
      processId: number;
      item: ItensProcesso;
    }[] = [];

    for (const [grau, itens] of itensPorInstanciaReal.entries()) {
      const processId = processIdPorInstancia.get(grau);
      if (!processId) {
        this.logger.warn(
          `⚠️ ${itens.length} documento(s) referenciam a instância ${grau} (${processNumber}), mas essa instância não foi consultada — pulando.`,
        );
        continue;
      }
      for (const item of itens) {
        todosOsItens.push({ grau, processId, item });
      }
    }

    if (todosOsItens.length === 0) {
      this.logger.warn(
        `⚠️ Nenhum documento relevante encontrado para ${processNumber}`,
      );
      return [];
    }

    for (const grau of new Set(todosOsItens.map((i) => i.grau))) {
      const total = todosOsItens.filter((i) => i.grau === grau).length;
      this.logger.log(
        `📊 Instância ${grau} (${processNumber}): ${total} documento(s) relevante(s) pra buscar`,
      );
    }

    // Contexto (headers/cookies/tokenCaptcha) montado uma vez por instância
    // e reaproveitado por todos os documentos dela, mesmo rodando num pool
    // de concorrência global.
    const contextosPorInstancia = new Map<
      string,
      Promise<DocumentoRequestContext>
    >();
    const getContexto = (grau: string) => {
      let contextoPromise = contextosPorInstancia.get(grau);
      if (!contextoPromise) {
        contextoPromise = this.fetchDocumentoService.buildContext(
          regionTRT,
          grau,
          processNumber,
        );
        contextosPorInstancia.set(grau, contextoPromise);
      }
      return contextoPromise;
    };

    const CONCORRENCIA_MAXIMA = 3;
    // Respiro entre requisições além do limite de concorrência — o PJe
    // aparentemente limita por taxa (req/s), não só por conexões simultâneas:
    // mesmo com N workers, se cada um reencadeia a próxima busca assim que a
    // anterior falha rápido (ex.: 429 quase instantâneo), a rajada efetiva
    // continua alta.
    const INTERVALO_ENTRE_REQUESTS_MS = 300;

    // Mesmo documento (mesma `chave`) pode aparecer em `todosOsItens` mais de
    // uma vez — uma ocorrência por instância que o referencia. Sem esse
    // cache, cada ocorrência disparava uma busca de verdade no PJe pro MESMO
    // documento, uma pra cada instância — desperdiçando captcha/requests pra
    // buscar de novo algo que a primeira ocorrência já baixou e salvou.
    // Guarda a Promise (não só o resultado) e faz o get+set de forma síncrona
    // — sem nenhum `await` entre eles — pra duas ocorrências concorrentes da
    // mesma chave não caírem na janela de corrida e buscarem em paralelo.
    const resultadoPorChave = new Map<string, Promise<Documento | null>>();
    const textoPorChave = new Map<string, string>();

    const buscarComCache = ({
      grau,
      processId,
      item,
    }: {
      grau: string;
      processId: number;
      item: ItensProcesso;
    }): Promise<Documento | null> => {
      const chave = item.idUnicoDocumento || String(item.id);

      const emAndamentoOuFeito = resultadoPorChave.get(chave);
      if (emAndamentoOuFeito) {
        this.logger.debug(
          `♻️ Documento "${item.titulo}" (idUnico=${chave}) já foi buscado via outra instância — reaproveitando o que já foi salvo, sem nova requisição ao PJe.`,
        );
        // `item` aqui é um objeto diferente do que foi de fato buscado (cada
        // instância tem sua própria cópia do item ecoado) — `.texto` só fica
        // marcado no objeto que `processarDocumento` recebeu originalmente,
        // então precisa ser replicado manualmente pra essa ocorrência também.
        return emAndamentoOuFeito.then((documento) => {
          const texto = textoPorChave.get(chave);
          if (texto) {
            item.texto = texto;
          }
          return documento;
        });
      }

      const promise = (async () => {
        await this.delay(INTERVALO_ENTRE_REQUESTS_MS);
        const context = await getContexto(grau);
        const documento = await this.processarDocumento(
          context,
          processId,
          item,
          processNumber,
          regionTRT,
          grau,
        );

        if (documento === null) {
          // Falhou com o contexto dessa instância — remove do cache pra uma
          // ocorrência em OUTRA instância (processId/contexto diferente)
          // poder tentar buscar de novo, em vez de herdar essa mesma falha.
          resultadoPorChave.delete(chave);
        } else if (item.texto) {
          textoPorChave.set(chave, item.texto);
        }

        return documento;
      })();

      resultadoPorChave.set(chave, promise);
      return promise;
    };

    const resultados = await comConcorrenciaLimitada(
      todosOsItens,
      CONCORRENCIA_MAXIMA,
      buscarComCache,
    );

    for (const grau of new Set(todosOsItens.map((i) => i.grau))) {
      const doGrau = resultados.filter(
        (_, idx) => todosOsItens[idx].grau === grau,
      );
      const sucesso = doGrau.filter((d) => d !== null).length;
      this.logger.log(
        `✅ Instância ${grau} (${processNumber}): ${sucesso}/${doGrau.length} documento(s) baixado(s) com sucesso`,
      );
    }

    // Com o cache por chave, o mesmo `Documento` pode aparecer mais de uma
    // vez em `resultados` (uma vez por instância que referenciava o
    // documento) — dedup pelo mesmo `uniqueName`/`temp_link` pra não mandar
    // o mesmo upload repetido no payload final.
    const chavesVistas = new Set<string>();
    const uploadedDocuments = resultados.filter(
      (documento): documento is Documento => {
        if (documento === null) return false;
        const chave = documento.uniqueName || documento.temp_link;
        if (chavesVistas.has(chave)) return false;
        chavesVistas.add(chave);
        return true;
      },
    );

    if (uploadedDocuments.length === 0) {
      this.logger.warn(
        `⚠️ Nenhum documento relevante encontrado para ${processNumber}`,
      );
    }

    return uploadedDocuments;
  }

  private async delay(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Só tenta renovar o tokenCaptcha e buscar de novo pra
  // `InvalidPjeDocumentResponseError` (causa ambígua, pode ser token
  // rejeitado). `DocumentoNaoEncontradoError` (PJe confirma que o ID não
  // existe naquele processo) cai direto no `throw error` abaixo — nenhum
  // token novo faz um documento inexistente aparecer, então renovar aqui
  // seria só desperdiçar uma resolução de captcha (custo real).
  private async fetchDocumentoComRenovacao(
    context: DocumentoRequestContext,
    processId: number,
    item: ItensProcesso,
    processNumber: string,
    regionTRT: number,
    instancia: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    try {
      return await this.fetchDocumentoService.fetchDocumento(
        context,
        processId,
        item.id,
        processNumber,
        item.titulo,
      );
    } catch (error: unknown) {
      if (!(error instanceof InvalidPjeDocumentResponseError)) {
        throw error;
      }

      this.logger.warn(
        `🔄 tokenCaptcha rejeitado pro documento "${item.titulo}" (id=${item.id}, instância ${instancia}) de ${processNumber} — renovando e tentando de novo.`,
      );

      const tokenRenovado = await this.fetchUrlMovimentService.refreshTokenCaptcha(
        processNumber,
        processId,
        instancia,
        regionTRT,
      );

      if (!tokenRenovado) {
        throw error;
      }

      return this.fetchDocumentoService.fetchDocumento(
        { ...context, tokenCaptcha: tokenRenovado },
        processId,
        item.id,
        processNumber,
        item.titulo,
      );
    }
  }


  private async processarDocumento(
    context: DocumentoRequestContext,
    processId: number,
    item: ItensProcesso,
    processNumber: string,
    regionTRT: number,
    instancia: string,
  ): Promise<Documento | null> {
    // Diagnóstico temporário: registra `instanciaId` de todo item (não só
    // os que falham) pra comparar contra `processId` na próxima execução
    // real e confirmar se é mesmo o id do processo apenso/relacionado.
    // Atrás de flag e sem `titulo` — pode conter conteúdo sensível e o log
    // roda pra todo item, não só falhas.
    if (process.env.DEBUG_PJE_DOCUMENT_FETCH === '1') {
      this.logger.debug(
        `🔎 Documento (id=${item.id}): instancia=${item.instancia}, instanciaId=${item.instanciaId}, processId=${processId}`,
      );
    }
    try {
      const { buffer, contentType } = await this.fetchDocumentoComRenovacao(
        context,
        processId,
        item,
        processNumber,
        regionTRT,
        instancia,
      );

      const extension = contentType.includes('pdf') ? 'pdf' : 'html';
      const fileKey = `${normalizeString(item.titulo)}_${item.id}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.${extension}`;

      // Reaproveita o buffer já baixado pro fetch do S3 — evita buscar o
      // mesmo documento duas vezes só pra extrair o texto via Lambda.
      const [texto] = await Promise.all([
        this.lambdaExtractorService
          .extractText(buffer, contentType, {
            titulo: item.titulo,
            idUnicoDocumento: item.idUnicoDocumento,
            processNumber,
          })
          .catch((extractError: unknown) => {
            this.logger.warn(
              `⚠️ Falha ao extrair texto do documento "${item.titulo}" (id=${item.id}) para ${processNumber}: ${this.getErrorMessage(extractError)}`,
            );
            return undefined;
          }),
        this.awsS3Service.uploadS3Object(
          process.env.AWS_S3_BUCKET_NAME as string,
          fileKey,
          buffer,
          contentType,
        ),
      ]);

      if (texto) {
        item.texto = texto;
      }

      const documento: Documento = {
        title: item.titulo,
        temp_link: fileKey,
        uniqueName: item.idUnicoDocumento,
        date: item.data,
      };
      return documento;
    } catch (error: unknown) {
      // `instanciaId`/`processId`/`instancia` aqui são diagnóstico —
      // suspeita de que documentos "não encontrados" no processId atual
      // (`instance.id`) podem pertencer a um processo apenso/relacionado
      // diferente, e `item.instanciaId` (nunca lido hoje) pode ser o id
      // certo pra esses casos. Ainda não confirmado contra payload real.
      this.logger.error(
        `⚠️ Falha ao buscar documento "${item.titulo}" (id=${item.id}, instanciaId=${item.instanciaId}, processId usado=${processId}, instancia=${instancia}) para ${processNumber}: ${this.getErrorMessage(error)}`,
      );
      return null;
    }
  }
}
