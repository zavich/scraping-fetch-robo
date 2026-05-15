# Feature: Receita Federal

## Quando usar

Use este mapa quando a task envolver scraping da Receita Federal para certidoes CNPJ ou CNDT.

## Pontos de entrada

- `src/modules/receita-federal/receita-federal.controller.ts`
- `POST /receita-federal?cnpj=xxx`: certidao CNPJ.
- `POST /receita-federal/cndt?cnpj=xxx`: CNDT.

## Arquivos relacionados

- `src/modules/receita-federal/services/find.service.ts`: scraping CNPJ com hCaptcha.
- `src/modules/receita-federal/services/cndt-scraper.service.ts`: scraping CNDT.
- `src/modules/receita-federal/services/recaptcha.service.ts`: resolucao hCaptcha.
- `src/utils/browser.manager.ts`: BrowserManager para navegacao.

## Fluxo resumido

### CNPJ

1. Request com CNPJ chega ao controller.
2. BrowserManager cria novo contexto.
3. Navega para site da Receita Federal.
4. Resolve hCaptcha via 2Captcha/ReCaptchaService.
5. Submete formulario com CNPJ.
6. Extrai PDF da certidao.
7. Retorna PDF.

### CNDT

1. Request com CNPJ chega ao controller.
2. BrowserManager cria contexto.
3. Navega para TST CNDT (cndt-certidao.tst.jus.br).
4. Resolve CAPTCHA de imagem via 2Captcha.
5. Submete CNPJ e obtém certidao.
6. Retorna resultado.

## Riscos e cuidados

- Sites da Receita Federal mudam layout periodicamente.
- hCaptcha pode mudar de provider.
- CNDT pode nao existir para o CNPJ.
- Rate limiting da Receita Federal.
