import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserManager } from 'src/utils/browser.manager';

@Injectable()
export class ScrapingService {
  private readonly logger = new Logger(ScrapingService.name);

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // A AWS às vezes seta o aws-waf-token duas vezes pro mesmo host — uma
  // versão host-only e outra com Domain=.dominio (convenção da própria AWS
  // pro cookie "de verdade"). page.cookies() devolve as duas, e juntar tudo
  // com join('; ') sem filtrar manda um Cookie header com dois valores
  // conflitantes de aws-waf-token — o servidor pode acabar usando o errado
  // (o stale/host-only) em vez do que o widget acabou de emitir.
  private serializarCookies(
    cookies: { name: string; value: string; domain: string }[],
  ): string {
    const cookieMap = new Map<string, string>();
    for (const c of cookies) {
      const existente = cookieMap.get(c.name);
      if (!existente || c.domain.startsWith('.')) {
        cookieMap.set(c.name, c.value);
      }
    }
    return Array.from(cookieMap.entries())
      .map(([name, value]) => `${name}=${value}`)
      .join('; ');
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

    // Monitora via CDP as requests pro domínio awswaf.com — usado pra
    // confirmar se o /verify realmente é disparado pelo próprio widget após
    // clicarmos nas células e no "Confirm".
    const cdpClient = await page.target().createCDPSession();
    await cdpClient.send('Network.enable');
    const awswafRequests: { method: string; url: string }[] = [];

    cdpClient.on('Network.requestWillBeSent', (event) => {
      const url = event.request?.url || '';
      if (url.includes('awswaf.com')) {
        awswafRequests.push({ method: event.request.method, url });
        this.logger.debug(
          `📡 [CDP] ${event.request.method} ${url.split('?')[0]}`,
        );
      }
    });

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

      // Detecta se é uma página de WAF (gokuProps injetado pela AWS, ou
      // fallback via regex no HTML — o mesmo dado, direto ou via markup)
      const wafParams = await page.evaluate(() => {
        // @ts-ignore
        const w = window as any;

        const key = w.gokuProps?.key || null;
        const iv = w.gokuProps?.iv || null;
        const context = w.gokuProps?.context || null;

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

      if (wafParams?.websiteKey && wafParams?.context && wafParams?.iv) {
        this.logger.warn(
          '⚠️ AWS WAF detectado — resolvendo com clique real no widget...',
        );

        // Procura um botão/link com o texto dado em todos os frames da
        // página (o widget da AWS pode estar no frame principal ou num
        // iframe cross-origin de captcha.awswaf.com).
        const clickButtonWithText = async (text: string): Promise<boolean> => {
          for (const frame of page.frames()) {
            try {
              const clicked = await frame.evaluate((needle) => {
                const els = Array.from(
                  document.querySelectorAll(
                    'button, a, div[role="button"], input[type="button"], input[type="submit"]',
                  ),
                );
                const el = els.find((e) =>
                  (e.textContent || (e as HTMLInputElement).value || '')
                    .trim()
                    .toLowerCase()
                    .includes(needle),
                );
                if (el) {
                  (el as HTMLElement).click();
                  return true;
                }
                return false;
              }, text);
              if (clicked) return true;
            } catch {
              // frame cross-origin ou destruído — tenta o próximo
            }
          }
          return false;
        };

        //
        // 1. CLICA EM "BEGIN" E ACHA O CANVAS DO GRID
        //
        // O grid de imagens é desenhado com pixels dentro de um <canvas> —
        // não existe nenhuma <img> real pro grid em si. Os alvos de clique
        // de verdade são <button>s numerados (1, 2, 3...) dentro do canvas
        // (conteúdo de fallback/acessibilidade). A AWS às vezes sorteia a
        // variante de ÁUDIO em vez da de canvas; como só sabemos resolver a
        // de canvas, recarrega e tenta de novo até achar um, ou desiste.
        let captchaFrame = page.mainFrame();
        let canvasHandle: Awaited<
          ReturnType<(typeof captchaFrame)['$']>
        > | null = null;
        let instruction = '';
        const MAX_TENTATIVAS_VARIANTE = 5;

        for (
          let tentativaVariante = 1;
          tentativaVariante <= MAX_TENTATIVAS_VARIANTE;
          tentativaVariante++
        ) {
          const clicouBegin = await clickButtonWithText('begin');
          this.logger.log(
            clicouBegin
              ? '👉 Botão "Begin" clicado'
              : '⚠️ Botão "Begin" não encontrado — talvez já esteja no grid',
          );
          await new Promise((r) => setTimeout(r, 1500));

          captchaFrame =
            page.frames().find((f) => f.url().includes('captcha.awswaf.com')) ||
            page.mainFrame();

          canvasHandle = await captchaFrame.$('canvas');

          if (canvasHandle) {
            // A instrução (ex: "Escolha todos(as) os relógios" ou "Choose
            // all the hats") fica no <div> irmão anterior do <div> que
            // envolve o canvas — extraído direto do DOM, funciona em
            // qualquer idioma (ao contrário de regex tipo /choose|select/).
            instruction = await canvasHandle.evaluate((canvas) => {
              const outerDiv = canvas.parentElement?.parentElement;
              const instrucaoDiv = outerDiv?.children?.[0];
              return instrucaoDiv?.textContent?.trim() || '';
            });
          }

          if (canvasHandle && instruction) {
            this.logger.log(
              `🧩 Instrução do captcha: "${instruction}" (variante de canvas, tentativa ${tentativaVariante})`,
            );
            break;
          }

          this.logger.warn(
            `⚠️ Sem canvas de imagem — provável variante de áudio (tentativa ${tentativaVariante}/${MAX_TENTATIVAS_VARIANTE}) — recarregando pra tentar de novo`,
          );

          if (tentativaVariante === MAX_TENTATIVAS_VARIANTE) {
            throw new Error(
              '❌ Não conseguiu cair na variante de canvas do captcha após várias tentativas (variante de áudio não é suportada)',
            );
          }

          // Um reload simples reaproveita a mesma sessão/preferência de
          // acessibilidade e sempre volta pra mesma variante. Limpa cookies
          // do WAF e localStorage/sessionStorage e faz uma navegação nova
          // (não reload) pra forçar a AWS a sortear de novo.
          const wafCookiesRetry = (await page.cookies()).filter((c) =>
            c.name.startsWith('aws-waf'),
          );
          if (wafCookiesRetry.length) {
            await page.deleteCookie(
              ...wafCookiesRetry.map((c) => ({
                name: c.name,
                domain: c.domain,
                path: c.path || '/',
              })),
            );
          }
          await page
            .evaluate(() => {
              localStorage.clear();
              sessionStorage.clear();
            })
            .catch(() => null);
          await page
            .goto(urlBase, { waitUntil: 'networkidle0' })
            .catch(() => null);
          await new Promise((r) => setTimeout(r, 1500));
        }

        if (!canvasHandle) {
          throw new Error('❌ Canvas do grid não encontrado');
        }
        const canvas = canvasHandle;

        // Os botões numerados podem levar um tempo pra todos aparecerem —
        // espera a contagem estabilizar antes de considerar definitiva.
        let buttonHandles = await canvas.$$('button');
        let contagemAnterior = -1;
        for (let tentativa = 0; tentativa < 14; tentativa++) {
          if (
            buttonHandles.length > 0 &&
            buttonHandles.length === contagemAnterior
          ) {
            break;
          }
          contagemAnterior = buttonHandles.length;
          await new Promise((r) => setTimeout(r, 400));
          buttonHandles = await canvas.$$('button');
        }

        if (!buttonHandles.length) {
          throw new Error(
            '❌ Nenhum botão de célula encontrado no canvas do captcha',
          );
        }

        // Os botões são conteúdo de fallback do <canvas> — o browser não dá
        // layout/posição visual real a eles quando o canvas é suportado
        // (que é sempre o caso aqui), então bounding box não serve pra
        // descobrir linhas/colunas. Em todos os grids que já vimos a AWS
        // sempre usa 3 colunas (9→3x3, 6→2x3, 3→1x3), então deriva o número
        // de linhas direto da contagem.
        const columns = 3;
        const rows = Math.max(1, Math.ceil(buttonHandles.length / columns));

        this.logger.log(
          `🔘 ${buttonHandles.length} botões de célula encontrados (assumindo ${columns} colunas → ${rows} linha(s))`,
        );

        //
        // 3. TIRA UM PRINT DO CANVAS (onde o grid é desenhado de verdade)
        //
        const gridScreenshot = await canvas.screenshot({ encoding: 'base64' });

        //
        // 4. MANDA PRO 2CAPTCHA (GridTask) SÓ PRA RECONHECER A IMAGEM —
        //    quem clica e submete o /verify é o nosso próprio browser
        //
        const cellIndices = await this.captchaService.solveGridImage(
          gridScreenshot,
          instruction,
          rows,
          columns,
        );

        this.logger.log(
          `🎯 Células a clicar (bruto, do 2Captcha): ${cellIndices.join(', ') || '(nenhuma)'}`,
        );

        if (!cellIndices.length) {
          throw new Error('❌ GridTask não retornou nenhuma célula pra clicar');
        }

        // Confirmado visualmente: o GridTask já numera as células em base 1,
        // na mesma ordem de leitura (esquerda->direita, cima->baixo) usada
        // pelos números dos botões de fallback do canvas. Ou seja, o índice
        // retornado JÁ É o número do botão — nada de deslocar.
        const numerosBotaoAClicar = cellIndices;

        this.logger.log(
          `🎯 Botões a clicar (por número, base 1): ${numerosBotaoAClicar.join(', ')}`,
        );

        //
        // 5. CLICA NOS BOTÕES CERTOS, DE VERDADE, NA NOSSA PÁGINA
        //
        // Busca os botões de novo — a GridTask pode levar mais de 15s pra
        // responder, e o widget pode ter trocado o desafio nesse meio
        // tempo. Mapeia por NÚMERO (texto do próprio botão), não por
        // posição no array — mais confiável que confiar na ordem do DOM.
        const buttonHandlesFrescos = await canvas.$$('button');
        const botaoPorNumero = new Map<
          number,
          (typeof buttonHandlesFrescos)[number]
        >();
        for (const btn of buttonHandlesFrescos) {
          const texto = await btn.evaluate((b) => b.textContent?.trim() || '');
          const numero = parseInt(texto, 10);
          if (!isNaN(numero)) botaoPorNumero.set(numero, btn);
        }
        this.logger.log(
          `🔘 Re-capturados ${buttonHandlesFrescos.length} botões antes de clicar (números disponíveis: ${Array.from(
            botaoPorNumero.keys(),
          )
            .sort((a, b) => a - b)
            .join(', ')})`,
        );

        for (const numero of numerosBotaoAClicar) {
          const handle = botaoPorNumero.get(numero);
          if (!handle) {
            this.logger.warn(`⚠️ Botão número ${numero} não encontrado`);
            continue;
          }
          try {
            // .click() do Puppeteer simula um clique de mouse real e exige
            // um ponto clicável na tela — mas esses botões são conteúdo de
            // fallback do <canvas>, sem posição/layout visual quando o
            // canvas é suportado. Chama .click() nativo via JS em vez
            // disso, que dispara o handler sem depender de posição visual.
            await handle.evaluate((el) => (el as HTMLElement).click());
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.logger.warn(`⚠️ Falha ao clicar no botão ${numero}: ${msg}`);
          }
          await new Promise((r) => setTimeout(r, 300 + Math.random() * 400));
        }

        // Registra o listener ANTES de clicar em "Confirm" pra não perder a
        // request — o SPA da PJE dispara /propriedades sozinho assim que o
        // desafio é resolvido, e pode ser rápido demais pra escutar só
        // depois do clique.
        const propriedadesResponsePromise = page
          .waitForResponse(
            (res) =>
              res.url().includes('/pje-consulta-api/api/propriedades') &&
              res.request().method() === 'GET',
            { timeout: 30000 },
          )
          .catch(() => null);

        //
        // 6. CLICA NO BOTÃO DE CONFIRMAR
        //
        const clicouConfirm = await clickButtonWithText('confirm');
        if (!clicouConfirm) {
          throw new Error(
            '❌ Botão "Confirm" não encontrado após clicar nas imagens',
          );
        }
        this.logger.log(
          '✅ Grid resolvido e confirmado — aguardando o /verify nativo da AWS...',
        );

        //
        // 7. AGUARDA O aws-waf-token APARECER (o próprio widget faz /verify
        //    + /voucher sozinho e seta o cookie ele mesmo). A prova real de
        //    sucesso é o cookie: window.gokuProps é só a config estática
        //    injetada na carga da página, o widget nunca limpa isso, então
        //    não serve como sinal de "desafio resolvido" — usar isso fazia o
        //    código dar timeout e lançar erro mesmo quando o /voucher já
        //    tinha emitido o token com sucesso.
        //
        let cookiesFinais: Awaited<ReturnType<typeof page.cookies>> = [];
        let tokensFinais: typeof cookiesFinais = [];
        const prazoLimite = Date.now() + 60000;
        while (Date.now() < prazoLimite) {
          cookiesFinais = await page.cookies();
          tokensFinais = cookiesFinais.filter(
            (c) => c.name === 'aws-waf-token' && c.value,
          );
          if (tokensFinais.length) break;
          await new Promise((r) => setTimeout(r, 1000));
        }

        const chamouVerify = awswafRequests.some((r) =>
          r.url.includes('/verify'),
        );
        this.logger.log(
          `🔍 Requests awswaf.com capturadas após o clique (${awswafRequests.length}): ${JSON.stringify(
            awswafRequests.map((r) => ({
              method: r.method,
              url: r.url.split('?')[0],
            })),
          )}`,
        );
        if (!chamouVerify) {
          this.logger.warn(
            '⚠️ Nenhuma request para /verify foi capturada — o clique sintético pode não ter disparado o handler real do widget',
          );
        }

        if (!tokensFinais.length) {
          throw new Error(
            '❌ aws-waf-token não encontrado após o widget confirmar o grid',
          );
        }

        // O cookie aparece logo após o /voucher, mas a prova definitiva de
        // que ele é válido é o próprio app da PJE usá-lo com sucesso numa
        // chamada de API normal e protegida (não é rota do desafio da AWS)
        // — /propriedades, disparada sozinha pelo SPA assim que o desafio é
        // resolvido. Espera essa confirmação e relê os cookies nesse
        // momento, pra salvar exatamente o valor que a AWS aceitou de
        // verdade, e não um token intermediário que pode mudar depois.
        const propriedadesResponse = await propriedadesResponsePromise;

        if (propriedadesResponse) {
          this.logger.log(
            `✅ Chamada de /propriedades confirmada (status ${propriedadesResponse.status()}) — usando cookies desse momento`,
          );
          cookiesFinais = await page.cookies();
          tokensFinais = cookiesFinais.filter(
            (c) => c.name === 'aws-waf-token' && c.value,
          );
          if (!tokensFinais.length) {
            throw new Error(
              '❌ aws-waf-token sumiu após a chamada de /propriedades',
            );
          }
        } else {
          this.logger.warn(
            '⚠️ Chamada de /propriedades não foi capturada — salvando o token obtido logo após o /voucher mesmo assim',
          );
        }

        // Checa duplicidade no snapshot que será REALMENTE persistido (o do
        // /propriedades, quando disponível) — checar só o snapshot inicial
        // deixaria passar batido um duplicado que só aparece depois.
        if (tokensFinais.length > 1) {
          this.logger.warn(
            `⚠️ Encontrados ${tokensFinais.length} cookies aws-waf-token (duplicado por domínio): ${JSON.stringify(tokensFinais.map((c) => ({ domain: c.domain, path: c.path })))}`,
          );
        }

        this.logger.log('✅ AWS WAF contornado via clique real no widget');

        // O token aws-waf-token é validado pela AWS junto com o fingerprint
        // do navegador que resolveu o desafio (User-Agent incluso). Se a
        // request seguinte (via axios) usar um User-Agent diferente do
        // Puppeteer real, a AWS rejeita com 405 mesmo o token sendo válido —
        // por isso salvamos o UA de verdade junto, pra reusar exatamente ele.
        //
        // IMPORTANTE: page.browser().userAgent() devolve o UA BRUTO do
        // browser (com "HeadlessChrome" no meio, já que headless:true no
        // browser.manager.ts) — o puppeteer-extra-plugin-stealth mascara
        // isso só na página via page.setUserAgent() (evasion
        // user-agent-override), então o valor real usado nas requests da
        // página é outro. Usar o valor bruto aqui vazava "HeadlessChrome"
        // pro header replayado via axios, e isso sozinho já é motivo de
        // bloqueio (403) por qualquer WAF/CDN de frente. navigator.userAgent
        // reflete o valor mascarado que a própria página usa de verdade.
        const userAgent = await page.evaluate(() => navigator.userAgent);

        await this.redis.set(
          `aws-waf-token:${processNumber}`,
          this.serializarCookies(cookiesFinais),
          'EX',
          180000, // 3 minutos de validade no Redis, para evitar reCAPTCHA frequentes
        );
        await this.redis.set(
          `aws-waf-ua:${processNumber}`,
          userAgent,
          'EX',
          180000,
        );

        return {
          integra: null,
          process: { mensagemErro: 'AWS WAF contornado' },
          singleInstance: false,
        };
      }

      this.logger.log('✅ Nenhum AWS WAF detectado na página');

      await new Promise((r) => setTimeout(r, 2000));
      await page.reload({ waitUntil: 'networkidle0' });
      this.logger.log('⏳ Aguardando aws-waf-token...');

      let token: string | null = null;
      let cookiesAtuais: Awaited<ReturnType<typeof page.cookies>> = [];

      for (let i = 0; i < 10; i++) {
        cookiesAtuais = await page.cookies();
        const found = cookiesAtuais.find((c) => c.name === 'aws-waf-token');

        if (found?.value) {
          token = found.value;
          break;
        }

        await new Promise((r) => setTimeout(r, 500));
      }

      // Quando a AWS não desafia a sessão, ela pode simplesmente não emitir
      // o cookie aws-waf-token (artefato do desafio JS que nem rodou). Não é
      // falha: persistimos os cookies de sessão que existirem.
      if (!token) {
        this.logger.warn(
          '⚠️ aws-waf-token não apareceu — seguindo sem ele (provável sessão não desafiada pela AWS)',
        );
      }

      if (!cookiesAtuais.length) {
        throw new Error('❌ Nenhum cookie de sessão disponível após reload');
      }

      await this.redis.set(
        `aws-waf-token:${processNumber}`,
        this.serializarCookies(cookiesAtuais),
        'EX',
        18000, // 5 horas de validade no Redis, para evitar reCAPTCHA frequentes
      );
      await this.redis.set(
        `aws-waf-ua:${processNumber}`,
        await page.evaluate(() => navigator.userAgent),
        'EX',
        18000,
      );
    } finally {
      this.logger.log('♻ Limpando recursos e liberando contexto...');
      try {
        if (page && !page.isClosed()) await page.close();
      } catch {}
      await BrowserManager.closeContext(context);
      this.logger.log('✅ Contexto liberado');
    }
  }
}
