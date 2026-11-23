/**
 * Flag de ambiente ligada por padrão: só desliga com o valor explícito
 * `'false'`. Ausente, vazia ou qualquer outro valor conta como ligada.
 */
export function flagLigadaPorPadrao(nome: string): boolean {
  return process.env[nome]?.trim().toLowerCase() !== 'false';
}

// O captcha de imagem (Lambda) e o grid do WAF (Lambda do Bedrock) são o
// caminho padrão; o 2Captcha não é mais usado em produção e só entra se
// alguém desligar uma das duas explicitamente.
export const usarLambdaCaptcha = (): boolean =>
  flagLigadaPorPadrao('USE_LAMBDA_CAPTCHA');
export const usarBedrockCaptcha = (): boolean =>
  flagLigadaPorPadrao('USE_BEDROCK_CAPTCHA');
