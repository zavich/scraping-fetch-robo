import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { descreverErro } from 'src/utils/describe-error';

@Injectable()
export class ReCaptchaService {
  private readonly logger = new Logger(ReCaptchaService.name);
  private readonly apiKey = process.env.API_KEY_2CAPTCHA;

  /**
   * Método para resolver captcha de imagem (CNDT / image-based)
   */
  async solveImageCaptcha(imageBuffer: Buffer): Promise<string> {
    try {
      this.logger.debug(`Enviando captcha de imagem para 2Captcha`);

      const base64 = imageBuffer.toString('base64');

      const sendResponse = await axios.post(
        `http://2captcha.com/in.php`,
        null,
        {
          params: {
            key: this.apiKey,
            method: 'base64',
            body: base64,
            json: 1,
          },
        },
      );

      if (!sendResponse.data || sendResponse.data.status !== 1) {
        throw new Error(
          `Erro ao enviar captcha: ${JSON.stringify(sendResponse.data)}`,
        );
      }

      const captchaId = sendResponse.data.request;

      let result: string | null = null;
      while (!result) {
        await new Promise((r) => setTimeout(r, 5000));
        const res = await axios.get(
          `http://2captcha.com/res.php?key=${this.apiKey}&action=get&id=${captchaId}&json=1`,
        );

        if (res.data.status === 1) {
          result = res.data.request;
        } else if (res.data.request !== 'CAPCHA_NOT_READY') {
          throw new Error(`Erro no 2Captcha: ${res.data.request}`);
        }
      }

      this.logger.debug(`Captcha de imagem resolvido: ${result}`);
      return result;
    } catch (error) {
      this.logger.error(
        'Erro ao resolver captcha de imagem via 2Captcha',
        error,
      );
      throw error;
    }
  }
  async solve2Captcha(
    siteKey: string,
    pageUrl: string,
    type: 'recaptcha' | 'hcaptcha' = 'recaptcha', // default reCAPTCHA
  ): Promise<string> {
    try {
      this.logger.debug(
        `Resolvendo captcha [${type}] para siteKey: ${siteKey} na URL: ${pageUrl}`,
      );

      // define o método de acordo com o tipo
      const method = type === 'hcaptcha' ? 'hcaptcha' : 'userrecaptcha';
      const keyParam = type === 'hcaptcha' ? 'sitekey' : 'googlekey';

      // 1️⃣ Envia captcha para 2Captcha
      const sendResponse = await axios.get(
        `http://2captcha.com/in.php?key=${this.apiKey}&method=${method}&${keyParam}=${siteKey}&pageurl=${pageUrl}&json=1`,
      );

      if (!sendResponse.data || sendResponse.data.status !== 1) {
        this.logger.error(
          `Erro ao enviar captcha: ${JSON.stringify(sendResponse.data)}`,
        );
        throw new Error('Erro ao enviar captcha para 2Captcha');
      }

      const captchaId = sendResponse.data.request;

      // 2️⃣ Espera a resolução
      let result: string | null = null;
      while (!result) {
        await new Promise((r) => setTimeout(r, 10000)); // espera 10s
        const res = await axios.get(
          `http://2captcha.com/res.php?key=${this.apiKey}&action=get&id=${captchaId}&json=1`,
        );

        if (res.data.status === 1) {
          result = res.data.request;
        } else if (res.data.request !== 'CAPCHA_NOT_READY') {
          throw new Error(`Erro no 2Captcha: ${res.data.request}`);
        }
      }

      this.logger.debug(`Captcha resolvido com sucesso`);
      return result; // token que você insere no form
    } catch (error) {
      this.logger.error(
        `Erro ao resolver captcha via 2Captcha: ${descreverErro(error)}`,
      );
      throw error;
    }
  }
}
