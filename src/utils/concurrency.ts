// Processa `items` com no máximo `concorrencia` chamadas de `fn` em voo ao
// mesmo tempo. Sem isso, um `Promise.all` disparava uma requisição por item
// simultaneamente contra o mesmo processo/servidor — rajadas de concorrência
// que costumam derrubar o PJe com erros 429/5xx em processos com muitos itens.
export async function comConcorrenciaLimitada<T, R>(
  items: T[],
  concorrencia: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];

  const resultados: R[] = new Array(items.length);
  let proximoIndice = 0;

  const worker = async () => {
    while (proximoIndice < items.length) {
      const indiceAtual = proximoIndice++;
      resultados[indiceAtual] = await fn(items[indiceAtual]);
    }
  };

  // `concorrencia` <= 0/NaN não pode zerar o pool de workers — isso faria
  // Promise.all resolver sem processar nada, devolvendo `resultados` com
  // undefined em todas as posições.
  const poolSize = Math.max(
    1,
    Math.min(Math.trunc(concorrencia || 1), items.length),
  );

  await Promise.all(Array.from({ length: poolSize }, worker));

  return resultados;
}
