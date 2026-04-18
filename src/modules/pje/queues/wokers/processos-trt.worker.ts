import { getQueueToken, WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job, Queue } from 'bullmq';
import Redis from 'ioredis';
import { ScrapingService } from 'src/helpers/scraping.service';
import { normalizeResponse } from 'src/utils/normalizeResponse';
import { LoginErrorTrt } from 'src/utils/trt-validate';
import { FetchUrlMovimentService } from '../../services/fetch-url.service';
import { LoginPoolService } from '../../services/login-pool.service';
import { WebScrapingMovimentService } from '../../services/web-scraping-moviment.service';

export class GenericProcessoWorker extends WorkerHost {
  private readonly logger = new Logger(GenericProcessoWorker.name);
  private readonly documentosQueues: Record<string, Queue> = {};
  constructor(
    @Inject(LoginPoolService) // 👈 AQUI
    private readonly loginPool: LoginPoolService,
    @Inject(WebScrapingMovimentService)
    private readonly webScrapingMovimentService: WebScrapingMovimentService,
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject(FetchUrlMovimentService)
    private readonly fetchUrlMovimentService: FetchUrlMovimentService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,

    // ✅ injeta todas as filas TRT
    @Inject(getQueueToken('pje-documentos-trt1')) trt1: Queue,
    @Inject(getQueueToken('pje-documentos-trt2')) trt2: Queue,
    @Inject(getQueueToken('pje-documentos-trt3')) trt3: Queue,
    @Inject(getQueueToken('pje-documentos-trt4')) trt4: Queue,
    @Inject(getQueueToken('pje-documentos-trt5')) trt5: Queue,
    @Inject(getQueueToken('pje-documentos-trt6')) trt6: Queue,
    @Inject(getQueueToken('pje-documentos-trt7')) trt7: Queue,
    @Inject(getQueueToken('pje-documentos-trt8')) trt8: Queue,
    @Inject(getQueueToken('pje-documentos-trt9')) trt9: Queue,
    @Inject(getQueueToken('pje-documentos-trt10')) trt10: Queue,
    @Inject(getQueueToken('pje-documentos-trt11')) trt11: Queue,
    @Inject(getQueueToken('pje-documentos-trt12')) trt12: Queue,
    @Inject(getQueueToken('pje-documentos-trt13')) trt13: Queue,
    @Inject(getQueueToken('pje-documentos-trt14')) trt14: Queue,
    @Inject(getQueueToken('pje-documentos-trt15')) trt15: Queue,
    @Inject(getQueueToken('pje-documentos-trt16')) trt16: Queue,
    @Inject(getQueueToken('pje-documentos-trt17')) trt17: Queue,
    @Inject(getQueueToken('pje-documentos-trt18')) trt18: Queue,
    @Inject(getQueueToken('pje-documentos-trt19')) trt19: Queue,
    @Inject(getQueueToken('pje-documentos-trt20')) trt20: Queue,
    @Inject(getQueueToken('pje-documentos-trt21')) trt21: Queue,
    @Inject(getQueueToken('pje-documentos-trt22')) trt22: Queue,
    @Inject(getQueueToken('pje-documentos-trt23')) trt23: Queue,
    @Inject(getQueueToken('pje-documentos-trt24')) trt24: Queue,
  ) {
    super();

    this.documentosQueues = {
      trt1: trt1,
      trt2: trt2,
      trt3: trt3,
      trt4: trt4,
      trt5: trt5,
      trt6: trt6,
      trt7: trt7,
      trt8: trt8,
      trt9: trt9,
      trt10: trt10,
      trt11: trt11,
      trt12: trt12,
      trt13: trt13,
      trt14: trt14,
      trt15: trt15,
      trt16: trt16,
      trt17: trt17,
      trt18: trt18,
      trt19: trt19,
      trt20: trt20,
      trt21: trt21,
      trt22: trt22,
      trt23: trt23,
      trt24: trt24,
    };
  }

  async process(
    job: Job<{
      numero: string;
      origem?: string;
      documents?: boolean;
      webhook?: string;
    }>,
  ) {
    const { numero, origem, documents = false, webhook } = job.data;

    this.logger.log(`📄 [${job.queueName}] Consultando processo ${numero}`);

    const webhookUrl = webhook ?? `${process.env.WEBHOOK_URL}/process/webhook`;

    // Extrai TRT do CNJ
    const match = numero.match(/^\d{7}-\d{2}\.\d{4}\.\d\.(\d{2})\.\d{4}$/);
    const regionTRT = match ? Number(match[1]) : null;

    try {
      // --------------------------
      // 🔍 Validação TRT
      // --------------------------
      if (regionTRT === null) {
        this.logger.warn(`⚠️ Número inválido ${numero}`);

        const response = normalizeResponse(
          numero,
          [],
          'Número do processo inválido',
          true,
        );

        await axios.post(webhookUrl, response);
        return;
      }
      await this.scrapingService.execute(numero, regionTRT, 1);
      const instances = await this.fetchUrlMovimentService.execute(
        numero,
        origem,
      );

      const result = instances.slice(0, 2);

      if (!instances || instances.length === 0) {
        this.logger.warn(
          `⚠️ Nenhum resultado encontrado para o processo ${numero}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Nenhum resultado encontrado',
          true,
          origem,
        );

        await axios.post(webhookUrl, response);
        return;
      }

      // --------------------------
      // 🔐 Segredo de Justiça
      // --------------------------
      const segredo = result.some((i) => {
        if (!i) return false; // protege contra null/undefined
        const maybeMsg = (i as any).mensagemErro as unknown;
        if (typeof maybeMsg !== 'string') return false;
        const msg = maybeMsg;
        if (!msg) return false;
        const normalized = msg
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase();
        return /segredo(?:.*justica)?/.test(normalized);
      });

      if (segredo) {
        this.logger.warn(`⚠️ Segredo de justiça ${numero}`);
        const response = normalizeResponse(
          numero,
          [],
          `O processo ${numero} está em segredo de justiça`,
          true,
          origem,
        );
        await axios.post(webhookUrl, response);
        return;
      }

      const erroMensagem = result.find(
        (i) =>
          i &&
          typeof (i as any).mensagemErro === 'string' &&
          (i as any).mensagemErro.length > 0,
      );

      if (erroMensagem) {
        this.logger.warn(
          `⚠️ Mensagem de erro para o processo ${numero}: ${erroMensagem.mensagemErro}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          erroMensagem.mensagemErro,
          true,
          origem,
        );
        await axios.post(webhookUrl, response);
        return;
      }

      // --------------------------
      // ✅ Resposta final
      // --------------------------
      const response = normalizeResponse(numero, result, '', false, origem);

      console.log('RESPONSE:', response);
      this.logger.log(`✅ [${job.queueName}] Finalizado ${numero}`);

      await axios.post(webhookUrl, response);
      if (documents) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // pequena pausa para garantir que o webhook seja processado antes de iniciar a consulta de documentos
        console.log(
          `🔐 [${job.queueName}] Consulta de documentos para ${numero} (TRT-${regionTRT})`,
        );
        let filePath: string | undefined = undefined;
        const validatedTRT = LoginErrorTrt.includes(regionTRT); // TRT3 tem tratamento especial
        if (!validatedTRT) {
          const { cookies, account } = await this.loginPool.getCookies(
            regionTRT,
            numero,
          );

          // Se não tiver cookies, significa que nenhuma conta está disponível
          if (!cookies || !account) {
            const resp = normalizeResponse(
              numero,
              [],
              `TRT-${regionTRT} indisponível ou todas as contas bloqueadas`,
              true,
            );
            await axios.post(webhookUrl, resp);
            return;
          }
          filePath = await this.fetchUrlMovimentService.fetchDocuments(
            numero,
            instances,
            regionTRT,
          );
        }
        const queueName = `trt${regionTRT}`;
        const documentosQueue = this.documentosQueues[queueName];
        await documentosQueue.add(
          'consulta-processo-documento',
          { numero, instances, filePath },
          {
            jobId: numero,
            attempts: 2,
            backoff: { type: 'fixed', delay: 5000 },
            removeOnFail: false,
            removeOnComplete: true,
          },
        );
      }
    } catch (error) {
      this.logger.error(error);

      if (axios.isAxiosError(error) && error.status === 503) {
        const response = normalizeResponse(
          numero,
          [],
          'Erro temporário, tente novamente mais tarde',
          true,
        );
        await axios.post(webhookUrl, response);
      }
    }
  }
}
