# Runtime: Redis

## Papel

Redis e o backbone de estado do scraping-fetch-robo. Usado para filas BullMQ, sessoes, locks e cache.

## Conexao

- `REDIS_URL` (variavel de ambiente): URL completa de conexao.
- `maxRetriesPerRequest: null` (obrigatorio para BullMQ, configurado em `redis.module.ts`).
- Conexao compartilhada entre BullMQ e servicos de sessao.

## Tabela completa de chaves

### Sessoes PJE

| Chave | Tipo | TTL | Operacao SET | Conteudo | Descricao |
|-------|------|-----|-------------|----------|-----------|
| `pje:session:{trt}` | String | 3600s (ou `login.expires_in` da API PJE) | `SET ... EX {ttl}` | Cookie string: `access_token_1g={token}; refresh_token_1g={token}; instancia={val}` | Sessao PJE reutilizada entre workers |
| `pje:session:{trt}:ready` | String | 30s | `SET ... EX 30` | `'1'` | Sinal para workers aguardando que cookie esta pronto |

### Locks

| Chave | Tipo | TTL | Operacao SET | Conteudo | Descricao |
|-------|------|-----|-------------|----------|-----------|
| `pje:lock:{trt}` | String | 60000ms | `SET ... NX PX 60000` | `'1'` | Mutex para evitar login concorrente no mesmo TRT. Flag NX = so seta se nao existe |

### Cache WAF

| Chave | Tipo | TTL | Operacao SET | Conteudo | Descricao |
|-------|------|-----|-------------|----------|-----------|
| `aws-waf-token:{processNumber}` | String | **7200s** | `SET ... EX 7200` | Cookie string: `aws-waf-token={value}` | Token WAF resolvido e reutilizado entre scraping de movimentos/documentos |

### Cache Captcha

| Chave | Tipo | TTL | Operacao SET | Conteudo | Descricao |
|-------|------|-----|-------------|----------|-----------|
| `tokencaptcha:{processNumber}:{instance}` | String | 86400s (24h) | `SET ... EX 86400` | Token captcha do header `captchatoken` da resposta PJE | Cache de tokens captcha por instancia |
| `pje:token:captcha:{processNumber}:{grau}` | String | N/A (somente leitura) | Nao e escrito no codigo atual | Token captcha | Reutilizacao de token captcha entre instancias |

### Headers (legado)

| Chave | Tipo | TTL | Operacao SET | Conteudo | Descricao |
|-------|------|-----|-------------|----------|-----------|
| `headers:{regionTRT}` | String | Desconhecido | Path de escrita esta COMENTADO | JSON string de headers HTTP | Headers reais capturados do browser (nao escrito no codigo atual) |

### Limpeza (DELETE patterns)

| Pattern | Quando | Descricao |
|---------|--------|-----------|
| `pje:token:captcha:{numero}*` | Apos document worker finalizar | Limpa cache de captcha do processo |
| `tokencaptcha:{numero}*` | Apos document worker finalizar | Limpa cache de captcha do processo |

### BullMQ (gerenciadas automaticamente)

| Padrao | Descricao |
|--------|-----------|
| `bull:pje-trt{N}:*` | Dados da fila de scraping do TRT N |
| `bull:pje-documentos-trt{N}:*` | Dados da fila de documentos do TRT N |
| `bull:pje-tst:*` | Dados da fila do TST |

## Filas BullMQ

Total: 49 filas.

- `pje-trt1` a `pje-trt24`: scraping de processos (24 filas).
- `pje-documentos-trt1` a `pje-documentos-trt24`: extracao de documentos (24 filas).
- `pje-tst`: scraping do TST (1 fila).

### Concorrencia por fila

| Filas | Concorrencia | lockDuration | stalledInterval | limiter |
|-------|-------------|-------------|-----------------|---------|
| `pje-trt3`, `pje-trt9`, `pje-tst` | 1 | 120000ms (2 min) | 30000ms | 3 req/1000ms |
| Demais TRTs | 3 | 120000ms (2 min) | 30000ms | 3 req/1000ms |
| Documentos (todos) | `BROWSER_POOL_SIZE * 5` | **600000ms (10 min)** | Nao configurado | Nao configurado |

### Job options por tipo

| Tipo | attempts | backoff | removeOnFail | removeOnComplete |
|------|----------|---------|-------------|-----------------|
| Processo (via ConsultarProcessoQueue) | 3 | fixed 5000ms | 500 jobs / 7 dias | 1000 jobs |
| Documento (via ConsultarProcessoDocumentoQueue) | 3 | fixed 5000ms | 500 jobs / 7 dias | 1000 jobs |
| Documento (inline do process worker) | **3** | exponential 5000ms | 500 jobs / 7 dias | 1000 jobs |

## Debug

- `redis-cli` para inspecionar chaves.
- `KEYS pje:session:*` para listar sessoes ativas.
- `TTL pje:lock:{trt}` para verificar se lock esta ativo.
- `KEYS aws-waf-token:*` para listar tokens WAF cacheados.
- `KEYS tokencaptcha:*` para listar tokens captcha cacheados.
- Bull Board (`/bull-board` em ambientes nao-production) para visao das filas.
