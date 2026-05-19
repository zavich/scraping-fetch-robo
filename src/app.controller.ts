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
      const pong = await this.redis.ping();
      checks.redis = pong === 'PONG';
    } catch {}

    // Verifica browser
    try {
      const browser = await BrowserManager.getBrowser();
      checks.browser = browser.isConnected();
    } catch {}

    // Verifica memoria (alerta se heap > 85%)
    const { heapUsed, heapTotal } = process.memoryUsage();
    checks.memory = heapUsed / heapTotal < 0.85;

    const healthy = checks.redis && checks.browser;
    if (!healthy) {
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        checks,
        heapUsedMB: Math.round(heapUsed / 1024 / 1024),
      });
    }

    return {
      status: 'ok',
      checks,
      heapUsedMB: Math.round(heapUsed / 1024 / 1024),
    };
  }
}
