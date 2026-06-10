# Debug Index

## Scraping timeout ou falhou

Leia: `features/pje-scraping.md`, `engineering/browser-automation.md`

Checar:
- Log do worker e erro retornado.
- Se a sessao PJE esta valida (`pje:session:{trt}` no Redis).
- Se o TRT esta acessivel (pode estar em manutencao).
- Se o browser nao crashou (`BrowserManager`).
- Se o rate limit foi excedido.
- Se o AWS WAF bloqueou a requisicao.

## CAPTCHA nao resolvido

Leia: `features/captcha-resolution.md`

Checar:
- Saldo do 2Captcha (`balance` endpoint).
- Se o tipo de CAPTCHA esta correto (imagem vs hCaptcha vs AWS WAF).
- Timeout de polling (5-10s por tentativa).
- Se o site mudou o tipo de CAPTCHA.

## Sessao expirada ou invalida

Leia: `features/pje-scraping.md`, `runtime/redis.md`

Checar:
- TTL da sessao no Redis (`pje:session:{trt}`).
- Se o login pool rotacionou corretamente.
- Se ha lock ativo (`pje:lock:{trt}`).
- Se as credenciais PJE estao corretas.

## PDF extracao falhou

Leia: `features/pje-documents.md`

Checar:
- Se o PDF foi baixado corretamente do PJE.
- Se o bookmark ID existe no PDF.
- Se pdf-lib/pdf-parse consegue parsear o arquivo.
- Se o upload para S3 foi bem sucedido.

## Rate limit ou bloqueio

Leia: `features/pje-scraping.md`, `architecture.md`

Checar:
- Concorrencia configurada no worker (TRT3/TRT9/TST = 1, demais = 3).
- Rate limiter: 3 req/s por fila.
- Se IP foi bloqueado pelo tribunal.
- Se AWS WAF esta exigindo novo token.

## WAF bloqueou requisicao

Leia: `features/captcha-resolution.md`, `runtime/redis.md`

Checar:
- `aws-waf-token:{processNumber}` no Redis.
- Se o token WAF expirou.
- Se 2Captcha resolveu o desafio AWS WAF corretamente.

## Login falhou

Leia: `features/pje-scraping.md`

Checar:
- Credenciais no Secrets Manager (PJE_USER_*, PJE_PASS_*).
- Se a conta nao foi bloqueada pelo tribunal.
- Se o endpoint de login do PJE esta acessivel.
- Lock `pje:lock:{trt}` (60s) para evitar login concorrente.

## Documento nao encontrado

Leia: `features/pje-documents.md`

Checar:
- Se o processo tem documentos publicos (segredo de justica pode impedir).
- Se o token de acesso ao documento esta valido.
- Se o endpoint de documentos mudou no PJE.
