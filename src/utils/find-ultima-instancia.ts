import { ItensProcesso, ProcessosResponse } from 'src/interfaces';

export function findUltimaInstancia(instances: ProcessosResponse[]): {
  id: number;
  instance: string;
  itensProcesso: ItensProcesso[];
  ultimaMovimentacao: ItensProcesso;
} | null {
  const movimentsInstances = instances.map((inst, index) => {
    if (!inst.itensProcesso?.length) return null;
    const ultimaMovimentacao = inst.itensProcesso.reduce(
      (maisRecente, atual) => {
        const dataMaisRecente = new Date(maisRecente.data);
        const dataAtual = new Date(atual.data);
        return dataAtual > dataMaisRecente ? atual : maisRecente;
      },
    );
    return {
      id: inst.id,
      instance: inst.instance ?? (index + 1).toString(),
      itensProcesso: inst.itensProcesso,
      ultimaMovimentacao,
    };
  });

  return movimentsInstances.reduce((maisRecente, atual) => {
    if (!maisRecente) return atual;
    if (!atual) return maisRecente;
    const dataMaisRecente = new Date(maisRecente.ultimaMovimentacao.data);
    const dataAtual = new Date(atual.ultimaMovimentacao.data);
    return dataAtual > dataMaisRecente ? atual : maisRecente;
  }, null);
}
