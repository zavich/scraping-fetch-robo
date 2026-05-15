# Risk Map

| Area | Arquivos | Risco | Antes de alterar |
|---|---|---|---|
| BrowserManager | `src/utils/browser.manager.ts` | Alto: singleton, todas as operacoes dependem | Ler `engineering/browser-automation.md` |
| Login pool | `src/modules/pje/services/login-pool.service.ts` | Alto: sessoes, rotacao, locks | Ler `features/pje-scraping.md` |
| Dynamic workers | `src/providers/dynamic-workers.provider.ts` | Alto: 48 instancias de worker | Ler `architecture.md` |
| Queue config | `src/modules/pje/queues/` | Alto: 49 filas, concorrencia, rate limit | Ler `features/pje-scraping.md` |
| CAPTCHA service | `src/services/captcha.service.ts` | Medio/alto: bloqueio se falhar | Ler `features/captcha-resolution.md` |
| Scraping process | `src/modules/pje/services/scraping-process.service.ts` | Medio: logica core de scraping | Ler `features/pje-scraping.md` |
| API Key guard | `src/guards/api-key.guard.ts` | Medio: seguranca | Ler `architecture.md` |
| Redis module | `src/connection/redis.module.ts` | Medio: todas as filas dependem | Ler `runtime/redis.md` |

## Politica

- Se o arquivo estiver neste mapa, a task deve explicar quais verificacoes foram feitas.
