import {
  Controller,
  Get,
  Inject,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { BrowserManager } from './utils/browser.manager';

@Controller()
export class AppController {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  @Get('health')
  async health() {
    const checks = {
      redis: false,
      browser: false,
    };

    // Verifica Redis
    try {
      const pong = await Promise.race([
        this.redis.ping(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error('Redis ping timeout')), 3000),
        ),
      ]);
      checks.redis = pong === 'PONG';
    } catch {}

    // Verifica browser — BrowserManager é lazy: slots só são criados no primeiro job.
    // Não marcar como unhealthy quando nenhum slot foi inicializado ainda.
    const browserSnapshot = BrowserManager.getHealthSnapshot();
    const browserInitialized = browserSnapshot.totalSlots > 0 &&
      (browserSnapshot.connectedSlots > 0 || browserSnapshot.activeContexts === 0);
    checks.browser = browserInitialized;

    // Verifica memoria (alerta se heap > 85%) — apenas informativo, não bloqueia healthy
    const { heapUsed, heapTotal } = process.memoryUsage();
    const memoryWarning = heapUsed / heapTotal >= 0.85;

    const healthy = checks.redis && checks.browser;
    if (!healthy) {
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        checks,
        memoryWarning,
        browserSnapshot,
        heapUsedMB: Math.round(heapUsed / 1024 / 1024),
      });
    }

    return {
      status: 'ok',
      checks,
      memoryWarning,
      browserSnapshot,
      heapUsedMB: Math.round(heapUsed / 1024 / 1024),
    };
  }
}
