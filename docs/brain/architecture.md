# Architecture Map

## Stack observada

- NestJS 11.
- TypeScript (ES2023).
- Puppeteer 24 + puppeteer-extra-plugin-stealth.
- BullMQ (49 filas).
- Redis / ioredis.
- Tesseract.js 6 (OCR, disponivel mas nao ativo).
- pdf-lib, pdf-parse, pdfjs-dist (manipulacao PDF).
- sharp, jimp (processamento de imagem).
- Axios.
- AWS S3 (upload de PDFs).
- Bull Board (visualizacao de filas).

## Bootstrap

- `src/main.ts`: cria app NestJS na porta 8081, configura CORS (apenas robo-api.juri.capital), registra Bull Board (non-prod), graceful shutdown com `app.close()` + `BrowserManager.closeAll()`.
- `src/app.module.ts`: importa PjeModule, ReceitaFederalModule, RedisModule, ScheduleModule.

## Modulos

### PJE Module

`src/modules/pje/` - scraping de tribunais trabalhistas.

- Controller: endpoints para consulta, extracao, login, gerenciamento de filas Redis.
- Queues: ConsultarProcessoQueue, ConsultarProcessoDocumentoQueue.
- Workers: processos-trt.worker (48 instancias para 24 TRTs + TST), documentos-trt.worker.
- Services: login, login-pool, scraping-process, extract (PDF), fetch-url (movimentos), fetch-documents-url, process-documents-find.
- Dynamic providers: criam workers por TRT automaticamente.

### Receita Federal Module

`src/modules/receita-federal/` - scraping de certidoes.

- Controller: CNPJ certificate, CNDT.
- Services: find (CNPJ), cndt-scraper, recaptcha.

## 49 Filas BullMQ

- `pje-trt1` ate `pje-trt24` (24 filas de processo).
- `pje-documentos-trt1` ate `pje-documentos-trt24` (24 filas de documento).
- `pje-tst` (1 fila TST).

Concorrencia: TRT3, TRT9, TST = 1; demais = 3. Rate limit: 3 req/s por fila.

## Browser Manager

- Singleton Puppeteer em `src/utils/browser.manager.ts`.
- Stealth plugin habilitado.
- User-agent fixo e viewport coerente com launch args.
- Context isolation por operacao.
- Headless: true, viewport: 1366x768.
- Graceful shutdown: SIGINT/SIGTERM/uncaughtException com fechamento do pool completo.

## Login Pool

- 6 contas PJE (FIRST a SIXTH).
- Rotacao a cada 5 processos.
- Sessao cacheada no Redis com TTL.
- Lock por TRT (60s) para evitar login concorrente.
- AWS WAF token cacheado por processo.

## Auth

- API Key guard via header `authorization`.
- CORS restrito a `robo-api.juri.capital`.
