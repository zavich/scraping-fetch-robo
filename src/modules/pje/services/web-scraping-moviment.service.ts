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

  constructor(private readonly scrapingService: ScrapingService) {}

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

    // ✅ Regras de início
    const initialGrau = origem === 'TST' ? 3 : 1;
    const finalGrau = origem === 'TST' ? 3 : 3;

    for (let i = initialGrau; i <= finalGrau; i++) {
      try {
        const delayMs = this.getRandomDelay();
        this.logger.debug(
          `⏱ Delay de ${delayMs}ms antes de buscar a ${i}ª instância`,
        );
        await this.delay(delayMs);

        const { process, singleInstance } = await this.scrapingService.execute(
          numeroDoProcesso,
          regionTRT,
          i,
        );

        const mensagemErro = (process as any)?.mensagemErro;

        // ✅ 1) Regra especial para TST: se instância única → TST não existe
        if (origem === 'TST' && singleInstance) {
          this.logger.warn(
            `⚠️ Processo ${numeroDoProcesso} não possui instância 3 (TST).`,
          );

          return [
            {
              mensagemErro: 'Processo não possui instância no TST',
              mensagem: '',
              tokenDesafio: '',
              itensProcesso: [],
              instance: '',
              imagem: '',
              resposta: '',
              id: 0,
              numero: '',
              classe: '',
              orgaoJulgador: '',
              pessoaRelator: '',
              segredoJustica: false,
              justicaGratuita: false,
              distribuidoEm: '',
              autuadoEm: '',
              valorDaCausa: 0,
              poloAtivo: [],
              poloPassivo: [],
              assuntos: [],
              expedientes: [],
              juizoDigital: false,
              documentos: [],
            },
          ];
        }

        // ✅ 2) Instância única em TRT → finaliza imediatamente
        if (singleInstance) {
          this.logger.log(
            `✅ Processo ${numeroDoProcesso} é de instância única. Finalizando buscas.`,
          );

          if (process) {
            instances.push(process as unknown as ProcessosResponse);
          }

          break;
        }

        // ✅ 3) Mensagem de erro apresentada pelo tribunal
        if (mensagemErro) {
          this.logger.warn(
            `Processo ${numeroDoProcesso} retornou mensagemErro na instância ${i}: ${mensagemErro}`,
          );

          instances.push(process as unknown as ProcessosResponse);
          break;
        }

        // ✅ 4) Dados válidos da instância
        if (process) {
          instances.push(process as unknown as ProcessosResponse);
        }
      } catch (err: any) {
        const msg = err.message || String(err);

        // ✅ 5) Erro de instância inexistente no TST
        if (origem === 'TST' && msg.includes('Instância 3 não encontrada')) {
          this.logger.warn(
            `⚠️ Processo ${numeroDoProcesso} não possui instância no TST.`,
          );

          return [
            {
              mensagemErro: 'Processo não possui instância no TST',
              mensagem: '',
              tokenDesafio: '',
              itensProcesso: [],
              instance: '',
              imagem: '',
              resposta: '',
              id: 0,
              numero: '',
              classe: '',
              orgaoJulgador: '',
              pessoaRelator: '',
              segredoJustica: false,
              justicaGratuita: false,
              distribuidoEm: '',
              autuadoEm: '',
              valorDaCausa: 0,
              poloAtivo: [],
              poloPassivo: [],
              assuntos: [],
              expedientes: [],
              juizoDigital: false,
              documentos: [],
            },
          ];
        }

        this.logger.warn(
          `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${msg}`,
        );

        // Em TRT continua tentando a próxima instância
        continue;
      }
    }

    return instances;
  }

  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  private getRandomDelay() {
    // Regra opcional futura para TRT15
    return Math.floor(Math.random() * (5000 - 1000 + 1)) + 1000;
  }
}
