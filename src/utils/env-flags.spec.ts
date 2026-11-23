import { flagLigadaPorPadrao, usarBedrockCaptcha } from './env-flags';

describe('flagLigadaPorPadrao', () => {
  const NOME = 'FLAG_DE_TESTE';
  afterEach(() => delete process.env[NOME]);

  it('ausente: ligada', () => {
    expect(flagLigadaPorPadrao(NOME)).toBe(true);
  });

  it.each(['true', '', '1', 'qualquer'])('"%s": ligada', (valor) => {
    process.env[NOME] = valor;
    expect(flagLigadaPorPadrao(NOME)).toBe(true);
  });

  it.each(['false', 'FALSE', ' false '])('"%s": desligada', (valor) => {
    process.env[NOME] = valor;
    expect(flagLigadaPorPadrao(NOME)).toBe(false);
  });
});

describe('usarBedrockCaptcha', () => {
  const antes = process.env.USE_BEDROCK_CAPTCHA;
  afterEach(() => {
    if (antes === undefined) delete process.env.USE_BEDROCK_CAPTCHA;
    else process.env.USE_BEDROCK_CAPTCHA = antes;
  });

  it('sem a variável, o Bedrock fica ligado', () => {
    delete process.env.USE_BEDROCK_CAPTCHA;
    expect(usarBedrockCaptcha()).toBe(true);
  });
});
