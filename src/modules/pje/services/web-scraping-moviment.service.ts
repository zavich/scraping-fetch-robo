/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import Redis from 'ioredis';
import { ProcessosResponse } from 'src/interfaces';
import { ScrapingService } from '../../../helpers/scraping.service';

@Injectable()
export class WebScrapingMovimentService {
  private readonly logger = new Logger(WebScrapingMovimentService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

  constructor(
    private readonly scrapingService: ScrapingService, // injeta o ScrapingService
  ) {}

  async execute(
    numeroDoProcesso: string,
    origem?: string,
  ): Promise<ProcessosResponse[]> {
    const regionTRT = numeroDoProcesso.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const instances: ProcessosResponse[] = [];
    const initialGrau = origem === 'TST' ? 3 : 1;

    for (let i = initialGrau; i <= 3; i++) {
      try {
        const delayMs = this.getRandomDelay();
        this.logger.debug(
          `⏱ Delay de ${delayMs}ms antes de buscar a ${i}ª instância`,
        );
        await this.delay(delayMs);

        // Chama o ScrapingService para capturar o processo via Puppeteer
        const { process } = await this.scrapingService.execute(
          numeroDoProcesso,
          regionTRT,
          i,
        );

        const mensagemErro = (process as any)?.mensagemErro;
        if (mensagemErro) {
          this.logger.warn(
            `Processo ${numeroDoProcesso} retornou mensagemErro na instância ${i}: ${mensagemErro}`,
          );
          instances.push(process as unknown as ProcessosResponse);
          break;
        }
        if (process) {
          instances.push(process as unknown as ProcessosResponse);
        }
      } catch (err: any) {
        this.logger.warn(
          `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err.message}`,
        );
        continue;
      }
    }

    return instances;
  }

  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  private getRandomDelay() {
    // if (regionTRT === 15) {
    //   return Math.floor(Math.random() * (15000 - 10000 + 1)) + 10000;
    // }
    return Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
  }
}
