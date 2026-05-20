# Application Map

## PJE Module

### Controller (`src/modules/pje/pje.controller.ts`)

- `POST /processos/:numero`: consulta processo por numero (enfileira job).
- `POST /processos/extract-by-id`: extrai paginas do PDF por bookmark ID.
- `POST /processos/list-bookmarks`: lista bookmarks de um PDF.
- `POST /processos/auth/login/:trt`: obtem cookies de sessao PJE.
- `DELETE /processos/redis/:queue/clear`: limpa fila Redis.
- `DELETE /processos/redis/flush-all`: flush all Redis.
- `POST /processos/redis/reprocess-failed`: reprocessa jobs falhados.

### Queue Services

- `ConsultarProcessoQueue` (`src/modules/pje/queues/service/consultar-processo.ts`): roteia consulta para fila do TRT correto.
- `ConsultarProcessoDocumentoQueue` (`src/modules/pje/queues/service/consultar-processo-documento.ts`): roteia extracao de documentos.

### Workers

- `processos-trt.worker.ts`: worker de processo (48 instancias via dynamic provider).
- `documentos-trt.worker.ts`: worker de documentos.
- Dynamic providers: `src/providers/dynamic-workers.provider.ts`, `src/providers/dynamic-document-workers.provider.ts`.

### Services

- `PjeLoginService` (`src/modules/pje/services/login.service.ts`): autenticacao direta no PJE.
- `LoginPoolService` (`src/modules/pje/services/login-pool.service.ts`): pool de 6 contas com rotacao.
- `ScrapingProcessService` (`src/modules/pje/services/scraping-process.service.ts`): logica core de scraping.
- `PdfExtractService` (`src/modules/pje/services/extract.service.ts`): extracao de paginas por bookmark.
- `FetchUrlMovimentService` (`src/modules/pje/services/fetch-url.service.ts`): busca movimentos.
- `FetchDocumentoService` (`src/modules/pje/services/fetch-documents-url.service.ts`): busca URLs de documentos.
- `ProcessDocumentsFindService` (`src/modules/pje/services/process-documents-find.service.ts`): descobre documentos acessiveis.

## Receita Federal Module

### Controller (`src/modules/receita-federal/receita-federal.controller.ts`)

- `POST /receita-federal?cnpj=xxx`: obtem certidao CNPJ (PDF).
- `POST /receita-federal/cndt?cnpj=xxx`: obtem CNDT.

### Services

- `CnpjScraperService` (`src/modules/receita-federal/services/find.service.ts`): scraping CNPJ com hCaptcha.
- `CndtScraperService` (`src/modules/receita-federal/services/cndt-scraper.service.ts`): scraping CNDT.
- `ReCaptchaService` (`src/modules/receita-federal/services/recaptcha.service.ts`): resolucao hCaptcha.

## Services Globais

- `AwsS3Service` (`src/services/aws-s3.service.ts`): upload de PDFs para S3 (AES256).
- `CaptchaService` (`src/services/captcha.service.ts`): integracao 2Captcha (imagem, AWS WAF).
- `RedisService` (`src/services/redis.service.ts`): gerenciamento de filas e chaves Redis.

## Utilities

- `BrowserManager` (`src/utils/browser.manager.ts`): singleton Puppeteer.
- `BrowserPool` (`src/utils/browser-pool.ts`): pool de contextos (opcional).
- `user-agents.ts`: lista de 100+ user agents.
- `getTRTQueue` (`src/helpers/getTRTQueue.ts`): extrai TRT do numero do processo e roteia.
- `trt-validate.ts`: validacao de TRT.
- `extractToken.ts`, `normalizeResponse.ts`, `normalize-string.ts`, `date-validations.ts`, `regex-documents.ts`, `redis-delete-keys.ts`.
