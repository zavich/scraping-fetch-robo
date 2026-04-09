import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { CaptchaService } from 'src/services/captcha.service';
import { scraperRequest } from 'src/utils/fetch-scraper';
import { buildHeaders } from 'src/utils/user-agents';

export interface LoginResponse {
  instancia: string;
  papel: string;
  interno: boolean;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  xsrf_token: string;
}

@Injectable()
export class PjeLoginService {
  private readonly logger = new Logger(PjeLoginService.name);
  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    // this.pool.init(); // inicializa o pool
  }
  async execute(
    regionTRT: number,
    username: string,
    password: string,
    numero: string,
  ): Promise<{ cookies: string }> {
    const cacheKey = `pje:session:${regionTRT}`;
    const cachedCookies = await this.redis.get(cacheKey);

    if (cachedCookies) {
      this.logger.debug(`Sessão cacheada reutilizada para TRT-${regionTRT}`);
      return { cookies: cachedCookies };
    }

    // const { context, page } = await BrowserManager.createPage();

    try {
      const url = `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/auth`;
      // const awsWafTokenKey = `aws-waf-token:${numero}`;
      // const awsWafToken = await this.redis.get(awsWafTokenKey);
      // console.log('awsWafToken:', awsWafToken);
      await new Promise((resolve) => setTimeout(resolve, 1000));

      const headers = buildHeaders('login', '1', 2);
      const response = await scraperRequest(
        url,
        `username`,
        headers,
        'POST',
        {
          login: username,
          senha: password,
        },
        true,
      );
      const login = response.data as LoginResponse;
      const redisKey = `pje:session:${regionTRT}`;
      const cookieString = `access_token_1g=${login.access_token}; refresh_token_1g=${login.refresh_token}; instancia=${login.instancia}`;
      await this.redis.set(
        redisKey,
        cookieString,
        'EX',
        login.expires_in || 3600,
      );
      this.logger.debug(`✅ Sessão Puppeteer salva em ${redisKey}`);
      return { cookies: cookieString };
      // const loginUrl = `https://pje.trt${regionTRT}.jus.br/consultaprocessual/login`;
      // const randomUA =
      //   userAgents[Math.floor(Math.random() * userAgents.length)];
      // await page.setUserAgent(randomUA);

      // this.logger.debug(`Acessando página inicial do TRT-${regionTRT}...`);
      // await page.goto(loginUrl, { waitUntil: 'networkidle0' });
      // await page
      //   .waitForFunction(
      //     () => {
      //       const iframes = Array.from(document.querySelectorAll('iframe'));
      //       return iframes.some(
      //         (f) =>
      //           f.src.includes('awswaf') ||
      //           f.src.includes('captcha') ||
      //           f.src.includes('token'),
      //       );
      //     },
      //     { timeout: 2000 },
      //   )
      //   .catch(() => null);

      // // Depois que o iframe aparece, busca o frame correspondente
      // const wafFrame = page
      //   .frames()
      //   .find(
      //     (f) =>
      //       f.url().includes('awswaf') ||
      //       f.url().includes('captcha') ||
      //       f.url().includes('token'),
      //   );

      // if (!wafFrame) {
      //   console.log('❌ Nenhum frame AWS WAF encontrado');
      // } else {
      //   console.log('✅ Frame AWS WAF detectado:', wafFrame.url());
      // }

      // // Detecta se é uma página de WAF
      // const wafParams = await page.evaluate(() => {
      //   // @ts-ignore
      //   const w = window as any;

      //   // Tenta pegar diretamente do objeto gokuProps, se existir
      //   const key = w.gokuProps?.key || null;
      //   const iv = w.gokuProps?.iv || null;
      //   const context = w.gokuProps?.context || null;

      //   // Se não tiver, tenta extrair do HTML como fallback
      //   const html = document.documentElement.innerHTML;
      //   const backupKey =
      //     (html.match(/"key"\s*:\s*"([^"]+)"/i) || [])[1] ||
      //     (html.match(/"sitekey"\s*:\s*"([^"]+)"/i) || [])[1];

      //   const backupIv = (html.match(/"iv"\s*:\s*"([^"]+)"/i) || [])[1];
      //   const backupContext = (html.match(/"context"\s*:\s*"([^"]+)"/i) ||
      //     [])[1];

      //   const scripts = Array.from(document.querySelectorAll('script')).map(
      //     (s) => s.src,
      //   );
      //   const challengeScript = scripts.find((s) => s.includes('challenge'));
      //   const captchaScript = scripts.find((s) => s.includes('captcha'));

      //   return {
      //     websiteKey: key || backupKey,
      //     iv: iv || backupIv,
      //     context: context || backupContext,
      //     challengeScript,
      //     captchaScript,
      //   };
      // });

      // console.log('wafFrame URL:', wafFrame?.url() || '❌ não encontrado');
      // const urlObj = new URL(loginUrl);

      // const correctDomain = urlObj.hostname;
      // // if (wafParams?.websiteKey && wafParams?.context && wafParams?.iv) {
      // //   const response = await fetch(
      // //     `https://pje.trt${regionTRT}.jus.br/pje-consulta-api/api/auth`,
      // //     {
      // //       method: 'POST',
      // //       headers: {
      // //         accept: 'application/json, text/plain, */*',
      // //         'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      // //         'content-type': 'application/json',
      // //         origin: `https://pje.trt${regionTRT}.jus.br`,
      // //         priority: 'u=1, i',
      // //         referer: `https://pje.trt${regionTRT}.jus.br/consultaprocessual/login`,
      // //         'sec-ch-ua': `"Chromium";v="142", "Google Chrome";v="142", "Not_A Brand";v="99"`,
      // //         'sec-ch-ua-mobile': '?0',
      // //         'sec-ch-ua-platform': `"macOS"`,
      // //         'sec-fetch-dest': 'empty',
      // //         'sec-fetch-mode': 'cors',
      // //         'sec-fetch-site': 'same-origin',
      // //         'user-agent':
      // //           userAgents[Math.floor(Math.random() * userAgents.length)],
      // //         'x-grau-instancia': '1',
      // //         Cookie: `aws-waf-token=${wafParams?.websiteKey}`,
      // //       },
      // //       body: JSON.stringify({
      // //         login: username,
      // //         senha: password,
      // //       }),
      // //     },
      // //   );

      // //   const data = await response.json();
      // //   const cookies = [
      // //     { name: 'access_token_1g', value: data.access_token },
      // //     { name: 'refresh_token_1g', value: data.refresh_token },
      // //     { name: 'instancia', value: data.instancia },
      // //   ];
      // //   const cookieString = cookies
      // //     .map((c) => `${c.name}=${c.value}`)
      // //     .join('; ');
      // //   await this.redis.set(cacheKey, cookieString, 'EX', 3600);
      // //   return { cookies: cookieString };
      // // }
      // if (wafParams?.websiteKey && wafParams?.context && wafParams?.iv) {
      //   this.logger?.warn(
      //     '⚠️ AWS WAF detectado — tentando resolver via 2Captcha...',
      //   );
      //   const client = await page.target().createCDPSession();
      //   await client.send('Page.stopLoading');

      //   // Extrai parâmetros WAF do site
      //   const wafParamsExtracted = await page.evaluate(() => {
      //     const goku = (window as any).gokuProps;
      //     if (!goku) return null;

      //     const challengeScript = (
      //       document.querySelector(
      //         'script[src*="token.awswaf.com"]',
      //       ) as HTMLScriptElement | null
      //     )?.src;
      //     const captchaScript = (
      //       document.querySelector(
      //         'script[src*="captcha.awswaf.com"]',
      //       ) as HTMLScriptElement | null
      //     )?.src;

      //     return {
      //       websiteKey: goku.key,
      //       iv: goku.iv,
      //       context: goku.context,
      //       challengeScript,
      //       captchaScript,
      //     };
      //   });

      //   this.logger?.log(
      //     `🧩 Parâmetros AWS WAF extraídos: ${JSON.stringify(wafParamsExtracted, null, 2)}`,
      //   );

      //   const solved = await this.captchaService.resolveAwsWaf({
      //     websiteURL: loginUrl,
      //     websiteKey: (wafParamsExtracted?.websiteKey as string) || '',
      //     context: (wafParamsExtracted?.context as string) || '',
      //     iv: (wafParamsExtracted?.iv as string) || '',
      //     challengeScript:
      //       (wafParamsExtracted?.challengeScript as string) || '',
      //     captchaScript: (wafParamsExtracted?.captchaScript as string) || '',
      //   });

      //   this.logger?.log('✅ CAPTCHA resolvido via 2Captcha');

      //   const tokenToUse = solved?.existing_token as string;
      //   if (!tokenToUse) {
      //     throw new Error(
      //       'Token AWS WAF não encontrado em solved.existing_token nem em solved.captcha_voucher',
      //     );
      //   }

      //   try {
      //     // Extrai base URL do challengeScript
      //     let voucherBaseUrl = '';
      //     if (wafParamsExtracted?.challengeScript) {
      //       voucherBaseUrl = wafParamsExtracted.challengeScript.replace(
      //         /\/challenge\.js$/,
      //         '',
      //       );
      //     }
      //     this.logger?.log(`🔗 Base URL para voucher: ${voucherBaseUrl}`);

      //     const voucherResponseText = String(
      //       await page.evaluate(
      //         async (
      //           baseUrl: string,
      //           voucherBody: {
      //             captcha_voucher: string;
      //             existing_token: string;
      //           },
      //         ) => {
      //           const res = await fetch(`${baseUrl}/voucher`, {
      //             method: 'POST',
      //             headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      //             body: JSON.stringify(voucherBody),
      //           });
      //           return await res.text();
      //         },
      //         voucherBaseUrl,
      //         {
      //           captcha_voucher: String(solved.captcha_voucher ?? ''),
      //           existing_token: String(solved.existing_token ?? ''),
      //         },
      //       ),
      //     );

      //     let voucherResponse: Record<string, unknown> | null = null;
      //     try {
      //       voucherResponse = JSON.parse(voucherResponseText) as Record<
      //         string,
      //         unknown
      //       >;
      //       this.logger?.debug(
      //         `🔔 voucherResponse: ${JSON.stringify(voucherResponse).slice(0, 500)}`,
      //       );
      //     } catch {
      //       this.logger?.warn(
      //         '⚠️ Não foi possível parsear voucherResponse como JSON',
      //       );
      //     }
      //     const wafCookies = (await page.cookies()).filter((c) =>
      //       c.name.startsWith('aws-waf'),
      //     );

      //     this.logger.log(
      //       '🔥 Cookies WAF encontrados antes de limpar:',
      //       wafCookies,
      //     );

      //     if (wafCookies.length) {
      //       await page.deleteCookie(
      //         ...wafCookies.map((c) => ({
      //           name: c.name,
      //           domain: c.domain,
      //           path: c.path || '/',
      //         })),
      //       );

      //       this.logger.log('🧹 Cookies AWS WAF removidos.');
      //     }
      //     await page.evaluate(() => {
      //       localStorage.clear();
      //       sessionStorage.clear();
      //     });

      //     // Setar cookie no browser
      //     await page.setCookie({
      //       name: 'aws-waf-token',
      //       value: voucherResponse?.token as string,
      //       domain: correctDomain,
      //       path: '/',
      //       httpOnly: false,
      //       secure: true,
      //       expires: Math.floor(Date.now() / 1000) + 60 * 60,
      //     });
      //     const after = await page.cookies();
      //     this.logger.log(
      //       '🍪 Cookies depois de setar token:',
      //       after.filter((c) => c.name.includes('waf')),
      //     );

      //     this.logger?.log('🍪 Cookie aws-waf-token setado no browser');
      //     // Recarrega a página para validar token
      //     await page.goto(loginUrl, {
      //       waitUntil: 'networkidle0',
      //       timeout: 60000,
      //     });
      //     this.logger?.log('🔁 Página recarregada após ativar token AWS WAF');
      //   } catch (err) {
      //     this.logger?.warn(
      //       '⚠️ Falha ao setar cookie via page.setCookie, tentando fallback',
      //     );
      //     await page.evaluate(
      //       (name, val) => {
      //         document.cookie = `${name}=${val}; path=/; max-age=${60 * 60}; Secure; SameSite=None`;
      //       },
      //       'aws-waf-token',
      //       tokenToUse,
      //     );
      //     this.logger?.log(
      //       '🍪 Cookie aws-waf-token setado via document.cookie (fallback)',
      //     );
      //   }
      // }
      // this.logger.log('🔍 Verificando se AWS WAF foi realmente removido...');

      // const stillWaf = await page
      //   .waitForSelector('input[name="usuario"]', { timeout: 3000 })
      //   .then(() => false)
      //   .catch(() => true);

      // if (stillWaf) {
      //   throw new ServiceUnavailableException(
      //     'AWS WAF ainda ativo após resolução — necessário retry.',
      //   );
      // }

      // this.logger.log('🟢 AWS WAF removido! Prosseguindo com o login...');
      // await new Promise((resolve) => setTimeout(resolve, 800));
      // await page.waitForSelector('input[name="usuario"]', { visible: true });
      // await page.type('input[name="usuario"]', username);
      // await page.type('input[name="senha"]', password);

      // await Promise.all([
      //   page.waitForNavigation({ waitUntil: 'networkidle0' }),
      //   page.click('#btnEntrar'),
      // ]);

      // const finalUrl = page.url();
      // const html = await page.content();

      // if (
      //   finalUrl.includes('login') ||
      //   html.includes('Usuário ou senha inválidos')
      // ) {
      //   throw new ServiceUnavailableException('Credenciais inválidas.');
      // }

      // const cookies = await page.cookies();
      // const cookieString = cookies
      //   .map((c) => `${c.name}=${c.value}`)
      //   .join('; ');

      // await this.redis.set(cacheKey, cookieString, 'EX', 1800);

      // this.logger.debug(`✅ Sessão Puppeteer salva em ${cacheKey}`);

      // return { cookies: cookieString };
    } catch (err) {
      this.logger.error(
        `Erro no login do TRT ${regionTRT}: ${err.message}`,
        err.stack,
      );
      throw new ServiceUnavailableException(
        `Erro ao realizar login no TRT ${regionTRT}: ${err.message}`,
      );
    }
  }
}
