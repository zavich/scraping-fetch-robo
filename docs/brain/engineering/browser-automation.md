# Browser Automation

## Stack

- Puppeteer 24 como engine de automacao.
- `puppeteer-extra` com `puppeteer-extra-plugin-stealth` para anti-deteccao.
- `BrowserManager` (`src/utils/browser.manager.ts`) como abstração central.

## BrowserManager

Gerencia o ciclo de vida do browser e contextos.

### Responsabilidades

- Criar e fechar contextos de browser isolados.
- Garantir que contextos sao fechados mesmo em caso de erro.
- Configurar viewport, user agent e plugins stealth.

### Uso correto

```typescript
const { page, context } = await browserManager.createContext();
try {
  // ... navegacao e scraping
} finally {
  await context.close();
}
```

### Anti-patterns

- Nunca criar `page` diretamente sem `BrowserManager`.
- Nunca esquecer de fechar contexto (causa memory leak).
- Nunca usar `page.waitForTimeout()` — usar `waitForSelector` ou `waitForNavigation`.

## Stealth

O plugin stealth modifica fingerprints do browser para evitar deteccao:
- Remove `navigator.webdriver`.
- Emula plugins e idiomas reais.
- Modifica Canvas/WebGL fingerprints.

## Navegacao

### Padrao de scraping

1. `page.goto(url, { waitUntil: 'networkidle0' })`.
2. `page.waitForSelector(seletor)` para garantir que elemento carregou.
3. `page.evaluate()` para extrair dados do DOM.
4. `page.click()` / `page.type()` para interacao.

### Timeouts

- Navegacao: timeout padrao configurado no BrowserManager.
- Seletores: timeout especifico por operacao.
- Jobs: timeout geral do BullMQ worker.

## Screenshots e CAPTCHA

- `page.screenshot({ encoding: 'base64' })` para captura de CAPTCHA de imagem.
- Screenshot enviado para 2Captcha para resolucao.

## Cookies e sessoes

- Sessoes PJE armazenadas no Redis (`pje:session:{trt}`).
- Cookies restaurados no contexto do browser via `page.setCookie()`.
- Sessao reutilizada ate expirar ou falhar.

## Recursos e memoria

- Cada contexto de browser consome ~100-300MB de memoria.
- Concorrencia limitada por worker para controlar uso de memoria.
- Container ECS deve ter memoria suficiente (2-4 GB recomendado).
- Contextos devem ser fechados o mais rapido possivel apos uso.
