import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserPool } from 'src/utils/browser-pool';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

  private readonly pool = new BrowserPool(5); // exemplo: 5 contexts simultâneos

  constructor(private readonly captchaService: CaptchaService) {
    this.pool.init(); // inicializa o pool
  }
  // async execute(
  //   processNumber: string,
  //   regionTRT: number,
  //   instanceIndex: number,
  //   usedCookies = false,
  //   downloadIntegra = false,
  //   username?: string,
  //   password?: string,
  //   maxWaitMs = 180_000, // timeout configurável em ms
  // ) {
  //   const POLL_INTERVAL_MS = 500;
  //   const context = await this.pool.acquire();
  //   let page = await context.newPage();

  //   let capturedResponseData: any = null;
  //   let integraBuffer: Buffer | null = null;
  //   let processCaptured = false;
  //   const requestMap = new Map<string, string>();

  //   // ===== Função de retry genérica =====
  //   const retry = async <T>(
  //     fn: () => Promise<T>,
  //     retries = 3,
  //     delayMs = 1000,
  //     stepName?: string,
  //   ) => {
  //     let lastError: any;
  //     for (let attempt = 1; attempt <= retries; attempt++) {
  //       try {
  //         return await fn();
  //       } catch (err) {
  //         lastError = err;
  //         this.logger.warn(
  //           `Tentativa ${attempt}/${retries} falhou${stepName ? ` (${stepName})` : ''}: ${err?.message ?? err}`,
  //         );
  //         if (attempt < retries)
  //           await new Promise((r) => setTimeout(r, delayMs));
  //       }
  //     }
  //     throw lastError;
  //   };

  //   // ===== Inicializa CDP para capturar respostas =====
  //   const initCDP = async (pg: typeof page) => {
  //     const client = await pg.target().createCDPSession();
  //     await client.send('Network.enable');

  //     client.on('Network.requestWillBeSent', (event) => {
  //       const reqId = event.requestId;
  //       const url = event.request?.url ?? '';
  //       if (reqId && url) requestMap.set(reqId, url);
  //     });

  //     client.on('Network.responseReceived', async (event) => {
  //       try {
  //         const resp = event.response;
  //         const reqId = event.requestId;
  //         const url = resp?.url ?? requestMap.get(reqId) ?? '';

  //         // Captura detalhes do processo (JSON)
  //         if (
  //           !processCaptured &&
  //           url.match(
  //             /\/pje-consulta-api\/api\/processos\/\d+\?tokenCaptcha=|\/pje-consulta-api\/api\/processos\/\d+\?tokenDesafio=.*&resposta=.*/,
  //           ) &&
  //           !url.includes('/documentos') &&
  //           !url.includes('/integra')
  //         ) {
  //           for (let attempt = 0; attempt < 6; attempt++) {
  //             try {
  //               const body = await client.send('Network.getResponseBody', {
  //                 requestId: reqId,
  //               });
  //               const text = body.base64Encoded
  //                 ? Buffer.from(body.body, 'base64').toString('utf8')
  //                 : body.body;
  //               capturedResponseData = JSON.parse(text);
  //               processCaptured = true;
  //               this.logger.log(`[CDP] ✅ Processo capturado na URL: ${url}`);
  //               break;
  //             } catch {
  //               await new Promise((r) => setTimeout(r, 300));
  //             }
  //           }
  //         }
  //       } catch (err) {
  //         this.logger.warn(
  //           `Erro ao processar resposta CDP: ${err?.message ?? err}`,
  //         );
  //       }
  //     });

  //     return client;
  //   };

  //   let client = await initCDP(page);

  //   try {
  //     // ===== Login / restauração de cookies =====
  //     const cacheKey = `pje:session:${regionTRT}`;
  //     const savedCookies = usedCookies ? await this.redis.get(cacheKey) : null;

  //     if (savedCookies) {
  //       const cookiesMap = new Map<string, string>();
  //       (savedCookies as string).split(';').forEach((c) => {
  //         const [name, ...rest] = c.trim().split('=');
  //         if (name && rest.length) cookiesMap.set(name, rest.join('='));
  //       });

  //       const requiredTokens = ['access_token_1g', 'access_token_2g'];
  //       const hasAllTokens = requiredTokens.every((token) =>
  //         cookiesMap.has(token),
  //       );

  //       if (!hasAllTokens) {
  //         this.logger.warn(
  //           '⚠ Tokens essenciais não encontrados — removendo cache para forçar login',
  //         );
  //         try {
  //           await this.redis.del(cacheKey);
  //         } catch {}
  //         usedCookies = false;
  //       } else {
  //         const cookiesArray = Array.from(cookiesMap.entries()).map(
  //           ([name, value]) => ({
  //             name,
  //             value,
  //             domain:
  //               instanceIndex === 3
  //                 ? '.pje.tst.jus.br'
  //                 : `.pje.trt${regionTRT}.jus.br`,
  //             path: '/',
  //             httpOnly: false,
  //             secure: true,
  //           }),
  //         );
  //         await page.setCookie(...cookiesArray);
  //         this.logger.debug(`✅ Cookies restaurados (${cookiesArray.length})`);
  //       }
  //     }

  //     if ((!savedCookies || !usedCookies) && username && password) {
  //       const loginUrl =
  //         instanceIndex === 3
  //           ? 'https://pje.tst.jus.br/consultaprocessual/login'
  //           : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/login`;

  //       await page.goto(loginUrl, { waitUntil: 'networkidle0' });
  //       await page.waitForSelector('input[name="usuario"]', { visible: true });
  //       await page.type('input[name="usuario"]', username);
  //       await page.type('input[name="senha"]', password);

  //       await Promise.all([
  //         page.waitForNavigation({ waitUntil: 'networkidle0' }),
  //         page.click('#btnEntrar'),
  //       ]);

  //       const cookies = await page.cookies();
  //       const cookieString = cookies
  //         .map((c) => `${c.name}=${c.value}`)
  //         .join(';');
  //       await this.redis.set(cacheKey, cookieString, 'EX', 60 * 30);
  //       this.logger.debug(`✅ Cookies salvos em ${cacheKey}`);
  //     }

  //     // Página inicial
  //     const processUrl =
  //       instanceIndex === 3
  //         ? 'https://pje.tst.jus.br/consultaprocessual/'
  //         : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;

  //     await retry(
  //       () => page.goto(processUrl, { waitUntil: 'networkidle0' }),
  //       3,
  //       1000,
  //       'Página de processo',
  //     );

  //     // Preencher número do processo
  //     await retry(
  //       async () => {
  //         await page.waitForSelector('#nrProcessoInput', { visible: true });
  //         await page.evaluate(() => {
  //           const input =
  //             document.querySelector<HTMLInputElement>('#nrProcessoInput');
  //           if (input) input.value = '';
  //         });
  //         await page.type('#nrProcessoInput', processNumber, { delay: 50 });
  //         await page.click('#btnPesquisar');
  //       },
  //       3,
  //       1000,
  //       'Preencher número do processo',
  //     );

  //     // Selecionar instância
  //     await retry(
  //       async () => {
  //         await page.waitForSelector('#painel-escolha-processo', {
  //           visible: true,
  //         });
  //         const processos = await page.$$(
  //           '#painel-escolha-processo .selecao-processo',
  //         );

  //         if (!processos.length) {
  //           throw new Error(
  //             'Nenhuma instância encontrada na página de seleção',
  //           );
  //         }

  //         const targetIndex = instanceIndex - 1;
  //         if (targetIndex < 0 || targetIndex >= processos.length) {
  //           this.logger.error(
  //             `Instância solicitada (${instanceIndex}) não está disponível. Instâncias encontradas: ${processos.length}`,
  //           );
  //           throw new Error(`Instância ${instanceIndex} não encontrada`);
  //         }

  //         let newPage: any = null;
  //         const onTargetCreated = async (target: any) => {
  //           try {
  //             const pg = await target.page();
  //             if (pg) newPage = pg;
  //           } catch {}
  //         };
  //         page.browser().on('targetcreated', onTargetCreated);

  //         await processos[targetIndex].click();
  //         await new Promise((r) => setTimeout(r, 1200));

  //         if (newPage) {
  //           if (typeof newPage.bringToFront === 'function')
  //             await newPage.bringToFront();
  //           page = newPage;
  //           client = await initCDP(page);
  //         }

  //         page.browser().off('targetcreated', onTargetCreated);
  //       },
  //       3,
  //       1000,
  //       'Selecionar instância',
  //     );

  //     // CAPTCHA
  //     const captchaVisible = await page.$('#imagemCaptcha');
  //     if (captchaVisible) {
  //       await retry(
  //         async () => {
  //           const base64 = await page.$eval(
  //             '#imagemCaptcha',
  //             (img: HTMLImageElement) => img.src,
  //           );
  //           const solved = await this.captchaService.resolveCaptcha(base64);
  //           if (!solved?.resposta) throw new Error('Captcha falhou');

  //           await page.evaluate((value) => {
  //             const input =
  //               document.querySelector<HTMLInputElement>('#captchaInput');
  //             if (input) {
  //               input.value = value;
  //               input.dispatchEvent(new Event('input', { bubbles: true }));
  //               input.dispatchEvent(new Event('change', { bubbles: true }));
  //             }
  //           }, solved.resposta);

  //           await page.click('#btnEnviar');
  //           await new Promise((r) => setTimeout(r, 1500));
  //         },
  //         3,
  //         1000,
  //         'Resolver CAPTCHA',
  //       );
  //     }

  //     // Captura PDF / integra
  //     if (downloadIntegra) {
  //       const integraPromise = page.waitForResponse(
  //         (resp) => resp.url().includes('/integra') && resp.status() === 200,
  //         { timeout: maxWaitMs },
  //       );

  //       const btnIntegra = await page.$('#btnDownloadIntegra');
  //       if (btnIntegra) await btnIntegra.click();

  //       try {
  //         const integraResponse = await integraPromise;
  //         integraBuffer = await integraResponse.buffer();
  //         this.logger.log(
  //           `[PDF] ✅ Integra capturada na URL: ${integraResponse.url()}`,
  //         );
  //       } catch {
  //         this.logger.warn(
  //           '⚠ PDF /integra não foi capturado dentro do tempo limite',
  //         );
  //       }
  //     }

  //     // Espera response JSON do processo
  //     const startProcess = Date.now();
  //     while (!processCaptured && Date.now() - startProcess < maxWaitMs) {
  //       await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  //     }

  //     if (!processCaptured)
  //       throw new Error('Não foi possível capturar a response do processo');
  //     if (integraBuffer && downloadIntegra) return { integra: integraBuffer };
  //     return { process: capturedResponseData };
  //   } finally {
  //     // ===== Cleanup =====
  //     try {
  //       await client?.send('Network.disable');
  //     } catch {}
  //     try {
  //       if (page && !page.isClosed()) await page.close();
  //       this.logger.debug('✅ Aba do Puppeteer fechada');
  //     } catch (err) {
  //       this.logger.warn(`Falha ao fechar aba: ${err?.message ?? err}`);
  //     }
  //     this.pool.release(context);
  //   }
  // }
  async execute(
    processNumber: string,
    regionTRT: number,
    instanceIndex: number,
    usedCookies = false,
    downloadIntegra = false,
    username?: string,
    password?: string,
    maxWaitMs = 180_000, // timeout configurável em ms
  ) {
    const POLL_INTERVAL_MS = 500;
    const context = await this.pool.acquire();
    let page = await context.newPage();

    let capturedResponseData: any = null;
    let integraBuffer: Buffer | null = null;
    let processCaptured = false;
    const requestMap = new Map<string, string>();

    // ===== Função de retry genérica =====
    const retry = async <T>(
      fn: () => Promise<T>,
      retries = 3,
      delayMs = 1000,
      stepName?: string,
    ) => {
      let lastError: any;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (err) {
          lastError = err;
          this.logger.warn(
            `Tentativa ${attempt}/${retries} falhou${stepName ? ` (${stepName})` : ''}: ${err?.message ?? err}`,
          );
          if (attempt < retries)
            await new Promise((r) => setTimeout(r, delayMs));
        }
      }
      throw lastError;
    };

    // ===== Inicializa CDP para capturar respostas =====
    const initCDP = async (pg: typeof page) => {
      const client = await pg.target().createCDPSession();
      await client.send('Network.enable');

      client.on('Network.requestWillBeSent', (event) => {
        const reqId = event.requestId;
        const url = event.request?.url ?? '';
        if (reqId && url) requestMap.set(reqId, url);
      });

      client.on('Network.responseReceived', async (event) => {
        try {
          const resp = event.response;
          const reqId = event.requestId;
          const url = resp?.url ?? requestMap.get(reqId) ?? '';

          // Filtra apenas URLs de processos (ignora /documentos e /integra)
          if (
            !processCaptured &&
            url.match(
              /\/pje-consulta-api\/api\/processos\/\d+\?(?:tokenCaptcha=.*|.*&resposta=.*)/,
            ) &&
            !url.includes('/documentos') &&
            !url.includes('/integra')
          ) {
            for (let attempt = 0; attempt < 6; attempt++) {
              try {
                const body = await client.send('Network.getResponseBody', {
                  requestId: reqId,
                });
                const text = body.base64Encoded
                  ? Buffer.from(body.body, 'base64').toString('utf8')
                  : body.body;

                let jsonData;
                try {
                  jsonData = JSON.parse(text);
                } catch {
                  this.logger.warn(`[CDP] ❌ JSON inválido na URL: ${url}`);
                  continue;
                }

                // ✅ Validação do response genérica
                const isValidResponse =
                  (Array.isArray(jsonData) && jsonData.length > 0) ||
                  (jsonData && jsonData.id && jsonData.numero);

                if (isValidResponse) {
                  capturedResponseData = jsonData;
                  processCaptured = true;
                  break;
                }
              } catch (err) {
                await new Promise((r) => setTimeout(r, 300));
              }
            }
          }
        } catch (err) {
          this.logger.warn(
            `Erro ao processar resposta CDP: ${err?.message ?? err}`,
          );
        }
      });

      return client;
    };

    let client = await initCDP(page);

    try {
      // ===== Login / restauração de cookies =====
      const cacheKey = `pje:session:${regionTRT}`;
      const savedCookies = usedCookies ? await this.redis.get(cacheKey) : null;

      if (savedCookies) {
        const cookiesMap = new Map<string, string>();
        (savedCookies as string).split(';').forEach((c) => {
          const [name, ...rest] = c.trim().split('=');
          if (name && rest.length) cookiesMap.set(name, rest.join('='));
        });

        const requiredTokens = ['access_token_1g', 'access_token_2g'];
        const hasAllTokens = requiredTokens.every((token) =>
          cookiesMap.has(token),
        );

        if (!hasAllTokens) {
          this.logger.warn(
            '⚠ Tokens essenciais não encontrados — removendo cache para forçar login',
          );
          try {
            await this.redis.del(cacheKey);
          } catch {}
          usedCookies = false;
        } else {
          const cookiesArray = Array.from(cookiesMap.entries()).map(
            ([name, value]) => ({
              name,
              value,
              domain:
                instanceIndex === 3
                  ? '.pje.tst.jus.br'
                  : `.pje.trt${regionTRT}.jus.br`,
              path: '/',
              httpOnly: false,
              secure: true,
            }),
          );
          await page.setCookie(...cookiesArray);
          this.logger.debug(`✅ Cookies restaurados (${cookiesArray.length})`);
        }
      }

      if ((!savedCookies || !usedCookies) && username && password) {
        const loginUrl =
          instanceIndex === 3
            ? 'https://pje.tst.jus.br/consultaprocessual/login'
            : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/login`;

        await page.goto(loginUrl, { waitUntil: 'networkidle0' });
        await page.waitForSelector('input[name="usuario"]', { visible: true });
        await page.type('input[name="usuario"]', username);
        await page.type('input[name="senha"]', password);

        await Promise.all([
          page.waitForNavigation({ waitUntil: 'networkidle0' }),
          page.click('#btnEntrar'),
        ]);

        const cookies = await page.cookies();
        const cookieString = cookies
          .map((c) => `${c.name}=${c.value}`)
          .join(';');
        await this.redis.set(cacheKey, cookieString, 'EX', 60 * 30);
        this.logger.debug(`✅ Cookies salvos em ${cacheKey}`);
      }

      // Página inicial
      const processUrl =
        instanceIndex === 3
          ? 'https://pje.tst.jus.br/consultaprocessual/'
          : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;

      await retry(
        () => page.goto(processUrl, { waitUntil: 'networkidle0' }),
        3,
        1000,
        'Página de processo',
      );

      // Preencher número do processo
      await retry(
        async () => {
          await page.waitForSelector('#nrProcessoInput', { visible: true });
          await page.evaluate(() => {
            const input =
              document.querySelector<HTMLInputElement>('#nrProcessoInput');
            if (input) input.value = '';
          });
          await page.type('#nrProcessoInput', processNumber, { delay: 50 });
          await page.click('#btnPesquisar');
        },
        3,
        1000,
        'Preencher número do processo',
      );

      // ===== Seleção de instância (sem retry se não existir) =====
      await page.waitForSelector('#painel-escolha-processo', { visible: true });
      const processos = await page.$$(
        '#painel-escolha-processo .selecao-processo',
      );

      if (!processos.length)
        throw new Error('Nenhuma instância encontrada na página de seleção');

      const targetIndex = instanceIndex - 1;
      if (targetIndex < 0 || targetIndex >= processos.length) {
        this.logger.error(
          `Instância solicitada (${instanceIndex}) não está disponível. Instâncias encontradas: ${processos.length}`,
        );
        throw new Error(`Instância ${instanceIndex} não encontrada`);
      }

      // Click na instância (retry apenas para falhas temporárias)
      await retry(
        async () => {
          let newPage: any = null;
          const onTargetCreated = async (target: any) => {
            try {
              const pg = await target.page();
              if (pg) newPage = pg;
            } catch {}
          };
          page.browser().on('targetcreated', onTargetCreated);

          await processos[targetIndex].click();
          await new Promise((r) => setTimeout(r, 1200));

          if (newPage) {
            if (typeof newPage.bringToFront === 'function')
              await newPage.bringToFront();
            page = newPage;
            client = await initCDP(page);
          }

          page.browser().off('targetcreated', onTargetCreated);
        },
        3,
        1000,
        'Clicar na instância',
      );

      // CAPTCHA
      const captchaVisible = await page.$('#imagemCaptcha');
      if (captchaVisible) {
        await retry(
          async () => {
            const base64 = await page.$eval(
              '#imagemCaptcha',
              (img: HTMLImageElement) => img.src,
            );
            const solved = await this.captchaService.resolveCaptcha(base64);
            if (!solved?.resposta) throw new Error('Captcha falhou');

            await page.evaluate((value) => {
              const input =
                document.querySelector<HTMLInputElement>('#captchaInput');
              if (input) {
                input.value = value;
                input.dispatchEvent(new Event('input', { bubbles: true }));
                input.dispatchEvent(new Event('change', { bubbles: true }));
              }
            }, solved.resposta);

            await page.click('#btnEnviar');
            await new Promise((r) => setTimeout(r, 1500));
          },
          3,
          1000,
          'Resolver CAPTCHA',
        );
      }

      // Captura PDF / integra
      if (downloadIntegra) {
        const integraPromise = page.waitForResponse(
          (resp) => resp.url().includes('/integra') && resp.status() === 200,
          { timeout: maxWaitMs },
        );

        const btnIntegra = await page.$('#btnDownloadIntegra');
        if (btnIntegra) await btnIntegra.click();

        try {
          const integraResponse = await integraPromise;
          integraBuffer = await integraResponse.buffer();
          this.logger.log(
            `[PDF] ✅ Integra capturada na URL: ${integraResponse.url()}`,
          );
        } catch {
          this.logger.warn(
            '⚠ PDF /integra não foi capturado dentro do tempo limite',
          );
        }
      }

      // Espera response JSON do processo
      const startProcess = Date.now();
      while (!processCaptured && Date.now() - startProcess < maxWaitMs) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }

      if (!processCaptured)
        throw new Error('Não foi possível capturar a response do processo');
      if (integraBuffer && downloadIntegra) return { integra: integraBuffer };
      return { process: capturedResponseData };
    } finally {
      // ===== Cleanup =====
      try {
        await client?.send('Network.disable');
      } catch {}
      try {
        if (page && !page.isClosed()) await page.close();
        this.logger.debug('✅ Aba do Puppeteer fechada');
      } catch (err) {
        this.logger.warn(`Falha ao fechar aba: ${err?.message ?? err}`);
      }
      this.pool.release(context);
    }
  }
}
