import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { ScrapingService } from 'src/helpers/scraping.service';
import { Documento, ItensProcesso, ProcessosResponse } from 'src/interfaces';
import { flattenItensProcesso } from 'src/utils/flatten-itens-processo';
import { normalizeString } from 'src/utils/normalize-string';
import { FetchUrlMovimentService } from './fetch-url.service';
import { LoginPoolService } from './login-pool.service';
import { ProcessDocumentsFindService } from './process-documents-find.service';

const CNJ_PATTERN = /^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/;

// Teto de segurança: a rota é para medir tempo de um documento específico,
// não para virar um caminho paralelo de coleta em massa fora da fila.
const LIMITE_MAXIMO = 20;
const LIMITE_PADRAO = 1;

export interface BenchmarkDocumentoInput {
  numero: string;
  // Texto procurado no título/tipo do documento (ex.: "petição inicial").
  // Comparado sem acento e sem diferenciar maiúsculas.
  termo?: string;
  // Lista os candidatos e para por aí, sem baixar nada. Serve para descobrir
  // como o documento se chama naquele TRT antes de medir o download — o
  // título varia entre tribunais.
  apenasListar?: boolean;
  limite?: number;
  // Documentos restritos exigem sessão autenticada. Petição inicial quase
  // sempre é restrita, então o padrão é logar.
  comLogin?: boolean;
  origem?: string;
}

export interface DocumentoCandidato {
  titulo: string;
  tipo: string;
  instancia: string;
  idUnicoDocumento: string;
  publico: boolean;
}

export interface BenchmarkDocumentoResultado {
  numero: string;
  trt: number;
  termo: string | null;
  comLogin: boolean;
  // Todos os documentos que casaram com o termo, antes do corte do limite.
  candidatos: DocumentoCandidato[];
  // Quantos foram efetivamente buscados (candidatos cortados pelo limite).
  tentados: number;
  baixados: number;
  documentos: { titulo: string; uniqueName: string; caracteresTexto: number }[];
  temposMs: {
    waf: number | null;
    login: number | null;
    movimentacoes: number;
    filtro: number;
    download: number | null;
    total: number;
  };
}

// Executa o mesmo caminho de coleta de documento que o worker roda em
// produção, porém SÍNCRONO e sem webhook: quem chamou recebe o resultado e os
// tempos na própria resposta HTTP. Existe para medir performance de um
// documento específico (ex.: só a petição inicial) sem esperar a fila nem
// caçar o tempo no log depois.
//
// O que ela NÃO faz de propósito, para que o número medido signifique algo:
//   - não enfileira: roda inline, então o tempo não inclui espera de fila;
//   - não envia webhook: nada é publicado no robo-api a partir daqui;
//   - não muda o serviço de download — passa pelo mesmo
//     `ProcessDocumentsFindService` de produção, só que com a lista de itens
//     já filtrada, para que o tempo medido seja o tempo real daquele caminho.
@Injectable()
export class BenchmarkDocumentoService {
  private readonly logger = new Logger(BenchmarkDocumentoService.name);

  constructor(
    private readonly fetchUrlMovimentService: FetchUrlMovimentService,
    private readonly loginPool: LoginPoolService,
    private readonly processDocsService: ProcessDocumentsFindService,
    private readonly scrapingService: ScrapingService,
  ) {}

  async execute(
    input: BenchmarkDocumentoInput,
  ): Promise<BenchmarkDocumentoResultado> {
    const iniciadoEm = Date.now();
    const trt = this.extrairTrt(input.numero);
    const comLogin = input.comLogin ?? true;
    const limite = this.resolverLimite(input.limite);
    const termo = input.termo?.trim() || null;

    const temposMs: BenchmarkDocumentoResultado['temposMs'] = {
      waf: null,
      login: null,
      movimentacoes: 0,
      filtro: 0,
      download: null,
      total: 0,
    };

    // TRT3 e TRT9 exigem passar pelo grid do AWS WAF antes de qualquer
    // requisição — mesmo pré-passo que o worker faz. Sem isso a medição
    // nesses tribunais falharia por 403, não por lentidão.
    if (trt === 3 || trt === 9) {
      const inicio = Date.now();
      await this.scrapingService.execute(input.numero, trt, 1);
      temposMs.waf = Date.now() - inicio;
    }

    let cookies: string | undefined;
    if (comLogin) {
      const inicio = Date.now();
      const sessao = await this.loginPool.getCookies(trt, input.numero);
      temposMs.login = Date.now() - inicio;

      if (!sessao?.cookies) {
        throw new BadRequestException(
          `Não foi possível autenticar no TRT-${trt} — todas as contas do pool estão indisponíveis ou bloqueadas.`,
        );
      }
      cookies = sessao.cookies;
    }

    const inicioMovimentacoes = Date.now();
    const instancias = await this.fetchUrlMovimentService.execute(
      input.numero,
      input.origem,
      cookies,
    );
    temposMs.movimentacoes = Date.now() - inicioMovimentacoes;

    if (!instancias?.length) {
      temposMs.total = Date.now() - iniciadoEm;
      return {
        numero: input.numero,
        trt,
        termo,
        comLogin,
        candidatos: [],
        tentados: 0,
        baixados: 0,
        documentos: [],
        temposMs,
      };
    }

    const inicioFiltro = Date.now();
    const selecionados = this.selecionarItens(
      instancias as ProcessosResponse[],
      termo,
    );
    temposMs.filtro = Date.now() - inicioFiltro;

    const candidatos = selecionados.map(({ item }) => this.descrever(item));

    if (input.apenasListar || selecionados.length === 0) {
      temposMs.total = Date.now() - iniciadoEm;
      return {
        numero: input.numero,
        trt,
        termo,
        comLogin,
        candidatos,
        tentados: 0,
        baixados: 0,
        documentos: [],
        temposMs,
      };
    }

    const paraBuscar = selecionados.slice(0, limite);
    this.logger.log(
      `⏱ Benchmark ${input.numero}: ${candidatos.length} candidato(s) para "${
        termo ?? 'qualquer documento'
      }", baixando ${paraBuscar.length}.`,
    );

    const instanciasPodadas = this.podarInstancias(
      instancias as ProcessosResponse[],
      paraBuscar,
    );

    const inicioDownload = Date.now();
    const resultado = await this.processDocsService.execute(
      input.numero,
      instanciasPodadas,
      trt,
    );
    temposMs.download = Date.now() - inicioDownload;
    temposMs.total = Date.now() - iniciadoEm;

    const documentos = this.extrairDocumentos(resultado, paraBuscar);

    return {
      numero: input.numero,
      trt,
      termo,
      comLogin,
      candidatos,
      tentados: paraBuscar.length,
      baixados: documentos.length,
      documentos,
      temposMs,
    };
  }

  private extrairTrt(numero: string): number {
    const match = CNJ_PATTERN.exec(numero ?? '');
    if (!match) {
      throw new BadRequestException(
        `Número de processo inválido: "${numero}". Formato esperado: 0000000-00.0000.0.00.0000`,
      );
    }
    return Number(match[1]);
  }

  private resolverLimite(limite?: number): number {
    if (limite == null) return LIMITE_PADRAO;

    if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) {
      throw new BadRequestException(
        `"limite" deve ser um inteiro entre 1 e ${LIMITE_MAXIMO}.`,
      );
    }
    return limite;
  }

  // Achata para alcançar anexos aninhados e mantém só o que é documento de
  // verdade — item de movimentação puramente textual não tem o que baixar.
  private selecionarItens(
    instancias: ProcessosResponse[],
    termo: string | null,
  ): { instanciaIndex: number; item: ItensProcesso }[] {
    const termoNormalizado = termo ? normalizeString(termo) : null;
    const selecionados: { instanciaIndex: number; item: ItensProcesso }[] = [];

    instancias.forEach((instancia, instanciaIndex) => {
      const itens = flattenItensProcesso(instancia.itensProcesso ?? []);

      for (const item of itens) {
        if (!item?.documento) continue;
        if (termoNormalizado && !this.casa(item, termoNormalizado)) continue;

        selecionados.push({ instanciaIndex, item });
      }
    });

    return selecionados;
  }

  private casa(item: ItensProcesso, termoNormalizado: string): boolean {
    const alvo = normalizeString(`${item.titulo ?? ''} ${item.tipo ?? ''}`);
    return alvo.includes(termoNormalizado);
  }

  // Devolve as instâncias com `itensProcesso` reduzido aos itens escolhidos.
  // `anexos` é zerado de propósito: o serviço de download achata a árvore
  // inteira, e manter os anexos faria baixar documentos que não foram
  // pedidos — inflando o tempo medido com trabalho que não é o do teste.
  private podarInstancias(
    instancias: ProcessosResponse[],
    selecionados: { instanciaIndex: number; item: ItensProcesso }[],
  ): ProcessosResponse[] {
    const itensPorInstancia = new Map<number, ItensProcesso[]>();

    for (const { instanciaIndex, item } of selecionados) {
      const lista = itensPorInstancia.get(instanciaIndex) ?? [];
      // Espalha num objeto novo só para soltar os anexos; `texto` continua
      // sendo escrito neste objeto pelo serviço de download, e é dele que a
      // contagem de caracteres sai no final.
      lista.push({ ...item, anexos: undefined });
      itensPorInstancia.set(instanciaIndex, lista);
    }

    return instancias
      .map((instancia, indice) => ({
        ...instancia,
        itensProcesso: itensPorInstancia.get(indice) ?? [],
      }))
      .filter((instancia) => instancia.itensProcesso.length > 0);
  }

  private descrever(item: ItensProcesso): DocumentoCandidato {
    return {
      titulo: item.titulo ?? '',
      tipo: item.tipo ?? '',
      instancia: item.instancia ?? '',
      idUnicoDocumento: item.idUnicoDocumento ?? String(item.id ?? ''),
      publico: Boolean(item.publico) && !item.documentoSigiloso,
    };
  }

  // O serviço de download devolve as instâncias com `documentos` preenchido;
  // todas carregam a mesma lista, então basta olhar a primeira.
  private extrairDocumentos(
    instancias: ProcessosResponse[],
    selecionados: { item: ItensProcesso }[],
  ): { titulo: string; uniqueName: string; caracteresTexto: number }[] {
    const baixados: Documento[] = instancias[0]?.documentos ?? [];
    const textoPorTitulo = new Map(
      selecionados.map(({ item }) => [item.titulo, item.texto?.length ?? 0]),
    );

    return baixados.map((documento) => ({
      titulo: documento.title,
      uniqueName: documento.uniqueName,
      caracteresTexto: textoPorTitulo.get(documento.title) ?? 0,
    }));
  }
}
