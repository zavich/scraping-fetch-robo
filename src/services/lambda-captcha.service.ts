import { HttpService } from '@nestjs/axios';
import { Injectable, Logger } from '@nestjs/common';
import { firstValueFrom } from 'rxjs';

export interface LambdaCaptchaResponse {
  text: string;
  score: number;
}

@Injectable()
export class LambdaCaptchaService {
  private readonly logger = new Logger(LambdaCaptchaService.name);
  private readonly LAMBDA_URL = process.env.LAMBDA_CAPTCHA_URL as string;
  private readonly API_KEY = process.env.LAMBDA_CAPTCHA_API_KEY as string;
  private readonly USE_LAMBDA = process.env.USE_LAMBDA_CAPTCHA === 'true';

  constructor(private readonly httpService: HttpService) {
    if (this.USE_LAMBDA) {
      if (!this.LAMBDA_URL) {
        this.logger.warn(
          'LAMBDA_CAPTCHA_URL não configurada nas variáveis de ambiente',
        );
      }
      if (!this.API_KEY) {
        this.logger.warn(
          'LAMBDA_CAPTCHA_API_KEY não configurada nas variáveis de ambiente',
        );
      }
    }
  }

  /**
   * Resolve captcha enviando a imagem em base64 para o Lambda AWS
   * @param imageBase64 Imagem em formato base64 (PNG)
   * @returns Resposta com o texto extraído e score de confiança
   */
  async resolveCaptcha(imageBase64: string): Promise<LambdaCaptchaResponse> {
    try {
      let image = imageBase64;

      // Remove o prefixo data:image/... se existir
      if (image.startsWith('data:image')) {
        image = image.substring(image.indexOf(',') + 1);
      }

      this.logger.log('Enviando captcha para resolução no Lambda AWS');

      const response = await firstValueFrom(
        this.httpService.post<LambdaCaptchaResponse>(
          this.LAMBDA_URL,
          {
            image_b64: image,
          },
          {
            headers: {
              'x-api-key': this.API_KEY,
              'Content-Type': 'application/json',
            },
            timeout: 30000, // 30 segundos de timeout
          },
        ),
      );

      if (
        !response.data ||
        !response.data.text ||
        response.data.score === undefined
      ) {
        throw new Error(
          'Resposta inválida do Lambda: ausência de campos obrigatórios',
        );
      }

      this.logger.log(
        `Captcha resolvido com sucesso. Score: ${response.data.score}`,
      );

      return response.data;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Erro desconhecido';
      this.logger.error('Erro ao resolver captcha no Lambda AWS', message);
      throw new Error(`Falha na resolução do captcha: ${message}`);
    }
  }
}
