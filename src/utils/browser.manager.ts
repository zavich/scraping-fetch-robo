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
const PAGE_VIEWPORT = {
  width: 1366,
  height: 768,
  deviceScaleFactor: 1,
  isMobile: false,
  hasTouch: false,
} as const;

// Número de instâncias paralelas de browser (configurable via env var BROWSER_POOL_SIZE)
const BROWSER_POOL_SIZE = Math.max(
  1,
  parseInt(process.env.BROWSER_POOL_SIZE ?? '3', 10) || 3,
);

interface BrowserSlot {
  browser: Browser | null;
  contextCount: number;
  activeContexts: number;
  index: number;
  recyclePending: boolean;
  /** Promise em andamento para lançar/reciclar o browser — evita race condition TOCTOU */
  initializing: Promise<Browser> | null;
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
    (_, i) => ({
      browser: null,
      contextCount: 0,
      activeContexts: 0,
      index: i,
      recyclePending: false,
      initializing: null,
    }),
  );
  private static roundRobinIndex = 0;
  private static readonly contextSlotIndex = new WeakMap<
    BrowserContext,
    number
  >();
  private static readonly interceptedPages = new WeakSet<Page>();
  private static readonly pagesWithDefaultRequestHandler = new WeakSet<Page>();

  private static readonly LAUNCH_ARGS = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-software-rasterizer',
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1366,768',
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
      defaultViewport: PAGE_VIEWPORT,
    });
    BrowserManager.logger.log(`[slot-${slotIndex}] Browser inicializado`);
    return browser;
  }

  private static async getOrCreateBrowserSlot(
    slotIndex: number,
  ): Promise<BrowserSlot> {
    const slot = BrowserManager.slots[slotIndex];

    // Aguarda inicialização em curso para evitar race TOCTOU: dois callers
    // concorrentes passariam ambos no check `!slot.browser` antes de qualquer
    // um atribuir o novo browser, causando dois launchBrowser simultâneos e
    // descartando o primeiro.
    if (!slot.browser || !slot.browser.isConnected()) {
      if (!slot.initializing) {
        slot.initializing = (async () => {
          // Fecha o browser desconectado antes de lançar novo para evitar zombies
          if (slot.browser) {
            await slot.browser.close().catch(() => {});
            slot.browser = null;
          }
          return BrowserManager.launchBrowser(slotIndex);
        })()
          .then((browser) => {
            slot.browser = browser;
            slot.contextCount = 0;
            slot.activeContexts = 0;
            slot.recyclePending = false;
            slot.initializing = null;
            return browser;
          })
          .catch((err: unknown) => {
            slot.initializing = null;
            throw err;
          });
      }
      await slot.initializing;
    }

    if (slot.contextCount >= MAX_CONTEXTS_PER_BROWSER) {
      if (slot.activeContexts > 0) {
        slot.recyclePending = true;
        BrowserManager.logger.warn(
          `[slot-${slotIndex}] reciclagem adiada: ${slot.activeContexts} contextos ainda ativos`,
        );
      } else {
        BrowserManager.logger.log(
          `[slot-${slotIndex}] ${slot.contextCount} contextos criados — reiniciando browser para evitar zombies`,
        );
        if (!slot.initializing) {
          slot.initializing = (async () => {
            try {
              if (slot.browser) {
                await slot.browser.close();
              }
            } catch {
              // ignore close errors
            }
            const browser = await BrowserManager.launchBrowser(slotIndex);
            slot.browser = browser;
            slot.contextCount = 0;
            slot.recyclePending = false;
            slot.initializing = null;
            return browser;
          })().catch((err: unknown) => {
            slot.initializing = null;
            throw err;
          });
        }
        await slot.initializing;
      }
    }

    return slot;
  }

  /**
   * Returns a browser for the next slot via round-robin.
   * Throws if the slot fails to initialize — no silent fallback to another slot.
   */
  static async getBrowser(): Promise<Browser> {
    const slotIndex = BrowserManager.getNextSlotIndex();
    const slot = await BrowserManager.getOrCreateBrowserSlot(slotIndex);
    if (!slot.browser) {
      throw new Error(
        `[slot-${slotIndex}] Browser slot not initialized after getOrCreateBrowserSlot`,
      );
    }
    return slot.browser;
  }

  private static getNextSlotIndex(): number {
    const slotIndex = BrowserManager.roundRobinIndex;
    BrowserManager.roundRobinIndex =
      (BrowserManager.roundRobinIndex + 1) % BROWSER_POOL_SIZE;
    return slotIndex;
  }

  /**
   * Contexto isolado — distribuído entre os N browsers do pool (PERF-001)
   */
  static async createContext(): Promise<BrowserContext> {
    const slotIndex = BrowserManager.getNextSlotIndex();
    const slot = await BrowserManager.getOrCreateBrowserSlot(slotIndex);
    // Incrementar após createBrowserContext para evitar vazamento de contadores
    // caso a chamada falhe antes de retornar o contexto
    if (!slot.browser) {
      throw new Error(
        `[slot-${slotIndex}] Browser slot not initialized after getOrCreateBrowserSlot`,
      );
    }
    const context = await slot.browser.createBrowserContext();
    slot.contextCount++;
    slot.activeContexts++;
    BrowserManager.contextSlotIndex.set(context, slotIndex);
    return context;
  }

  /**
   * Página pronta para scraping stealth
   */
  static async createPage(): Promise<{
    context: BrowserContext;
    page: Page;
  }> {
    const context = await BrowserManager.createContext();
    try {
      const page = await context.newPage();

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

      await BrowserManager.ensureRequestInterception(page);

      // Timeouts
      page.setDefaultTimeout(120000);
      page.setDefaultNavigationTimeout(120000);

      return { context, page };
    } catch (err) {
      // Garante que o contexto é fechado se qualquer etapa de setup falhar
      await BrowserManager.closeContext(context).catch(() => {});
      throw err;
    }
  }

  static async ensureRequestInterception(page: Page): Promise<void> {
    if (!BrowserManager.interceptedPages.has(page)) {
      await page.setRequestInterception(true);
      BrowserManager.interceptedPages.add(page);
    }

    if (BrowserManager.pagesWithDefaultRequestHandler.has(page)) {
      return;
    }

    page.on('request', (req) => {
      if (req.isInterceptResolutionHandled()) {
        return;
      }

      if (req.resourceType() === 'media') {
        req.abort().catch(() => {});
        return;
      }

      req.continue().catch(() => {});
    });
    BrowserManager.pagesWithDefaultRequestHandler.add(page);
  }

  /**
   * Fecha contexto
   */
  static async closeContext(context: BrowserContext): Promise<void> {
    const slotIndex = BrowserManager.contextSlotIndex.get(context);
    BrowserManager.contextSlotIndex.delete(context);

    try {
      await context.close();
    } catch {
      // ignore
    }

    if (slotIndex === undefined) {
      return;
    }

    const slot = BrowserManager.slots[slotIndex];
    slot.activeContexts = Math.max(0, slot.activeContexts - 1);

    if (slot.recyclePending && slot.activeContexts === 0 && slot.browser) {
      try {
        await slot.browser.close();
      } catch {
        // ignore close errors
      } finally {
        slot.browser = null;
        slot.contextCount = 0;
        slot.recyclePending = false;
      }
    }
  }

  /**
   * Fecha todos os browsers do pool
   */
  static async closeAll(): Promise<void> {
    await Promise.allSettled(
      BrowserManager.slots.map(async (slot) => {
        // Aguarda lançamento em curso antes de fechar para não deixar zombies
        if (slot.initializing) {
          await slot.initializing.catch(() => {});
        }
        if (slot.browser) {
          try {
            await slot.browser.close();
          } finally {
            slot.browser = null;
            slot.contextCount = 0;
            slot.activeContexts = 0;
            slot.recyclePending = false;
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

  static getHealthSnapshot(): {
    connectedSlots: number;
    initializedSlots: number;
    totalSlots: number;
    roundRobinIndex: number;
    activeContexts: number;
    recyclePendingSlots: number;
  } {
    return {
      connectedSlots: BrowserManager.slots.filter((slot) =>
        slot.browser?.isConnected(),
      ).length,
      // Slots com browser ativo no momento (browser !== null); zera após reciclagem/closeAll
      initializedSlots: BrowserManager.slots.filter(
        (slot) => slot.browser !== null,
      ).length,
      totalSlots: BrowserManager.slots.length,
      roundRobinIndex: BrowserManager.roundRobinIndex,
      activeContexts: BrowserManager.slots.reduce(
        (total, slot) => total + slot.activeContexts,
        0,
      ),
      recyclePendingSlots: BrowserManager.slots.filter(
        (slot) => slot.recyclePending,
      ).length,
    };
  }
}
