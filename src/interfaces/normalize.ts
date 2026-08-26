// Tempos de coleta medidos pelo worker e anexados ao payload do webhook.
// Já eram cronometrados para log (`logStageDurations`); mandar junto permite
// que o robo-api saiba ONDE o tempo foi gasto, não só que demorou — sem isso
// o breakdown por estágio só existe no CloudWatch Logs, fora de qualquer
// consulta. Todo campo é opcional: um estágio não alcançado nessa execução
// (ex.: `login` quando documents:false) fica null, e um payload sem
// `timings` continua válido para quem já consome o webhook.
export interface WebhookTimings {
  // Tempo que o job passou parado na fila antes de o worker pegá-lo.
  queueWaitMs: number | null;
  // Duração total do processamento no worker, do início até este envio.
  totalMs: number;
  // Região do TRT extraída do CNJ — dimensão principal da análise por fila.
  trt: number | null;
  // `true` quando a coleta incluiu documentos restritos (exige login).
  documents: boolean;
  // `documentosPublicos` e `documentosRestritos` são MUTUAMENTE EXCLUSIVOS:
  // medem o mesmo trabalho — baixar os documentos — por caminhos diferentes
  // do worker. Com `documents: false` o tempo cai em `documentosPublicos`;
  // com `documents: true` o fluxo de autos baixa públicos e restritos na
  // mesma passada (ProcessDocumentsFindService filtra por `item.documento`,
  // sem separar) e todo o tempo cai em `documentosRestritos`. Um deles é
  // sempre null — o que NÃO significa que nada foi baixado por aquele
  // caminho; significa que aquele caminho não foi o usado.
  stages: {
    login: number | null;
    fetchMovimentacoes: number | null;
    documentosPublicos: number | null;
    documentosRestritos: number | null;
  };
}

export interface Root {
  id: number;
  webhookId: string;
  created_at?: CreatedAt;
  enviar_callback?: string;
  link_api?: string;
  numero_processo?: string;
  resposta?: Resposta;
  status?: string;
  motivo_erro?: string | null;
  status_callback?: string | null;
  tipo?: string;
  opcoes?: Record<string, unknown>;
  tribunal?: Tribunal;
  valor?: string;
  event?: string;
  uuid?: string;
  timings?: WebhookTimings;
}
export interface CreatedAt {
  date: string;
  timezone_type: number;
  timezone: string;
}
export interface Resposta {
  numero_unico?: string;
  origem?: string;
  instancias?: Instancia[];
  message?: string;
}
export interface DocumentoRestrito {
  posicao_id: number;
  titulo: string;
  descricao: string;
  data: string;
  tipo: string;
  unique_name: string;
  suffix: string;
  size: number;
  is_backblaze: boolean;
  is_on_s3: boolean;
  is_compressed: boolean;
  possivel_restrito: boolean;
  paginas: number;
  updated_at: string;
  movid: string | number | null;
  link_api: string;
  hash: string;
}
export interface Instancia {
  id: number;
  url: string;
  sistema: string;
  instancia: string;
  extra_instancia: string;
  tipo_precatorio: string | null;
  segredo: boolean;
  numero: string | null;
  numeros_alternativos: string[];
  assunto: string;
  classe: string;
  area: string;
  data_distribuicao: string;
  orgao_julgador: string;
  moeda_valor_causa: string;
  valor_causa: string;
  arquivado: boolean;
  data_arquivamento: string;
  fisico: boolean | null;
  last_update_time: string;
  situacoes: Record<string, string | number | boolean | null>[];
  dados: Dado[];
  partes: Parte[];
  movimentacoes: Movimentacoes[];
  audiencias: Audiencia[];
  documentos_restritos: DocumentoRestrito[];
  documentos: Documento[];
}

export interface Dado {
  tipo: string;
  valor: string;
}

export interface Parte {
  id: number;
  tipo: string;
  nome: string;
  principal: boolean;
  polo: string;
  documento: Documento;
  advogado_de?: number;
  oabs?: Oab[];
}

export interface Documento {
  tipo?: string;
  numero?: string;
}

export interface Oab {
  numero: string;
  uf: string;
}

export interface Movimentacoes {
  id: number;
  data: string;
  conteudo: string;
  idUnicoDocumento?: string;
  texto?: string;
  pje_doc_id?: number;
  publico?: boolean;
  // Anexos (ex: procuração, estatuto, CNPJ) aninhados nesta movimentação,
  // mesma forma que o PJe já usa.
  anexos?: Movimentacoes[];
}

export interface Audiencia {
  data: string;
  audiencia: string;
  situacao: string;
  numero_pessoas: number;
  informacoes_adicionais: Record<
    string,
    string | number | boolean | null
  > | null;
}

export interface Tribunal {
  sigla?: string;
  nome?: string;
  busca_processo?: number;
  busca_nome?: number;
  busca_oab?: number;
  busca_documento?: number;
  disponivel_autos?: number;
  documentos_publicos?: number;
}
