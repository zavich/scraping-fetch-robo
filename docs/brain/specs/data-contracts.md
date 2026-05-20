# Data Contracts

## Interfaces principais

Arquivo fonte: `src/interfaces/index.ts`

### ProcessosResponse

Resposta principal do PJE para um processo.

```typescript
interface ProcessosResponse {
  // Campos de metadata/captcha
  mensagem: string
  tokenDesafio: string             // token do desafio captcha inline
  itensProcesso: ItensProcesso[]
  grau?: string
  instance: string
  imagem: string                   // base64 da imagem captcha (quando PJE retorna desafio inline)
  resposta: string                 // resposta do captcha

  // Campos do processo
  id: number
  numero: string
  classe: string
  orgaoJulgador: string
  pessoaRelator: string
  segredoJustica: boolean
  justicaGratuita: boolean
  distribuidoEm: string
  autuadoEm: string
  valorDaCausa: number
  poloAtivo: Polo[]
  poloPassivo: Polo[]
  assuntos: Assunto[]
  expedientes: any[]
  juizoDigital: boolean
  documentos_restritos?: DocumentosRestritos[]
  documentos: Documento[]
  mensagemErro?: string            // presente quando PJE retorna erro

  [key: string]: any
}
```

### ItensProcesso

```typescript
interface ItensProcesso {
  documento: boolean
  id: number
  data: string              // ISO date string
  titulo: string
  tipo: string
  publico: boolean
  idUnicoDocumento: string
  instancia: string         // label do grau
  instanciaId: number
}
```

### Polo

```typescript
type Polo = {
  id: number
  tipo: string
  nome: string
  principal?: boolean
  polo: string
  documento: string
  tipoDocumento?: string
  advogado_de?: number
  representantes?: Polo[]
  papeis?: Papeis[]
  endereco?: Endereco
  oabs?: OAB[]
  login?: string             // CPF ou CNPJ
}
```

### DocumentosRestritos

```typescript
type DocumentosRestritos = {
  documentoId: number
  posicao_id?: number
  titulo?: string
  descricao?: string
  data: string
  unique_name?: string
  link_api?: string
  instancia: string
  instanciaId: number
  tipo?: string
  match?: RegExp
  idUnicoDocumento: string
}
```

### Documento

```typescript
type Documento = {
  title: string
  temp_link: string         // chave S3 (NAO e URL completa)
  uniqueName: string
  date: string
}
```

---

## Interfaces de webhook (saida)

Arquivo fonte: `src/interfaces/normalize.ts`

### Root (payload enviado para robo-api)

```typescript
interface Root {
  id: number                    // numero aleatorio de 11 digitos
  created_at?: {
    date: string                // "YYYY-MM-DD HH:MM:SS" (UTC)
    timezone_type: number       // sempre 3
    timezone: string            // sempre "UTC"
  }
  enviar_callback?: string
  link_api?: string
  numero_processo?: string
  resposta?: Resposta
  status?: string               // "SUCESSO" | "NAO_ENCONTRADO"
  motivo_erro?: any             // "SEM_DADOS" quando nao encontrado
  status_callback?: any
  tipo?: string                 // "BUSCA_PROCESSO"
  opcoes?: {
    documento: boolean          // true se resultado de documentos
    origem?: string             // "TST" se origem TST
    autos?: true                // presente quando isDocument=true
  }
  tribunal?: Tribunal
  valor?: string                // = numero_processo (campo redundante)
  event?: string
  uuid?: string
}
```

### Resposta

```typescript
interface Resposta {
  numero_unico?: string
  origem?: string               // "TST" ou "TRT-{N}"
  instancias?: Instancia[]
  message?: string              // ex: "Nenhum resultado encontrado"
}
```

### Instancia

```typescript
interface Instancia {
  id: number
  url: string
  sistema: string
  instancia: string
  extra_instancia: string
  tipo_precatorio: any
  segredo: boolean
  numero: any
  numeros_alternativos: any[]
  assunto: string
  classe: string
  area: string
  data_distribuicao: string
  orgao_julgador: string
  moeda_valor_causa: string
  valor_causa: string
  arquivado: boolean
  data_arquivamento: string
  fisico: any
  last_update_time: string
  situacoes: any[]
  dados: Dado[]
  partes: Parte[]
  movimentacoes: Movimentacoes[]
  audiencias: Audiencia[]
  documentos_restritos: DocumentoRestrito[]
  documentos: Documento[]
}
```

### Movimentacoes

```typescript
interface Movimentacoes {
  id: number
  data: string
  conteudo: string
  idUnicoDocumento?: string
}
```

### DocumentoRestrito (saida normalizada)

```typescript
interface DocumentoRestrito {
  posicao_id: number
  titulo: string
  descricao: string
  data: string
  tipo: string
  unique_name: string
  suffix: string
  size: number
  is_backblaze: boolean
  is_on_s3: boolean
  is_compressed: boolean
  possivel_restrito: boolean
  paginas: number
  updated_at: string
  movid: any
  link_api: string
  hash: string
}
```

---

## Enum: ProcessDocumentType

Arquivo: `src/interfaces/process-document.enum.ts`

```typescript
enum ProcessDocumentType {
  HomologacaoDeCalculo, PeticaoInicial, AdmissibilidadeRR,
  HomologacaoDeAcordo, RRReclamada, RecursoDeRevista,
  SentencaMerito, SentencaED, SentencaEE, Acordao,
  AcordaoMerito, AcordaoED, AcordaoAP, AcordaoTRT,
  RRAP, EmendaAInicial, Alvara, PlanilhaCalculo,
  Parcelamento916, Impugnacao, Garantia, Decisao
}
```

**Nota**: definido mas NAO importado/usado em nenhum lugar do codebase atual (codigo morto ou planejado).

---

## LoginResponse (resposta do PJE /api/auth)

```typescript
interface LoginResponse {
  instancia: string
  papel: string
  interno: boolean
  access_token: string
  refresh_token: string
  token_type: string
  expires_in: number          // TTL em segundos para a sessao
  xsrf_token: string
}
```

**Cookie string gerado**: `access_token_1g={access_token}; refresh_token_1g={refresh_token}; instancia={instancia}`
