import { Inject, Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { Page } from 'puppeteer';
import { ProcessosResponse } from 'src/interfaces';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { CaptchaService } from 'src/services/captcha.service';
import { BrowserPool } from 'src/utils/browser-pool';
import { BrowserManager } from 'src/utils/browser.manager';

@Injectable()
export class ScrapingProcessService {
  private readonly logger = new Logger(ScrapingProcessService.name);

  private readonly pool = new BrowserPool(5); // Reduzir o limite
  private isInitialized = false;
  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly awsS3Service: AwsS3Service,
  ) {
    this.pool.init();
  }

  async execute(processNumber: string, regionTRT: number, instance: number) {
    if (!this.isInitialized) {
      await this.pool.init();
      this.isInitialized = true;
    }
    const { page, context } = await BrowserManager.createPage();

    try {
      if (!page || !context) {
        this.logger.error('❌ Falha ao criar o contexto ou a página.');
        throw new Error('Falha ao criar o contexto ou a página.');
      }
      const urlBase = `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`;
      this.logger.log(`🌐 Acessando URL base: ${urlBase}`);
      await page.setUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
          '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      );
      await page.goto(urlBase, {
        waitUntil: 'domcontentloaded',
        timeout: 120000, // Aumentar para 2 minutos
      });
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
        const w = window as unknown as {
          gokuProps?: { key?: string; iv?: string; context?: string };
        };

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
          const win = window as Window & {
            gokuProps?: { key?: string; iv?: string; context?: string };
          };
          const goku = win.gokuProps;
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
        const solved: {
          captcha_voucher?: string;
          existing_token?: string;
        } = await this.captchaService.resolveAwsWaf({
          websiteURL: urlBase,
          websiteKey: wafParamsExtracted.websiteKey,
          context: wafParamsExtracted.context as string,
          iv: wafParamsExtracted.iv as string,
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

        let voucherResponse: unknown = null;
        try {
          voucherResponse = JSON.parse(voucherResponseText);
        } catch {
          this.logger.warn('⚠️ Resposta /voucher não é JSON válido');
        }

        let newToken: string | undefined = undefined;
        if (
          voucherResponse &&
          typeof voucherResponse === 'object' &&
          'token' in voucherResponse &&
          typeof (voucherResponse as { token?: unknown }).token === 'string'
        ) {
          newToken = (voucherResponse as { token: string }).token;
        }

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
            value: newToken as string,
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
          this.logger.error(
            '⚠️ Falha no setCookie — usando fallback document.cookie',
          );
          this.logger.error(err);
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
        // const originalCookies = await page.cookies();
        // await this.redis.set(
        //   `aws-waf-token:${regionTRT}`,
        //   originalCookies.map((c) => `${c.name}=${c.value}`).join('; '),
        //   'EX',
        //   3600,
        // );
        await new Promise((r) => setTimeout(r, 1500));
        await page.reload({ waitUntil: 'domcontentloaded' });
      }
      // 🔥 ESPERA REAL DO FRONT
      await page.waitForFunction(
        () => {
          return document.readyState === 'complete';
        },
        { timeout: 10000 },
      );

      // 🔥 AGUARDA JS DO PJE RENDERIZAR
      await new Promise((r) => setTimeout(r, 3000));

      this.logger.log(
        '🔁 Página recarregada — aguardando renderização real...',
      );
      await this.detectBlock(page);
      this.logger.log('📄 HTML parcial:');
      console.log((await page.content()).slice(0, 1000));
      this.logger.log('📍 URL atual:', page.url());
      page.on('response', (res) => {
        if (res.status() === 403) {
          console.log('🚫 403 detectado:', res.url());
        }
      });

      // Substitui a espera direta pelo retry para o inputSelector
      this.logger.log(
        '🔍 Identificando campo de entrada do número do processo...',
      );
      const inputSelector = '#nrProcessoInput'; // Atualizado para usar o ID correto
      await this.waitForSelectorWithRetry(page, inputSelector);

      // Simula digitação natural do número do processo
      for (const char of processNumber) {
        await page.type(inputSelector, char);
        await this.delay(100 + Math.random() * 100); // Pausa aleatória entre 100ms e 300ms
      }

      this.logger.log(
        `✅ Número do processo ${processNumber} inserido no campo de forma natural.`,
      );

      // Submete o formulário
      const submitButtonSelector = '#btnPesquisar';
      this.logger.log('🖱 Clicando no botão de submit...');
      await page.waitForSelector(submitButtonSelector, { visible: true });
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click(submitButtonSelector),
      ]);
      this.logger.log('✅ Formulário enviado com sucesso.');

      // Verifica se o painel de escolha de processos existe
      this.logger.log(
        '🔍 Verificando se o painel de escolha de processos está presente...',
      );
      const panelSelector = '#painel-escolha-processo';
      const panelExists = await page.$(panelSelector);
      let multipleInstances: boolean = false;
      if (panelExists) {
        this.logger.log('🔍 Painel de escolha de processos encontrado.');

        const instanceButtonSelector = `button.selecao-processo`;
        this.logger.log(
          `🔍 Aguardando os botões com o seletor: ${instanceButtonSelector}`,
        );
        await page
          .waitForSelector(instanceButtonSelector, {
            visible: true,
            timeout: 5000,
          })
          .catch(() => {
            this.logger.log(
              `⚠️ Nenhum botão encontrado com o seletor: ${instanceButtonSelector}`,
            );
          });

        const buttons = await page.$$(instanceButtonSelector);
        this.logger.log(`🔍 Botões encontrados: ${buttons.length}`);

        let instanceButton: any = null;
        console.log(`🔍 Botões encontrados: ${buttons.length}`);
        multipleInstances = buttons.length > 1;
        for (const button of buttons) {
          const buttonText = await page.evaluate(
            (el) => el.textContent?.split('\n')[0].trim(), // Considera apenas o texto antes da quebra de linha
            button,
          );
          this.logger.log(
            `🔍 Texto inicial do botão encontrado: [${buttonText}]`,
          );
          if (buttonText?.startsWith(`${instance}° Grau`)) {
            instanceButton = button;
            break;
          }
        }

        if (instanceButton) {
          this.logger.log(`🖱 Selecionando a instância: ${instance}° Grau...`);
          await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle0' }),
            page.evaluate((button) => {
              if (button instanceof HTMLElement) {
                button.click();
                console.log('✅ Clique executado no botão.');
              } else {
                console.log('⚠️ O elemento não é um HTMLElement.');
              }
            }, instanceButton),
          ]);
          this.logger.log(
            `✅ Instância ${instance}° Grau selecionada com sucesso.`,
          );
        } else {
          this.logger.log(
            `⚠️ Não foi possível encontrar o botão para a instância ${instance}° Grau.`,
          );
        }

        // Verifica se a navegação após a seleção da instância foi concluída
        this.logger.log(
          '🔍 Verificando se a página foi carregada após a seleção da instância...',
        );
        await this.delay(2000); // Aguarda um tempo para garantir o carregamento

        // Aguarda o carregamento do captcha após a seleção da instância
        const captchaSelector = '#imagemCaptcha';
        this.logger.log('🔍 Aguardando o carregamento do captcha...');
        await page
          .waitForSelector(captchaSelector, { visible: true, timeout: 10000 })
          .catch(() => {
            this.logger.log(
              '⚠️ O captcha não foi carregado após a seleção da instância.',
            );
          });

        const captchaElement = await page.$(captchaSelector);
        if (captchaElement) {
          this.logger.log('🔍 Captcha detectado na página.');

          // Obtém a imagem do captcha
          const captchaImage = await page.evaluate((el) => {
            return el.getAttribute('src');
          }, captchaElement);

          if (captchaImage) {
            this.logger.log('🔍 Resolvendo o captcha...');
            const captchaResponse =
              await this.captchaService.resolveCaptcha(captchaImage);

            if (captchaResponse?.resposta) {
              this.logger.log('✅ Captcha resolvido com sucesso.');

              // Insere a resposta do captcha no campo correspondente
              const captchaInputSelector = '#captchaInput';
              await page.type(captchaInputSelector, captchaResponse.resposta);

              // Submete o captcha
              const captchaSubmitSelector = '#btnEnviar';
              await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle0' }),
                page.click(captchaSubmitSelector),
              ]);
              this.logger.log('✅ Captcha submetido com sucesso.');
            } else {
              this.logger.log('⚠️ Falha ao resolver o captcha.');
            }
          }
        } else {
          this.logger.log(
            '⚠️ Captcha não detectado na página. Verifique o seletor ou o carregamento da página.',
          );
        }
      } else {
        this.logger.log(
          'ℹ️ Painel de escolha de processos não encontrado. Prosseguindo para a próxima etapa.',
        );
      }

      // Adiciona listeners para capturar requisições e respostas
      this.logger.log(
        '🔍 Adicionando listeners para capturar requisições e respostas...',
      );

      // Listener para requisições
      page.on('request', (request) => {
        const url = request.url();
        if (url.includes('/api/processos/dadosbasicos/')) {
          this.logger.log(`🔍 Requisição capturada: ${url}`);
          this.logger.log(`🔍 Método: ${request.method()}`);
        }
      });

      // Variável para armazenar o ID da resposta anterior
      let previousId: string | null = null;

      // Listener para respostas (captura o ID da resposta anterior e cancela novas requisições após extração)
      page.on('response', (response) => {
        const url = response.url();
        if (url.includes('/api/processos/dadosbasicos/') && !previousId) {
          void (async () => {
            this.logger.log(`🔍 Resposta capturada: ${url}`);
            this.logger.log(`🔍 Status: ${response.status()}`);
            try {
              const responseBody = await response.text();
              this.logger.log(`🔍 Corpo da resposta: ${responseBody}`);

              // Verifica se o corpo da resposta é uma string antes de fazer JSON.parse
              const data: unknown =
                typeof responseBody === 'string'
                  ? JSON.parse(responseBody)
                  : responseBody;

              // Tenta extrair o ID da resposta
              const isProcessoDadosBasicos = (
                obj: unknown,
              ): obj is { id: number } => {
                return (
                  typeof obj === 'object' &&
                  obj !== null &&
                  'id' in obj &&
                  typeof (obj as Record<string, unknown>).id === 'number'
                );
              };

              if (
                Array.isArray(data) &&
                data.length > 0 &&
                isProcessoDadosBasicos(data[0])
              ) {
                previousId = data[0].id.toString();
                this.logger.log(`🔍 ID extraído: ${previousId}`);
              } else {
                this.logger.log('⚠️ Estrutura inesperada na resposta.');
              }
            } catch (err) {
              this.logger.log(`⚠️ Erro ao obter o corpo da resposta: ${err}`);
            }
          })();
        }
      });
      const extractedData = await new Promise<ProcessosResponse>((resolve) => {
        const handler = (response: import('puppeteer').HTTPResponse): void => {
          void (async () => {
            const url = response.url();
            if (previousId && url.includes(`/api/processos/${previousId}`)) {
              this.logger.log(`🔍 Resposta subsequente capturada: ${url}`);
              this.logger.log(`🔍 Status: ${response.status()}`);

              const headers = response.headers();
              const contentType = headers['content-type'];
              if (contentType && contentType.includes('application/pdf')) {
                this.logger.log(
                  '⚠️ Resposta ignorada: Tipo de conteúdo é PDF.',
                );
                return;
              }

              // Captura o tokenCaptcha dos headers
              const tokenCaptcha = headers['captchatoken'];
              if (tokenCaptcha) {
                this.logger.log(`🔑 TokenCaptcha capturado: ${tokenCaptcha}`);

                // Armazena o tokenCaptcha no Redis
                const redisKey = `tokencaptcha:${processNumber}:${instance}`;
                await this.redis.set(redisKey, tokenCaptcha, 'EX', 3600);
                this.logger.log(
                  `✅ TokenCaptcha armazenado no Redis com a chave: ${redisKey}`,
                );
              }

              try {
                const responseJson =
                  (await response.json()) as ProcessosResponse;
                if (
                  typeof responseJson === 'object' &&
                  responseJson !== null &&
                  'id' in responseJson &&
                  'numero' in responseJson &&
                  'classe' in responseJson &&
                  'poloAtivo' in responseJson
                ) {
                  page.off('response', handler);

                  resolve(responseJson);
                }
              } catch (err) {
                this.logger.log(`⚠️ Erro ao processar a resposta: ${err}`);
              }
            }

            // Captura o tokenDesafio da URL da resposta subsequente
            const tokenDesafioMatch = url.match(/tokenDesafio=([^&]+)/);
            const tokenDesafio = tokenDesafioMatch
              ? tokenDesafioMatch[1]
              : null;
            if (tokenDesafio) {
              this.logger.log(`🔑 TokenDesafio capturado: ${tokenDesafio}`);
            }
          })();
        };

        page.on('response', handler);
      });
      await page.waitForNetworkIdle({ idleTime: 500 }).catch(() => {});
      // Finaliza a extensão (fecha a página e o contexto do navegador)

      return { data: extractedData, multipleInstances };
    } finally {
      // 3. O PULO DO GATO: Fechar a página antes de liberar o contexto
      if (page) await page.close().catch(() => {});

      // 4. Libera o contexto para o próximo job da fila
      this.pool.release(context);
      this.logger.log('✅ Contexto liberado e aba fechada');
    }
  }
  private async detectBlock(page: Page): Promise<void> {
    const html = await page.content();
    const url = page.url();

    if (
      html.includes('awswaf') ||
      html.includes('Access Denied') ||
      url.includes('error') ||
      url.includes('blocked')
    ) {
      throw new Error('🚫 BLOQUEADO (WAF)');
    }

    // 🔥 verifica se o body está vazio ou estranho
    const bodyLength = html.length;

    if (bodyLength < 5000) {
      const screenshotPath =
        `screenshots/block-detected-${Date.now()}.png` as `${string}.png`;
      const screenshotBuffer = await page.screenshot({ path: screenshotPath });
      await this.awsS3Service.uploadS3Object(
        process.env.AWS_S3_BUCKET_NAME as string,
        screenshotPath,
        screenshotBuffer,
        'application/png',
      );
      this.logger.log(`📸 Captura de tela salva em: ${screenshotPath}`);

      throw new Error('🚫 HTML suspeito (provável bloqueio)');
    }
  }

  private async delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Função auxiliar para realizar o retry
  private async waitForSelectorWithRetry(
    page: import('puppeteer').Page,
    selector: string,
    maxRetries: number = 5,
    delayMs: number = 1000,
  ): Promise<void> {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        this.logger.log(
          `🔍 Tentativa ${attempt} de ${maxRetries} para encontrar o seletor: ${selector}`,
        );

        // Verifica se o seletor existe no DOM antes de esperar por visibilidade
        const exists = await page.evaluate((sel) => {
          return !!document.querySelector(sel);
        }, selector);

        if (!exists) {
          this.logger.warn(
            `⚠️ Seletor ${selector} não encontrado no DOM na tentativa ${attempt}.`,
          );
          throw new Error(`Seletor ${selector} não encontrado no DOM.`);
        }

        await page.waitForSelector(selector, {
          visible: true,
          timeout: delayMs,
        });

        this.logger.log(`✅ Seletor encontrado: ${selector}`);
        return;
      } catch (err: unknown) {
        const errorMessage =
          err instanceof Error ? err.message : 'Erro desconhecido';
        this.logger.warn(
          `⚠️ Tentativa ${attempt} falhou para o seletor: ${selector}. Erro: ${errorMessage}`,
        );
        if (attempt === maxRetries) {
          throw new Error(
            `❌ Não foi possível encontrar o seletor: ${selector} após ${maxRetries} tentativas.`,
          );
        }
        await this.delay(delayMs); // Aguarda antes de tentar novamente
      }
    }
  }
}
