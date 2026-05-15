# Infraestrutura

## Deploy

- AWS ECS Fargate na regiao `sa-east-1`.
- CI/CD via GitHub Actions.
- Docker image com Chromium embutido para Puppeteer.

## Servicos AWS

| Servico | Uso |
|---------|-----|
| ECS Fargate | Container do servico |
| ElastiCache Redis | Sessoes, locks, filas BullMQ, cache WAF |
| S3 | Upload de documentos PDF (AES256) |
| Secrets Manager | Credenciais PJE (PJE_USER_*, PJE_PASS_*) |
| CloudWatch | Logs e metricas |
| ECR | Registry de imagens Docker |

## Container

- Base image com Node.js 20 e Chromium.
- Dependencias do Chromium: `nss`, `freetype`, `harfbuzz`, `ca-certificates`, `ttf-freefont`.
- Puppeteer configurado para usar Chromium do sistema (`executablePath`).
- Memoria recomendada: 2-4 GB (Puppeteer consome bastante).

## Redis

- ElastiCache Redis para BullMQ e sessoes.
- Chaves com TTL para evitar acumulo.
- Usado para: filas, sessoes PJE, locks, tokens WAF.

## Monitoramento

- CloudWatch Logs para todos os containers.
- Metricas de CPU/memoria do ECS.
- Bull Board (`/admin/queues`) para monitorar filas.

## Variaveis de ambiente

- `REDIS_HOST`, `REDIS_PORT`: conexao Redis.
- `AWS_S3_BUCKET`: bucket para documentos.
- `TWO_CAPTCHA_API_KEY`: chave da API 2Captcha.
- `PJE_*`: credenciais carregadas do Secrets Manager.
- Validadas com Zod no bootstrap.

## Seguranca

- Credenciais nunca em variaveis de ambiente diretamente — Secrets Manager.
- S3 com encriptacao AES256.
- Puppeteer com stealth plugin para evitar deteccao de bot.
- Rate limiting por fila para nao sobrecarregar tribunais.
