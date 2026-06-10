# Testing

## Framework

- Jest como test runner.
- Testes unitarios para servicos isolados.
- Testes e2e com supertest para controllers.

## Estrutura

- Testes no mesmo diretorio do arquivo fonte com sufixo `.spec.ts`.
- Ex: `captcha.service.ts` → `captcha.service.spec.ts`.

## O que testar

- **Servicos de parsing**: transformacao de dados extraidos do scraping.
- **Logica de retry/backoff**: configuracao de tentativas e delays.
- **Login pool rotation**: rotacao correta de credenciais.
- **Rate limiter**: respeito aos limites configurados.
- **PDF extraction**: extracao de paginas por bookmark.
- **Servicos Redis administrativos**: `scan/del/flushdb` e reprocessamento seguro de jobs falhos.

## O que nao testar (ou testar com cuidado)

- **Scraping real**: depende de sites externos, usar mocks.
- **2Captcha real**: depende de servico pago, usar mocks.
- **Browser real**: usar mocks do Puppeteer para testes unitarios.
- **Redis real**: usar mock ou Redis em container para testes.

## Executar testes

```bash
yarn test --runInBand # testes unitarios
yarn test:e2e         # testes e2e
yarn test:cov         # cobertura
```

## Mocks comuns

- `BrowserManager`: mock de `createContext()`, `close()`.
- `CaptchaService`: mock de `solveCaptcha()`, `solveAwsWaf()`.
- `RedisService`: mock de `get()`, `set()`, `del()`.
- `HttpService`: mock de chamadas HTTP externas.

## Estado atual validado

- `src/services/redis.service.spec.ts`: cobre `deleteQueue()`, `reprocessAllFailedJobs()` e `flushDb()`.
- Validacao da rodada: `yarn test --runInBand` e `yarn build` passaram.
- Antes do deploy, o template `task-definition.json` deve ser materializado com `yarn render:task-definition`.
