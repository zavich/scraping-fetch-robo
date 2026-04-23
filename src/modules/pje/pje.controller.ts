import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  Res,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';

import { Response } from 'express';
import { PdfExtractService } from './services/extract.service';
import { LoginPoolService } from './services/login-pool.service';
import { RedisService } from 'src/services/redis.service';
@Controller('processos')
export class PjeController {
  constructor(
    private readonly consultarProcessoQueue: ConsultarProcessoQueue,
    private readonly extractService: PdfExtractService,
    private readonly loginPoolService: LoginPoolService,
    private readonly redisService: RedisService,
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
  @Post('/auth/login/:trt')
  async loginPje(@Param('trt') trt: number): Promise<any> {
    return await this.loginPoolService.getCookies(
      trt,
      '0011054-02.2024.5.03.0102',
    );
  }
  @Delete('redis/:queue/clear')
  async clearRedis(@Param('queue') queue: string): Promise<any> {
    return await this.redisService.deleteQueue(queue);
  }
}
