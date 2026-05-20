# Feature: PJE Documents

## Quando usar

Use este mapa quando a task envolver extracao de documentos PDF do PJE, bookmarks, paginas ou upload para S3.

## Pontos de entrada

- `src/modules/pje/pje.controller.ts`: `POST /processos/extract-by-id`, `POST /processos/list-bookmarks`.
- `src/modules/pje/queues/wokers/documentos-trt.worker.ts`: worker de documentos.

## Arquivos relacionados

- `src/modules/pje/services/extract.service.ts`: extracao de paginas por bookmark ID.
- `src/modules/pje/services/fetch-documents-url.service.ts`: busca URLs de documentos.
- `src/modules/pje/services/process-documents-find.service.ts`: descobre documentos acessiveis.
- `src/services/aws-s3.service.ts`: upload para S3 com AES256.
- `src/providers/dynamic-document-workers.provider.ts`: cria workers de documento por TRT.

## Fluxo resumido

1. Worker de documento consome job da fila `pje-documentos-trt{N}`.
2. Busca URLs de documentos via `FetchDocumentoService`.
3. Download do PDF completo do processo.
4. Lista bookmarks (indices de documentos dentro do PDF).
5. Extrai paginas especificas por bookmark ID via `PdfExtractService`.
6. Upload do PDF extraido para S3 com encriptacao AES256.
7. Retorna URL do S3 via webhook.

## Conceitos

- Bookmark: marcador dentro do PDF composto que indica inicio de um documento individual.
- Extract by ID: extrai subset de paginas de um PDF grande usando pdf-lib.
- PDF composto: PJE retorna todos os documentos de um processo em um unico PDF.

## Riscos e cuidados

- PDFs podem ser muito grandes (centenas de paginas).
- Documentos restritos (segredo de justica) nao sao acessiveis.
- Token de acesso ao documento pode expirar durante download.
- pdf-lib pode falhar em PDFs mal-formados.
