# Brain Index

Este e o entrypoint canonico do repositorio para tasks assistidas por LLM.

Sempre leia este arquivo no inicio de uma task. Depois, carregue somente os documentos necessarios para a area investigada.

## Objetivo

O brain existe para reduzir custo de investigacao, evitar redescoberta recorrente e preservar conhecimento operacional sobre scraping, filas, sessoes, browser e decisoes.

## Ordem de leitura

1. Leia `project.md` para entender o contexto geral.
2. Use `task-router.md` quando a task tiver sintoma, area ou palavra-chave clara.
3. Consulte `architecture.md` quando a task envolver estrutura, modulos, filas ou browser.
4. Consulte `features/README.md` para localizar mapas de feature existentes.
5. Se a task vier como sintoma operacional, consulte `debug-index.md`.
6. Leia somente os mapas em `features/` relacionados a task.
7. Consulte `runtime/redis.md` quando a task envolver sessoes, locks, tokens ou filas.
8. Consulte `engineering/` quando a task envolver convencoes, browser automation ou infraestrutura.
9. Consulte `decisions/` quando a task tocar uma decisao arquitetural ja registrada.

## Politica de carregamento

- Nao carregar todo o brain por padrao.
- Comecar pelo indice e pelos mapas mais proximos da task.
- Expandir conforme necessidade revelada por imports, workers e services.
- Preferir evidencia local do repositorio a memoria ou suposicao.

## Politica de atualizacao

Atualize o brain quando a investigacao revelar conhecimento duravel, como:

- novo TRT, fila ou worker;
- mudanca em login pool, sessoes ou CAPTCHA;
- regra de rate limit ou anti-bot;
- risco operacional recorrente;
- decisao estrutural que futuras tasks devem respeitar.

Nao atualize para detalhes efemeros, logs temporarios ou explicacoes linha a linha.

## Estrutura

- `project.md`: contexto geral, escopo e vocabulario.
- `architecture.md`: stack, bootstrap, modulos, filas, browser.
- `application-map.md`: indice operacional de modulos, controllers, services, queues.
- `coverage.md`: cobertura atual e lacunas.
- `debug-index.md`: indice por sintoma.
- `manifest.json`: indice machine-readable.
- `task-router.md`: matriz de termos de task.
- `test-matrix.md`: matriz de testes e risco.
- `risk-map.md`: areas de maior blast radius.
- `local-setup.md`: setup local.
- `features/`: mapas por feature.
- `workflows/`: roteiros para debug e investigacao.
- `decisions/`: ADRs.
- `runbooks/`: triagens operacionais.
- `incidents/`: postmortems.
- `templates/`: templates para runbook, incidente e ADR.
- `engineering/`: convencoes, browser automation, testes, infraestrutura.
- `runtime/`: contratos Redis.
- `specs/`: contratos de especificacao (API, filas, dados, env vars, inter-service, browser config, dependency graph).
- `generated/`: inventarios gerados.
- `CHANGELOG.md`: historico do brain.

## Atalhos por tipo de task

- Scraping PJE, consulta de processo, TRT: `features/pje-scraping.md`.
- Documentos PJE, PDF, bookmarks, S3: `features/pje-documents.md`.
- Receita Federal, CNPJ, CNDT: `features/receita-federal.md`.
- CAPTCHA, 2Captcha, WAF, hCaptcha: `features/captcha-resolution.md`.
- Filas, BullMQ, workers, jobs: `workflows/debug-fila-jobs.md`.
- Browser, Puppeteer, Chromium, stealth: `engineering/browser-automation.md`.
- Redis, sessoes, locks, tokens: `runtime/redis.md`.
- Docker, ECS, deploy: `engineering/infrastructure.md`.
- Endpoints, request/response shapes: `specs/api-contracts.md`.
- Job payloads, retry, concorrencia: `specs/queue-contracts.md`.
- Interfaces TypeScript, webhook payloads: `specs/data-contracts.md`.
- Variaveis de ambiente: `specs/env-vars.md`.
- Webhooks, APIs externas, login pool: `specs/inter-service.md`.
- Puppeteer config, stealth, args: `specs/browser-config.md`.
- Grafo de dependencias: `specs/dependency-graph.md`.

## Atalhos por sintoma

- Scraping timeout ou falhou: `workflows/debug-scraping-pje.md`.
- CAPTCHA nao resolvido: `debug-index.md`.
- Sessao expirada ou invalida: `debug-index.md`.
- PDF extracao falhou: `debug-index.md`.
- Fila travada ou job preso: `workflows/debug-fila-jobs.md`.
- Browser crash: `runbooks/browser-crash.md`.
- Rate limit ou bloqueio: `debug-index.md`.
- WAF bloqueou requisicao: `debug-index.md`.
- Login falhou: `debug-index.md`.
- 2Captcha fora do ar: `runbooks/captcha-service-down.md`.

## Protocolo de investigacao progressiva

1. Identifique termos da task e busque no codigo com `rg`.
2. Localize pontos de entrada: controller, worker, service ou provider.
3. Siga dependencias: services, utils, browser manager, Redis.
4. Localize testes existentes (se houver).
5. Se houver mapa de feature, compare com o encontrado.
6. Atualize o mapa apenas com conhecimento confirmado.
