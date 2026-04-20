// src/utils/browser-manager.ts

import { Browser, BrowserContext, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';

// CommonJS compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

export class BrowserManager {
  private static browser: Browser | null = null;
  /**
   * Browser singleton
   */
  static async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      this.browser = await puppeteer.launch({
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
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
          '--ignore-certificate-errors',
          '--allow-insecure-localhost',
          '--disable-features=site-per-process',
          '--disable-background-timer-throttling',
          '--disable-renderer-backgrounding',
          '--disable-backgrounding-occluded-windows',
        ],

        protocolTimeout: 120_000,
        timeout: 180_000,
        defaultViewport: null,
      });

      console.log('✅ Browser inicializado');
    }

    return this.browser;
  }

  /**
   * Contexto isolado
   */
  static async createContext(): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    return browser.createBrowserContext();
  }

  /**
   * Página pronta para scraping stealth
   */
  static async createPage(): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const context = await this.createContext();
    const page = await context.newPage();
    const client = await page.target().createCDPSession();

    await client.send('Security.setIgnoreCertificateErrors', {
      ignore: true,
    });

    // await page.authenticate({
    //   username: proxyUsername,
    //   password: proxyPassword,
    // });

    /**
     * Viewport realista
     */
    await page.setViewport({
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });
    /**
     * Headers reais
     */
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    /**
     * User agent moderno
     */
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    );

    /**
     * Anti fingerprint
     */
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false,
      });

      Object.defineProperty(navigator, 'platform', {
        get: () => 'Win32',
      });

      Object.defineProperty(navigator, 'language', {
        get: () => 'pt-BR',
      });

      Object.defineProperty(navigator, 'languages', {
        get: () => ['pt-BR', 'pt', 'en-US', 'en'],
      });

      Object.defineProperty(navigator, 'hardwareConcurrency', {
        get: () => 8,
      });

      Object.defineProperty(navigator, 'deviceMemory', {
        get: () => 8,
      });

      Object.defineProperty(navigator, 'maxTouchPoints', {
        get: () => 0,
      });

      /**
       * window.chrome fake
       */
      // @ts-ignore
      window.chrome = {
        runtime: {},
      };

      /**
       * Permissions patch
       */
      const originalQuery = window.navigator.permissions.query.bind(
        window.navigator.permissions,
      );

      // @ts-ignore
      window.navigator.permissions.query = (
        parameters: PermissionDescriptor,
      ): Promise<PermissionStatus> => {
        if (parameters.name === 'notifications') {
          return Promise.resolve({
            state: Notification.permission,
            name: 'notifications',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            dispatchEvent: () => true,
          } as PermissionStatus);
        }

        return originalQuery(parameters);
      };
    });

    /**
     * Timezone BR
     */
    await page.emulateTimezone('America/Sao_Paulo');

    /**
     * Bloqueio seletivo de assets
     */
    await page.setRequestInterception(true);

    page.on('request', (req) => {
      const blocked = ['media'];

      if (blocked.includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    /**
     * Timeouts
     */
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    return { context, page };
  }

  /**
   * Fecha contexto
   */
  static async closeContext(context: BrowserContext) {
    try {
      await context.close();
    } catch {}
  }

  /**
   * Fecha browser global
   */
  static async closeBrowser() {
    try {
      await this.browser?.close();
      this.browser = null;
    } catch {}
  }
}
