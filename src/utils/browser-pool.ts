// src/utils/browser-pool.ts

import { BrowserContext } from 'puppeteer';
import { BrowserManager } from './browser.manager';

interface PoolItem {
  context: BrowserContext;
  busy: boolean;
}

export class BrowserPool {
  private pool: PoolItem[] = [];
  private maxContexts: number;

  constructor(maxContexts = 3) {
    this.maxContexts = maxContexts;
  }

  async init() {
    for (let i = 0; i < this.maxContexts; i++) {
      const context = await BrowserManager.createContext();
      this.pool.push({ context, busy: false });
    }
    console.log(`✅ Pool inicializado com ${this.maxContexts} contexts`);
  }

  async acquire(): Promise<BrowserContext> {
    while (true) {
      const free = this.pool.find((c) => !c.busy);
      if (free) {
        free.busy = true;
        return free.context;
      }
      // espera 100ms se não houver context livre
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  release(context: BrowserContext) {
    const item = this.pool.find((c) => c.context === context);
    if (item) item.busy = false;
  }

  async closeAll() {
    for (const item of this.pool) {
      try {
        await item.context.close();
      } catch {}
    }
  }
}
