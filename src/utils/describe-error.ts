import axios from 'axios';

/**
 * Descrição de um erro segura para log.
 *
 * Logar o `AxiosError` inteiro serializa `config` e a requisição: headers
 * (`x-service-key` do webhook, `Authorization`, cookie com `aws-waf-token`)
 * e `params` (a key do 2Captcha). Visto no CloudWatch em 23/11/2026: a
 * `x-service-key` do webhook em texto puro a cada webhook que falhava.
 *
 * Para erro do axios, fica só método, URL sem query string, status e code.
 */
export function descreverErro(error: unknown): string {
  if (axios.isAxiosError(error)) {
    const requisicao = [
      error.config?.method?.toUpperCase(),
      error.config?.url?.split('?')[0],
    ]
      .filter(Boolean)
      .join(' ');
    const status = error.response?.status ?? 'sem status';
    const code = error.code ? ` ${error.code}` : '';
    return `AxiosError${code} (HTTP ${status}) ${requisicao}: ${error.message}`;
  }
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}
