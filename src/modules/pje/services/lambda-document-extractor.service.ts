import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface LambdaExtractionContext {
  titulo: string;
  idUnicoDocumento: string;
  processNumber: string;
}

@Injectable()
export class LambdaDocumentExtractorService {
  private readonly logger = new Logger(LambdaDocumentExtractorService.name);

  private readonly LAMBDA_URL =
    process.env.LAMBDA_DOCUMENT_EXTRACTOR_URL as string;
  private readonly LAMBDA_API_KEY =
    process.env.LAMBDA_DOCUMENT_EXTRACTOR_API_KEY as string;

  async extractText(
    buffer: Buffer,
    pjeContentType: string,
    context: LambdaExtractionContext,
  ): Promise<string> {
    if (!this.LAMBDA_URL || !this.LAMBDA_API_KEY) {
      throw new Error(
        'LAMBDA_DOCUMENT_EXTRACTOR_URL e LAMBDA_DOCUMENT_EXTRACTOR_API_KEY são obrigatórios',
      );
    }

    const lambdaContentType = pjeContentType.includes('pdf') ? 'pdf' : 'html';

    const response = await axios.post<Record<string, unknown>>(
      this.LAMBDA_URL,
      {
        api_key: this.LAMBDA_API_KEY,
        content_type: lambdaContentType,
        content_b64: buffer.toString('base64'),
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 60000,
      },
    );

    this.logger.debug(
      `🔍 Lambda response para "${context.titulo}" (idUnico=${context.idUnicoDocumento}, content_type=${lambdaContentType}): keys=${Object.keys(response.data ?? {}).join(',')}`,
    );

    const texto =
      (response.data?.texto as string) ??
      (response.data?.text as string) ??
      (response.data?.result as string) ??
      (response.data?.content as string) ??
      '';

    this.logger.debug(
      `✅ Texto extraído para documento "${context.titulo}" (idUnico=${context.idUnicoDocumento}) de ${context.processNumber} (${texto.length} chars)`,
    );

    return texto;
  }
}
