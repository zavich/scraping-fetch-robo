// Processa `items` com no máximo `concorrencia` chamadas de `fn` em voo ao
// mesmo tempo. Sem isso, um `Promise.all` disparava uma requisição por item
// simultaneamente contra o mesmo processo/servidor — rajadas de concorrência
// que costumam derrubar o PJe com erros 429/5xx em processos com muitos itens.
export async function comConcorrenciaLimitada<T, R>(
  items: T[],
  concorrencia: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const resultados: R[] = new Array(items.length);
  let proximoIndice = 0;

  const worker = async () => {
    while (proximoIndice < items.length) {
      const indiceAtual = proximoIndice++;
      resultados[indiceAtual] = await fn(items[indiceAtual]);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concorrencia, items.length) }, worker),
  );

  return resultados;
}
