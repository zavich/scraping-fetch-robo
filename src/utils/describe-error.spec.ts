import { AxiosError, AxiosHeaders } from 'axios';
import { descreverErro } from './describe-error';

describe('descreverErro', () => {
  it('erro do axios: sem headers, sem params e sem query string', () => {
    const erro = new AxiosError(
      'getaddrinfo ENOTFOUND webhook.invalid',
      'ENOTFOUND',
      {
        method: 'post',
        url: 'https://webhook.invalid/hook?token=segredo-na-query',
        headers: new AxiosHeaders({ 'x-service-key': 'segredo-no-header' }),
        params: { key: 'segredo-no-param' },
      },
    );

    const texto = descreverErro(erro);

    expect(texto).toBe(
      'AxiosError ENOTFOUND (HTTP sem status) POST https://webhook.invalid/hook: getaddrinfo ENOTFOUND webhook.invalid',
    );
    expect(texto).not.toContain('segredo');
  });

  it('erro do axios com resposta: inclui o status', () => {
    const erro = new AxiosError('Request failed with status code 403');
    erro.config = { headers: new AxiosHeaders(), method: 'get', url: '/x' };
    erro.response = {
      status: 403,
      statusText: 'Forbidden',
      data: '',
      headers: {},
      config: erro.config,
    };

    expect(descreverErro(erro)).toContain('(HTTP 403) GET /x');
  });

  it('Error comum: mantém o stack', () => {
    const erro = new Error('falhou');
    expect(descreverErro(erro)).toBe(erro.stack);
  });

  it('valor que não é Error vira string', () => {
    expect(descreverErro('motivo')).toBe('motivo');
  });
});
