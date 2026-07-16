import { ItensProcesso } from 'src/interfaces';

// Achata itensProcesso + anexos aninhados numa lista só, mantendo a mesma
// referência de objeto (sem clonar) — só serve pra enumerar TODOS os
// documentos (inclusive anexos) que precisam passar pela extração via
// Lambda/upload. Quem mutar `item.texto` num item achatado está mutando o
// mesmo objeto que `buildMovimentacao` (normalizeResponse.ts) lê depois
// recursivamente em `.anexos`, então o texto extraído de um anexo chega
// certo no payload final sem nenhum tratamento especial.
export function flattenItensProcesso(itens: ItensProcesso[]): ItensProcesso[] {
  const resultado: ItensProcesso[] = [];
  for (const item of itens) {
    resultado.push(item);
    if (item.anexos?.length) {
      resultado.push(...flattenItensProcesso(item.anexos));
    }
  }
  return resultado;
}
