// src/utils/browser-manager.ts
import { Browser, Page, BrowserContext } from 'puppeteer';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import puppeteerFull = require('puppeteer');
import { addExtra } from 'puppeteer-extra';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import rebrowserPuppeteerCore = require('rebrowser-puppeteer-core');

// rebrowser-puppeteer-core desativa o Runtime.enable automático que o
// Puppeteer normalmente dispara em toda página (necessário para
// page.evaluate() funcionar) — esse comando é observável de dentro da
// página e é um dos sinais que sistemas anti-bot (AWS WAF Bot Control,
// Cloudflare, DataDome) usam pra detectar DevTools/CDP conectado, mesmo
// com o stealth plugin ativo. https://github.com/rebrowser/rebrowser-patches
const puppeteer = addExtra(rebrowserPuppeteerCore as any);

// CommonJS compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

export class BrowserManager {
  private static browser: Browser | null = null;

  /**
   * Retorna uma instância única do browser.
   */
  static async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        // rebrowser-puppeteer-core não baixa/gerencia o Chrome sozinho (ao
        // contrário do pacote "puppeteer" completo) — por isso, na ausência
        // de PUPPETEER_EXECUTABLE_PATH, reaproveitamos o Chrome for Testing
        // que o "puppeteer" completo já baixa/gerencia como dependência.
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH ||
          puppeteerFull.executablePath(),
        headless: false,
        defaultViewport: null,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--no-zygote',
          '--window-size=1920,1080',
        ],
        protocolTimeout: 180_000, // 3 minutos
        timeout: 180_000,
      });
      console.log('✅ Browser inicializado');
    }
    return this.browser;
  }

  /**
   * Cria um novo contexto isolado (ideal para login).
   * Cada contexto tem cookies e storage próprios.
   */
  static async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = await browser.createBrowserContext();

    return context;
  }

  /**
   * Cria uma nova página dentro de um contexto isolado.
   */
  static async createPage(): Promise<{ context: BrowserContext; page: Page }> {
    const context = await this.createContext();
    const page = await context.newPage();

    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const blocked = ['image', 'font', 'media', 'stylesheet'];
      if (blocked.includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    return { context, page };
  }

  /**
   * Fecha página e contexto, mantendo o browser ativo.
   */
  static async closeContext(context: BrowserContext) {
    try {
      await context.close();
    } catch {}
  }
}
