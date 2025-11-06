import { Injectable, Logger } from '@nestjs/common';

import * as fs from 'fs';
import Redis from 'ioredis';
import * as path from 'path';
import { ScrapingService } from 'src/helpers/scraping.service';
import { LoginPoolService } from './login-pool.service';

@Injectable()
export class DocumentoService {
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });
  private readonly logger = new Logger(DocumentoService.name);
  constructor(
    private readonly scrapingService: ScrapingService,
    private readonly loginPoolService: LoginPoolService,
  ) {}
  async execute(
    processNumber: string,
    regionTRT: number,
    instanceIndex: number,
  ): Promise<string> {
    const { username, password } = this.loginPoolService.getConta();

    try {
      // chama o ScrapingService
      const { integra } = await this.scrapingService.execute(
        processNumber,
        regionTRT,
        instanceIndex,
        true,
        true,
        username,
        password,
      );

      if (!integra) {
        this.logger.warn('⚠ PDF /integra não foi capturado');
        return '';
      }

      // cria pasta temp se não existir
      const tempDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

      const sanitizedProcessNumber = processNumber.replace(/\D+/g, '');
      const fileName = `proc_${sanitizedProcessNumber}_${instanceIndex}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.pdf`;
      const filePath = path.join(tempDir, fileName);

      // salva o PDF no disco
      fs.writeFileSync(filePath, integra);

      this.logger.log(`PDF salvo em: ${filePath}`);
      return filePath;
    } catch (error) {
      this.logger.error('Erro ao executar DocumentoService', error);
      throw error;
    }
  }
}
