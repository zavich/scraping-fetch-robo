import { ItensProcesso, ProcessosResponse } from 'src/interfaces';
import {
  BloqueioTemporarioError,
  DesafioAntiBotError,
} from './fetch-documents-url.service';
import { ProcessDocumentsFindService } from './process-documents-find.service';

const CNJ = '0010362-49.2026.5.03.0064';

function instancia(qtd: number): ProcessosResponse {
  const itensProcesso = Array.from(
    { length: qtd },
    (_, i) =>
      ({
        id: 1000 + i,
        idUnicoDocumento: `doc${i}`,
        titulo: `Documento ${i}`,
        data: '2026-07-10T17:24:29.210027',
        documento: true,
        publico: false,
      }) as unknown as ItensProcesso,
  );
  return {
    id: 3254956,
    instance: '1',
    itensProcesso,
  } as unknown as ProcessosResponse;
}

type Resposta = 'ok' | 'bloqueio' | 'desafio';

// `responder(n, tokensRenovados)` decide, pela ordem da chamada, o que o PJe
// devolve: o documento, o bloqueio do WAF (403/html) ou o desafio anti-bot
// expirado (405/html) — simula as janelas vistas no TRT3.
function montar(
  responder: (chamada: number, tokensRenovados: number) => Resposta,
) {
  let chamadas = 0;
  let tokensRenovados = 0;
  const scrapingService = {
    execute: jest.fn(() => {
      tokensRenovados += 1;
      return Promise.resolve();
    }),
  };
  const fetchDocumento = jest.fn(() => {
    chamadas += 1;
    const resposta = responder(chamadas, tokensRenovados);
    if (resposta === 'bloqueio') {
      return Promise.reject(
        new BloqueioTemporarioError('HTTP 403 (bloqueio do WAF)'),
      );
    }
    if (resposta === 'desafio') {
      return Promise.reject(new DesafioAntiBotError('HTTP 405 (desafio)'));
    }
    return Promise.resolve({
      buffer: Buffer.from('%PDF-1.4'),
      contentType: 'application/pdf',
    });
  });
  const service = new ProcessDocumentsFindService(
    { uploadS3Object: jest.fn().mockResolvedValue(undefined) } as never,
    { buildContext: jest.fn().mockResolvedValue({}), fetchDocumento } as never,
    { extractText: jest.fn().mockResolvedValue('texto') } as never,
    {} as never,
    scrapingService as never,
  );
  const esperas: number[] = [];
  jest
    .spyOn(
      service as unknown as { delay: (ms: number) => Promise<void> },
      'delay',
    )
    .mockImplementation((ms: number) => {
      esperas.push(ms);
      return Promise.resolve();
    });
  return { service, fetchDocumento, esperas, scrapingService };
}

const baixados = (r: ProcessosResponse[]) =>
  (r[0] as unknown as { documentos: unknown[] }).documentos.length;

describe('ProcessDocumentsFindService — bloqueio do WAF nos downloads restritos', () => {
  it('adia os bloqueados e baixa todos depois da pausa', async () => {
    // Bloqueio da 4ª à 6ª chamada (as em voo); depois da pausa, o tribunal libera.
    const { service, esperas } = montar((n) =>
      n >= 4 && n <= 6 ? 'bloqueio' : 'ok',
    );

    const resultado = await service.execute(CNJ, [instancia(10)], 3);

    expect(baixados(resultado)).toBe(10);
    expect(esperas).toContain(60_000);
    expect(esperas).not.toContain(120_000);
  });

  it('não insiste no tribunal durante o bloqueio', async () => {
    // Bloqueado a partir da 3ª chamada até o fim da 1ª passada.
    const { service, fetchDocumento } = montar((n) =>
      n >= 3 && n <= 5 ? 'bloqueio' : 'ok',
    );

    await service.execute(CNJ, [instancia(20)], 3);

    // 20 downloads + no máximo as chamadas que já estavam em voo quando o
    // bloqueio começou (concorrência 3); os outros esperam a pausa.
    expect(fetchDocumento.mock.calls.length).toBeLessThanOrEqual(20 + 3);
  });

  it('bloqueio persistente: duas rodadas e segue sem os bloqueados', async () => {
    const { service, esperas } = montar((n) => (n >= 3 ? 'bloqueio' : 'ok'));

    const resultado = await service.execute(CNJ, [instancia(10)], 3);

    expect(esperas).toEqual(expect.arrayContaining([60_000, 120_000]));
    expect(baixados(resultado)).toBe(2);
  });

  it('desafio expirado (405): renova o token e baixa o resto sem a pausa de 60s', async () => {
    // A partir da 5ª chamada o token expira; só volta a passar depois de renovado.
    const { service, esperas, scrapingService } = montar((n, renovados) =>
      n >= 5 && renovados === 0 ? 'desafio' : 'ok',
    );

    const resultado = await service.execute(CNJ, [instancia(12)], 3);

    expect(scrapingService.execute).toHaveBeenCalledTimes(1);
    expect(scrapingService.execute).toHaveBeenCalledWith(CNJ, 3, 1);
    expect(esperas).not.toContain(60_000);
    expect(baixados(resultado)).toBe(12);
  });

  it('desafio que não cede: renova nas duas rodadas e segue sem os recusados', async () => {
    const { service, scrapingService } = montar((n) =>
      n >= 3 ? 'desafio' : 'ok',
    );

    const resultado = await service.execute(CNJ, [instancia(8)], 3);

    expect(scrapingService.execute).toHaveBeenCalledTimes(2);
    expect(baixados(resultado)).toBe(2);
  });
});
