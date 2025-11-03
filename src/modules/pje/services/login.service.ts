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
      const loginUrl = `https://pje.trt${regionTRT}.jus.br/consultaprocessual/login`;

      const randomUA =
        userAgents[Math.floor(Math.random() * userAgents.length)];
      await page.setUserAgent(randomUA);

      this.logger.debug(`Acessando login TRT-${regionTRT} via novo método...`);
      await page.goto(loginUrl, { waitUntil: 'networkidle0' });

      // ✅ Espera campo usuário
      await page.waitForSelector('input[name="usuario"]', { visible: true });

      // ✅ Preenche credenciais
      await page.type('input[name="usuario"]', username, { delay: 50 });
      await page.type('input[name="senha"]', password, { delay: 50 });

      // ✅ Clique no botão submit do Angular Material
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('#btnEntrar'),
      ]);

      // ✅ Verificar se o login deu certo
      const finalUrl = page.url();
      const html = await page.content();

      if (
        finalUrl.includes('login') ||
        html.includes('Usuário ou senha inválidos') ||
        html.includes('senha incorreta')
      ) {
        throw new ServiceUnavailableException('Credenciais inválidas no PJe.');
      }

      // ✅ Sucesso — obtém cookies
      const cookies = await page.cookies();
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');
      if (!cookieString) {
        this.logger.error('Falha ao obter cookies de sessão.');
        throw new ServiceUnavailableException(
          'Falha ao obter cookies de sessão.',
        );
      }
      await this.redis.set(cacheKey, cookieString, 'EX', 1800);
      this.logger.debug(`✅ Login TRT-${regionTRT} realizado com sucesso!`);

      return { cookies: cookieString };
    } finally {
      await BrowserManager.closeContext(context);
    }
  }
}
