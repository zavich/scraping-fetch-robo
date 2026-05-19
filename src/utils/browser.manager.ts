// src/utils/browser-manager.ts

import { Logger } from '@nestjs/common';
import { Browser, BrowserContext, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';

// CommonJS compat
// eslint-disable-next-line @typescript-eslint/no-require-imports
const StealthPlugin = require('puppeteer-extra-plugin-stealth');

puppeteer.use(StealthPlugin());

// Reinicia cada slot após N contextos para evitar acúmulo de Chrome zombies (EST-003)
const MAX_CONTEXTS_PER_BROWSER = 200;

// Número de instâncias paralelas de browser (configurable via env var BROWSER_POOL_SIZE)
const BROWSER_POOL_SIZE = Math.max(
  1,
  parseInt(process.env.BROWSER_POOL_SIZE ?? '3', 10),
);

interface BrowserSlot {
  browser: Browser | null;
  contextCount: number;
  index: number;
}

/**
 * Pool de instâncias de browser.
 * Distribui contextos entre N browsers para isolamento de falhas (PERF-001):
 * se um browser travar, apenas ~1/N das operações são afetadas.
 */
export class BrowserManager {
  private static readonly logger = new Logger('BrowserManager');
  private static slots: BrowserSlot[] = Array.from(
    { length: BROWSER_POOL_SIZE },
    (_, i) => ({ browser: null, contextCount: 0, index: i }),
  );
  private static roundRobinIndex = 0;

  private static readonly LAUNCH_ARGS = [
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
  ];

  private static async launchBrowser(slotIndex: number): Promise<Browser> {
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: BrowserManager.LAUNCH_ARGS,
      protocolTimeout: 120_000,
      timeout: 180_000,
      defaultViewport: null,
    });
    BrowserManager.logger.log(`[slot-${slotIndex}] Browser inicializado`);
    return browser;
  }

  private static async getOrCreateBrowserSlot(slotIndex: number): Promise<BrowserSlot> {
    const slot = BrowserManager.slots[slotIndex];

    if (!slot.browser || !slot.browser.isConnected()) {
      slot.browser = await BrowserManager.launchBrowser(slotIndex);
      slot.contextCount = 0;
    }

    if (slot.contextCount >= MAX_CONTEXTS_PER_BROWSER) {
      BrowserManager.logger.log(
        `[slot-${slotIndex}] ${slot.contextCount} contextos criados — reiniciando browser para evitar zombies`,
      );
      try {
        await slot.browser.close();
      } catch {
        // ignore close errors
      }
      slot.browser = await BrowserManager.launchBrowser(slotIndex);
      slot.contextCount = 0;
    }

    return slot;
  }

  /**
   * Picks the next slot via round-robin, falls back to another if dead.
   */
  static async getBrowser(): Promise<Browser> {
    const slot = await BrowserManager.getOrCreateBrowserSlot(
      BrowserManager.roundRobinIndex % BROWSER_POOL_SIZE,
    );
    BrowserManager.roundRobinIndex =
      (BrowserManager.roundRobinIndex + 1) % BROWSER_POOL_SIZE;
    return slot.browser!;
  }

  /**
   * Contexto isolado — distribuído entre os N browsers do pool (PERF-001)
   */
  static async createContext(): Promise<BrowserContext> {
    const slotIndex = BrowserManager.roundRobinIndex % BROWSER_POOL_SIZE;
    BrowserManager.roundRobinIndex =
      (BrowserManager.roundRobinIndex + 1) % BROWSER_POOL_SIZE;

    const slot = await BrowserManager.getOrCreateBrowserSlot(slotIndex);
    slot.contextCount++;
    return slot.browser!.createBrowserContext();
  }

  /**
   * Página pronta para scraping stealth
   */
  static async createPage(): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const context = await BrowserManager.createContext();
    const page = await context.newPage();

    // Viewport realista
    await page.setViewport({
      width: 1366,
      height: 768,
      deviceScaleFactor: 1,
      isMobile: false,
      hasTouch: false,
    });

    // Headers reais
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
    });

    // User agent moderno
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        '(KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36',
    );

    // Anti fingerprint
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => false });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'language', { get: () => 'pt-BR' });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['pt-BR', 'pt', 'en-US', 'en'],
      });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
      Object.defineProperty(navigator, 'maxTouchPoints', { get: () => 0 });

      // window.chrome fake
      // @ts-ignore
      window.chrome = { runtime: {} };

      // Permissions patch
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

    // Timezone BR
    await page.emulateTimezone('America/Sao_Paulo');

    // Bloqueio seletivo de assets
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      if (['media'].includes(req.resourceType())) {
        req.abort().catch(() => {});
      } else {
        req.continue().catch(() => {});
      }
    });

    // Timeouts
    page.setDefaultTimeout(120000);
    page.setDefaultNavigationTimeout(120000);

    return { context, page };
  }

  /**
   * Fecha contexto
   */
  static async closeContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch {
      // ignore
    }
  }

  /**
   * Fecha todos os browsers do pool
   */
  static async closeAll(): Promise<void> {
    await Promise.allSettled(
      BrowserManager.slots.map(async (slot) => {
        if (slot.browser) {
          try {
            await slot.browser.close();
          } finally {
            slot.browser = null;
          }
        }
      }),
    );
  }

  /**
   * @deprecated Use closeAll() instead
   */
  static async closeBrowser(): Promise<void> {
    return BrowserManager.closeAll();
  }
}
