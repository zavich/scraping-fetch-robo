# Test Matrix

## Estado atual

Nenhum teste automatizado existe. Jest configurado mas sem specs.

## Areas criticas para testes

| Area | Arquivos | Tipo recomendado | Risco |
|---|---|---|---|
| Login pool | `login-pool.service.ts` | Unit (mock Redis) | Alto: rotacao e sessoes |
| Queue routing | `getTRTQueue.ts` | Unit | Alto: roteamento incorreto |
| PDF extraction | `extract.service.ts` | Unit (mock pdf-lib) | Medio: parsing |
| CAPTCHA service | `captcha.service.ts` | Unit (mock 2Captcha API) | Medio: resolucao |
| Browser manager | `browser.manager.ts` | Integration | Alto: singleton e cleanup |
| TRT validation | `trt-validate.ts` | Unit | Medio: mapeamento |

## Lacunas

- Nenhum teste existe.
- Scraping services sao dificeis de testar (dependem de sites externos).
- Browser automation requer mocks complexos.
