import { Injectable, Logger } from '@nestjs/common';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import { normalizeString } from 'src/utils/normalize-string';
@Injectable()
export class PdfExtractService {
  logger = new Logger(PdfExtractService.name);

  async extractPagesByIndex(fileBuffer: Buffer, documentId: string) {
    // Carrega bookmarks
    const bookmarks = await this.extractBookmarks(fileBuffer);

    // Encontra o bookmark pelo id
    const bookmark = bookmarks.find(
      (b) => normalizeString(b.id) === normalizeString(documentId),
    );

    if (!bookmark) {
      this.logger.error(`Bookmark matching "${documentId}" not found.`);
      return null;
    }

    const { startPage, endPage } = bookmark;

    // Carrega PDF com pdf-lib
    const pdfDoc = await PDFDocument.load(fileBuffer);
    const pdfLibTotalPages = pdfDoc.getPageCount();

    // Carrega PDF com pdfjs apenas para calcular offset
    const pdfjsDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
    }).promise;
    const pdfjsTotalPages = pdfjsDoc.numPages;

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
    this.logger.debug(
      `✅ Documento "${bookmark.title}" extraído com sucesso (páginas ${startIndex + 1}-${endIndex + 1})`,
    );

    return Buffer.from(pdfBytes);
  }

  async extractBookmarks(buffer: Buffer): Promise<
    {
      title: string;
      startPage: number;
      endPage: number;
      index: number;
      data: string;
      id: string;
    }[]
  > {
    (pdfjsLib.GlobalWorkerOptions as { workerSrc: string | null }).workerSrc =
      null;
    const uint8Array = new Uint8Array(buffer);
    const loadingTask = pdfjsLib.getDocument({ data: uint8Array });
    const pdf = await loadingTask.promise;

    const outline = await pdf.getOutline();
    if (!outline) {
      return [];
    }

    const bookmarks: {
      title: string;
      startPage: number;
      endPage: number;
      index: number;
      data: string;
      id: string;
    }[] = [];

    for (const item of outline) {
      let dest: any;

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

    return bookmarks;
  }
}
