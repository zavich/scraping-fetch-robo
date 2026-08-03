import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

interface TwoCaptchaResultResponse {
  status: number;
  request: string; // texto do captcha ou mensagem ("CAPCHA_NOT_READY", etc)
}

interface LambdaCaptchaResponse {
  text: string;
  score: number;
}
export interface CaptchaResult {
  resposta: string;
}
@Injectable()
export class CaptchaService {
  private readonly logger = new Logger(CaptchaService.name);
  private readonly API_KEY = process.env.API_KEY_2CAPTCHA as string;
  private readonly LAMBDA_CAPTCHA_URL = process.env
    .LAMBDA_CAPTCHA_URL as string;
  private readonly LAMBDA_CAPTCHA_API_KEY = process.env
    .LAMBDA_CAPTCHA_API_KEY as string;
  private readonly LAMBDA_MIN_SCORE = 0.3;

  constructor(private readonly httpService: HttpService) {}

  async resolveCaptcha(image: string): Promise<CaptchaResult> {
    try {
      let imageFile = image;
      if (imageFile.startsWith('data:image')) {
        imageFile = imageFile.substring(imageFile.indexOf(',') + 1);
      }

      const { data } = await firstValueFrom(
        this.httpService.post<LambdaCaptchaResponse>(
          this.LAMBDA_CAPTCHA_URL,
          { image_b64: imageFile },
          {
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': this.LAMBDA_CAPTCHA_API_KEY,
            },
            timeout: 30000, // 30 segundos de timeout
          },
        ),
      );

      if (!data?.text) {
        this.logger.error(
          `Lambda de captcha não retornou resposta válida: ${JSON.stringify(data)}`,
        );
        return {} as CaptchaResult;
      }

      if (data.score < this.LAMBDA_MIN_SCORE) {
        this.logger.warn(
          `Captcha resolvido com baixa confiança (score: ${data.score})`,
        );
      } else {
        this.logger.log(
          `Captcha resolvido com sucesso! (score: ${data.score})`,
        );
      }

      return { resposta: data.text };
    } catch (error) {
      this.logger.error('Erro no método resolveCaptcha', error);
      return {} as CaptchaResult;
    }
  }
  async getBalance(): Promise<number> {
    try {
      // const response = await axios.get('https://2captcha.com/res.php', {
      //   params: {
      //     key: this.apiKey,
      //     action: 'getbalance',
      //     json: 1,
      //   },
      // });
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

    const createTaskResult = await createTaskResp.json();

    if (createTaskResult.errorId !== 0) {
      throw new Error(
        `Erro ao criar task 2Captcha: ${createTaskResult.errorCode} - ${createTaskResult.errorDescription}`,
      );
    }

    const taskId = createTaskResult.taskId;
    this.logger.log(`📡 Task criada no 2Captcha com ID: ${taskId}`);

    // 2️⃣ Esperar até o CAPTCHA ser resolvido
    let result;
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

      result = await checkResp.json();

      if (result.status === 'ready') break;

      this.logger.log(`⏳ Aguardando resposta... (${attempt + 1}/40)`);
    }

    if (!result || result.status !== 'ready') {
      throw new Error('Tempo limite atingido aguardando resolução do CAPTCHA');
    }

    this.logger.log('✅ CAPTCHA AWS WAF resolvido com sucesso!');
    this.logger.debug('🧾 Resultado:', result.solution);

    // 3️⃣ Extrair o cookie de resposta
    const { captcha_voucher, existing_token } = result.solution;

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

    const createTaskResult = await createTaskResp.json();

    if (createTaskResult.errorId !== 0) {
      throw new Error(
        `Erro ao criar GridTask no 2Captcha: ${createTaskResult.errorCode} - ${createTaskResult.errorDescription}`,
      );
    }

    const taskId = createTaskResult.taskId;
    this.logger.log(`📡 GridTask criada no 2Captcha com ID: ${taskId}`);

    let result;
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

      result = await checkResp.json();

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
