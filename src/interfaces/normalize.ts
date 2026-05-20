export interface Root {
  id: number;
  webhookId?: string;
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
  situacoes: unknown[];
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
}

export interface Audiencia {
  data: string;
  audiencia: string;
  situacao: string;
  numero_pessoas: number;
  informacoes_adicionais: unknown;
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
