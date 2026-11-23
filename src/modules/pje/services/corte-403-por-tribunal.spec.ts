/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/unbound-method */
import { Logger } from '@nestjs/common';
import axios from 'axios';
import {
  Corte403PorTribunal,
  LIMIAR_403_SEGUIDOS,
} from './corte-403-por-tribunal';
import { FetchUrlMovimentService } from './fetch-url.service';

jest.mock('axios');

// Redis em memória com só o que o corte usa (sem expiração real).
function redisEmMemoria() {
  const dados = new Map<string, string>();
  return {
    dados,
    incr: jest.fn((k: string) => {
      const v = Number(dados.get(k) ?? 0) + 1;
      dados.set(k, String(v));
      return Promise.resolve(v);
    }),
    expire: jest.fn(() => Promise.resolve(1)),
    exists: jest.fn((k: string) => Promise.resolve(dados.has(k) ? 1 : 0)),
    set: jest.fn((k: string, v: string, ...opcoes: unknown[]) => {
      if (opcoes.includes('NX') && dados.has(k)) return Promise.resolve(null);
      dados.set(k, v);
      return Promise.resolve('OK');
    }),
    del: jest.fn((k: string) => Promise.resolve(dados.delete(k) ? 1 : 0)),
  };
}

const HOST = 'pje.trt1.jus.br';
const logger = new Logger('teste');

describe('Corte403PorTribunal', () => {
  it(`entra em corte com ${LIMIAR_403_SEGUIDOS} 403 seguidos`, async () => {
    const corte = new Corte403PorTribunal(redisEmMemoria() as never, logger);

    for (let i = 1; i < LIMIAR_403_SEGUIDOS; i++)
      await corte.registrar403(HOST);
    expect(await corte.emCorte(HOST)).toBe(false);

    await corte.registrar403(HOST);
    expect(await corte.emCorte(HOST)).toBe(true);
  });

  it('um sucesso zera a sequência e desfaz o corte', async () => {
    const corte = new Corte403PorTribunal(redisEmMemoria() as never, logger);
    for (let i = 0; i < LIMIAR_403_SEGUIDOS; i++)
      await corte.registrar403(HOST);

    await corte.registrarSucesso(HOST);

    expect(await corte.emCorte(HOST)).toBe(false);
    await corte.registrar403(HOST);
    expect(await corte.emCorte(HOST)).toBe(false);
  });

  it('o corte é por tribunal', async () => {
    const corte = new Corte403PorTribunal(redisEmMemoria() as never, logger);
    for (let i = 0; i < LIMIAR_403_SEGUIDOS; i++)
      await corte.registrar403(HOST);

    expect(await corte.emCorte('pje.trt2.jus.br')).toBe(false);
  });

  it('Redis fora do ar não derruba nada: segue sem corte', async () => {
    const quebrado = {
      incr: () => Promise.reject(new Error('down')),
      exists: () => Promise.reject(new Error('down')),
      del: () => Promise.reject(new Error('down')),
    };
    const corte = new Corte403PorTribunal(quebrado as never, logger);

    await expect(corte.registrar403(HOST)).resolves.toBeUndefined();
    await expect(corte.registrarSucesso(HOST)).resolves.toBeUndefined();
    expect(await corte.emCorte(HOST)).toBe(false);
  });
});

describe('FetchUrlMovimentService — novas tentativas de 403 com o corte', () => {
  const CNJ = '0100001-11.2025.5.01.0001';
  const URL_DADOS = `https://${HOST}/pje-consulta-api/api/processos/dadosbasicos/${CNJ}`;
  const erro403 = Object.assign(new Error('403'), {
    response: { status: 403 },
  });
  const erro429 = Object.assign(new Error('429'), {
    response: { status: 429 },
  });

  function montar() {
    const redis = redisEmMemoria();
    const svc = new FetchUrlMovimentService(
      {} as never,
      redis as never,
      {} as never,
    );
    jest
      .spyOn(
        svc as unknown as { delay: (ms: number) => Promise<void> },
        'delay',
      )
      .mockResolvedValue(undefined);
    const dadosBasicos = (
      svc as unknown as {
        fetchDadosBasicos: (
          u: string,
          h: object,
          n: string,
          i: number,
        ) => Promise<unknown>;
      }
    ).fetchDadosBasicos.bind(svc);
    return { redis, dadosBasicos };
  }

  beforeEach(() => (axios.get as jest.Mock).mockReset());

  it('sem corte: repete o 403 como sempre (5 tentativas)', async () => {
    const { dadosBasicos } = montar();
    (axios.get as jest.Mock).mockRejectedValue(erro403);

    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro403);
    expect(axios.get).toHaveBeenCalledTimes(5);
  });

  it('com o tribunal em corte: 1 tentativa só', async () => {
    const { dadosBasicos } = montar();
    (axios.get as jest.Mock).mockRejectedValue(erro403);
    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro403);
    (axios.get as jest.Mock).mockClear();

    // Próximo processo do mesmo tribunal: a sequência já passou do limiar.
    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro403);
    expect(axios.get).toHaveBeenCalledTimes(1);
  });

  it('em corte, a 1ª consulta ainda sai e, se passar, desfaz o corte', async () => {
    const { dadosBasicos, redis } = montar();
    (axios.get as jest.Mock).mockRejectedValue(erro403);
    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro403);
    expect(redis.dados.has(`corte403:${HOST}`)).toBe(true);

    (axios.get as jest.Mock).mockResolvedValueOnce({ data: [{ id: 1 }] });
    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).resolves.toEqual([
      { id: 1 },
    ]);
    expect(redis.dados.has(`corte403:${HOST}`)).toBe(false);
  });

  it('429 continua com as tentativas mesmo em corte', async () => {
    const { dadosBasicos } = montar();
    (axios.get as jest.Mock).mockRejectedValue(erro403);
    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro403);
    (axios.get as jest.Mock).mockReset().mockRejectedValue(erro429);

    await expect(dadosBasicos(URL_DADOS, {}, CNJ, 1)).rejects.toBe(erro429);
    expect(axios.get).toHaveBeenCalledTimes(5);
  });
});
