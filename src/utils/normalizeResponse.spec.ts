import { ProcessosResponse } from 'src/interfaces';
import { normalizeResponse } from './normalizeResponse';

// Recorte do retorno real do PJe (TRT3, 0010362-49.2026.5.03.0064): só
// documento tem `id`; movimentação textual vem sem, e itens diferentes podem
// cair no mesmo instante (as duas intimações abaixo).
const CNJ = '0010362-49.2026.5.03.0064';

function instancia(): ProcessosResponse {
  return {
    id: 3254956,
    numero: CNJ,
    classe: 'CumPrSe',
    instance: '1',
    poloAtivo: [],
    poloPassivo: [],
    itensProcesso: [
      {
        titulo: 'Expedido(a) intimação a(o) VALE S.A.',
        data: '2026-06-10T11:25:28.494867',
        documento: false,
      },
      {
        titulo:
          'Expedido(a) intimação a(o) SINDICATO TRAB IND EXTRACAO FERROS E MET BAS DE MARIANA',
        data: '2026-06-10T11:25:28.494867',
        documento: false,
      },
      {
        id: 251340960,
        titulo: 'Sentença',
        tipo: 'Sentença',
        data: '2026-06-10T11:24:28.494867',
        documento: true,
        publico: true,
        anexos: [
          { id: 1, titulo: 'Anexo', data: '2026-06-10T11:24:28.494867', documento: true },
        ],
      },
      {
        titulo: 'Publicado(a) o(a) intimação em 12/06/2026',
        data: '2026-06-11T07:38:42.974911',
        documento: false,
      },
      {
        titulo: 'Publicado(a) o(a) intimação em 12/06/2026',
        data: '2026-06-11T07:38:42.974911',
        documento: false,
      },
    ],
  } as unknown as ProcessosResponse;
}

const ids = (numero: string, body: ProcessosResponse[]) => {
  const resposta = normalizeResponse(numero, body).resposta as {
    instancias: { movimentacoes: { id: number; anexos?: { id: number }[] }[] }[];
  };
  return resposta.instancias[0].movimentacoes;
};

describe('normalizeResponse — id das movimentações', () => {
  it('é o mesmo em duas coletas do mesmo processo', () => {
    const primeira = ids(CNJ, [instancia()]).map((m) => m.id);
    const segunda = ids(CNJ, [instancia()]).map((m) => m.id);

    expect(segunda).toEqual(primeira);
  });

  it('é único dentro da coleta, mesmo com itens no mesmo instante ou idênticos', () => {
    const movs = ids(CNJ, [instancia()]);
    const todos = movs.flatMap((m) => [m.id, ...(m.anexos ?? []).map((a) => a.id)]);

    expect(new Set(todos).size).toBe(todos.length);
  });

  it('muda com o processo e com o grau', () => {
    const outroCnj = ids('0010363-34.2026.5.03.0064', [instancia()]).map((m) => m.id);
    const segundoGrau = ids(CNJ, [{ ...instancia(), instance: '2' }]).map((m) => m.id);
    const base = ids(CNJ, [instancia()]).map((m) => m.id);

    expect(outroCnj.some((id) => base.includes(id))).toBe(false);
    expect(segundoGrau.some((id) => base.includes(id))).toBe(false);
  });

  it('é inteiro seguro (cabe no INT64 do lake)', () => {
    for (const { id } of ids(CNJ, [instancia()])) {
      expect(Number.isSafeInteger(id)).toBe(true);
      expect(id).toBeGreaterThan(0);
    }
  });
});
