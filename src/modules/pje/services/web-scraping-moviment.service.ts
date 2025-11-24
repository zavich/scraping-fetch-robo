/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Injectable, Logger } from '@nestjs/common';
import { ProcessosResponse } from 'src/interfaces';
import { ScrapingService } from '../../../helpers/scraping.service';

@Injectable()
export class WebScrapingMovimentService {
  private readonly logger = new Logger(WebScrapingMovimentService.name);

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
    let instancia3NaoEncontrada = false;

    // ✅ Regras de início
    let initialGrau = origem === 'TST' ? 3 : 1;

    // ✅ TST sempre é somente 3
    if (origem === 'TST') {
      initialGrau = 3;
    }

    let maxInstance = 3; // valor padrão antes da primeira chamada

    for (let i = initialGrau; i <= maxInstance; i++) {
      try {
        const delayMs = this.getRandomDelay(regionTRT);
        this.logger.debug(
          `⏱ Delay de ${delayMs}ms antes de buscar a ${i}ª instância`,
        );
        await this.delay(delayMs);

        const result = {} as {
          process?: ProcessosResponse;
          singleInstance?: boolean;
          quantityInstances?: number;
          mensagemErro?: string;
        };

        const { process, singleInstance, quantityInstances } = result;

        // Assim que descobrir o quantityInstances, ajusta o loop
        if (quantityInstances && quantityInstances < maxInstance) {
          this.logger.debug(
            `🔢 Atualizando maxInstance para ${quantityInstances}`,
          );
          maxInstance = quantityInstances;
        }

        const mensagemErro =
          result.mensagemErro ?? (result.process as any)?.mensagemErro;

        // --- Regra TST ---
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

        // --- Instância única ---
        if (singleInstance) {
          this.logger.log(
            `✅ Processo ${numeroDoProcesso} é de instância única.`,
          );
          if (process) instances.push(process as ProcessosResponse);
          break;
        }

        // --- Mensagem de erro ---
        if (mensagemErro) {
          this.logger.warn(
            `Processo ${numeroDoProcesso} retornou mensagemErro na instância ${i}: ${mensagemErro}`,
          );

          if (mensagemErro === 'Instância 3 não encontrada') {
            instancia3NaoEncontrada = true;
            continue;
          }
        }

        // --- Dados válidos ---
        if (process) {
          instances.push(process as ProcessosResponse);
        }
      } catch (err: any) {
        const msg = err.message || String(err);
        this.logger.warn(
          `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${msg}`,
        );

        continue;
      }
    }

    // ✅ No final, se solicitou TST (instância 3) e não encontrou
    if (initialGrau === 3 && instancia3NaoEncontrada) {
      return [
        {
          mensagemErro: 'Instância 3 não encontrada',
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

    return instances;
  }

  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }

  private getRandomDelay(regionTRT) {
    const minDelay = regionTRT === 15 ? 2000 : 1000;
    const maxDelay = regionTRT === 15 ? 10000 : 5000;
    return Math.floor(Math.random() * (maxDelay - minDelay + 1)) + minDelay;
  }
}
