/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unnecessary-type-assertion */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
/* eslint-disable @typescript-eslint/no-unsafe-assignment */
/* eslint-disable @typescript-eslint/no-misused-promises */
import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import Redis from 'ioredis';
import { CDPSession, Page, BrowserContext, HTTPRequest } from 'puppeteer';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserManager } from 'src/utils/browser.manager';

@Injectable()
export class ScrapingService implements OnModuleInit {
  private readonly logger = new Logger(ScrapingService.name);

  // BrowserPool removido: usaremos BrowserManager e criaremos um BrowserContext novo por execução

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}
  async onModuleInit() {
    // Inicialização do pool removida. O BrowserManager é lazy e será usado por execução.
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
    let context: BrowserContext | null = null;

    // Hoisted para permitir cleanup seguro no finally
    let page!: Page;
    let client: CDPSession | null = null;

    // Função resiliente para criar uma nova página; em caso de erro de conexão
    // tenta liberar o contexto atual e reaquiri-lo antes de tentar novamente.
    const createPageWithRecovery = async (maxAttempts = 3) => {
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          // Se existir um contexto anterior, tente fechar páginas abertas antes de criar novo contexto
          if (context) {
            try {
              const pages = await context.pages();
              for (const p of pages) {
                if (!p.isClosed()) await p.close();
              }
            } catch (e) {
              /* ignore */
            }
            // fecha o contexto anterior de forma segura
            try {
              await BrowserManager.closeContext(context);
            } catch (e) {
              /* ignore */
            }
            context = null;
          }

          const created = await BrowserManager.createPage();
          context = created.context;
          page = created.page;
          this.logger.log('✅ Contexto criado e página pronta');
          return;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.logger.warn(
            `❌ Erro ao criar nova página (tentativa ${attempt}/${maxAttempts}): ${msg}`,
          );

          // Tenta liberar o contexto possivelmente corrompido e reaquece um novo
          try {
            // fechar o context corrompido
            if (context) {
              try {
                await BrowserManager.closeContext(context);
              } catch (e) {
                /* ignore */
              }
              context = null;
            }
          } catch {
            /* ignore */
          }

          if (attempt === maxAttempts) throw err;

          await new Promise((r) => setTimeout(r, 500));
          // próxima iteração irá criar novo contexto via BrowserManager.createPage()
        }
      }
    };

    await createPageWithRecovery();

    interface CdpRequestEvent {
      requestId: string;
      request: { url: string };
    }
    interface CdpResponseEvent {
      requestId: string;
      response?: {
        url?: string;
        headers?: Record<string, string>;
        encodedDataLength?: number;
      };
    }
    interface VoucherResponse {
      token?: string;
    }

    let processCaptured = false;
    let onResponse: ((event: CdpResponseEvent) => Promise<void>) | null = null;
    let onRequest: ((event: CdpRequestEvent) => void) | null = null;
    const requestMap = new Map<string, string>();
    const MAX_MAP_SIZE = 1000;
    // limite de bytes para considerar o body seguro para baixar/parsear
    const MAX_BODY_BYTES = 1_000_000; // 1 MB

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

      onRequest = (event: CdpRequestEvent) => {
        if (requestMap.size > MAX_MAP_SIZE) {
          const firstKey = requestMap.keys().next().value;
          requestMap.delete(firstKey);
        }

        requestMap.set(event.requestId, event.request.url);
      };

      client.on('Network.requestWillBeSent', onRequest);

      onResponse = async (event: CdpResponseEvent) => {
        try {
          const url = (event.response?.url ??
            requestMap.get(event.requestId) ??
            '') as string;

          if (
            !processCaptured &&
            url.match(/\/pje-consulta-api\/api\/processos\/\d+/)
          ) {
            this.logger.debug(
              `📥 Tentando capturar JSON do processo em: ${url}`,
            );

            // Proteções de tamanho antes de requisitar o body via CDP
            const headers = event.response?.headers || {};
            const contentLengthHeader = Number(
              headers['content-length'] || headers['Content-Length'] || 0,
            );
            const encodedLen = Number(event.response?.encodedDataLength || 0);

            if (
              contentLengthHeader > MAX_BODY_BYTES ||
              encodedLen > MAX_BODY_BYTES
            ) {
              this.logger.warn(
                `⚠️ Ignorando body grande (${contentLengthHeader || encodedLen} bytes) em ${url}`,
              );
              return;
            }

            for (let attempt = 0; attempt < 3; attempt++) {
              try {
                const body = await client.send('Network.getResponseBody', {
                  requestId: event.requestId,
                });

                const text = body.base64Encoded
                  ? Buffer.from(body.body, 'base64').toString('utf8')
                  : body.body;

                // Proteção adicional contra textos enormes
                if (!text || text.length > 2_000_000) {
                  this.logger.warn(
                    `⚠️ Body muito grande (texto ${text ? text.length : 0} chars), ignorando`,
                  );
                  return;
                }

                let json: unknown;
                try {
                  json = JSON.parse(text);
                } catch {
                  return;
                }

                if (
                  (Array.isArray(json) && json.length > 0) ||
                  (typeof json === 'object' && json !== null && 'id' in json)
                ) {
                  processCaptured = true;
                  this.logger.log('✅ Processo capturado via CDP!');
                  break;
                }
              } catch {
                /* ignore */
              }
              await new Promise((r) => setTimeout(r, 200));
            }
          }
        } catch (e) {
          this.logger.error(`Erro no handler de response: ${e}`);
        }
      };

      client.on('Network.responseReceived', onResponse);

      return client;
    };

    client = await initCDP(page);

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
        () => page.goto(urlBase, { waitUntil: 'domcontentloaded' }),
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
        const w = window as Window & typeof globalThis & { gokuProps?: { key?: string; iv?: string; context?: string } };
        const g = w.gokuProps;
        if (g) {
          const q1 = document.querySelector(
            'script[src*="token.awswaf.com"]',
          ) as HTMLScriptElement | null;
          const q2 = document.querySelector(
            'script[src*="captcha.awswaf.com"]',
          ) as HTMLScriptElement | null;
          return {
            websiteKey: g.key || null,
            iv: g.iv || null,
            context: g.context || null,
            challengeScript: q1 ? q1.src : null,
            captchaScript: q2 ? q2.src : null,
          };
        }

        // fallback: examina apenas scripts (pequeno slice do texto) para evitar innerHTML gigante
        const scriptEls = Array.from(
          document.scripts || [],
        ) as HTMLScriptElement[];
        const scripts = scriptEls.map((s) => ({
          src: s.src || null,
          text: s.textContent ? s.textContent.slice(0, 2000) : '',
        }));
        const challengeScript =
          scripts.find((s) => s.src && s.src.includes('token.awswaf.com'))
            ?.src || null;
        const captchaScript =
          scripts.find((s) => s.src && s.src.includes('captcha.awswaf.com'))
            ?.src || null;

        let websiteKey: string | null = null;
        let iv: string | null = null;
        let contextVal: string | null = null;
        for (const s of scripts.slice(0, 10)) {
          const t = s.text || '';
          if (!t) continue;
          const mKey =
            t.match(/"key"\s*:\s*"([^"]+)"/) ||
            t.match(/sitekey\s*:\s*"([^"]+)"/);
          if (mKey) websiteKey = websiteKey || (mKey[1] as string);
          const mIv = t.match(/"iv"\s*:\s*"([^"]+)"/);
          if (mIv) iv = iv || (mIv[1] as string);
          const mC = t.match(/"context"\s*:\s*"([^"]+)"/);
          if (mC) contextVal = contextVal || (mC[1] as string);
          if (websiteKey && iv && contextVal) break;
        }

        return {
          websiteKey,
          iv,
          context: contextVal,
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
          const goku = (window as Window & typeof globalThis & { gokuProps: { key: string; iv: string; context: string } | undefined }).gokuProps;
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

        this.logger.log('🧩 Parâmetros AWS WAF extraídos:');

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

        let voucherResponse: VoucherResponse | null = null;
        try {
          const mem = process.memoryUsage();
          this.logger.debug(
            `MEM before voucher parse: heapUsed=${Math.round(mem.heapUsed / 1024 / 1024)}MB`,
          );

          const MAX_VOUCHER_CHARS = 200000; // 200 KB
          if (
            typeof voucherResponseText === 'string' &&
            voucherResponseText.length > MAX_VOUCHER_CHARS
          ) {
            this.logger.warn(
              `⚠️ voucherResponseText muito grande (${voucherResponseText.length} chars), ignorando parse`,
            );
          } else {
            try {
              voucherResponse = JSON.parse(voucherResponseText) as VoucherResponse;
            } catch {
              this.logger.warn('⚠️ Resposta /voucher não é JSON válido');
            }
          }
        } catch {
          this.logger.warn('⚠️ Erro ao processar voucherResponseText');
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

        await page.evaluate(async () => {
          localStorage.clear();
          sessionStorage.clear();

          // Limpa caches do Service Worker / Cache API como segurança adicional
          if ('caches' in window) {
            try {
              const keys = await caches.keys();
              await Promise.all(keys.map((k) => caches.delete(k)));
            } catch (e) {
              /* ignore */
            }
          }
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
            value: newToken ?? '',
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
          180, // 3 minutos de validade no Redis (PERF-010)
        );
        await new Promise((r) => setTimeout(r, 1500));
        await page.reload({ waitUntil: 'domcontentloaded' });
        this.logger.log('🔁 Página recarregada — AWS WAF liberado!');
        return {
          integra: null,
          process: { mensagemErro: 'AWS WAF contornado' },
          singleInstance: false,
        };
      }
      this.logger.log('✅ Nenhum AWS WAF detectado na página');
      // await this.captureRealRequest(page, regionTRT);
      // 👇 1. espera frontend inicializar
      // await new Promise((r) => setTimeout(r, 2000));
      // 👇 1. espera frontend inicializar (delay randômico)
      const delay = Math.floor(Math.random() * (3500 - 1500 + 1)) + 1500;
      await new Promise((r) => setTimeout(r, delay));
      await page.reload({ waitUntil: 'domcontentloaded' });
      // 👇 2. aguarda o cookie aparecer (isso é o segredo)
      this.logger.log('⏳ Aguardando aws-waf-token...');

      let token: string | null = null;

      for (let i = 0; i < 10; i++) {
        const cookies = await page.cookies();
        const found = cookies.find((c) => c.name === 'aws-waf-token');

        if (found?.value) {
          token = found.value;
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      // 👇 3. validação
      if (!token) {
        this.logger.warn(
          `⚠️ aws-waf-token não encontrado após espera, prosseguindo sem token...`,
        );
        return;
      }

      // 👇 4. salva
      await this.redis.set(
        `aws-waf-token:${processNumber}`,
        `aws-waf-token=${token}`,
        'EX',
        7200, // 2 horas de validade no Redis (sessão WAF dura ~1h)
      );
    } finally {
      this.logger.log('♻ Limpando recursos e liberando contexto...');

      // Detach / disable no client somente se foi inicializado
      if (client) {
        try {
          await client.send('Network.disable');
        } catch {}
        try {
          await client.detach();
        } catch {
          /* ignore */
        }
      }

      // Fecha a página com segurança
      try {
        if (page && !page.isClosed()) {
          try {
            await page.close({ runBeforeUnload: true });
          } catch {
            try {
              await page.close();
            } catch {
              /* ignore */
            }
          }
        }
      } catch {
        /* ignore */
      }

      // Remove listeners se o client existir
      try {
        if (client && typeof client.off === 'function') {
          if (onResponse) client.off('Network.responseReceived', onResponse);
          if (onRequest) client.off('Network.requestWillBeSent', onRequest);
        }
      } catch {
        /* ignore */
      }

      // Garante fechamento do contexto caso exista
      try {
        if (context) await BrowserManager.closeContext(context);
      } catch {
        /* ignore */
      }

      this.logger.log('✅ Contexto liberado');
    }
  }
  async captureRealRequest(page: Page) {
    // Atenção: evitar remover listeners globais ou setar interception múltiplas vezes.
    // Se necessário, setRequestInterception deve ser feito uma única vez na stack.
    try {
      await page.setRequestInterception(true);
    } catch {
      /* ignore */
    }

    const onRequestIntercept = async (request: HTTPRequest) => {
      try {
        const url = request.url();

        if (url.includes('/pje-consulta-api/api/propriedades')) {
          // Exemplo de captura de headers (comentado de forma segura)
          // const headers = request.headers();
          // const filteredHeaders = {
          //   referer: headers.referer,
          //   'user-agent': headers['user-agent'],
          //   'x-grau-instancia': headers['x-grau-instancia'],
          //   accept: headers.accept,
          // };
          // await this.redis.set(`headers:${regionTRT}`, JSON.stringify(filteredHeaders), 'EX', 3600);
        }
      } catch {
        /* ignore */
      } finally {
        try {
          if (!request.isInterceptResolutionHandled()) {
            await request.continue();
          }
        } catch {
          /* ignore */
        }
      }
    };

    page.on('request', onRequestIntercept);
    // remover automaticamente quando a página fechar
    try {
      page.once('close', () => {
        try {
          page.off('request', onRequestIntercept);
        } catch {
          /* ignore */
        }
      });
    } catch {
      /* ignore */
    }
  }
}
