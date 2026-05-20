# Feature: PJE Scraping

## Quando usar

Use este mapa quando a task envolver scraping de processos via PJE, filas por TRT, login pool, sessoes ou consulta de movimentos.

## Status do mapeamento

- Estado: parcial
- Principais lacunas: detalhes de cada TRT individualmente

## Pontos de entrada

- `src/modules/pje/pje.controller.ts`: `POST /processos/:numero`.
- `src/modules/pje/queues/service/consultar-processo.ts`: roteia para fila do TRT.
- `src/modules/pje/queues/wokers/processos-trt.worker.ts`: worker de processo.

## Arquivos relacionados

- `src/modules/pje/services/login-pool.service.ts`: pool de 6 contas.
- `src/modules/pje/services/login.service.ts`: login direto no PJE.
- `src/modules/pje/services/scraping-process.service.ts`: logica core.
- `src/modules/pje/services/fetch-url.service.ts`: busca movimentos.
- `src/helpers/getTRTQueue.ts`: extrai TRT do numero e retorna nome da fila.
- `src/utils/browser.manager.ts`: singleton Puppeteer.
- `src/providers/dynamic-workers.provider.ts`: cria workers para cada TRT.

## Fluxo resumido

1. Request POST `/processos/:numero` chega ao controller.
2. `getTRTQueue` extrai TRT do numero do processo (digitos 14-17 do CNJ).
3. Job adicionado a fila `pje-trt{N}` via BullMQ.
4. Worker consome job, obtem sessao via `LoginPoolService`.
5. LoginPool rotaciona contas a cada 5 processos, cacheia sessao no Redis.
6. Se sessao invalida, faz novo login com lock de 60s por TRT.
7. Scraping via Puppeteer (stealth) ou API direta do PJE.
8. Dados extraidos: numero, classe, orgao julgador, partes, movimentos, documentos.
9. Resultado enviado via webhook para robo-api.

## Conceitos

- TRT routing: numero do processo contem codigo do TRT (posicao 14-17).
- Concorrencia: TRT3/TRT9/TST = 1 (restrito), demais = 3.
- Rate limit: 3 requisicoes/segundo por fila.
- Lock duration: 120 segundos por job.
- Retry: 3 tentativas com backoff de 5 segundos.
- Prioridade: 0 (alta) para requests explicitos, 5 (normal) padrao.

## Riscos e cuidados

- TRTs podem mudar layout ou API sem aviso.
- Contas PJE podem ser bloqueadas por excesso de requisicoes.
- AWS WAF pode exigir novo token a qualquer momento.
- Sessao expirada causa falha silenciosa se nao detectada.
- Lock de 60s por TRT evita corrida em TRTs lentos e reduz re-login concorrente.
