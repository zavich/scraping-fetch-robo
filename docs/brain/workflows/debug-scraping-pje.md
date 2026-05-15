# Workflow: Debug Scraping PJE

## Sintoma

Scraping de processo PJE falhou, timeout, retorno vazio ou erro inesperado.

## Pre-condicoes

- [ ] Acesso aos logs do worker.
- [ ] Acesso ao Redis para verificar sessoes e locks.
- [ ] Bull Board disponivel para inspecionar jobs.

## Passos

1. **Identificar o erro**: verifique o log do worker que processou o job.
   - Timeout? Passo 2.
   - Sessao invalida? Passo 3.
   - AWS WAF bloqueou? Passo 4.
   - CAPTCHA falhou? Passo 5.
   - Processo nao encontrado? Passo 6.

2. **Timeout de scraping**:
   - Verifique se o TRT esta acessivel manualmente.
   - Cheque se o browser crashou (`BrowserManager` logs).
   - Verifique concorrencia do worker (TRT3/TRT9/TST = 1, demais = 3).
   - Verifique rate limiter (3 req/s por fila).

3. **Sessao invalida**:
   - Verifique `pje:session:{trt}` no Redis (TTL, conteudo).
   - Verifique se ha lock ativo `pje:lock:{trt}` (TTL 15s).
   - Verifique credenciais no Secrets Manager (`PJE_USER_*`, `PJE_PASS_*`).
   - Force novo login removendo a sessao do Redis.

4. **AWS WAF bloqueou**:
   - Verifique `aws-waf-token:{processNumber}` no Redis.
   - Se token expirou, sera resolvido automaticamente na proxima tentativa.
   - Verifique saldo do 2Captcha.
   - Verifique se o tipo de desafio WAF mudou.

5. **CAPTCHA falhou**:
   - Verifique saldo do 2Captcha.
   - Verifique tipo de CAPTCHA (imagem vs hCaptcha vs AWS WAF).
   - Verifique timeout de polling.
   - Consulte `features/captcha-resolution.md`.

6. **Processo nao encontrado**:
   - Verifique se o numero do processo esta correto (formato CNJ).
   - Verifique se o processo existe no TRT correto.
   - Verifique se e segredo de justica.

## Resultado esperado

Causa raiz identificada e job reprocessado com sucesso, ou problema escalado com diagnostico claro.

## Quando escalar

- Se o TRT estiver em manutencao prolongada.
- Se o IP foi bloqueado permanentemente.
- Se o layout do PJE mudou (requer adaptacao de seletores).
