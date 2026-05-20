import {
  Body,
  Controller,
  Delete,
  Logger,
  Param,
  Post,
  Res,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { ApiKeyAuthGuard } from 'src/guards/api-key.guard';
import { FileInterceptor } from '@nestjs/platform-express';
import { ConsultarProcessoQueue } from './queues/service/consultar-processo';

import { Response } from 'express';
import { PdfExtractService } from './services/extract.service';
import { LoginPoolService } from './services/login-pool.service';
import { RedisService } from 'src/services/redis.service';
@Controller('processos')
export class PjeController {
  private readonly logger = new Logger(PjeController.name);

  constructor(
    private readonly consultarProcessoQueue: ConsultarProcessoQueue,
    private readonly extractService: PdfExtractService,
    private readonly loginPoolService: LoginPoolService,
    private readonly redisService: RedisService,
  ) {}
  @Post('extract-by-id')
  @UseGuards(ApiKeyAuthGuard)
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
      this.logger.error('Erro ao processar PDF:', err);
      return res.status(500).json({ error: 'Erro ao processar PDF' });
    }
  }

  /**
   * Endpoint para listar bookmarks do PDF
   */
  @Post('list-bookmarks')
  @UseGuards(ApiKeyAuthGuard)
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
      this.logger.error('Erro ao extrair bookmarks:', err);
      return res.status(500).json({ error: 'Erro ao extrair bookmarks' });
    }
  }
  @Post('/:numero')
  @UseGuards(ApiKeyAuthGuard)
  async getFindProcess(
    @Param('numero') numero: string,
    @Body()
    body: {
      documents?: boolean;
      origem?: string;
      webhook?: string;
      priority?: boolean;
    },
  ) {
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
  @UseGuards(ApiKeyAuthGuard)
  async loginPje(
    @Param('trt') trt: number,
    @Body('numero') numero: string,
  ) {
    if (!numero) {
      return { success: false, error: 'Campo "numero" obrigatório no body' };
    }
    await this.loginPoolService.getCookies(trt, numero);
    return { success: true };
  }
  @Delete('redis/:queue/clear')
  @UseGuards(ApiKeyAuthGuard)
  async clearRedis(@Param('queue') queue: string) {
    return await this.redisService.deleteQueue(queue);
  }
  @Delete('redis/flush-all')
  @UseGuards(ApiKeyAuthGuard)
  async flushAllRedis() {
    return await this.redisService.flushAll();
  }
  @Post('redis/reprocess-failed')
  @UseGuards(ApiKeyAuthGuard)
  async reprocessFailedJobs() {
    try {
      await this.redisService.reprocessAllFailedJobs(async (jobData) => {
        this.logger.debug(`Processando job: ${JSON.stringify(jobData)}`);
        await new Promise((resolve) => setTimeout(resolve, 1000));
      });
      return {
        message: 'Reprocessamento concluído.',
      };
    } catch (error) {
      this.logger.error('Erro ao reprocessar jobs:', error);
      throw error;
    }
  }
}
