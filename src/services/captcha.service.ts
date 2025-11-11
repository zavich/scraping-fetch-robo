import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

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

  constructor(private readonly httpService: HttpService) {}

  private sleep(ms: number) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async resolveCaptcha(image: string): Promise<CaptchaResult> {
    try {
      let imageFile = image;
      if (imageFile.startsWith('data:image')) {
        imageFile = imageFile.substring(imageFile.indexOf(',') + 1);
      }

      // Envia para 2captcha
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
        this.logger.error(
          'Erro ao enviar captcha: ' + sendResponse.data.request,
        );
        return {} as CaptchaResult;
      }

      const captchaId = sendResponse.data.request;
      this.logger.log(`Captcha enviado para resolução. ID: ${captchaId}`);

      // Timeout para o loop (exemplo: 2 minutos)
      const timeoutMs = 2 * 60 * 1000;
      const startTime = Date.now();

      while (true) {
        if (Date.now() - startTime > timeoutMs) {
          this.logger.error('Timeout aguardando resposta do captcha');
          return {} as CaptchaResult;
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
          this.logger.error('Erro na resolução do captcha: ' + data.request);
          return {} as CaptchaResult;
        }
        // Se CAPCHA_NOT_READY, continua no loop
      }
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
}
