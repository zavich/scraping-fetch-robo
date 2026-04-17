// src/utils/browser-manager.ts
import { Browser, Page, BrowserContext } from 'puppeteer';
import puppeteer from 'puppeteer-extra';

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
        executablePath:
          process.env.PUPPETEER_EXECUTABLE_PATH ||
          '/usr/bin/google-chrome-stable',
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--disable-software-rasterizer',
          '--window-size=1366,768',
          '--start-maximized',
          '--disable-blink-features=AutomationControlled',
        ],
        protocolTimeout: 120_000,
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
