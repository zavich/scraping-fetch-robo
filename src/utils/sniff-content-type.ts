// O PJe às vezes manda o documento de verdade (HTML/PDF com o conteúdo real)
// com um `content-type` errado (ex.: `application/json`) — sem olhar o corpo,
// documentos válidos eram rejeitados/mal classificados. `%PDF`/`<` no início
// do buffer é bem mais confiável que o header nesse caso.
export function sniffContentType(
  buffer: Buffer,
  headerContentType: string,
): string {
  const inicioBuffer = buffer.toString('utf-8', 0, 50).trimStart();
  const pareceHtml = inicioBuffer.startsWith('<');
  const parecePdf = buffer.subarray(0, 4).toString('latin1') === '%PDF';

  if (/pdf|html/.test(headerContentType)) return headerContentType;
  if (parecePdf) return 'application/pdf';
  if (pareceHtml) return 'text/html';
  return headerContentType;
}
