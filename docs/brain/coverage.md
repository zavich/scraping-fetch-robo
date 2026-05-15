# Brain Coverage

## Cobertura forte

- PJE scraping: controller, queues, workers, login pool, sessoes.
- PJE documents: extracao PDF, bookmarks, S3 upload.
- Receita Federal: CNPJ, CNDT, hCaptcha.
- CAPTCHA: 2Captcha, AWS WAF, hCaptcha.
- Browser: BrowserManager, stealth, user-agents.
- Filas: 49 queues BullMQ, concorrencia, rate limit.
- Redis: sessoes, locks, tokens, filas.

## Lacunas controladas

- Sem suite de testes automatizados.
- Tesseract/OCR disponivel mas nao ativo; mapear quando for habilitado.
- Detalhes de cada TRT individualmente nao mapeados.
- Vertex AI importado mas nao usado ativamente.

## Politica de expansao

Expanda quando houver conhecimento duravel. Nao expanda para logs ou payloads sensiveis.
