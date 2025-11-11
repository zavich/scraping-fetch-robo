import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CaptchaService } from 'src/services/captcha.service';
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
  constructor(private readonly captchaService: CaptchaService) {
    // this.pool.init(); // inicializa o pool
  }
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
      await page
        .waitForFunction(
          () => {
            const iframes = Array.from(document.querySelectorAll('iframe'));
            return iframes.some(
              (f) =>
                f.src.includes('awswaf') ||
                f.src.includes('captcha') ||
                f.src.includes('token'),
            );
          },
          { timeout: 2000 },
        )
        .catch(() => null);

      // Depois que o iframe aparece, busca o frame correspondente
      const wafFrame = page
        .frames()
        .find(
          (f) =>
            f.url().includes('awswaf') ||
            f.url().includes('captcha') ||
            f.url().includes('token'),
        );

      if (!wafFrame) {
        console.log('❌ Nenhum frame AWS WAF encontrado');
      } else {
        console.log('✅ Frame AWS WAF detectado:', wafFrame.url());
      }

      // Detecta se é uma página de WAF
      const wafParams = await page.evaluate(() => {
        // @ts-ignore
        const w = window as any;

        // Tenta pegar diretamente do objeto gokuProps, se existir
        const key = w.gokuProps?.key || null;
        const iv = w.gokuProps?.iv || null;
        const context = w.gokuProps?.context || null;

        // Se não tiver, tenta extrair do HTML como fallback
        const html = document.documentElement.innerHTML;
        const backupKey =
          (html.match(/"key"\s*:\s*"([^"]+)"/i) || [])[1] ||
          (html.match(/"sitekey"\s*:\s*"([^"]+)"/i) || [])[1];

        const backupIv = (html.match(/"iv"\s*:\s*"([^"]+)"/i) || [])[1];
        const backupContext = (html.match(/"context"\s*:\s*"([^"]+)"/i) ||
          [])[1];

        const scripts = Array.from(document.querySelectorAll('script')).map(
          (s) => s.src,
        );
        const challengeScript = scripts.find((s) => s.includes('challenge'));
        const captchaScript = scripts.find((s) => s.includes('captcha'));

        return {
          websiteKey: key || backupKey,
          iv: iv || backupIv,
          context: context || backupContext,
          challengeScript,
          captchaScript,
        };
      });

      console.log('wafParams:', wafParams);

      console.log('wafFrame URL:', wafFrame?.url() || '❌ não encontrado');
      console.log('wafParams:', wafParams);
      const { hostname } = new URL(loginUrl);

      if (wafParams?.websiteKey && wafParams?.context && wafParams?.iv) {
        this.logger?.warn(
          '⚠️ AWS WAF detectado — tentando resolver via 2Captcha...',
        );

        // Extrai parâmetros WAF do site
        const wafParamsExtracted = await page.evaluate(() => {
          const goku = (window as any).gokuProps;
          if (!goku) return null;

          const challengeScript = (
            document.querySelector(
              'script[src*="token.awswaf.com"]',
            ) as HTMLScriptElement | null
          )?.src;
          const captchaScript = (
            document.querySelector(
              'script[src*="captcha.awswaf.com"]',
            ) as HTMLScriptElement | null
          )?.src;

          return {
            websiteKey: goku.key,
            iv: goku.iv,
            context: goku.context,
            challengeScript,
            captchaScript,
          };
        });

        this.logger?.log(
          `🧩 Parâmetros AWS WAF extraídos: ${JSON.stringify(wafParamsExtracted, null, 2)}`,
        );

        const solved = await this.captchaService.resolveAwsWaf({
          websiteURL: loginUrl,
          websiteKey: (wafParamsExtracted?.websiteKey as string) || '',
          context: (wafParamsExtracted?.context as string) || '',
          iv: (wafParamsExtracted?.iv as string) || '',
          challengeScript:
            (wafParamsExtracted?.challengeScript as string) || '',
          captchaScript: (wafParamsExtracted?.captchaScript as string) || '',
        });

        this.logger?.log('✅ CAPTCHA resolvido via 2Captcha');

        const tokenToUse = solved?.existing_token as string;
        if (!tokenToUse) {
          throw new Error(
            'Token AWS WAF não encontrado em solved.existing_token nem em solved.captcha_voucher',
          );
        }

        try {
          // Extrai base URL do challengeScript
          let voucherBaseUrl = '';
          if (wafParamsExtracted?.challengeScript) {
            voucherBaseUrl = wafParamsExtracted.challengeScript.replace(
              /\/challenge\.js$/,
              '',
            );
          }
          this.logger?.log(`🔗 Base URL para voucher: ${voucherBaseUrl}`);

          const voucherResponseText = String(
            await page.evaluate(
              async (
                baseUrl: string,
                voucherBody: {
                  captcha_voucher: string;
                  existing_token: string;
                },
              ) => {
                const res = await fetch(`${baseUrl}/voucher`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
                  body: JSON.stringify(voucherBody),
                });
                return await res.text();
              },
              voucherBaseUrl,
              {
                captcha_voucher: String(solved.captcha_voucher ?? ''),
                existing_token: String(solved.existing_token ?? ''),
              },
            ),
          );

          let voucherResponse: Record<string, unknown> | null = null;
          try {
            voucherResponse = JSON.parse(voucherResponseText) as Record<
              string,
              unknown
            >;
            this.logger?.debug(
              `🔔 voucherResponse: ${JSON.stringify(voucherResponse).slice(0, 500)}`,
            );
          } catch {
            this.logger?.warn(
              '⚠️ Não foi possível parsear voucherResponse como JSON',
            );
          }
          const cookies = await page.cookies();
          if (cookies.length) {
            await page.deleteCookie(
              ...cookies.map((c) => ({
                name: c.name,
                domain: c.domain,
                path: c.path,
              })),
            );
          }
          // Setar cookie no browser
          await page.setCookie({
            name: 'aws-waf-token',
            value: voucherResponse?.token as string,
            domain: hostname,
            path: '/',
            httpOnly: false,
            secure: true,
            expires: Math.floor(Date.now() / 1000) + 60 * 60,
          });

          this.logger?.log('🍪 Cookie aws-waf-token setado no browser');

          // Recarrega a página para validar token
          await page.goto(loginUrl, {
            waitUntil: 'networkidle0',
            timeout: 60000,
          });
          this.logger?.log('🔁 Página recarregada após ativar token AWS WAF');
        } catch (err) {
          this.logger?.warn(
            '⚠️ Falha ao setar cookie via page.setCookie, tentando fallback',
          );
          await page.evaluate(
            (name, val) => {
              document.cookie = `${name}=${val}; path=/; max-age=${60 * 60}; Secure; SameSite=None`;
            },
            'aws-waf-token',
            tokenToUse,
          );
          this.logger?.log(
            '🍪 Cookie aws-waf-token setado via document.cookie (fallback)',
          );
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 800));

      // const hasCaptcha = await page.$('#amzn-captcha-verify-button');

      // // ✅ LOGIN VIA AXIOS QUANDO HÁ CAPTCHA
      // if (hasCaptcha) {
      //   this.logger.warn('CAPTCHA detectado → usando Axios');

      //   try {
      //     const url = `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/auth`;

      //     const userAgent =
      //       userAgents[Math.floor(Math.random() * userAgents.length)];

      //     const response = await axios.post<LoginResponse>(
      //       url,
      //       { login: username, senha: password },
      //       {
      //         headers: {
      //           accept: 'application/json, text/plain, */*',
      //           'content-type': 'application/json',
      //           origin: `https://pje.trt${regionTRT}.jus.br`,
      //           referer: url,
      //           'user-agent': userAgent,
      //           'x-grau-instancia': '1',
      //         },
      //         withCredentials: true,
      //       },
      //     );

      //     const api = response.data;

      //     if (!api.access_token || !api.refresh_token) {
      //       throw new ServiceUnavailableException(
      //         'Resposta inválida do PJe (faltam tokens)',
      //       );
      //     }

      //     // ✅ MONTA O COOKIE EXATAMENTE COMO NO SEU EXEMPLO
      //     const cookieString =
      //       `access_token_1g=${api.access_token}; ` +
      //       `refresh_token_1g=${api.refresh_token}; ` +
      //       `instancia=${api.instancia}`;

      //     // ✅ SALVA NO REDIS NO FORMATO FINAL
      //     await this.redis.set(cacheKey, cookieString, 'EX', 1800);

      //     this.logger.debug(`✅ Tokens salvos no Redis: ${cacheKey}`);

      //     return { cookies: cookieString };
      //   } catch (err: unknown) {
      //     let trace: string;
      //     if (err instanceof Error) trace = err.stack ?? err.message;
      //     else trace = String(err);
      //     this.logger.error('Erro no login via Axios', trace);
      //     throw new ServiceUnavailableException(
      //       'Falha no login via API ao detectar CAPTCHA.',
      //     );
      //   }
      // }

      // ✅ LOGIN NORMAL VIA PUPPETEER
      // this.logger.debug('Nenhum CAPTCHA → login via Puppeteer');

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
