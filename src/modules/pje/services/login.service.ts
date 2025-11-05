import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import axios from 'axios';
import { BrowserManager } from 'src/utils/browser.manager';
import { userAgents } from 'src/utils/user-agents';

interface LoginResponse {
  access_token: string;
  refresh_token: string;
  instancia: string;
}

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

      this.logger.debug(`Acessando página inicial do TRT-${regionTRT}...`);
      await page.goto(loginUrl, { waitUntil: 'networkidle0' });

      await new Promise((resolve) => setTimeout(resolve, 800));

      const hasCaptcha = await page.$('#amzn-captcha-verify-button');

      // ✅ LOGIN VIA AXIOS QUANDO HÁ CAPTCHA
      if (hasCaptcha) {
        this.logger.warn('CAPTCHA detectado → usando Axios');

        try {
          const url = `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/auth`;

          const userAgent =
            userAgents[Math.floor(Math.random() * userAgents.length)];

          const response = await axios.post<LoginResponse>(
            url,
            { login: username, senha: password },
            {
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                origin: `https://pje.trt${regionTRT}.jus.br`,
                referer: url,
                'user-agent': userAgent,
                'x-grau-instancia': '1',
              },
              withCredentials: true,
            },
          );

          const api = response.data;

          if (!api.access_token || !api.refresh_token) {
            throw new ServiceUnavailableException(
              'Resposta inválida do PJe (faltam tokens)',
            );
          }

          // ✅ MONTA O COOKIE EXATAMENTE COMO NO SEU EXEMPLO
          const cookieString =
            `access_token_1g=${api.access_token}; ` +
            `refresh_token_1g=${api.refresh_token}; ` +
            `instancia=${api.instancia}`;

          // ✅ SALVA NO REDIS NO FORMATO FINAL
          await this.redis.set(cacheKey, cookieString, 'EX', 1800);

          this.logger.debug(`✅ Tokens salvos no Redis: ${cacheKey}`);

          return { cookies: cookieString };
        } catch (err: unknown) {
          let trace: string;
          if (err instanceof Error) trace = err.stack ?? err.message;
          else trace = String(err);
          this.logger.error('Erro no login via Axios', trace);
          throw new ServiceUnavailableException(
            'Falha no login via API ao detectar CAPTCHA.',
          );
        }
      }

      // ✅ LOGIN NORMAL VIA PUPPETEER
      this.logger.debug('Nenhum CAPTCHA → login via Puppeteer');

      await page.waitForSelector('input[name="usuario"]', { visible: true });
      await page.type('input[name="usuario"]', username);
      await page.type('input[name="senha"]', password);

      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('#btnEntrar'),
      ]);

      const finalUrl = page.url();
      const html = await page.content();

      if (
        finalUrl.includes('login') ||
        html.includes('Usuário ou senha inválidos')
      ) {
        throw new ServiceUnavailableException('Credenciais inválidas.');
      }

      const cookies = await page.cookies();
      const cookieString = cookies
        .map((c) => `${c.name}=${c.value}`)
        .join('; ');

      await this.redis.set(cacheKey, cookieString, 'EX', 1800);

      this.logger.debug(`✅ Sessão Puppeteer salva em ${cacheKey}`);

      return { cookies: cookieString };
    } finally {
      await BrowserManager.closeContext(context);
    }
  }
}
