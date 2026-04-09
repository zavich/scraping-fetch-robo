import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CDPSession, Page } from 'puppeteer';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserPool } from 'src/utils/browser-pool';
import { BrowserManager } from 'src/utils/browser.manager';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);

  private readonly pool = new BrowserPool(10); // exemplo: 30 contexts simultâneos

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    this.pool.init(); // inicializa o pool
  }
  async execute(
    processNumber: string,
    regionTRT: number,
    instanceIndex: number,
    usedCookies = false,
  ) {
    this.logger.log(
      `▶ Iniciando scraping do processo ${processNumber} (TRT ${regionTRT}, Instância ${instanceIndex})`,
    );
    const { page, context } = await BrowserManager.createPage();
    this.logger.log('✅ Contexto adquirido do pool');

    this.logger.log('✅ Nova página aberta');

    let processCaptured = false;
    const requestMap = new Map<string, string>();

    const retry = async <T>(
      fn: () => Promise<T>,
      retries = 3,
      delayMs = 1000,
      stepName?: string,
    ) => {
      let lastError: unknown;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const result = await fn();
          this.logger.log(
            `✅ Etapa '${stepName}' concluída na tentativa ${attempt}`,
          );
          return result;
        } catch (err) {
          lastError = err;
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `❌ Tentativa ${attempt}/${retries} falhou na etapa '${stepName}': ${msg}`,
          );
          if (attempt < retries)
            await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      throw lastError;
    };

    const initCDP = async (pg: Page): Promise<CDPSession> => {
      this.logger.log('🔧 Inicializando CDP para monitoramento de rede...');
      const client: CDPSession = await pg.target().createCDPSession();
      await client.send('Network.enable');

      client.on('Network.requestWillBeSent', (event) => {
        if (event.requestId && event.request?.url) {
          requestMap.set(event.requestId, event.request.url);
        }
      });

      client.on('Network.responseReceived', (event) => {
        void (async () => {
          try {
            const url =
              event.response?.url ?? requestMap.get(event.requestId) ?? '';
            // this.logger.debug(
            //   `⬅ Response recebida: ${url} [${event.response?.status}]`,
            // );

            if (
              !processCaptured &&
              url.match(/\/pje-consulta-api\/api\/processos\/\d+/)
            ) {
              this.logger.debug(
                `📥 Tentando capturar JSON do processo em: ${url}`,
              );

              for (let attempt = 0; attempt < 6; attempt++) {
                try {
                  const body = await client.send('Network.getResponseBody', {
                    requestId: event.requestId,
                  });
                  const text = body.base64Encoded
                    ? Buffer.from(body.body, 'base64').toString('utf8')
                    : body.body;

                  try {
                    const json: unknown = JSON.parse(text);

                    const valid =
                      (Array.isArray(json) && json.length > 0) ||
                      (typeof json === 'object' &&
                        json !== null &&
                        'id' in json);
                    if (valid) {
                      // capturedResponseData = json;
                      processCaptured = true;
                      this.logger.log('✅ Processo capturado via CDP!');
                      this.logger.debug(
                        JSON.stringify(json, null, 2).slice(0, 500),
                      );
                      break;
                    }
                  } catch {}
                } catch {}
                await new Promise((r) => setTimeout(r, 200));
              }
            }
          } catch (e) {
            this.logger.error(`Erro no handler de response: ${e}`);
          }
        })();
      });

      return client;
    };

    const client = await initCDP(page);

    try {
      const cacheKey = `pje:session:${regionTRT}`;
      const savedCookies = usedCookies ? await this.redis.get(cacheKey) : null;

      if (savedCookies) {
        this.logger.log('🍪 Restaurando cookies salvos...');
        const mapCookies = new Map<string, string>();

        savedCookies.split(';').forEach((c) => {
          const [name, ...rest] = c.trim().split('=');
          if (name && rest.length) mapCookies.set(name, rest.join('='));
        });

        this.logger.log(`✅ Cookies restaurados (${mapCookies.size})`);

        await page.setCookie(
          ...Array.from(mapCookies.entries()).map(([name, value]) => ({
            name,
            value,
            domain:
              instanceIndex === 3
                ? '.pje.tst.jus.br'
                : `.pje.trt${regionTRT}.jus.br`,
            path: '/',
            secure: true,
          })),
        );
      }

      const urlBase =
        instanceIndex === 3
          ? 'https://pje.tst.jus.br/consultaprocessual/'
          : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;

      this.logger.log(`🌐 Acessando URL base: ${urlBase}`);
      await retry(
        () => page.goto(urlBase, { waitUntil: 'networkidle0' }),
        3,
        1000,
        'Abrir consulta',
      );
      const wafCookies = (await page.cookies()).filter((c) =>
        c.name.startsWith('aws-waf'),
      );

      if (wafCookies.length) {
        await page.deleteCookie(
          ...wafCookies.map((c) => ({
            name: c.name,
            domain: c.domain,
            path: c.path || '/',
          })),
        );
        this.logger.log('🧹 Cookies AWS WAF removidos.');
      }
      // 🚧 Detecta se caiu no AWS WAF
      // Aguarda o iframe do AWS WAF aparecer no DOM
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

      console.log('wafFrame URL:', wafFrame?.url() || '❌ não encontrado');
      const urlObj = new URL(urlBase);

      const correctDomain = urlObj.hostname;

      if (wafParams?.websiteKey && wafParams?.context && wafParams?.iv) {
        this.logger.warn('⚠️ AWS WAF detectado — iniciando resolução...');

        const client = await page.target().createCDPSession();
        await client.send('Page.stopLoading');

        //
        // 1. EXTRAIR PARÂMETROS DO WAF
        //
        const wafParamsExtracted = await page.evaluate(() => {
          const goku = (window as any).gokuProps;
          if (!goku) return null;

          const challengeScript =
            (
              document.querySelector(
                'script[src*="token.awswaf.com"]',
              ) as HTMLScriptElement | null
            )?.src || null;

          const captchaScript =
            (
              document.querySelector(
                'script[src*="captcha.awswaf.com"]',
              ) as HTMLScriptElement | null
            )?.src || null;

          return {
            websiteKey: goku.key,
            iv: goku.iv,
            context: goku.context,
            challengeScript,
            captchaScript,
          };
        });

        this.logger.log(
          '🧩 Parâmetros AWS WAF extraídos:',
          JSON.stringify(wafParamsExtracted, null, 2),
        );

        if (!wafParamsExtracted?.websiteKey) {
          throw new Error('Não foi possível extrair parâmetros do AWS WAF');
        }

        //
        // 2. RESOLVER CAPTCHA VIA 2CAPTCHA
        //
        const solved = await this.captchaService.resolveAwsWaf({
          websiteURL: urlBase,
          websiteKey: wafParamsExtracted.websiteKey,
          context: wafParamsExtracted.context,
          iv: wafParamsExtracted.iv,
          challengeScript: wafParamsExtracted.challengeScript || '',
          captchaScript: wafParamsExtracted.captchaScript || '',
        });

        this.logger.log('✅ AWS WAF resolvido via 2Captcha');

        const tokenToUse = solved?.existing_token;
        if (!tokenToUse) {
          throw new Error(
            'existing_token não retornado pelo resolvedor AWS WAF',
          );
        }

        //
        // 3. OBTER /voucher DO WAF
        //
        const voucherBaseUrl = (
          wafParamsExtracted.challengeScript || ''
        ).replace(/\/challenge\.js$/, '');

        this.logger.log(`🔗 Base URL do voucher: ${voucherBaseUrl}`);

        const voucherResponseText = await page.evaluate(
          async (baseUrl, voucherBody) => {
            const res = await fetch(`${baseUrl}/voucher`, {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
              body: JSON.stringify(voucherBody),
            });
            return res.text();
          },
          voucherBaseUrl,
          {
            captcha_voucher: solved.captcha_voucher || '',
            existing_token: solved.existing_token || '',
          },
        );

        let voucherResponse: any = null;
        try {
          voucherResponse = JSON.parse(voucherResponseText);
        } catch {
          this.logger.warn('⚠️ Resposta /voucher não é JSON válido');
        }

        const newToken = voucherResponse?.token;

        //
        // 4. LIMPAR COOKIES EXISTENTES DO WAF
        //
        const wafCookies = (await page.cookies()).filter((c) =>
          c.name.startsWith('aws-waf'),
        );

        if (wafCookies.length) {
          await page.deleteCookie(
            ...wafCookies.map((c) => ({
              name: c.name,
              domain: c.domain,
              path: c.path || '/',
            })),
          );
          this.logger.log('🧹 Cookies AWS WAF removidos.');
        }

        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });

        //
        // 5. DEFINIR COOKIE DO TOKEN
        //
        try {
          const originalCookies = await page.cookies();
          const wafOriginal = originalCookies.find((c) =>
            c.name.includes('aws'),
          );
          const finalDomain = wafOriginal?.domain || correctDomain;

          await page.setCookie({
            name: 'aws-waf-token',
            value: newToken,
            domain: finalDomain,
            path: '/',
            httpOnly: false,
            secure: true,
            expires: Math.floor(Date.now() / 1000) + 3600,
          });

          this.logger.log(
            '🍪 Cookie aws-waf-token setado com sucesso (via setCookie)',
          );
        } catch (err) {
          this.logger.warn(
            '⚠️ Falha no setCookie — usando fallback document.cookie',
          );
          await page.evaluate((token) => {
            document.cookie = `aws-waf-token=${token}; path=/; max-age=3600; Secure; SameSite=None`;
          }, newToken);
          this.logger.log(
            '🍪 Cookie aws-waf-token setado via fallback document.cookie',
          );
        }

        //
        // 6. RECARREGAR PARA VALIDAR O TOKEN
        //
        const originalCookies = await page.cookies();
        await this.redis.set(
          `aws-waf-token:${processNumber}`,
          originalCookies.map((c) => `${c.name}=${c.value}`).join('; '),
          'EX',
          180000, // 3 minutos de validade no Redis, para evitar reCAPTCHA frequentes
        );
        await new Promise((r) => setTimeout(r, 1500));
        await page.reload({ waitUntil: 'networkidle0' });
        this.logger.log('🔁 Página recarregada — AWS WAF liberado!');
        return {
          integra: null,
          process: { mensagemErro: 'AWS WAF contornado' },
          singleInstance: false,
        };
      } else {
        return {
          integra: null,
          process: { mensagemErro: 'AWS WAF não contornado' },
          singleInstance: false,
        };
      }
    } finally {
      this.logger.log('♻ Limpando recursos e liberando contexto...');

      try {
        await client.send('Network.disable');
      } catch {}

      try {
        if (page && !page.isClosed()) await page.close();
      } catch {}

      await BrowserManager.closeContext(context);
      this.logger.log('✅ Contexto liberado');
    }
  }
}
