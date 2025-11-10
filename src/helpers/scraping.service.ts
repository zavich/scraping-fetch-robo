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
  //   maxWaitMs = 180_000,
  // ) {
  //   const POLL_INTERVAL_MS = 500;
  //   this.logger.log(
  //     `▶ Iniciando scraping do processo ${processNumber} (TRT ${regionTRT}, Instância ${instanceIndex})`,
  //   );

  //   const context = await this.pool.acquire();
  //   this.logger.log('✅ Contexto adquirido do pool');

  //   const page = await context.newPage();
  //   this.logger.log('✅ Nova página aberta');

  //   let capturedResponseData: any = null;
  //   let integraBuffer: Buffer | null = null;
  //   let processCaptured = false;
  //   const requestMap = new Map<string, string>();

  //   const retry = async <T>(
  //     fn: () => Promise<T>,
  //     retries = 3,
  //     delayMs = 1000,
  //     stepName?: string,
  //   ) => {
  //     let lastError: unknown;
  //     for (let attempt = 1; attempt <= retries; attempt++) {
  //       try {
  //         const result = await fn();
  //         this.logger.log(
  //           `✅ Etapa '${stepName}' concluída na tentativa ${attempt}`,
  //         );
  //         return result;
  //       } catch (err) {
  //         lastError = err;
  //         const msg = err instanceof Error ? err.message : String(err);
  //         this.logger.warn(
  //           `❌ Tentativa ${attempt}/${retries} falhou na etapa '${stepName}': ${msg}`,
  //         );
  //         if (attempt < retries)
  //           await new Promise((r) => setTimeout(r, delayMs));
  //       }
  //     }
  //     throw lastError;
  //   };

  //   const initCDP = async (pg) => {
  //     this.logger.log('🔧 Inicializando CDP para monitoramento de rede...');
  //     const client = await pg.target().createCDPSession();
  //     await client.send('Network.enable');

  //     client.on('Network.requestWillBeSent', (event) => {
  //       if (event.requestId && event.request?.url) {
  //         requestMap.set(event.requestId, event.request.url);
  //         // this.logger.debug(
  //         //   `➡ Request enviado: ${event.request.url.substring(0, 120)}`,
  //         // );
  //       }
  //     });

  //     client.on('Network.responseReceived', (event) => {
  //       void (async () => {
  //         try {
  //           const url =
  //             event.response?.url ?? requestMap.get(event.requestId) ?? '';
  //           // this.logger.debug(
  //           //   `⬅ Response recebida: ${url} [${event.response?.status}]`,
  //           // );

  //           if (
  //             !processCaptured &&
  //             url.match(/\/pje-consulta-api\/api\/processos\/\d+/)
  //           ) {
  //             this.logger.debug(
  //               `📥 Tentando capturar JSON do processo em: ${url}`,
  //             );

  //             for (let attempt = 0; attempt < 6; attempt++) {
  //               try {
  //                 const body = await client.send('Network.getResponseBody', {
  //                   requestId: event.requestId,
  //                 });
  //                 const text = body.base64Encoded
  //                   ? Buffer.from(body.body, 'base64').toString('utf8')
  //                   : body.body;

  //                 try {
  //                   const json = JSON.parse(text);

  //                   const valid =
  //                     (Array.isArray(json) && json.length > 0) ||
  //                     (typeof json === 'object' && json && 'id' in json);
  //                   if (valid) {
  //                     capturedResponseData = json;
  //                     processCaptured = true;
  //                     this.logger.log('✅ Processo capturado via CDP!');
  //                     this.logger.debug(
  //                       JSON.stringify(json, null, 2).slice(0, 500),
  //                     );
  //                     break;
  //                   }
  //                 } catch {}
  //               } catch {}
  //               await new Promise((r) => setTimeout(r, 200));
  //             }
  //           }
  //         } catch (e) {
  //           this.logger.error(`Erro no handler de response: ${e}`);
  //         }
  //       })();
  //     });

  //     return client;
  //   };

  //   const client = await initCDP(page);

  //   try {
  //     const cacheKey = `pje:session:${regionTRT}`;
  //     const savedCookies = usedCookies ? await this.redis.get(cacheKey) : null;

  //     if (savedCookies) {
  //       this.logger.log('🍪 Restaurando cookies salvos...');
  //       const mapCookies = new Map<string, string>();

  //       savedCookies.split(';').forEach((c) => {
  //         const [name, ...rest] = c.trim().split('=');
  //         if (name && rest.length) mapCookies.set(name, rest.join('='));
  //       });

  //       this.logger.log(`✅ Cookies restaurados (${mapCookies.size})`);

  //       await page.setCookie(
  //         ...Array.from(mapCookies.entries()).map(([name, value]) => ({
  //           name,
  //           value,
  //           domain:
  //             instanceIndex === 3
  //               ? '.pje.tst.jus.br'
  //               : `.pje.trt${regionTRT}.jus.br`,
  //           path: '/',
  //           secure: true,
  //         })),
  //       );
  //     }

  //     const urlBase =
  //       instanceIndex === 3
  //         ? 'https://pje.tst.jus.br/consultaprocessual/'
  //         : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;

  //     this.logger.log(`🌐 Acessando URL base: ${urlBase}`);

  //     await retry(
  //       () => page.goto(urlBase, { waitUntil: 'networkidle0' }),
  //       3,
  //       1000,
  //       'Abrir consulta',
  //     );

  //     this.logger.log('⏳ Preenchendo número do processo...');

  //     await retry(
  //       async () => {
  //         await page.waitForSelector('#nrProcessoInput', { visible: true });

  //         await page.$eval(
  //           '#nrProcessoInput',
  //           (el) => ((el as HTMLInputElement).value = ''),
  //         );

  //         await page.type('#nrProcessoInput', processNumber, { delay: 45 });

  //         await Promise.all([
  //           page.waitForNavigation({
  //             waitUntil: 'networkidle0',
  //             timeout: 15000,
  //           }),
  //           page.click('#btnPesquisar'),
  //         ]);
  //       },
  //       3,
  //       1500,
  //       'Pesquisar processo',
  //     );

  //     this.logger.log('✅ Número do processo preenchido');

  //     const painelProm = page
  //       .waitForSelector('#painel-escolha-processo', { visible: true })
  //       .then(() => 'painel')
  //       .catch(() => null);
  //     const captchaProm = page
  //       .waitForSelector('#imagemCaptcha', { visible: true })
  //       .then(() => 'captcha')
  //       .catch(() => null);

  //     const resultado = await Promise.race([painelProm, captchaProm]);
  //     let singleInstance = false;

  //     if (resultado === 'painel') {
  //       this.logger.log('✅ Múltiplas instâncias detectadas');

  //       const processos = await page.$$(
  //         '#painel-escolha-processo .selecao-processo',
  //       );
  //       this.logger.log(
  //         `🔢 Total de instâncias disponíveis: ${processos.length}`,
  //       );

  //       if (!processos.length) throw new Error('Nenhuma instância encontrada');

  //       // ✅ ✅ NOVO COMPORTAMENTO
  //       // Se solicitou instância 3 e só existem 1 ou 2 → parar IMEDIATAMENTE sem captcha
  //       if (instanceIndex === 3 && processos.length < 3) {
  //         this.logger.warn(
  //           `⚠️ Instância 3 não encontrada (apenas ${processos.length} instâncias). Interrompendo sem resolver captcha.`,
  //         );

  //         return {
  //           process: { mensagemErro: 'Instância 3 não encontrada' },
  //           integra: null,
  //           singleInstance: false,
  //         };
  //       }

  //       // ✅ instância existe → selecionar normalmente
  //       const target = instanceIndex - 1;
  //       if (target < 0 || target >= processos.length)
  //         throw new Error(`Instância ${instanceIndex} não encontrada`);

  //       this.logger.log(`✅ Selecionando instância ${instanceIndex}`);

  //       await Promise.all([
  //         page
  //           .waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 })
  //           .catch(() => null),
  //         processos[target].click(),
  //       ]);

  //       this.logger.log('✅ Instância selecionada, indo para CAPTCHA');
  //     } else if (resultado === 'captcha') {
  //       this.logger.log(
  //         '⚠️ Processo possui apenas uma instância — indo direto ao CAPTCHA',
  //       );
  //       singleInstance = true;

  //       // ✅ ✅ NOVO: impedir buscar instâncias inexistentes
  //       if (instanceIndex !== 1) {
  //         this.logger.warn(
  //           `⚠️ Instância ${instanceIndex} não existe, pois o processo possui apenas uma instância.`,
  //         );

  //         return {
  //           process: {
  //             mensagemErro: `Instância ${instanceIndex} não encontrada`,
  //           },
  //           integra: null,
  //           singleInstance: true,
  //         };
  //       }
  //     }

  //     const captchaVisible = await page
  //       .waitForSelector('#imagemCaptcha', { visible: true, timeout: 6000 })
  //       .catch(() => null);
  //     if (captchaVisible) {
  //       this.logger.log('🔐 CAPTCHA detectado — iniciando resolução');

  //       await retry(
  //         async () => {
  //           const imgHandle = await page.$('#imagemCaptcha');
  //           if (!imgHandle) throw new Error('Imagem de CAPTCHA não encontrada');

  //           const srcProp = await imgHandle.getProperty('src');
  //           const srcVal = await srcProp.jsonValue();
  //           if (typeof srcVal !== 'string')
  //             throw new Error('Valor do src do CAPTCHA não é uma string');

  //           let base64 = srcVal.replace(/^data:image\/\w+;base64,/, '');

  //           const solved = await this.captchaService.resolveCaptcha(base64);
  //           if (!solved?.resposta) throw new Error('Falha ao resolver CAPTCHA');

  //           await page.$eval(
  //             '#captchaInput',
  //             (el: HTMLInputElement) => (el.value = ''),
  //           );
  //           await page.type('#captchaInput', solved.resposta, { delay: 50 });
  //           await page.click('#btnEnviar');
  //           await new Promise((r) => setTimeout(r, 400));
  //         },
  //         3,
  //         1000,
  //         'Resolver CAPTCHA',
  //       );

  //       this.logger.log('✅ CAPTCHA resolvido');
  //     }

  //     await new Promise((r) => setTimeout(r, 700));

  //     const painelErro = await page.$('#painel-erro');
  //     if (painelErro) {
  //       try {
  //         const spanErro = await painelErro.waitForSelector('span', {
  //           visible: true,
  //           timeout: 1500,
  //         });
  //         if (spanErro) {
  //           const mensagemErro = await spanErro.evaluate(
  //             (el) => el.textContent?.trim() || '',
  //           );
  //           this.logger.warn(`⚠️ Erro apresentado na tela: ${mensagemErro}`);
  //           return { process: { mensagemErro }, integra: null, singleInstance };
  //         }
  //       } catch {}
  //     }

  //     this.logger.log('⏳ Aguardando captura do processo pelo CDP...');

  //     const start = Date.now();
  //     while (!processCaptured && Date.now() - start < maxWaitMs) {
  //       await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  //     }

  //     if (!processCaptured) {
  //       this.logger.error('❌ Timeout — Processo não foi capturado pelo CDP');
  //       throw new Error('Processo não foi capturado');
  //     }

  //     this.logger.log('✅ Dados do processo capturados com sucesso');

  //     if (downloadIntegra) {
  //       this.logger.log('📄 Download do PDF /integra solicitado');

  //       const btnIntegra = await page.$('#btnDownloadIntegra');
  //       if (btnIntegra) {
  //         this.logger.log('📄 Botão de Integra encontrado, clicando...');
  //         await btnIntegra.click();
  //       } else {
  //         this.logger.warn('⚠️ Botão de Integra NÃO encontrado');
  //       }

  //       try {
  //         const r = await page.waitForResponse(
  //           (resp) => resp.url().includes('/integra') && resp.status() === 200,
  //           { timeout: maxWaitMs },
  //         );
  //         integraBuffer = await r.buffer();
  //         this.logger.log(`✅ PDF capturado (${integraBuffer.length} bytes)`);
  //       } catch (err) {
  //         this.logger.warn(`⚠️ Falha ao capturar PDF: ${err}`);
  //       }
  //     }

  //     return {
  //       process: !downloadIntegra ? capturedResponseData : undefined,
  //       integra: integraBuffer ?? undefined,
  //       singleInstance,
  //     };
  //   } finally {
  //     this.logger.log('♻ Limpando recursos e liberando contexto...');

  //     try {
  //       await client.send('Network.disable');
  //     } catch {}

  //     try {
  //       if (page && !page.isClosed()) await page.close();
  //     } catch {}

  //     this.pool.release(context);
  //     this.logger.log('✅ Contexto liberado');
  //   }
  // }
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

    const context = await this.pool.acquire();
    this.logger.log('✅ Contexto adquirido do pool');

    const page = await context.newPage();
    this.logger.log('✅ Nova página aberta');

    let capturedResponseData: any = null;
    let integraBuffer: Buffer | null = null;
    let processCaptured = false;
    const requestMap = new Map<string, string>();

    // Função de retry genérica
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

    // Inicializa CDP para capturar JSON do processo
    const initCDP = async (pg) => {
      const client = await pg.target().createCDPSession();
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
            if (
              !processCaptured &&
              url.match(/\/pje-consulta-api\/api\/processos\/\d+/)
            ) {
              for (let attempt = 0; attempt < 6; attempt++) {
                try {
                  const body = await client.send('Network.getResponseBody', {
                    requestId: event.requestId,
                  });
                  const text = body.base64Encoded
                    ? Buffer.from(body.body, 'base64').toString('utf8')
                    : body.body;

                  const json = JSON.parse(text);
                  const valid =
                    (Array.isArray(json) && json.length > 0) ||
                    (typeof json === 'object' && json && 'id' in json);
                  if (valid) {
                    capturedResponseData = json;
                    processCaptured = true;
                    this.logger.log('✅ Processo capturado via CDP!');
                    break;
                  }
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

      // ⚡ Aqui colocamos **toda a interação do processo dentro do retry**
      await retry(
        async () => {
          this.logger.log('⏳ Preenchendo número do processo...');

          await page.waitForSelector('#nrProcessoInput', { visible: true });
          await page.$eval(
            '#nrProcessoInput',
            (el) => ((el as HTMLInputElement).value = ''),
          );
          await page.type('#nrProcessoInput', processNumber, { delay: 45 });
          await Promise.all([
            page.waitForNavigation({
              waitUntil: 'networkidle0',
              timeout: 15000,
            }),
            page.click('#btnPesquisar'),
          ]);

          // Verifica instâncias
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

          if (resultado === 'painel') {
            const processos = await page.$$(
              '#painel-escolha-processo .selecao-processo',
            );
            if (instanceIndex === 3 && processos.length < 3)
              throw new Error(`Instância 3 não encontrada`);

            const target = instanceIndex - 1;
            if (target < 0 || target >= processos.length)
              throw new Error(`Instância ${instanceIndex} não encontrada`);

            await Promise.all([
              page
                .waitForNavigation({
                  waitUntil: 'networkidle0',
                  timeout: 15000,
                })
                .catch(() => null),
              processos[target].click(),
            ]);
          } else if (resultado === 'captcha') {
            singleInstance = true;
            if (instanceIndex !== 1)
              throw new Error(`Instância ${instanceIndex} não encontrada`);
          }

          // CAPTCHA
          const captchaVisible = await page
            .waitForSelector('#imagemCaptcha', { visible: true, timeout: 6000 })
            .catch(() => null);
          if (captchaVisible) {
            const imgHandle = await page.$('#imagemCaptcha');
            const srcProp = await imgHandle!.getProperty('src');
            const srcVal = await srcProp.jsonValue();
            let base64 = (srcVal as string).replace(
              /^data:image\/\w+;base64,/,
              '',
            );
            const solved = await this.captchaService.resolveCaptcha(base64);
            if (!solved?.resposta) throw new Error('Falha ao resolver CAPTCHA');
            await page.$eval(
              '#captchaInput',
              (el: HTMLInputElement) => (el.value = ''),
            );
            await page.type('#captchaInput', solved.resposta, { delay: 50 });
            await page.click('#btnEnviar');
            await new Promise((r) => setTimeout(r, 400));
          }

          // Verifica erro na tela
          const painelErro = await page.$('#painel-erro');
          if (painelErro) {
            const spanErro = await painelErro.waitForSelector('span', {
              visible: true,
              timeout: 1500,
            });
            const mensagemErro = await spanErro?.evaluate(
              (el) => el.textContent?.trim() || '',
            );
            if (mensagemErro) throw new Error(`Erro PJe: ${mensagemErro}`);
          }
        },
        3,
        1500,
        'Pesquisar processo',
      );

      // Espera captura via CDP
      this.logger.log('⏳ Aguardando captura do processo pelo CDP...');
      const start = Date.now();
      while (!processCaptured && Date.now() - start < maxWaitMs) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
      if (!processCaptured) throw new Error('Processo não foi capturado');

      this.logger.log('✅ Dados do processo capturados com sucesso');

      // Download integra
      if (downloadIntegra) {
        this.logger.log('📄 Download do PDF /integra solicitado');
        const btnIntegra = await page.$('#btnDownloadIntegra');
        if (btnIntegra) await btnIntegra.click();
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
        singleInstance: false,
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
