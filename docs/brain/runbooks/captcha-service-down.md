# Runbook: CAPTCHA Service Down

## Severidade

Alta

## Sintoma

- Resolucao de CAPTCHA falha consistentemente.
- Logs mostram timeout no polling do 2Captcha.
- Erros `ERROR_ZERO_BALANCE`, `ERROR_NO_SLOT_AVAILABLE`, ou timeout.
- Jobs que dependem de CAPTCHA (Receita Federal, AWS WAF) falham em massa.

## Impacto

- Scraping de processos protegidos por AWS WAF para.
- Consultas a Receita Federal (CNPJ, CNDT) falham.
- Jobs acumulam em filas que dependem de CAPTCHA.

## Diagnostico

1. Verificar saldo do 2Captcha via API (`getbalance`).
2. Verificar status do 2Captcha (https://2captcha.com/status).
3. Verificar se o tipo de CAPTCHA mudou no site alvo.
4. Verificar logs do `CaptchaService` e `ReCaptchaService`.
5. Verificar se o site key do hCaptcha mudou (Receita Federal).

## Resolucao

1. **Saldo zerado**: recarregar conta do 2Captcha.
2. **Servico indisponivel**: aguardar restauracao ou considerar provider alternativo.
3. **Tipo de CAPTCHA mudou**: atualizar implementacao:
   - Para hCaptcha: `src/modules/receita-federal/services/recaptcha.service.ts`.
   - Para imagem: `src/services/captcha.service.ts`.
   - Para AWS WAF: `src/services/captcha.service.ts` (AmazonTaskProxyless).
4. **Site key mudou**: atualizar site key no codigo do ReCaptchaService.

## Prevencao

- Monitorar saldo do 2Captcha com alerta quando abaixo de threshold.
- Cache de tokens WAF no Redis para reduzir chamadas (`aws-waf-token:{processNumber}`).
- Logs claros diferenciando tipo de erro (saldo, timeout, tipo errado).

## Historico

| Data | Descricao |
|------|-----------|
| - | Nenhum incidente registrado ainda |
