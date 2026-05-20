# Environment Variables

## Tabela completa

| Variavel | Arquivo fonte | Tipo | Obrigatorio | Default | Descricao |
|----------|--------------|------|-------------|---------|-----------|
| `REDIS_URL` | `redis.module.ts:10` | string | Sim | - | URL completa de conexao Redis (ex: `redis://...`) |
| `WEBHOOK_URL` | `processos-trt.worker.ts:95`, `documentos-trt.worker.ts:30`, `cndt-scraper.service.ts:116` | string | Sim | - | URL base do robo-api. Concatenada com `/process/webhook` ou `/company/webhook?type=cndt` |
| `API_KEY` | `api-key.guard.ts:14` | string | Sim | - | API key para rotas da Receita Federal (header `Authorization`) |
| `API_KEY_2CAPTCHA` | `captcha.service.ts:36`, `recaptcha.service.ts:7` | string | Sim | - | Chave API do 2Captcha |
| `PUPPETEER_EXECUTABLE_PATH` | `browser.manager.ts:21`, `find.service.ts:19` | string | Sim | - | Caminho para binario Chromium/Chrome |
| `PJE_USER_FIRST` | `login-pool.service.ts:23` | string | Sim | - | Username conta PJE 1 |
| `PJE_PASS_FIRST` | `login-pool.service.ts:25` | string | Sim | - | Password conta PJE 1 |
| `PJE_USER_SECOND` | `login-pool.service.ts:28` | string | Sim | - | Username conta PJE 2 |
| `PJE_PASS_SECOND` | `login-pool.service.ts:30` | string | Sim | - | Password conta PJE 2 |
| `PJE_USER_THIRD` | `login-pool.service.ts:33` | string | Sim | - | Username conta PJE 3 |
| `PJE_PASS_THIRD` | `login-pool.service.ts:35` | string | Sim | - | Password conta PJE 3 |
| `PJE_USER_FOURTH` | `login-pool.service.ts:38` | string | Sim | - | Username conta PJE 4 |
| `PJE_PASS_FOURTH` | `login-pool.service.ts:40` | string | Sim | - | Password conta PJE 4 |
| `PJE_USER_FIFTH` | `login-pool.service.ts:43` | string | Sim | - | Username conta PJE 5 |
| `PJE_PASS_FIFTH` | `login-pool.service.ts:45` | string | Sim | - | Password conta PJE 5 |
| `PJE_USER_SIXTH` | `login-pool.service.ts:48` | string | Sim | - | Username conta PJE 6 |
| `PJE_PASS_SIXTH` | `login-pool.service.ts:50` | string | Sim | - | Password conta PJE 6 |
| `AWS_S3_BUCKET_NAME` | `aws-s3.service.ts:9`, `process-documents-find.service.ts:112`, `cndt-scraper.service.ts:107` | string | Sim | - | Nome do bucket S3 para documentos |
| `AWS_S3_REGION` | `aws-s3.service.ts:13,29` | string | Sim | - | Regiao AWS para S3 |
| `ENVIRONMENT` | `main.ts:28` | string | Nao | undefined | Se NAO for `'production'`, Bull Board e montado em `/bull-board` |
| `AUTHORIZATION_ESCAVADOR` | `cndt-scraper.service.ts:127` | string | Sim (para CNDT) | - | Token de auth enviado no webhook CNDT (sem prefixo "Bearer") |
| `SCRAPER_API_KEY` | task-definition.json | string | Desconhecido | - | Presente no Secrets Manager mas sem uso no codigo fonte (possivelmente legado) |

## Notas

- Credenciais PJE sao lidas no momento de instanciacao do `LoginPoolService` (nao injetadas via ConfigService).
- `AUTHORIZATION_ESCAVADOR` e usado como `Authorization: {valor}` sem prefixo "Bearer".
- `REDIS_URL` configura `maxRetriesPerRequest: null` (obrigatorio para BullMQ) via `redis.module.ts`.
- Nao existe validacao Zod central de env vars neste servico (diferente do robo-api).
