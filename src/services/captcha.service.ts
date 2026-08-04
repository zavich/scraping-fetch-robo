import { HttpService } from '@nestjs/axios';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';
import { LambdaCaptchaService } from './lambda-captcha.service';

// Interfaces globais para tipagem
interface CreateTaskResponse {
  errorId: number;
  errorCode?: string;
  errorDescription?: string;
  taskId?: string;
}

interface TaskResult {
  status: string;
  solution?: {
    captcha_voucher?: string;
    existing_token?: string;
  };
}

interface GridTaskResult {
  status: string;
  solution?: {
    click?: unknown;
    data?: unknown;
  };
}

interface TwoCaptchaSendResponse {
  status: number;
  request: string; // pode ser id ou mensagem de erro
}

interface TwoCaptchaResultResponse {
  status: number;
  request: string; // texto do captcha ou mensagem ("CAPCHA_NOT_READY", etc)
}
export interface CaptchaResult {
  resposta: string;
}
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);
  private readonly API_KEY = process.env.API_KEY_2CAPTCHA as string;
  private readonly USE_LAMBDA = process.env.USE_LAMBDA_CAPTCHA === 'true';

  constructor(
    private readonly httpService: HttpService,
    @Optional() private readonly lambdaCaptchaService?: LambdaCaptchaService,
  ) {}

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async resolveCaptcha(
    image: string,
    regionTRT?: number,
  ): Promise<CaptchaResult> {
    try {
      let imageFile = image;
      if (imageFile.startsWith('data:image')) {
        imageFile = imageFile.substring(imageFile.indexOf(',') + 1);
      }

      // 🔄 NOVO: Usar Lambda como backend principal (exceto TRT3)
      const useLambda = !!(
        this.USE_LAMBDA &&
        this.lambdaCaptchaService &&
        regionTRT !== 3
      );

      this.logger.debug(
        `CaptchaService Debug: USE_LAMBDA=${this.USE_LAMBDA}, lambdaCaptchaService=${this.lambdaCaptchaService ? 'OK' : 'null'}, regionTRT=${regionTRT}, useLambda=${useLambda}`,
      );

      if (useLambda) {
        this.logger.log(
          `📡 Usando Lambda AWS para resolver captcha (TRT${regionTRT})`,
        );
        try {
          const lambdaResult =
            await this.lambdaCaptchaService.resolveCaptcha(imageFile);
          return {
            resposta: lambdaResult.text,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : 'Erro desconhecido';
          this.logger.warn(
            `Falha ao usar Lambda, tentando fallback 2Captcha... ${message}`,
          );
          // Continua com 2Captcha como fallback
        }
      } else {
        this.logger.debug(
          `TRT${regionTRT}: Pulando Lambda, usando 2Captcha direto`,
        );
      }

      // ⏮️ FALLBACK: Usar 2Captcha
      if (!this.API_KEY) {
        throw new Error(
          'API_KEY_2CAPTCHA não configurada nas variáveis de ambiente',
        );
      }
      this.logger.log('🔄 Utilizando 2Captcha para resolver captcha');
      const sendResponse = await firstValueFrom(
        this.httpService.post<TwoCaptchaSendResponse>(
          'https://2captcha.com/in.php',
          new URLSearchParams({
            key: this.API_KEY,
            method: 'base64',
            body: imageFile,
            json: '1',
          }).toString(),
          {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          },
        ),
      );

      if (sendResponse.data.status !== 1) {
        throw new Error(
          'Erro ao enviar captcha ao 2Captcha: ' + sendResponse.data.request,
        );
      }

      const captchaId = sendResponse.data.request;
      this.logger.log(`Captcha enviado para resolução. ID: ${captchaId}`);

      // Timeout para o loop (exemplo: 2 minutos)
      const timeoutMs = 2 * 60 * 1000;
      const startTime = Date.now();

      while (true) {
        if (Date.now() - startTime > timeoutMs) {
          throw new Error(
            'Timeout aguardando resposta do 2Captcha (2 minutos)',
          );
        }

        this.logger.log(
          'Aguardando 10 segundos para verificar resposta do captcha...',
        );
        await this.sleep(10000);

        const checkResponse = await firstValueFrom(
          this.httpService.get<TwoCaptchaResultResponse>(
            'https://2captcha.com/res.php',
            {
              params: {
                key: this.API_KEY,
                action: 'get',
                id: captchaId,
                json: 1,
              },
            },
          ),
        );

        const data = checkResponse.data;
        this.logger.log('Status do captcha: ' + JSON.stringify(data));

        if (data.status === 1) {
          this.logger.log('Captcha resolvido com sucesso!');
          return {
            resposta: data.request,
          };
        } else if (data.request !== 'CAPCHA_NOT_READY') {
          throw new Error(
            'Erro na resolução do captcha pelo 2Captcha: ' + data.request,
          );
        }
        // Se CAPCHA_NOT_READY, continua no loop
      }
    } catch (error) {
      this.logger.error('Erro no método resolveCaptcha', error);
      throw error;
    }
  }
  async getBalance(): Promise<number> {
    try {
      const response = await firstValueFrom(
        this.httpService.get<TwoCaptchaResultResponse>(
          'https://2captcha.com/res.php',
          {
            params: {
              key: this.API_KEY,
              action: 'getbalance',
              json: 1,
            },
          },
        ),
      );
      if (response.data.status === 1) {
        return parseFloat(response.data.request);
      } else {
        this.logger.warn(`Erro ao consultar saldo: ${response.data.request}`);
        return 0;
      }
    } catch (error) {
      this.logger.error('Falha ao consultar saldo no 2Captcha:', error);
      return 0;
    }
  }
  async resolveAwsWaf({
    websiteURL,
    websiteKey,
    context,
    iv,
    challengeScript,
    captchaScript,
  }: {
    websiteURL: string;
    websiteKey: string;
    context: string;
    iv: string;
    challengeScript: string;
    captchaScript: string;
  }) {
    this.logger.log(`🧩 Iniciando resolução do AWS WAF em: ${websiteURL}`);

    // 1️⃣ Criar task no 2Captcha
    const createTaskResp = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: this.API_KEY,
        task: {
          type: 'AmazonTaskProxyless',
          websiteURL,
          websiteKey,
          iv,
          context,
          challengeScript,
          captchaScript,
        },
      }),
    });

    const createTaskResult =
      (await createTaskResp.json()) as CreateTaskResponse;

    if (createTaskResult.errorId !== 0) {
      throw new Error(
        `Erro ao criar task 2Captcha: ${createTaskResult.errorCode} - ${createTaskResult.errorDescription}`,
      );
    }

    const taskId = createTaskResult.taskId!;
    this.logger.log(`📡 Task criada no 2Captcha com ID: ${taskId}`);

    // 2️⃣ Esperar até o CAPTCHA ser resolvido
    let result: TaskResult = { status: '' };
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise((r) => setTimeout(r, 5000)); // espera 5s

      const checkResp = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: this.API_KEY,
          taskId,
        }),
      });

      try {
        result = (await checkResp.json()) as TaskResult;
      } catch (error) {
        this.logger.error(
          'Erro ao fazer parsing do JSON retornado pela API 2Captcha:',
          error,
        );
        this.logger.debug('Resposta inválida:', await checkResp.text());
        throw new Error('Resposta inválida da API 2Captcha');
      }

      if (result.status === 'ready') break;

      this.logger.log(`⏳ Aguardando resposta... (${attempt + 1}/40)`);
    }

    if (!result || result.status !== 'ready') {
      throw new Error('Tempo limite atingido aguardando resolução do CAPTCHA');
    }

    this.logger.log('✅ CAPTCHA AWS WAF resolvido com sucesso!');
    this.logger.debug('🧾 Resultado:', result.solution);

    // 3️⃣ Extrair o cookie de resposta
    const { captcha_voucher, existing_token } = result.solution || {};

    if (!captcha_voucher && !existing_token) {
      throw new Error('Não foi possível obter o token do AWS WAF');
    }

    return {
      existing_token,
      captcha_voucher,
    };
  }

  /**
   * Reconhece um grid de imagens (ex: "Choose all the hats") via GridTask do
   * 2Captcha — apenas classificação de imagem, sem envolver a AWS. Quem
   * clica de verdade e submete o /verify é o próprio browser (Puppeteer),
   * então o state/key/hmac_tag (e o client_ip) nascem vinculados à sessão
   * real, não à do 2Captcha.
   */
  async solveGridImage(
    imageBase64: string,
    instruction: string,
    rows: number,
    columns: number,
  ): Promise<number[]> {
    this.logger.log(
      `🖼️ Resolvendo grid via 2Captcha (GridTask): "${instruction}" (${rows}x${columns})`,
    );

    const createTaskResp = await fetch('https://api.2captcha.com/createTask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientKey: this.API_KEY,
        task: {
          type: 'GridTask',
          body: imageBase64,
          comment: instruction,
          rows,
          columns,
        },
      }),
    });

    const createTaskResult =
      (await createTaskResp.json()) as CreateTaskResponse;

    if (createTaskResult.errorId !== 0) {
      throw new Error(
        `Erro ao criar GridTask no 2Captcha: ${createTaskResult.errorCode} - ${createTaskResult.errorDescription}`,
      );
    }

    const taskId = createTaskResult.taskId!;
    this.logger.log(`📡 GridTask criada no 2Captcha com ID: ${taskId}`);

    let result: GridTaskResult = { status: '' };
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise((r) => setTimeout(r, 3000));

      const checkResp = await fetch('https://api.2captcha.com/getTaskResult', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientKey: this.API_KEY,
          taskId,
        }),
      });

      result = (await checkResp.json()) as GridTaskResult;

      if (result.status === 'ready') break;

      this.logger.log(
        `⏳ Aguardando resposta da GridTask... (${attempt + 1}/20)`,
      );
    }

    if (!result || result.status !== 'ready') {
      throw new Error('Tempo limite atingido aguardando resolução da GridTask');
    }

    this.logger.log(
      `🧾 Resultado GridTask: ${JSON.stringify(result.solution)}`,
    );

    const raw: unknown =
      result.solution?.click ?? result.solution?.data ?? result.solution ?? '';

    // O formato varia por tipo de task: às vezes vem um array de números
    // direto (ex: [2,3,4,6]), às vezes uma string tipo "click:2/3/4/6".
    // Aceita os dois pra não perder índices por causa do formato errado.
    const indices = Array.isArray(raw)
      ? raw.map((n) => Number(n)).filter((n) => !isNaN(n))
      : String(raw)
          .replace(/^click:/i, '')
          .split('/')
          .map((n) => parseInt(n, 10))
          .filter((n) => !isNaN(n));

    return indices;
  }
}
