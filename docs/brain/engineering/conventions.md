# Convencoes de Codigo

## Linguagem e runtime

- TypeScript strict mode.
- NestJS 11 com decorators e injecao de dependencia.
- Node.js 20+.

## Estrutura de modulos

```
src/modules/{nome}/
  {nome}.module.ts        # Modulo NestJS
  {nome}.controller.ts    # Controller (se tiver endpoints)
  services/               # Servicos do modulo
  queues/
    producers/            # Producers BullMQ
    workers/              # Workers/consumers BullMQ
  dto/                    # DTOs de validacao
```

## Nomenclatura

- Arquivos: `kebab-case` com sufixo de tipo (`.service.ts`, `.controller.ts`, `.worker.ts`, `.module.ts`).
- Classes: `PascalCase` com sufixo (ex: `ScrapingProcessService`, `PjeController`).
- Variaveis e funcoes: `camelCase`.
- Constantes de config: `UPPER_SNAKE_CASE`.
- Filas BullMQ: `pje-trt{N}`, `pje-documentos-trt{N}`, `pje-tst`.

## Injecao de dependencia

- Todos os servicos sao injetados via constructor do NestJS.
- Providers dinamicos para workers (`DynamicWorkerProvider`, `DynamicDocumentWorkersProvider`).

## Tratamento de erros

- Workers usam try/catch com logging estruturado.
- Jobs falhos sao retentados com backoff exponencial.
- Erros criticos sao logados com contexto (TRT, processo, tipo de erro).

## Browser automation

- Sempre usar `BrowserManager` para criar/fechar contextos.
- Fechar contexto em bloco `finally`.
- Usar `puppeteer-extra-plugin-stealth` para evitar deteccao.
- Nao usar `page.waitForTimeout()` — preferir `waitForSelector` ou `waitForNavigation`.

## Redis

- Chaves com namespace: `pje:session:{trt}`, `pje:lock:{trt}`, `aws-waf-token:{processNumber}`.
- Sempre definir TTL para chaves temporarias.
- Usar locks para operacoes que nao podem ser concorrentes (login).

## Env e secrets

- Variaveis de ambiente validadas com Zod no bootstrap.
- Credenciais PJE no AWS Secrets Manager (`PJE_USER_*`, `PJE_PASS_*`).
- Nunca commitar secrets no repositorio.
