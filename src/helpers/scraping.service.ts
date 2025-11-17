import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CDPSession, Page } from 'puppeteer';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserPool } from 'src/utils/browser-pool';

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
    downloadIntegra = false,
    maxWaitMs = 180_000,
  ) {
    const POLL_INTERVAL_MS = 500;
    this.logger.log(
      `▶ Iniciando scraping do processo ${processNumber} (TRT ${regionTRT}, Instância ${instanceIndex})`,
    );

    let context = await this.pool.acquire();
    this.logger.log('✅ Contexto adquirido do pool');

    // 🔍 Verifica se o contexto é válido antes de abrir a página
    if (!context || context.closed) {
      this.logger.warn('⚠️ Contexto inválido ou fechado, criando novo...');
      context = await this.pool.acquire();
    }

    const page = await context.newPage();
    this.logger.log('✅ Nova página aberta');

    let capturedResponseData: any = null;
    let integraBuffer: Buffer | null = null;
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
                    const json = JSON.parse(text);

                    const valid =
                      (Array.isArray(json) && json.length > 0) ||
                      (typeof json === 'object' && json && 'id' in json);
                    if (valid) {
                      capturedResponseData = json;
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
        this.logger?.warn(
          '⚠️ AWS WAF detectado — tentando resolver via 2Captcha...',
        );
        const client = await page.target().createCDPSession();
        await client.send('Page.stopLoading');

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
          websiteURL: urlBase,
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
          // const wafCookies = (await page.cookies()).filter((c) =>
          //   c.name.startsWith('aws-waf'),
          // );

          // this.logger.log(
          //   '🔥 Cookies WAF encontrados antes de limpar:',
          //   wafCookies,
          // );

          // if (wafCookies.length) {
          //   await page.deleteCookie(
          //     ...wafCookies.map((c) => ({
          //       name: c.name,
          //       domain: c.domain,
          //       path: c.path || '/',
          //     })),
          //   );

          //   this.logger.log('🧹 Cookies AWS WAF removidos.');
          // }
          const cookies = await page.cookies();
          for (const c of cookies) {
            if (c.name === 'aws-waf-token') {
              await page.deleteCookie({
                name: c.name,
                domain: c.domain,
                path: c.path,
              });
            }
          }
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });

          // Setar cookie no browser
          await page.setCookie({
            name: 'aws-waf-token',
            value: voucherResponse?.token as string,
            domain: '.pje.trt3.jus.br',
            path: '/',
            httpOnly: false,
            secure: true,
            expires: Math.floor(Date.now() / 1000) + 60 * 60,
          });
          const after = await page.cookies();
          this.logger.log(
            '🍪 Cookies depois de setar token:',
            after.filter((c) => c.name.includes('waf')),
          );

          this.logger?.log('🍪 Cookie aws-waf-token setado no browser');
          // Recarrega a página para validar token
          await page.goto(urlBase, {
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

      this.logger.log('⏳ Preenchendo número do processo...');

      await retry(
        async () => {
          await page.waitForSelector('#nrProcessoInput', { visible: true });

          await page.$eval(
            '#nrProcessoInput',
            (el) => ((el as HTMLInputElement).value = ''),
          );

          await page.type('#nrProcessoInput', processNumber, { delay: 45 });

          await Promise.all([
            page.waitForNavigation({
              waitUntil: 'networkidle0',
              timeout: 5000,
            }),
            page.click('#btnPesquisar'),
          ]);
        },
        3,
        1500,
        'Pesquisar processo',
      );

      this.logger.log('✅ Número do processo preenchido');
      const painelProm = page
        .waitForSelector('#painel-escolha-processo', { visible: true })
        .then(() => 'painel')
        .catch(() => null);

      const captchaProm = page
        .waitForSelector('#imagemCaptcha', { visible: true })
        .then(() => 'captcha')
        .catch(() => null);

      const resultado = await Promise.race([painelProm, captchaProm]);

      let singleInstance = false;
      // let capturedResponseData: any = null;
      let quantityInstances;
      if (resultado === 'painel') {
        this.logger.log('✅ Múltiplas instâncias detectadas');

        const processos = await page.$$(
          '#painel-escolha-processo .selecao-processo',
        );
        this.logger.log(
          `🔢 Total de instâncias disponíveis: ${processos.length}`,
        );
        quantityInstances = processos.length;
        if (!processos.length) throw new Error('Nenhuma instância encontrada');

        // Se solicitou instância 3 e só existem 1 ou 2 → parar sem captcha
        if (instanceIndex === 3 && processos.length < 3) {
          this.logger.warn(
            `⚠️ Instância 3 não encontrada (apenas ${processos.length} instâncias). Interrompendo sem resolver captcha.`,
          );

          return {
            process: { mensagemErro: 'Instância 3 não encontrada' },
            integra: null,
            singleInstance: false,
          };
        }

        // Seleciona instância solicitada
        const target = instanceIndex - 1;
        if (target < 0 || target >= processos.length)
          throw new Error(`Instância ${instanceIndex} não encontrada`);

        this.logger.log(`✅ Selecionando instância ${instanceIndex}`);

        // Aguarda resposta da API do processo após clicar
        const responsePromise = page.waitForResponse(
          (resp) =>
            resp.url().includes('/pje-consulta-api/api/processos/') &&
            resp.status() === 200,
          { timeout: 30000 }, // espera até 30s
        );

        await processos[target].click();

        const response = await responsePromise;
        const text = await response.text();
        capturedResponseData = JSON.parse(text);

        this.logger.log('✅ Instância selecionada e processo capturado');
      } else if (resultado === 'captcha') {
        this.logger.log(
          '⚠️ Processo possui apenas uma instância — indo direto ao CAPTCHA',
        );
        singleInstance = true;

        // Se solicitou instância diferente de 1 → erro
        if (instanceIndex !== 1) {
          this.logger.warn(
            `⚠️ Instância ${instanceIndex} não existe, pois o processo possui apenas uma instância.`,
          );

          return {
            process: {
              mensagemErro: `Instância ${instanceIndex} não encontrada`,
            },
            integra: null,
            singleInstance: true,
          };
        }

        this.logger.log('✅ Processo capturado via CAPTCHA (única instância)');
      } else {
        this.logger.warn(
          '⚠️ Resultado inesperado ao detectar múltiplas instâncias',
        );

        // Se o usuário solicitou instância 3 e não há painel → retorna erro
        if (instanceIndex === 3) {
          return {
            process: {
              mensagemErro: 'Instância 3 não encontrada',
            },
            integra: null,
            singleInstance: true,
          };
        }
      }
      const captchaVisible = await page
        .waitForSelector('#imagemCaptcha', { visible: true, timeout: 6000 })
        .catch(() => null);
      if (captchaVisible) {
        this.logger.log('🔐 CAPTCHA detectado — iniciando resolução');

        await retry(
          async () => {
            const imgHandle = await page.$('#imagemCaptcha');
            if (!imgHandle) throw new Error('Imagem de CAPTCHA não encontrada');

            const srcProp = await imgHandle.getProperty('src');
            const srcVal = await srcProp.jsonValue();
            if (typeof srcVal !== 'string')
              throw new Error('Valor do src do CAPTCHA não é uma string');

            let base64 = srcVal.replace(/^data:image\/\w+;base64,/, '');

            const solved = await this.captchaService.resolveCaptcha(base64);
            if (!solved?.resposta) throw new Error('Falha ao resolver CAPTCHA');

            await page.$eval(
              '#captchaInput',
              (el: HTMLInputElement) => (el.value = ''),
            );
            await page.type('#captchaInput', solved.resposta, { delay: 50 });
            await page.click('#btnEnviar');
            await new Promise((r) => setTimeout(r, 400));
          },
          3,
          1000,
          'Resolver CAPTCHA',
        );

        this.logger.log('✅ CAPTCHA resolvido');
      }

      await new Promise((r) => setTimeout(r, 700));

      const painelErro = await page.$('#painel-erro');
      if (painelErro) {
        try {
          const spanErro = await painelErro.waitForSelector('span', {
            visible: true,
            timeout: 1500,
          });
          if (spanErro) {
            const mensagemErro = await spanErro.evaluate(
              (el) => el.textContent?.trim() || '',
            );
            this.logger.warn(`⚠️ Erro apresentado na tela: ${mensagemErro}`);
            // ❌ não retornar, mas lançar erro para o retry
            throw new Error(`Erro na tela do processo: ${mensagemErro}`);
          }
        } catch {}
      }

      this.logger.log('⏳ Aguardando captura do processo pelo CDP...');

      const start = Date.now();
      while (!processCaptured && Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!processCaptured) {
        this.logger.error('❌ Timeout — Processo não foi capturado pelo CDP');
        throw new Error('Processo não foi capturado');
      }

      this.logger.log('✅ Dados do processo capturados com sucesso');

      if (downloadIntegra) {
        this.logger.log('📄 Download do PDF /integra solicitado');

        const btnIntegra = await page.$('#btnDownloadIntegra');
        if (btnIntegra) {
          this.logger.log('📄 Botão de Integra encontrado, clicando...');
          await btnIntegra.click();
        } else {
          this.logger.warn('⚠️ Botão de Integra NÃO encontrado');
        }

        try {
          const r = await page.waitForResponse(
            (resp) => resp.url().includes('/integra') && resp.status() === 200,
            { timeout: maxWaitMs },
          );
          integraBuffer = await r.buffer();
          this.logger.log(`✅ PDF capturado (${integraBuffer.length} bytes)`);
        } catch (err) {
          this.logger.warn(`⚠️ Falha ao capturar PDF: ${err}`);
        }
      }

      return {
        process: !downloadIntegra ? capturedResponseData : undefined,
        integra: integraBuffer ?? undefined,
        singleInstance,
        quantityInstances: quantityInstances ?? undefined,
      };
    } finally {
      this.logger.log('♻ Limpando recursos e liberando contexto...');

      try {
        await client.send('Network.disable');
      } catch {}

      try {
        if (page && !page.isClosed()) await page.close();
      } catch {}

      this.pool.release(context);
      this.logger.log('✅ Contexto liberado');
    }
  }
}
