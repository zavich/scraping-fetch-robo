# Browser Configuration

## BrowserManager (`src/utils/browser.manager.ts`)

### Puppeteer launch config

```typescript
puppeteer.launch({
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  headless: true,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1280,720',
    '--disable-blink-features=AutomationControlled',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
  ],
  protocolTimeout: 120_000,   // 2 minutos
  timeout: 180_000,           // 3 minutos
  defaultViewport: null,      // viewport configurado por pagina, nao globalmente
})
```

### Configuracao por pagina (`createPage()`)

**Viewport**:
```typescript
{ width: 1366, height: 768, deviceScaleFactor: 1, isMobile: false, hasTouch: false }
```

**Headers**:
```typescript
'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7'
'Accept': 'text/html,application/xhtml+xml,...'
```

**User-Agent** (fixo, NAO rotativo):
```
Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36
```

**Nota**: o BrowserManager usa UM user-agent fixo. O pool de user-agents rotativos (100+) e usado apenas em requisicoes HTTP do LoginService.

**Timezone**: `America/Sao_Paulo`

**Navigator overrides** (via `evaluateOnNewDocument`):
```typescript
navigator.webdriver = false
navigator.platform = 'Win32'
navigator.language = 'pt-BR'
navigator.languages = ['pt-BR', 'pt', 'en-US', 'en']
navigator.hardwareConcurrency = 8
navigator.deviceMemory = 8
navigator.maxTouchPoints = 0
window.chrome = { runtime: {} }
// navigator.permissions.query patched para 'notifications'
```

**Interceptacao de requests**:
- Bloqueado: `['media']` (apenas tipo media)
- Demais tipos: continue normalmente

**Timeouts por pagina**:
```typescript
page.setDefaultTimeout(120000)            // 2 minutos
page.setDefaultNavigationTimeout(120000)  // 2 minutos
```

### Padrao de uso

- **Singleton**: uma instancia `Browser` para toda a aplicacao
- **Isolamento**: cada operacao cria um `BrowserContext` proprio
- `createPage()`: cria novo context + nova page
- `closeContext()`: fecha o context (nao o browser)
- `closeBrowser()`: fecha e anula o singleton

---

## CnpjScraperService (browser separado)

O servico de CNPJ da Receita Federal usa `puppeteer.launch()` diretamente, **NAO** o BrowserManager.

```typescript
puppeteer.launch({
  headless: true,
  executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-blink-features=AutomationControlled',
    '--disable-dev-shm-usage'
  ]
})
```

**Diferenças**:
- Sem stealth plugin
- Sem protocolTimeout/timeout
- Sem navigator overrides
- Sem interceptacao de requests
- Apenas 4 args (vs 12 no BrowserManager)

---

## Dependencia de browser

### Plugins
- `puppeteer-extra`: wrapper para plugins
- `puppeteer-extra-plugin-stealth`: anti-deteccao (remove webdriver flag, emula fingerprints)

### Pacotes auxiliares
- `sharp`: processamento de imagem (disponivel mas uso limitado)
- `jimp`: processamento de imagem (disponivel mas uso limitado)
- `tesseract.js`: OCR (disponivel mas NAO ativo no fluxo atual)
