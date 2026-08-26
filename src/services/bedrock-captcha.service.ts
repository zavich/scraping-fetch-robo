import { Injectable, Logger } from '@nestjs/common';
import { LambdaClient, InvokeCommand } from '@aws-sdk/client-lambda';

export interface BedrockGridResult {
  indices: number[];
  inputTokens: number;
  outputTokens: number;
}

interface RespostaLambda {
  statusCode: number;
  body: string;
}

interface CorpoLambda {
  indices?: number[];
  inputTokens?: number;
  outputTokens?: number;
  erro?: string;
}

// Resolve o grid de imagens do AWS WAF ("escolha todos os relógios") chamando
// o lambda `pje-waf-grid-solver`, que roda o Qwen3-VL no Bedrock — mesmo
// desenho dos outros lambdas do robô (pje-captcha-solver, extrator de
// documentos): a credencial do modelo fica no lambda, não aqui.
//
// Como a GridTask do 2Captcha, isto só CLASSIFICA a imagem — quem clica nas
// células e submete o /verify continua sendo o Puppeteer, então
// state/hmac_tag/client_ip seguem nascendo vinculados à sessão real do
// browser.
//
// A invocação é via SDK (IAM), não por Function URL: assim o endpoint não
// fica público e a autorização é a role/credencial do robô.
@Injectable()
export class BedrockCaptchaService {
  private readonly logger = new Logger(BedrockCaptchaService.name);
  private readonly ENABLED = process.env.USE_BEDROCK_CAPTCHA === 'true';
  private readonly FUNCTION_NAME =
    process.env.GRID_SOLVER_LAMBDA_NAME || 'pje-waf-grid-solver';
  // Reaproveita a região que o robô já usa pra AWS (mesma do bucket S3 e
  // do lambda) em vez de subir mais um secret só pra isso. Se um dia o
  // lambda for pra outra região, é aqui que precisa de env própria.
  private readonly REGION = process.env.AWS_S3_REGION as string;
  private readonly API_KEY = process.env.GRID_SOLVER_LAMBDA_API_KEY as string;
  private readonly X_API_KEY = process.env
    .GRID_SOLVER_LAMBDA_X_API_KEY as string;

  private client: LambdaClient | null = null;

  isEnabled(): boolean {
    if (this.ENABLED && !this.REGION) {
      // Falhar em silêncio aqui já custou um diagnóstico: sem a região o
      // serviço ficava desligado sem dizer por quê, e tudo caía no 2Captcha.
      this.logger.warn(
        '⚠️ USE_BEDROCK_CAPTCHA=true mas AWS_S3_REGION não foi definida — resolvedor de grid desligado',
      );
    }
    if (this.ENABLED && !this.API_KEY) {
      this.logger.warn(
        '⚠️ USE_BEDROCK_CAPTCHA=true mas GRID_SOLVER_LAMBDA_API_KEY não foi definida — resolvedor de grid desligado',
      );
    }
    if (this.ENABLED && !this.X_API_KEY) {
      this.logger.warn(
        '⚠️ USE_BEDROCK_CAPTCHA=true mas GRID_SOLVER_LAMBDA_X_API_KEY não foi definida — resolvedor de grid desligado',
      );
    }
    // As duas chaves são obrigatórias no lambda: sem uma delas toda
    // invocação volta 401, então é melhor nem habilitar.
    return this.ENABLED && !!this.REGION && !!this.API_KEY && !!this.X_API_KEY;
  }

  private getClient(): LambdaClient {
    if (!this.client) {
      if (!this.REGION) {
        throw new Error(
          'AWS_S3_REGION é obrigatório para o BedrockCaptchaService',
        );
      }
      // Credenciais saem da cadeia padrão da AWS — as mesmas já usadas pelo
      // @aws-sdk/client-s3 e client-cloudwatch, sem chave nova no .env.
      this.client = new LambdaClient({ region: this.REGION });
    }
    return this.client;
  }

  async solveGrid(
    imageBase64: string,
    instruction: string,
    rows: number,
    columns: number,
  ): Promise<BedrockGridResult> {
    const resposta = await this.getClient().send(
      new InvokeCommand({
        FunctionName: this.FUNCTION_NAME,
        Payload: Buffer.from(
          JSON.stringify({
            api_key: this.API_KEY,
            // Vai no payload porque a invocação é por SDK, que não tem
            // headers HTTP — o lambda aceita nos dois lugares.
            'x-api-key': this.X_API_KEY,
            image_b64: imageBase64,
            instruction,
            rows,
            columns,
          }),
        ),
      }),
    );

    if (resposta.FunctionError) {
      throw new Error(
        `Lambda ${this.FUNCTION_NAME} falhou: ${resposta.FunctionError}`,
      );
    }
    if (!resposta.Payload) {
      throw new Error(`Lambda ${this.FUNCTION_NAME} não devolveu payload`);
    }

    const rawPayload = Buffer.from(resposta.Payload).toString();

    let envelope: RespostaLambda;
    try {
      envelope = JSON.parse(rawPayload) as RespostaLambda;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const sample = rawPayload.slice(0, 500);
      throw new Error(
        `Lambda ${this.FUNCTION_NAME} devolveu payload inválido: ${message} — início do payload: ${sample}`,
      );
    }

    let corpo: CorpoLambda;
    try {
      corpo = JSON.parse(envelope.body) as CorpoLambda;
    } catch {
      corpo = { erro: envelope.body };
    }

    if (envelope.statusCode !== 200) {
      throw new Error(
        `Lambda ${this.FUNCTION_NAME} respondeu ${envelope.statusCode}: ${corpo.erro ?? 'erro desconhecido'}`,
      );
    }

    const indices = corpo.indices ?? [];
    const inputTokens = corpo.inputTokens ?? 0;
    const outputTokens = corpo.outputTokens ?? 0;

    // Os tokens são o equivalente ao `cost` que a API do 2Captcha devolve:
    // sem registrar isso não dá pra comparar os dois backends de verdade.
    this.logger.log(
      `🧠 Grid resolvido pelo ${this.FUNCTION_NAME}: ${indices.length} célula(s) — ` +
        `${inputTokens} tokens de entrada, ${outputTokens} de saída`,
    );

    return { indices, inputTokens, outputTokens };
  }
}
