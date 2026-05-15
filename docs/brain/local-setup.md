# Brain Local Setup

## Setup basico

1. Instale dependencias:

```bash
npm install
```

2. Suba Redis via Docker:

```bash
docker compose up redis -d
```

3. Configure variaveis de ambiente:

```bash
API_KEY="..."
API_KEY_2CAPTCHA="..."
PJE_USER_FIRST="..." PJE_PASS_FIRST="..."
PJE_USER_SECOND="..." PJE_PASS_SECOND="..."
# ... ate SIXTH
AWS_S3_REGION="sa-east-1"
AWS_S3_BUCKET_NAME="..."
REDIS_URL="redis://localhost:6379"
WEBHOOK_URL="http://localhost:8080/v1/process/webhook"
NODE_ENV="development"
```

4. Rode o servidor:

```bash
npm run start:dev
```

API disponivel em `http://localhost:8081`.

## Docker (com Chromium)

```bash
docker compose up --build
```

Docker instala Chromium, fonts e dumb-init. Requer `shm_size: 1gb` para Puppeteer.

## Bull Board

Em desenvolvimento: `http://localhost:8081/bull-board`.

## Regras locais

- Nao salvar credenciais PJE ou 2Captcha em `docs/brain/`.
- Nao versionar cookies ou tokens de sessao.
