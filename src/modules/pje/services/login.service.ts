import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { BrowserManager } from 'src/utils/browser.manager';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class PjeLoginService {
  private readonly logger = new Logger(PjeLoginService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

  async execute(
    regionTRT: number,
    username: string,
    password: string,
  ): Promise<{ cookies: string }> {
    const cacheKey = `pje:session:${regionTRT}`;
    const cachedCookies = await this.redis.get(cacheKey);
    if (cachedCookies) {
      this.logger.debug(`Sessão cacheada reutilizada para TRT-${regionTRT}`);
      return { cookies: cachedCookies };
    }

    const { context, page } = await BrowserManager.createPage();
    try {
      const loginUrl = `https://pje.trt${regionTRT}.jus.br/primeirograu/login.seam`;

      const randomUA =
        userAgents[Math.floor(Math.random() * userAgents.length)];
      await page.setUserAgent(randomUA);
      await page.goto(loginUrl, { waitUntil: 'load' });

      await page.waitForSelector('#btnSsoPdpj');
      await page.click('#btnSsoPdpj');

      await page.waitForSelector('#username', { visible: true });
      await page.type('#username', username, { delay: 50 });
      await page.type('#password', password, { delay: 50 });

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('input[type="submit"]'),
      ]);

      const content = await page.content();
      if (content.includes('JBWEB000065')) {
        throw new ServiceUnavailableException('Credenciais inválidas');
      }

      const cookies = await page.cookies();
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

      await this.redis.set(cacheKey, cookieString, 'EX', 1800);
      return { cookies: cookieString };
    } finally {
      await BrowserManager.closeContext(context);
    }
  }
}
