# API Contracts

## Base

- Framework: NestJS 11
- Porta: 3000
- Sem prefixo global

---

## GET /health

- **Auth**: nenhuma
- **Response**: `{ status: 'ok' }` (HTTP 200)

---

## POST /processos/:numero

Enfileira processo para scraping.

- **Auth**: nenhuma
- **Params**: `numero: string` (numero CNJ)
- **Body**:
  ```typescript
  {
    documents?: boolean,   // buscar documentos alem de movimentacoes
    origem?: string,       // "TST" para fila TST, undefined para TRT
    webhook?: string,      // URL webhook override (default: WEBHOOK_URL + '/process/webhook')
    priority?: boolean     // true = prioridade 0, false = prioridade 5
  }
  ```
- **Response (200)**:
  ```typescript
  { fila: string, numero: string, origem: string }
  ```
- **Logica de fila**: `origem === 'TST'` → `pje-tst`. Senao extrai digitos 14-15 do CNJ → `pje-trt{N}`.
- **Deduplicacao**: se ja existe job com mesmo `jobId` (= numero), o job antigo e removido antes de adicionar o novo.
- **Response (400)**: `BadRequestException`

---

## POST /processos/extract-by-id

Extrai paginas especificas de um PDF por bookmark ID.

- **Auth**: nenhuma
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `file`: buffer do PDF
  - `documentId`: string (ID do bookmark)
- **Response (200)**: binary PDF
  - `Content-Type: application/pdf`
  - `Content-Disposition: attachment; filename=extracted_{documentId}.pdf`
- **Response (400)**: `{ error: string }`
- **Response (404)**: `{ error: string }`
- **Response (500)**: `{ error: string }`

---

## POST /processos/list-bookmarks

Lista bookmarks (indices de documentos) dentro de um PDF.

- **Auth**: nenhuma
- **Content-Type**: `multipart/form-data`
- **Body**:
  - `file`: buffer do PDF
- **Response (200)**: JSON array de objetos bookmark
- **Response (400/500)**: `{ error: string }`

---

## POST /processos/auth/login/:trt

Endpoint de teste/debug — forca login no TRT especificado.

- **Auth**: nenhuma
- **Params**: `trt: number`
- **Response**: resultado do `LoginPoolService.getCookies()`
- **Nota**: usa numero de processo hardcoded `'0011054-02.2024.5.03.0102'` internamente

---

## DELETE /processos/redis/:queue/clear

Limpa uma fila BullMQ especifica.

- **Auth**: nenhuma
- **Params**: `queue: string` (nome da fila)
- **Response**: void

---

## DELETE /processos/redis/flush-all

Flush completo do Redis.

- **Auth**: nenhuma
- **Response**: void
- **CUIDADO**: apaga TODAS as chaves Redis, incluindo sessoes e filas

---

## POST /processos/redis/reprocess-failed

Reprocessa todos os jobs falhados de todas as filas.

- **Auth**: nenhuma
- **Response**: `{ message: 'Reprocessamento concluído.' }`

---

## POST /receita-federal

Gera certidao CNPJ da Receita Federal.

- **Auth**: `ApiKeyAuthGuard` (header `Authorization` obrigatorio)
- **Query**: `cnpj: string`
- **Response (200)**: binary PDF
  - `Content-Type: application/pdf`
  - `Content-Disposition: inline; filename="{cnpj}.pdf"`
  - `Content-Length: N`
- **Response (404)**: `{ message: 'CNPJ não encontrado ou inválido.' }`

---

## POST /receita-federal/cndt

Inicia busca de CNDT (fire-and-forget).

- **Auth**: `ApiKeyAuthGuard`
- **Query**: `cnpj: string`
- **Response (200)**: `{ message: 'Processo iniciado' }`
- **Nota**: servico roda async, caller recebe resposta imediata sem aguardar resultado
- **Webhook**: resultado enviado para `WEBHOOK_URL + '/company/webhook?type=cndt'`

---

## ApiKeyAuthGuard

- Verifica presenca do header `Authorization`
- **NAO valida o valor** — apenas verifica `if (!authHeader)` e retorna `true`
- Arquivo: `src/guards/api-key.guard.ts`
