# Queue Contracts

## Visao geral

49 filas BullMQ: 24 scraping TRT + 24 documentos TRT + 1 TST.

---

## Filas de processo (pje-trt1..24, pje-tst)

### Job: `consulta-processo`

**Payload de entrada**:
```typescript
{
  numero: string,       // numero CNJ ex: "0000001-00.2024.5.03.0000"
  origem?: string,      // "TST" ou undefined
  documents?: boolean,  // buscar documentos, default false
  webhook?: string      // URL webhook override
}
```

**Opcoes BullMQ**:
```typescript
{
  jobId: numero,             // chave de deduplicacao = numero do processo
  attempts: 3,
  priority: priority ? 0 : 5,
  backoff: { type: 'fixed', delay: 5000 },
  removeOnFail: false,       // jobs falhados permanecem na fila
  removeOnComplete: true     // jobs completos sao removidos
}
```

**Selecao de fila**:
- `origem === 'TST'` → `pje-tst`
- Senao: extrai digitos 14-15 do formato CNJ → `pje-trt{N}`

**Deduplicacao**: se existe job com mesmo `jobId`, e removido antes de adicionar o novo.

### Worker: GenericProcessoWorker

**Concorrencia**:

| Filas | Concorrencia | lockDuration | stalledInterval | limiter |
|-------|-------------|-------------|-----------------|---------|
| pje-trt3, pje-trt9, pje-tst | 1 | 120000ms (2 min) | 30000ms | 3 req/1000ms |
| Demais TRTs | 3 | 120000ms (2 min) | 30000ms | 3 req/1000ms |

**Fluxo do worker**:
1. Verifica saldo 2Captcha (`getBalance()`). Se < 0.001, **aborta imediatamente**.
2. Obtem cookies via `LoginPoolService.getCookies(trt)`.
3. Para TRT3 e TRT9: usa `ScrapingService` (Puppeteer + WAF bypass).
4. Demais TRTs: usa `FetchUrlMovimentService` (HTTP direto).
5. Normaliza resposta com `normalizeResponse()`.
6. Envia webhook com resultado.
7. Se `documents === true`: enfileira job de documentos com delay de 2s.

**Webhook enviado** (ver `specs/inter-service.md` para payload completo):
- URL: `webhook ?? process.env.WEBHOOK_URL + '/process/webhook'`
- Metodo: POST
- Auth: nenhuma

**Enfileiramento de documentos** (inline do worker, NAO via ConsultarProcessoDocumentoQueue):
```typescript
{
  numero: string,
  instances: ProcessosResponse[],
  pdfBase64: string | undefined    // PDF integra em base64
}
// jobId: numero (sem sufixo '-docs')
// attempts: 2 (NAO 3)
// backoff: { type: 'fixed', delay: 5000 }
```

---

## Filas de documentos (pje-documentos-trt1..24)

### Job: `consulta-documentos`

**Payload de entrada**:
```typescript
{
  numero: string,
  instances: ProcessosResponse[],
  pdfBase64: string | undefined
}
```

**Via ConsultarProcessoDocumentoQueue (acesso direto)**:
```typescript
{
  jobId: `${numero}-docs`,
  attempts: 3,
  backoff: { type: 'fixed', delay: 5000 },
  removeOnComplete: true,
  removeOnFail: false
}
```

### Worker: GenericDocumentosWorker

| Configuracao | Valor |
|-------------|-------|
| Concorrencia | **100** (NAO 3 como docs anteriores diziam) |
| lockDuration | **600000ms (10 min)** |
| stalledInterval | Nao configurado |
| limiter | Nao configurado |

**Nota**: usa property injection (`@Inject` em campos de classe), nao constructor injection.

**Fluxo do worker**:
1. Busca URLs de documentos via `ProcessDocumentsFindService`.
2. Download do PDF integra (se nao veio no job como `pdfBase64`).
3. Extrai paginas por bookmark via `PdfExtractService`.
4. Upload para S3 com AES256.
5. Limpa chaves Redis: `pje:token:captcha:{numero}*` e `tokencaptcha:{numero}*`.
6. Envia webhook com resultado (documentos como `Documento[]`).

**S3 key format**: `{normalizeString(title)}_{index}_{timestamp}_{random6chars}.pdf`

---

## HTTP Retry (FetchUrlService)

| Configuracao | Valor |
|-------------|-------|
| Retry status codes | HTTP 429, 403 |
| Max attempts (geral) | 5 |
| Max attempts (TRT15) | 7 |
| TRT15 especial | Limpa captcha token apos attempt 1 |
| Captcha retry | Ate 3 tentativas, delay `300ms * attempt` |

---

## Rate Limiting Global

- 3 requisicoes por segundo por fila (via BullMQ limiter: `{ max: 3, duration: 1000 }`).
- Apenas filas de processo tem limiter. Filas de documento NAO tem limiter.
