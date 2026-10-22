import { ItensProcesso, ProcessosResponse } from 'src/interfaces';
import { BloqueioTemporarioError } from './fetch-documents-url.service';
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

// `bloqueado(n)` decide, pela ordem da chamada, se o PJe responde com o
// bloqueio do WAF (403/html) — simula a janela de bloqueio do TRT3.
function montar(bloqueado: (chamada: number) => boolean) {
  let chamadas = 0;
  const fetchDocumento = jest.fn(() => {
    chamadas += 1;
    if (bloqueado(chamadas)) {
      return Promise.reject(
        new BloqueioTemporarioError('HTTP 403 (bloqueio do WAF)'),
      );
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
  return { service, fetchDocumento, esperas };
}

const baixados = (r: ProcessosResponse[]) =>
  (r[0] as unknown as { documentos: unknown[] }).documentos.length;

describe('ProcessDocumentsFindService — bloqueio do WAF nos downloads restritos', () => {
  it('adia os bloqueados e baixa todos depois da pausa', async () => {
    // Bloqueio da 4ª à 6ª chamada (as em voo); depois da pausa, o tribunal libera.
    const { service, esperas } = montar((n) => n >= 4 && n <= 6);

    const resultado = await service.execute(CNJ, [instancia(10)], 3);

    expect(baixados(resultado)).toBe(10);
    expect(esperas).toContain(60_000);
    expect(esperas).not.toContain(120_000);
  });

  it('não insiste no tribunal durante o bloqueio', async () => {
    // Bloqueado a partir da 3ª chamada até o fim da 1ª passada.
    const { service, fetchDocumento } = montar((n) => n >= 3 && n <= 5);

    await service.execute(CNJ, [instancia(20)], 3);

    // 20 downloads + no máximo as chamadas que já estavam em voo quando o
    // bloqueio começou (concorrência 3); os outros esperam a pausa.
    expect(fetchDocumento.mock.calls.length).toBeLessThanOrEqual(20 + 3);
  });

  it('bloqueio persistente: duas rodadas e segue sem os bloqueados', async () => {
    const { service, esperas } = montar((n) => n >= 3);

    const resultado = await service.execute(CNJ, [instancia(10)], 3);

    expect(esperas).toEqual(expect.arrayContaining([60_000, 120_000]));
    expect(baixados(resultado)).toBe(2);
  });
});
