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
      memory: false,
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

    // Verifica browser
    const browserSnapshot = BrowserManager.getHealthSnapshot();
    checks.browser = browserSnapshot.connectedSlots > 0;

    // Verifica memoria (alerta se heap > 85%)
    const { heapUsed, heapTotal } = process.memoryUsage();
    checks.memory = heapUsed / heapTotal < 0.85;

    const healthy = checks.redis && checks.browser;
    if (!healthy) {
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        checks,
        browserSnapshot,
        heapUsedMB: Math.round(heapUsed / 1024 / 1024),
      });
    }

    return {
      status: 'ok',
      checks,
      browserSnapshot,
      heapUsedMB: Math.round(heapUsed / 1024 / 1024),
    };
  }
}
