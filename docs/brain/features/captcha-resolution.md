# Feature: CAPTCHA Resolution

## Quando usar

Use este mapa quando a task envolver resolucao de CAPTCHA, 2Captcha, AWS WAF ou hCaptcha.

## Pontos de entrada

- `src/services/captcha.service.ts`: servico principal de CAPTCHA.
- `src/modules/receita-federal/services/recaptcha.service.ts`: hCaptcha para Receita Federal.

## Fluxo resumido

### Imagem CAPTCHA

1. Screenshot do CAPTCHA em base64.
2. Envio para 2Captcha via API.
3. Polling a cada 5-10 segundos ate resolucao.
4. Retorna texto resolvido.

### AWS WAF

1. Detecta desafio WAF na resposta.
2. Envia para 2Captcha como AmazonTaskProxyless.
3. Polling ate resolucao.
4. Token WAF cacheado no Redis (`aws-waf-token:{processNumber}`).

### hCaptcha

1. Detecta hCaptcha no site da Receita Federal.
2. Envia site key e URL para 2Captcha.
3. Polling ate resolucao.
4. Retorna token hCaptcha para submissao.

## Conceitos

- 2Captcha: servico pago de resolucao de CAPTCHA (humanos ou AI).
- AWS WAF: Web Application Firewall da Amazon, protege alguns PJE endpoints.
- hCaptcha: alternativa ao reCAPTCHA, usado pela Receita Federal.
- Polling: verifica resultado a cada 5-10s (CAPTCHA demora 10-30s para resolver).

## Riscos e cuidados

- 2Captcha tem custo por resolucao; verificar saldo.
- Timeout de resolucao pode atrasar scraping.
- Sites podem mudar tipo de CAPTCHA sem aviso.
- Token WAF tem validade limitada.
