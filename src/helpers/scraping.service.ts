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
  async execute(
    processNumber: string,
    regionTRT: number,
    instanceIndex: number,
    usedCookies = false,
    downloadIntegra = false,
    maxWaitMs = 180_000,
  ) {
    const POLL_INTERVAL_MS = 500;
    const context = await this.pool.acquire();
    let page = await context.newPage();

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

    const initCDP = async (pg: typeof page) => {
      const client = await pg.target().createCDPSession();
      await client.send('Network.enable');

      client.on('Network.requestWillBeSent', (event) => {
        if (event.requestId && event.request?.url)
          requestMap.set(event.requestId, event.request.url);
      });

      client.on('Network.responseReceived', async (event) => {
        try {
          const resp = event.response;
          const reqId = event.requestId;
          const url = resp?.url ?? requestMap.get(reqId) ?? '';

          if (
            !processCaptured &&
            url.match(/\/pje-consulta-api\/api\/processos\/\d+/) &&
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

                let json;
                try {
                  json = JSON.parse(text);
                } catch {
                  continue;
                }

                const valid =
                  (Array.isArray(json) && json.length > 0) ||
                  (json?.id && json?.numero);

                if (valid) {
                  capturedResponseData = json;
                  processCaptured = true;
                  break;
                }
              } catch {
                await new Promise((r) => setTimeout(r, 250));
              }
            }
          }
        } catch {}
      });

      return client;
    };

    const client = await initCDP(page);

    try {
      // LOGIN / COOKIES
      const cacheKey = `pje:session:${regionTRT}`;
      const savedCookies = usedCookies ? await this.redis.get(cacheKey) : null;

      if (savedCookies) {
        const mapCookies = new Map<string, string>();
        savedCookies.split(';').forEach((c) => {
          const [name, ...rest] = c.trim().split('=');
          if (name && rest.length) mapCookies.set(name, rest.join('='));
        });

        const hasTokens = ['access_token_1g', 'access_token_2g'].every((t) =>
          mapCookies.has(t),
        );

        if (hasTokens) {
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

          this.logger.debug('✅ Cookies restaurados');
        } else {
          await this.redis.del(cacheKey);
          usedCookies = false;
        }
      }

      // if ((!savedCookies || !usedCookies) && username && password) {
      //   const baseUrl =
      //     instanceIndex === 3
      //       ? 'https://pje.tst.jus.br/consultaprocessual'
      //       : `https://pje.trt${regionTRT}.jus.br/consultaprocessual`;

      //   await page.goto(baseUrl, { waitUntil: 'networkidle0' });

      //   const acessoBtn = await page.waitForSelector(
      //     'a[routerlink="/login"][mattooltip="Acesso restrito"]',
      //     { visible: true, timeout: 5000 },
      //   );
      //   if (!acessoBtn)
      //     throw new Error(
      //       `Botão "Acesso restrito" não encontrado para TRT-${regionTRT}`,
      //     );
      //   await acessoBtn.click();

      //   const usuarioInput = await page.waitForSelector(
      //     'input[name="usuario"]',
      //     { visible: true, timeout: 10000 },
      //   );
      //   const senhaInput = await page.waitForSelector('input[name="senha"]', {
      //     visible: true,
      //     timeout: 10000,
      //   });
      //   if (!usuarioInput || !senhaInput)
      //     throw new Error(
      //       `Campos de login não encontrados para TRT-${regionTRT}`,
      //     );

      //   await usuarioInput.type(username, { delay: 50 });
      //   await senhaInput.type(password, { delay: 50 });

      //   const btnEntrar = await page.waitForSelector('#btnEntrar', {
      //     visible: true,
      //     timeout: 5000,
      //   });
      //   if (!btnEntrar)
      //     throw new Error(
      //       `Botão "Entrar" não encontrado para TRT-${regionTRT}`,
      //     );
      //   await btnEntrar.click();

      //   const cookies = await page.cookies();
      //   const hasAccessToken = cookies.some((c) =>
      //     c.name.includes('access_token'),
      //   );

      //   if (hasAccessToken) {
      //     const cookiesString = cookies
      //       .map((c) => `${c.name}=${c.value}`)
      //       .join(';');
      //     await this.redis.set(cacheKey, cookiesString, 'EX', 1800);
      //     this.logger.log(
      //       `✅ Login realizado e cookies salvos para TRT-${regionTRT}`,
      //     );
      //   } else {
      //     const blockedKey = `blocked:${regionTRT}:${username}`;
      //     await this.redis.set(
      //       blockedKey,
      //       JSON.stringify({
      //         username,
      //         regionTRT,
      //         blockedAt: new Date(),
      //         cookies,
      //       }),
      //       'EX',
      //       3600,
      //     );
      //     this.logger.warn(
      //       `⚠️ Usuário ${username} no TRT-${regionTRT} está bloqueado ou login falhou.`,
      //     );
      //     return { process: null, integra: null, blocked: true };
      //   }
      // }

      const urlBase =
        instanceIndex === 3
          ? 'https://pje.tst.jus.br/consultaprocessual/'
          : `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;

      await retry(
        () => page.goto(urlBase, { waitUntil: 'networkidle0' }),
        3,
        1000,
        'Abrir consulta',
      );

      // Preenche processo
      await retry(
        async () => {
          await page.waitForSelector('#nrProcessoInput', { visible: true });
          await page.evaluate(() => {
            const input =
              document.querySelector<HTMLInputElement>('#nrProcessoInput');
            if (input) input.value = '';
          });
          await page.type('#nrProcessoInput', processNumber, { delay: 45 });
          await page.click('#btnPesquisar');
        },
        3,
        1000,
        'Preencher processo',
      );

      // Seleção de instância
      const painelProm = page
        .waitForSelector('#painel-escolha-processo', { visible: true })
        .then(() => 'painel')
        .catch(() => null);
      const captchaProm = page
        .waitForSelector('#imagemCaptcha', { visible: true })
        .then(() => 'captcha')
        .catch(() => null);
      const resultado = await Promise.race([painelProm, captchaProm]);

      if (resultado === 'painel') {
        this.logger.log('✅ Múltiplas instâncias — painel exibido');
        const processos = await page.$$(
          '#painel-escolha-processo .selecao-processo',
        );
        if (!processos.length) throw new Error('Nenhuma instância encontrada');

        const target = instanceIndex - 1;
        if (target < 0 || target >= processos.length)
          throw new Error(`Instância ${instanceIndex} não encontrada`);

        await Promise.all([
          page
            .waitForNavigation({ waitUntil: 'networkidle0', timeout: 15000 })
            .catch(() => null),
          processos[target].click(),
        ]);

        this.logger.log('✅ Instância selecionada, aguardando captcha...');
      }

      // CAPTCHA
      const captchaVisible = await page
        .waitForSelector('#imagemCaptcha', { visible: true, timeout: 5000 })
        .catch(() => null);
      if (captchaVisible) {
        this.logger.log('⏳ Resolvendo CAPTCHA…');
        await retry(async () => {
          let base64 = await page.$eval(
            '#imagemCaptcha',
            (img: HTMLImageElement) => img.src,
          );
          base64 = base64.replace(/^data:image\/\w+;base64,/, '');
          const solved = await this.captchaService.resolveCaptcha(base64);
          if (!solved?.resposta) throw new Error('Captcha falhou');

          await page.evaluate(() => {
            const input =
              document.querySelector<HTMLInputElement>('#captchaInput');
            if (input) input.value = '';
          });
          await page.type('#captchaInput', solved.resposta, { delay: 50 });
          await page.click('#btnEnviar');
          await new Promise((r) => setTimeout(r, 500));
        }, 3);
        this.logger.log('✅ CAPTCHA resolvido!');
      }

      // ✅ CHECK IMEDIATO DO PAINEL DE ERRO
      await new Promise((r) => setTimeout(r, 700));

      const painelErro = await page.$('#painel-erro');

      if (painelErro) {
        try {
          const spanErro = await painelErro.waitForSelector('span', {
            visible: true,
            timeout: 2000,
          });
          if (spanErro) {
            const mensagemErro = await spanErro.evaluate(
              (el) => el.textContent?.trim() || '',
            );
            if (mensagemErro) {
              return { process: { mensagemErro }, integra: null };
            }
          }
        } catch (err) {
          // span não apareceu, continua normalmente
        }
      }

      // Captura do processo normalmente
      const start = Date.now();
      while (!processCaptured && Date.now() - start < maxWaitMs)
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

      if (!processCaptured) throw new Error('Processo não foi capturado');

      if (downloadIntegra && integraBuffer) return { integra: integraBuffer };
      return { process: capturedResponseData };
    } finally {
      try {
        await client?.send('Network.disable');
      } catch {}
      try {
        if (page && !page.isClosed()) await page.close();
      } catch {}
      this.pool.release(context);
    }
  }
}
