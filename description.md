# Refatoracao scraping-fetch-robo — Escopo Completo do PR

> **AVISO PARA REVISORES**
>
> Este PR e grande **por design**. O escopo foi definido desde o inicio, baseado em uma auditoria estruturada de 58 achados nos 3 servicos (`scraping-fetch-robo`, `robo-api`, `painel-robo`), documentada em 7 arquivos `MELHORIAS-*.md` na raiz do diretorio pai (`robo_coleta/`).
>
> **Este branch ja passou por 5-6 rodadas de code review profundos** (registradas em `robo_coleta/review/v1-*.md` ate `review/v5-*.md`). Cada rodada identificou ate dezenas de issues, fechou todos os blockers das rodadas anteriores e introduziu um conjunto cada vez menor de novos achados. Saimos de **22 blockers v1 -> 6 blockers v2 -> 1 blocker v3 -> 0 blockers v4 e v5**.
>
> Por causa desse historico, **qualquer review feito a partir de agora deve ser O MAIS APROFUNDADO POSSIVEL**: bugs de superficie ja foram filtrados; o que sobrou ou e nuance dificil de pegar, ou e contexto faltando no review. Tempo gasto em revisao sera bem investido. Reviews superficiais (so olhar o diff sem cruzar com o resto do sistema) provavelmente vao perder o ponto.

---

## Contexto da refatoracao

O `scraping-fetch-robo` e um servico NestJS que roda Puppeteer para coletar dados de processos judiciais do PJE (Tribunais Regionais do Trabalho — TRT — brasileiros), alem de TST. Ele:
- Mantem login pool em ate 6 contas PJE rotacionadas
- Resolve captchas via 2Captcha
- Coleta movimentacoes e documentos
- Envia webhooks para o `robo-api` com sucesso, erro, ou nao-encontrado

A equipe (Pedro e Rafael) reportou dois problemas criticos em producao, e o `scraping-fetch-robo` esta no centro dos dois:

1. **Containers instaveis** — o servico reinicia frequentemente (memory leaks Puppeteer, Chrome zombies, health check fake), perdendo jobs em andamento.
2. **Processos falhando silenciosamente** — erros do PJE eram silenciados (o webhook so era enviado para HTTP 503), deixando processos em limbo no robo-api.

A auditoria revelou 58 achados no total. Do total, **22 sao responsabilidade do `scraping-fetch-robo`** — concentrados em estabilidade, bugs criticos de webhook e arquitetura do browser pool.

---

## O que mudou no `scraping-fetch-robo` neste PR

### Bugs criticos resolvidos

| ID | Descricao | Arquivos |
|----|-----------|----------|
| BUG-001 | Webhook so era enviado para HTTP 503; outros erros (401, 403, 500, timeout, rede) eram silenciados | `pje/queues/wokers/processos-trt.worker.ts` (catch reescrito para sempre enviar webhook com codigo HTTP em log + try/catch proprio no envio para nao suprimir o erro original) |
| BUG-003 | `resolveCaptcha()` retornava `{} as CaptchaResult` em timeout — codigo consumidor proseguia com `resposta === undefined` | `services/captcha.service.ts` (substituido por `throw new Error(...)` em todos os caminhos; tipo mantido como `Promise<CaptchaResult>`) |
| BUG-006 | No worker de documentos, se `axios.post(webhookUrl)` no catch falhasse, o `finally` ignorava e job ia para sucesso | `pje/queues/wokers/documentos-trt.worker.ts` (try/catch proprio no envio, re-throw para BullMQ retentar) |
| BUG-007 | Race conditions no login pool (lock TTL 15s curto, validacao JWT por regex `/access_token/`) | `pje/services/login-pool.service.ts` (lock TTL 60s, validacao de estrutura JWT, rotacao protegida por estado do lock) |
| BUG-001 (silent worker) | Worker falhava sem enviar erro algum em alguns paths | `documentos-trt.worker.ts` (early returns viraram `throw new Error(...)` apos envio do webhook) |
| BRN-SCR-1 | Webhook duplicado em sucesso + falha tardia | `processos-trt.worker.ts:279` (guard `if (successWebhookSent) throw` — sem `documents &&` quebrado anterior) |

### Estabilidade (causa raiz do problema #1)

| ID | Descricao | Arquivos |
|----|-----------|----------|
| EST-001 | Health check `GET /health` sempre retornava 200 sem checar dependencias | `health.controller.ts` (verifica Redis, browser, RSS com OOM threshold) |
| EST-002 | Memory leaks Puppeteer — pages/contexts nao fechavam em cenarios de erro | `utils/browser.manager.ts` (cleanup em `finally`, `closeAll()` em shutdown) |
| EST-003 | Chrome zombies sem safeguards | `browser.manager.ts` (`MAX_CONTEXTS_PER_BROWSER = 200`, recriacao de slot apos limite) |
| EST-004 | Sem handlers para `unhandledRejection`/`uncaughtException` | `main.ts` |
| EST-005 | Redis connection loss sem reconnection strategy | `redis.module.ts` |
| EST-006 | `removeOnFail: false` — jobs falhos acumulavam no Redis | `processos-trt.worker.ts:271`, `documentos-trt.worker.ts` (`removeOnFail: { count: 500, age: 7 * 24 * 3600 }`) |
| BRN-SCR-2 | Shutdown ficava com 1 slot Puppeteer ativo | `browser.manager.ts` (`closeAll()` itera o pool inteiro) |
| BRN-SCR-3 | Round-robin no health check (mutava state) | `browser.manager.ts` (snapshot read-only) |
| BRN-SCR-5 | `aws-waf-token` quebrado em TRT3/9 | `redis.service.ts` (`redis.set` no momento certo do fluxo) |
| BRN-SCR-6 | `opcoes.documento=true` mis-tag em jobs | `processos-trt.worker.ts` (tagging corrigido) |
| BRN-SCR-8 | Viewport mismatch entre `defaultViewport: null` e `setViewport(1366x768)` | `browser.manager.ts:79` (`defaultViewport: PAGE_VIEWPORT`, removido `setViewport` redundante) |

### Performance

| ID | Descricao | Arquivos |
|----|-----------|----------|
| PERF-001 | Browser singleton bottleneck para 49 filas | `utils/browser.manager.ts` (pool configuravel via `BROWSER_POOL_SIZE` env, round-robin atomico via `getNextSlotIndex`) |
| V2-SCR-7 | `redis.keys('failed:*')` bloqueava event loop | `services/redis.service.ts:73-91` (novo `scanKeys` privado com `SCAN cursor MATCH pattern COUNT 100`) |
| V2-SCR-8 | Double `setRequestInterception` em algumas paginas | `browser.manager.ts:222-247` (`ensureRequestInterception` com WeakSet guard) |

### Arquitetura

| ID | Descricao | Arquivos |
|----|-----------|----------|
| ARQ-005 | Sem correlation IDs end-to-end | `processos-trt.worker.ts:228`/`documentos-trt.worker.ts:30-34` propagam `correlationId` em job data, header `x-correlation-id` no webhook, e `webhookId` por evento (`${correlationId}:movements-success`, `:autos-error`, etc.) |
| V2-SCR-2 | `jobId: numero` causava colisao de retries em 7 dias | `processos-trt.worker.ts:268` (`jobId: ${numero}:${correlationId}`) |
| V2-SCR-4 | `correlationId` nao propagado para worker de documentos | `documentos-trt.worker.ts` agora recebe `correlationId` do parent |
| V2-SCR-5 | Early returns marcavam job como sucesso em estado degradado | `documentos-trt.worker.ts:63, 82, 103` (substituidos por `throw new Error(...)`) |

### Infra e deploy

- `task-definition.json` sanitizado: todos os ARNs/account IDs/secret names substituidos por placeholders `<AWS_*>`
- `scripts/render-task-definition.mjs` (NOVO) renderiza template usando `process.env`, com `fileURLToPath` (compativel com Node 18 do Dockerfile)
- `.github/workflows/deploy.yml` agora le account ID, regiao, ECR repo, cluster, service, family, container, role ARNs, secret manager ID e Redis URL fingerprint todos de `secrets.*`

### Brain docs (`docs/brain/`)

Reconciliacao para refletir o estado real do codigo:
- `engineering/infrastructure.md`, `engineering/testing.md`
- `runtime/health-checks.md`, `runtime/redis.md`, `runtime/browser-pool.md`, `runtime/login-pool.md`
- `specs/browser-config.md`, `specs/inter-service.md`, `specs/env-vars.md`

`inter-service.md` agora documenta corretamente:
- Header `x-service-key: ${WEBHOOK_SERVICE_KEY}` (a doc antiga falava "Auth: nenhuma" — erro grave corrigido)
- `webhookId` formato `{correlationId}:event-name` em todos os payloads de sucesso e erro

### Testes

- `services/redis.service.spec.ts` (NOVO, cobre `SCAN`, `reprocessAllFailedJobs`, `flushdb`)

---

## Estatisticas do diff (rough)

- **~15 arquivos novos** (specs, brain docs, render script)
- **~25 arquivos modificados** (workers, browser manager, services, module)
- **~2500 linhas adicionadas, ~700 removidas** (sem yarn.lock)
- **3 testes** passando (`yarn test --runInBand`)

---

## Como revisar (sugestao)

Por causa do tamanho, sugiro revisao por dominio:

1. **Browser pool e estabilidade** — `utils/browser.manager.ts`, `main.ts`. Esse e o coracao da estabilidade. Le com cuidado o ciclo `getNextSlotIndex` -> `getOrCreateBrowserSlot` -> `MAX_CONTEXTS_PER_BROWSER` reset; entenda o `WeakSet` no `ensureRequestInterception`.
2. **Workers** — `pje/queues/wokers/processos-trt.worker.ts`, `pje/queues/wokers/documentos-trt.worker.ts`. Atencao a:
   - Quais paths enviam webhook de sucesso vs erro vs nao-encontrado.
   - Onde o `successWebhookSent` esta sendo setado e como o guard final usa.
   - `webhookId` em cada caminho — confirmar que sempre e populado (robo-api `BadRequestException` se ausente).
   - `removeOnFail` policy.
3. **Login pool** — `pje/services/login-pool.service.ts`. Lock TTL, validacao JWT, rotacao de conta. Le com cuidado porque sao race conditions sutis em multi-worker.
4. **Captcha** — `services/captcha.service.ts`. Confirmar que todos os returns `{} as CaptchaResult` foram removidos.
5. **Redis** — `services/redis.service.ts`. Confirmar que `SCAN` (nao `KEYS`) e usado em deleteQueue e reprocessAllFailedJobs.
6. **Health check** — `health.controller.ts`. Vai pingar Redis, browser pool, OOM threshold. Se algum check falhar, retorna 503 — orchestrator entao reinicia o container (o que era impossivel antes).
7. **Brain docs** — `docs/brain/specs/inter-service.md` em particular: confere se o formato do payload `Root` bate com o que o `robo-api` espera (`webhookId`, `x-correlation-id`, etc.).

---

## O que NAO esta neste PR (escopo deferido conscientemente)

- **ARQ-008** Structured logging — skip explicito; ficamos com `Logger` Nest + `correlationId`.
- **PERF-002** Concorrencia de filas por TRT — equipe decidiu manter configuracao atual.
- **Cobertura extensa de testes** — adicionada cobertura nos pontos criticos (`redis.service.spec.ts`); o resto pode crescer organicamente.

---

## Referencias

- Auditoria original: `robo_coleta/MELHORIAS-*.md` (8 arquivos)
- Code reviews: `robo_coleta/review/v1-*.md` ate `review/v5-*.md` (mais o resumo `00-RESUMO-FINAL.md`)
- Status item-a-item: `robo_coleta/MELHORIAS-STATUS.md`
- Secrets a configurar: `robo_coleta/GITHUB_ACTIONS_SECRETS.md`
