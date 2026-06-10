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
      let pingTimer: ReturnType<typeof setTimeout> | undefined;
      const pong = await Promise.race([
        this.redis.ping().catch(() => null),
        new Promise<null>((_, reject) => {
          pingTimer = setTimeout(
            () => reject(new Error('Redis ping timeout')),
            3000,
          );
        }),
      ]).finally(() => clearTimeout(pingTimer));
      checks.redis = pong === 'PONG';
    } catch {}

    // BrowserManager é lazy: browsers só são criados no primeiro job.
    // initializedSlots conta slots com browser !== null AGORA (zera após reciclagem).
    // Se não há browsers ativos (warm-up ou reciclagem em curso), não penalizar.
    // Só marca falha se há browsers inicializados mas nenhum conectado.
    const browserSnapshot = BrowserManager.getHealthSnapshot();
    const noActiveBrowsers = browserSnapshot.initializedSlots === 0;
    checks.browser = noActiveBrowsers || browserSnapshot.connectedSlots > 0;

    // Verifica memoria — alerta se RSS >= 85% do threshold OOM (mesmo sinal do restart)
    const { rss, heapUsed } = process.memoryUsage();
    const rssMB = Math.round(rss / 1024 / 1024);
    const OOM_THRESHOLD_MB = Number(process.env.OOM_THRESHOLD_MB ?? 1800);
    const memoryWarning = rssMB >= Math.round(OOM_THRESHOLD_MB * 0.85);

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
