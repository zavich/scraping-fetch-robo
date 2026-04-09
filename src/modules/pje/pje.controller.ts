import {
  Body,
  Controller,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';

import { Response } from 'express';
import { ScrapingService } from '../../helpers/scraping.service';
import { PdfExtractService } from './services/extract.service';
import { LoginPoolService } from './services/login-pool.service';
import { buildHeaders } from 'src/utils/user-agents';
import { scraperRequest } from 'src/utils/fetch-scraper';
import { LoginResponse } from './services/login.service';
@Controller('processos')
export class PjeController {
  constructor(
    private readonly consultarProcessoQueue: ConsultarProcessoQueue,
    private readonly extractService: PdfExtractService,
    private readonly loginPoolService: LoginPoolService,
    private readonly scrapingService: ScrapingService,
  ) {}
  @Post('extract-by-id')
  @UseInterceptors(FileInterceptor('file'))
  async extractById(
    @UploadedFile() file: Express.Multer.File,
    @Body('documentId') documentId: string,
    @Res() res: Response,
  ) {
    if (!file || !documentId) {
      return res
        .status(400)
        .json({ error: 'Arquivo e documentId são obrigatórios' });
    }

    try {
      const pdfBuffer = await this.extractService.extractPagesByIndex(
        file.buffer,
        documentId,
      );

      if (!pdfBuffer) {
        return res.status(404).json({ error: 'Bookmark não encontrado' });
      }

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `attachment; filename=extracted_${documentId}.pdf`,
      );
      return res.send(pdfBuffer);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Erro ao processar PDF' });
    }
  }

  /**
   * Endpoint para listar bookmarks do PDF
   */
  @Post('list-bookmarks')
  @UseInterceptors(FileInterceptor('file'))
  async listBookmarks(
    @UploadedFile() file: Express.Multer.File,
    @Res() res: Response,
  ) {
    if (!file) {
      return res.status(400).json({ error: 'Arquivo é obrigatório' });
    }

    try {
      const bookmarks = await this.extractService.extractBookmarks(file.buffer);
      return res.json(bookmarks);
    } catch (err) {
      console.error(err);
      return res.status(500).json({ error: 'Erro ao extrair bookmarks' });
    }
  }
  @Post('/:numero')
  async getFindProcess(
    @Param('numero') numero: string,
    @Body()
    body: {
      documents?: boolean;
      origem?: string;
      webhook?: string;
      priority?: boolean;
    },
  ): Promise<any> {
    const { documents, origem, webhook, priority } = body || {};
    return this.consultarProcessoQueue.execute(
      numero,
      origem,
      documents,
      webhook,
      priority,
    );
  }
  @Post('/auth/login')
  async loginPje(): Promise<any> {
    // const url = `https://pje.trt2.jus.br/pje-consulta-api/api/auth`;
    // const headers = buildHeaders('login', '1', 3, undefined, url);
    // const username = process.env.PJE_USER_FIRST || 'rafael.nicacio';
    // const password = process.env.PJE_PASS_FIRST || 'Rafael123!';
    // const response = await scraperRequest(
    //   url,
    //   `username`,
    //   headers,
    //   'POST',
    //   {
    //     login: username,
    //     senha: password,
    //   },
    //   false,
    // );
    // return response.data as LoginResponse;
    return await this.loginPoolService.getCookies(3);
  }
  @Post('/teste/trt')
  async teste(): Promise<any> {
    return await this.scrapingService.execute(
      '0016495-78.2023.5.16.0023',
      16,
      2,
    );
  }
}
