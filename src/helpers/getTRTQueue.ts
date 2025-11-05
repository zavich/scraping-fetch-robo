export function getTRTFromProcess(numero: string): number | null {
  const match = numero.match(/^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/);
  if (!match) return null;

  return Number(match[1]);
}

export function getTRTQueue(numero: string): string | null {
  const trt = getTRTFromProcess(numero);
  if (!trt) return null;

  return `pje-trt${trt}`;
}

export const ALL_TRT_QUEUES = Array.from(
  { length: 24 },
  (_, i) => `pje-trt${i + 1}`,
);

export const ALL_TRT_DOCUMENT_QUEUES = Array.from(
  { length: 24 },
  (_, i) => `pje-documentos-trt${i + 1}`,
);
