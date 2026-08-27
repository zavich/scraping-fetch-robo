import { BadRequestException } from '@nestjs/common';
import { BenchmarkDocumentoService } from './benchmark-documento.service';
import { ItensProcesso, ProcessosResponse } from 'src/interfaces';

const numero = '0001933-43.2015.5.11.0101';

const item = (over: Partial<ItensProcesso> = {}): ItensProcesso =>
  ({
    documento: true,
    id: 1,
    data: '2024-01-01',
    titulo: 'Petição Inicial',
    tipo: 'Petição',
    publico: false,
    idUnicoDocumento: 'uid-1',
    instancia: '1',
    instanciaId: 10,
    ...over,
  }) as ItensProcesso;

const instancia = (itens: ItensProcesso[]): ProcessosResponse =>
  ({ id: 99, instance: '1', itensProcesso: itens }) as ProcessosResponse;

describe('BenchmarkDocumentoService', () => {
  let fetchUrl: { execute: jest.Mock };
  let loginPool: { getCookies: jest.Mock };
  let processDocs: { execute: jest.Mock };
  let scraping: { execute: jest.Mock };
  let service: BenchmarkDocumentoService;

  beforeEach(() => {
    fetchUrl = { execute: jest.fn().mockResolvedValue([]) };
    loginPool = {
      getCookies: jest
        .fn()
        .mockResolvedValue({ cookies: 'c=1', account: 'conta-1' }),
    };
    processDocs = { execute: jest.fn().mockResolvedValue([]) };
    scraping = { execute: jest.fn().mockResolvedValue(undefined) };

    service = new BenchmarkDocumentoService(
      fetchUrl as never,
      loginPool as never,
      processDocs as never,
      scraping as never,
    );
  });

  it('rejeita número de processo fora do formato CNJ', async () => {
    await expect(service.execute({ numero: '123' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(loginPool.getCookies).not.toHaveBeenCalled();
  });

  it('rejeita limite fora da faixa permitida', async () => {
    await expect(
      service.execute({ numero, limite: 999 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('casa o termo ignorando acento e caixa', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([
        item({ titulo: 'PETICAO INICIAL', idUnicoDocumento: 'uid-a' }),
        item({ titulo: 'Sentença', idUnicoDocumento: 'uid-b' }),
      ]),
    ]);

    const resultado = await service.execute({
      numero,
      termo: 'petição inicial',
      apenasListar: true,
    });

    expect(resultado.candidatos).toHaveLength(1);
    expect(resultado.candidatos[0].idUnicoDocumento).toBe('uid-a');
  });

  it('encontra o documento também quando ele é um anexo aninhado', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([
        item({
          titulo: 'Movimentação',
          idUnicoDocumento: 'uid-pai',
          anexos: [
            item({ titulo: 'Petição Inicial', idUnicoDocumento: 'uid-anexo' }),
          ],
        }),
      ]),
    ]);

    const resultado = await service.execute({
      numero,
      termo: 'petição inicial',
      apenasListar: true,
    });

    expect(resultado.candidatos.map((c) => c.idUnicoDocumento)).toEqual([
      'uid-anexo',
    ]);
  });

  it('ignora itens que não são documento', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([
        item({ titulo: 'Petição Inicial', documento: false }),
        item({ titulo: 'Petição Inicial', idUnicoDocumento: 'uid-ok' }),
      ]),
    ]);

    const resultado = await service.execute({
      numero,
      termo: 'petição',
      apenasListar: true,
    });

    expect(resultado.candidatos).toHaveLength(1);
  });

  it('não baixa nada quando apenasListar está ligado', async () => {
    fetchUrl.execute.mockResolvedValue([instancia([item()])]);

    const resultado = await service.execute({
      numero,
      termo: 'petição',
      apenasListar: true,
    });

    expect(processDocs.execute).not.toHaveBeenCalled();
    expect(resultado.temposMs.download).toBeNull();
    expect(resultado.baixados).toBe(0);
  });

  it('baixa apenas até o limite pedido, mantendo a lista completa de candidatos', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([
        item({ idUnicoDocumento: 'uid-1' }),
        item({ idUnicoDocumento: 'uid-2' }),
        item({ idUnicoDocumento: 'uid-3' }),
      ]),
    ]);

    const resultado = await service.execute({ numero, termo: 'petição' });

    expect(resultado.candidatos).toHaveLength(3);
    expect(resultado.tentados).toBe(1);

    const instanciasPodadas = processDocs.execute.mock
      .calls[0][1] as ProcessosResponse[];
    expect(instanciasPodadas[0].itensProcesso).toHaveLength(1);
  });

  it('solta os anexos do item selecionado para não baixar o que não foi pedido', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([
        item({
          titulo: 'Petição Inicial',
          anexos: [
            item({ titulo: 'Procuração', idUnicoDocumento: 'uid-proc' }),
          ],
        }),
      ]),
    ]);

    await service.execute({ numero, termo: 'petição inicial' });

    const instanciasPodadas = processDocs.execute.mock
      .calls[0][1] as ProcessosResponse[];
    expect(instanciasPodadas[0].itensProcesso[0].anexos).toBeUndefined();
  });

  it('descarta instâncias que ficaram sem item após o filtro', async () => {
    fetchUrl.execute.mockResolvedValue([
      instancia([item({ titulo: 'Sentença' })]),
      instancia([
        item({ titulo: 'Petição Inicial', idUnicoDocumento: 'uid-p' }),
      ]),
    ]);

    await service.execute({ numero, termo: 'petição inicial' });

    const instanciasPodadas = processDocs.execute.mock
      .calls[0][1] as ProcessosResponse[];
    expect(instanciasPodadas).toHaveLength(1);
  });

  it('pula o login quando comLogin é false', async () => {
    fetchUrl.execute.mockResolvedValue([]);

    const resultado = await service.execute({ numero, comLogin: false });

    expect(loginPool.getCookies).not.toHaveBeenCalled();
    expect(resultado.temposMs.login).toBeNull();
    expect(fetchUrl.execute).toHaveBeenCalledWith(numero, undefined, undefined);
  });

  it('passa pelo WAF antes de tudo nos TRTs que exigem', async () => {
    await service.execute({ numero: '0001933-43.2015.5.03.0101' });

    expect(scraping.execute).toHaveBeenCalledWith(
      '0001933-43.2015.5.03.0101',
      3,
      1,
    );
  });

  it('não chama o WAF em TRT que não precisa', async () => {
    await service.execute({ numero });

    expect(scraping.execute).not.toHaveBeenCalled();
  });

  it('reporta o tempo de cada etapa e o total', async () => {
    fetchUrl.execute.mockResolvedValue([instancia([item()])]);
    processDocs.execute.mockResolvedValue([
      {
        documentos: [
          { title: 'Petição Inicial', uniqueName: 'arq.pdf', temp_link: 'x' },
        ],
      },
    ]);

    const resultado = await service.execute({ numero, termo: 'petição' });

    expect(resultado.temposMs.login).not.toBeNull();
    expect(resultado.temposMs.download).not.toBeNull();
    expect(resultado.temposMs.total).toBeGreaterThanOrEqual(0);
    expect(resultado.baixados).toBe(1);
    expect(resultado.documentos[0].uniqueName).toBe('arq.pdf');
  });

  it('devolve resultado vazio quando o processo não trouxe instâncias', async () => {
    fetchUrl.execute.mockResolvedValue([]);

    const resultado = await service.execute({ numero, termo: 'petição' });

    expect(resultado.candidatos).toEqual([]);
    expect(processDocs.execute).not.toHaveBeenCalled();
  });

  it('falha claramente quando o pool de contas não devolve sessão', async () => {
    loginPool.getCookies.mockResolvedValue({ cookies: null, account: null });

    await expect(service.execute({ numero })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
