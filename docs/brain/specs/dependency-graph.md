# Dependency Graph

## Grafo de injecao de dependencias

```
AppModule
  ├── PjeModule
  ├── ReceitaFederalModule
  ├── RedisModule (global, exports REDIS_CLIENT)
  ├── BullModule (usa REDIS_CLIENT)
  └── ScheduleModule

PjeModule providers:
  PjeController
    ├── ConsultarProcessoQueue (injeta 25 Queues: pje-trt1..24 + pje-tst)
    ├── PdfExtractService (sem deps)
    ├── LoginPoolService
    └── RedisService

  PjeLoginService
    ├── CaptchaService → HttpService
    └── REDIS_CLIENT

  CaptchaService
    └── HttpService (HttpModule)

  FetchUrlMovimentService
    ├── CaptchaService
    ├── REDIS_CLIENT
    └── FetchDocumentoService

  FetchDocumentoService
    └── REDIS_CLIENT

  ConsultarProcessoQueue
    └── 25x Queue tokens (pje-trt1..24, pje-tst)

  ConsultarProcessoDocumentoQueue
    └── 24x Queue tokens (pje-documentos-trt1..24)

  LoginPoolService
    ├── PjeLoginService
    └── REDIS_CLIENT

  ProcessDocumentsFindService
    ├── AwsS3Service
    └── PdfExtractService

  PdfExtractService (sem deps)
  AwsS3Service (sem deps, le env vars)
  RedisService → REDIS_CLIENT

  ScrapingService (src/helpers/, NAO src/modules/pje/services/)
    ├── CaptchaService
    └── REDIS_CLIENT

  GenericProcessoWorker (dinamico, 25 instancias)
    ├── LoginPoolService
    ├── FetchUrlMovimentService
    ├── ScrapingService
    ├── REDIS_CLIENT
    └── 24x pje-documentos-trt Queue tokens

  GenericDocumentosWorker (dinamico, 24 instancias)
    ├── ProcessDocumentsFindService (via @Inject property)
    ├── LoginPoolService (via @Inject property)
    └── REDIS_CLIENT (via @Inject property)

ReceitaFederalModule providers:
  ReceitaFederalController
    ├── CnpjScraperService
    └── CndtScraperService

  CnpjScraperService
    └── ReCaptchaService

  CndtScraperService
    ├── CaptchaService
    └── AwsS3Service

  ReCaptchaService (sem deps injetadas, le env diretamente)
```

## Notas importantes

- **ScrapingService** esta em `src/helpers/`, NAO em `src/modules/pje/services/`. Diferente de `scraping-process.service.ts`.
- **ScrapingService** so roda para TRT3 e TRT9 (condicao: `if (regionTRT === 3 || regionTRT === 9)`). Para demais TRTs, o worker usa `FetchUrlMovimentService` (HTTP direto).
- **GenericDocumentosWorker** usa property injection (`@Inject` em campos), nao constructor injection.
- **CnpjScraperService** cria browser proprio via `puppeteer.launch()` (nao usa BrowserManager).
- **ReCaptchaService** le `API_KEY_2CAPTCHA` diretamente do `process.env` (nao injetado via ConfigService).
- **Dynamic providers**: `DynamicWorkerProvider` cria 25 GenericProcessoWorker, `DynamicDocumentWorkersProvider` cria 24 GenericDocumentosWorker.
