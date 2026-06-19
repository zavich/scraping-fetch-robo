import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { normalizeString } from 'src/utils/normalize-string';

export type BookmarkItem = {
  title: string;
  startPage: number;
  endPage: number;
  index: number;
  data: string;
  id: string;
};

@Injectable()
export class PdfExtractService {
  logger = new Logger(PdfExtractService.name);

  /**
   * Extrai páginas de um bookmark específico a partir de um PDFDocument já carregado.
   * Recebe pdfDoc e pdfjsTotalPages para evitar recarregar o PDF a cada chamada
   * (o carregamento duplicado era o principal responsável pelo OOM em jobs concorrentes).
   */
  async extractPagesByIndex(
    pdfDoc: PDFDocument,
    pdfjsTotalPages: number,
    documentId: string,
    bookmarks: BookmarkItem[],
  ): Promise<Buffer | null> {
    const bookmark = bookmarks.find(
      (b) => normalizeString(b.id) === normalizeString(documentId),
    );

    if (!bookmark) {
      this.logger.error(`Bookmark matching "${documentId}" not found.`);
      return null;
    }

    const { startPage, endPage } = bookmark;

    const pdfLibTotalPages = pdfDoc.getPageCount();

    // Ajuste de offset entre pdfjs e pdf-lib
    const pageOffset = pdfjsTotalPages - pdfLibTotalPages;

    // Calcula índices corretos 0-based para pdf-lib
    const startIndex = Math.max(startPage - 1 - pageOffset, 0);
    const endIndex = Math.min(endPage - 1 - pageOffset, pdfLibTotalPages - 1);

    if (startIndex > endIndex) {
      this.logger.warn(
        `Bookmark "${bookmark.title}" tem índices invertidos. Corrigindo para pelo menos 1 página.`,
      );
    }

    const newPdf = await PDFDocument.create();

    // Copia páginas corretas para o novo PDF
    const pagesToCopy = Array.from(
      { length: Math.max(endIndex - startIndex + 1, 1) },
      (_, i) => startIndex + i,
    );

    const pages = await newPdf.copyPages(pdfDoc, pagesToCopy);
    pages.forEach((p) => newPdf.addPage(p));

    const pdfBytes = await newPdf.save();
    return Buffer.from(pdfBytes);
  }

  async extractBookmarks(buffer: Buffer): Promise<{
    bookmarks: BookmarkItem[];
    totalPages: number;
  }> {
    (pdfjsLib.GlobalWorkerOptions as { workerSrc: string | null }).workerSrc =
      null;
    const uint8Array = new Uint8Array(buffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdf = await loadingTask.promise;

    try {
      const outline = await pdf.getOutline();
      if (!outline) {
        return { bookmarks: [], totalPages: pdf.numPages };
      }

      const bookmarks: BookmarkItem[] = [];

      for (const item of outline) {
        let dest: unknown;

        if (typeof item.dest === 'string') {
          dest = await pdf.getDestination(item.dest);
        } else if (Array.isArray(item.dest)) {
          dest = item.dest; // já vem resolvido
        }

        const parts = item.title.split(' - ');

        let id: string = '';
        let index = 0;
        let date: string = '';
        let description = '';

        if (parts.length >= 3) {
          // Assume que o último pedaço é o ID
          id = parts[parts.length - 1].trim();
          description = parts.slice(1, -1).join(' - ').trim();
        } else if (parts.length === 2) {
          description = parts[1].trim();
        } else {
          description = parts[0].trim();
        }

        // Extrair índice e data do primeiro pedaço
        const firstPart = parts[0].trim();
        const matchWithIndex = firstPart.match(
          /^(\d+)\.\s*(\d{2}\/\d{2}\/\d{4})$/,
        );
        const matchWithoutIndex = firstPart.match(/^(\d{2}\/\d{2}\/\d{4})$/);

        if (matchWithIndex) {
          index = parseInt(matchWithIndex[1], 10);
          date = matchWithIndex[2];
        } else if (matchWithoutIndex) {
          date = matchWithoutIndex[1];
        }
        if (dest && Array.isArray(dest) && dest.length > 0) {
          const ref = await pdf.getPageIndex(dest[0]);
          if (typeof ref === 'number') {
            bookmarks.push({
              index,
              id,
              title: String(description).trim(),
              data: date,
              startPage: ref + 1, // 1-based
              endPage: 0, // placeholder, será calculado depois
            });
          }
        }
      }

      // calcular endPage
      const totalPages = pdf.numPages;
      for (let i = 0; i < bookmarks.length; i++) {
        if (i < bookmarks.length - 1) {
          bookmarks[i].endPage = bookmarks[i + 1].startPage - 1;
        } else {
          bookmarks[i].endPage = totalPages;
        }
      }

      return { bookmarks, totalPages };
    } finally {
      await pdf.destroy();
    }
  }
}
