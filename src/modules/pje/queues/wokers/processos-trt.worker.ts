import { WorkerHost } from '@nestjs/bullmq';
import { Inject, Logger } from '@nestjs/common';
import axios from 'axios';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { normalizeResponse } from 'src/utils/normalizeResponse';
import { deleteByPattern } from 'src/utils/redis-delete-keys';
import { FetchUrlMovimentService } from '../../services/fetch-url.service';
import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';
import { ProcessosResponse } from 'src/interfaces';
import { DocumentoExtraido } from '../../services/fetch-public-documents.service';
import { ScrapingService } from 'src/helpers/scraping.service';
import { Root } from 'src/interfaces/normalize';

export class GenericProcessoWorker extends WorkerHost {
  private readonly logger = new Logger(GenericProcessoWorker.name);
  constructor(
    @Inject(FetchUrlMovimentService)
    private readonly fetchUrlMovimentService: FetchUrlMovimentService,
    @Inject(LoginPoolService)
    private readonly loginPool: LoginPoolService,
    @Inject(ProcessDocumentsFindService)
    private readonly processDocsService: ProcessDocumentsFindService,
    @Inject(ScrapingService)
    private readonly scrapingService: ScrapingService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    super();
  }

  async process(
    job: Job<{
      numero: string;
      origem?: string;
      documents?: boolean;
      webhook?: string;
      correlationId?: string;
    }>,
  ) {
    const { numero, origem, documents = false, webhook } = job.data;

    this.logger.log(`📄 [${job.queueName}] Consultando processo ${numero}`);

    const webhookUrl = webhook ?? `${process.env.WEBHOOK_URL}/process/webhook`;
    // ARQ-005: propagate correlation ID across services
    // Usa numero como fallback determinístico para manter idempotência entre retries
    const correlationId = job.data.correlationId ?? String(job.id ?? numero);
    const webhookHeaders = {
      'x-correlation-id': correlationId,
      ...(process.env.WEBHOOK_SERVICE_KEY
        ? { 'x-service-key': process.env.WEBHOOK_SERVICE_KEY }
        : {}),
    };
    let successWebhookSent = false;

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
          {
            status: 'ERRO',
            motivoErro: 'NUMERO_INVALIDO',
            webhookId: `${correlationId}:invalid-number`,
          },
        );

        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }
      if (regionTRT === 3 || regionTRT === 9) {
        await this.scrapingService.execute(numero, regionTRT, 1);
      }

      // Quando documents:true, autentica ANTES de buscar as movimentações —
      // sem login o PJE retorna itensProcesso incompleto (sem os documentos
      // restritos), então a busca de movimentações precisa ir com os
      // cookies/headers da sessão logada. A mesma sessão é reaproveitada
      // depois na busca dos documentos restritos (via Redis).
      let sessionCookies: string | undefined;
      if (documents) {
        const { cookies, account } = await this.loginPool.getCookies(
          regionTRT,
          numero,
        );

        if (!cookies || !account) {
          const response = normalizeResponse(
            numero,
            [],
            `TRT-${regionTRT} indisponível ou todas as contas bloqueadas`,
            {
              status: 'ERRO',
              motivoErro: 'LOGIN_UNAVAILABLE',
              webhookId: `${correlationId}:login-unavailable`,
              origem,
            },
          );
          await axios.post(webhookUrl, response, { headers: webhookHeaders });
          return;
        }
        sessionCookies = cookies;
      }

      const instances = await this.fetchUrlMovimentService.execute(
        numero,
        origem,
        sessionCookies,
      );

      // Sem cap aqui — processo pode ter até 3 instâncias (1º grau, 2º grau
      // e TST). Um `.slice(0, 2)` de antes do suporte a TST descartava a 3ª
      // instância do webhook mesmo quando ela era buscada com sucesso.
      const result = instances;

      if (!instances || instances.length === 0) {
        this.logger.warn(
          `⚠️ Nenhum resultado encontrado para o processo ${numero}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          'Nenhum resultado encontrado',
          {
            origem,
            webhookId: `${correlationId}:not-found`,
          },
        );

        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      // --------------------------
      // 🔐 Segredo de Justiça
      // --------------------------
      const segredo = result.some((i) => {
        if (!i) return false; // protege contra null/undefined
        const maybeMsg: unknown = i.mensagemErro;
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
          {
            origem,
            webhookId: `${correlationId}:secrecy`,
            status: 'ERRO',
            motivoErro: 'SEGREDO_JUSTICA',
          },
        );
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      const erroMensagem = result.find(
        (i) =>
          i && typeof i.mensagemErro === 'string' && i.mensagemErro.length > 0,
      );

      if (erroMensagem) {
        this.logger.warn(
          `⚠️ Mensagem de erro para o processo ${numero}: ${erroMensagem.mensagemErro}`,
        );
        const response = normalizeResponse(
          numero,
          [],
          erroMensagem.mensagemErro,
          {
            origem,
            webhookId: `${correlationId}:message-error`,
            status: 'ERRO',
            motivoErro: 'PJE_ERRO',
          },
        );
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
        return;
      }

      // --------------------------
      // 📄 Documentos públicos (best-effort — enriquece as movimentações antes do webhook)
      // Pulado quando documents:true — nesse caso o fluxo de autos (login) logo
      // abaixo já busca públicos e restritos juntos, numa única passada.
      // --------------------------
      if (!documents) {
        try {
          this.logger.log(
            `📄 [${job.queueName}] Extraindo documentos públicos para ${numero} (TRT-${regionTRT})`,
          );
          const publicDocs: DocumentoExtraido[] =
            await this.fetchUrlMovimentService.fetchPublicDocuments(
              numero,
              instances as ProcessosResponse[],
              regionTRT,
              false,
            );

          const publicDocsById = new Map(
            publicDocs.map((d) => [d.idUnicoDocumento, d.texto]),
          );
          for (const instance of instances as ProcessosResponse[]) {
            if (!instance.itensProcesso?.length) continue;
            for (const item of instance.itensProcesso) {
              const texto = publicDocsById.get(item.idUnicoDocumento);
              if (texto) item.texto = texto;
            }
          }

          this.logger.log(
            `✅ [${job.queueName}] ${publicDocs.length} documento(s) público(s) extraído(s) para ${numero}`,
          );
        } catch (publicDocError) {
          this.logger.warn(
            `⚠️ Falha ao extrair documentos públicos para ${numero}: ${publicDocError instanceof Error ? publicDocError.message : String(publicDocError)}`,
          );
        }
      }

      this.logger.log(`✅ [${job.queueName}] Finalizado ${numero}`);

      // Evita re-envio em retries do BullMQ: checa se o webhook de sucesso já foi
      // enviado numa tentativa anterior (correlationId é estável por estar no job data).
      const successOkKey = `scraper:movements-ok:${correlationId}`;
      const alreadySent = await this.redis.get(successOkKey);

      const sendOnce = async (payload: Root) => {
        if (alreadySent) {
          successWebhookSent = true;
          return;
        }
        await axios.post(webhookUrl, payload, { headers: webhookHeaders });
        // Marca como enviado antes do redis.set: se o POST deu certo mas o
        // set falhar, o catch externo não deve mandar um webhook de erro
        // por cima de um sucesso já entregue.
        successWebhookSent = true;
        try {
          await this.redis.set(successOkKey, '1', 'EX', 86400);
        } catch (redisErr: unknown) {
          this.logger.warn(
            `Falha ao gravar ${successOkKey} no Redis (webhook já enviado): ${redisErr instanceof Error ? redisErr.message : String(redisErr)}`,
          );
        }
      };

      if (!documents) {
        // --------------------------
        // ✅ Resposta final (inclui texto dos docs públicos se extraídos)
        // --------------------------
        const response = normalizeResponse(
          numero,
          result as ProcessosResponse[],
          '',
          {
            origem,
            webhookId: `${correlationId}:movements-success`,
          },
        );
        await sendOnce(response);
        return;
      }

      // Com documents:true, manda só UM webhook de sucesso ao final (em vez
      // de um pras movimentações e outro pros documentos restritos) —
      // cada webhook vira uma gravação completa de processo/instâncias/
      // partes/movimentações no Parquet (SaveWebhookToAthenaService), então
      // dois webhooks pro mesmo job duplicavam essas linhas no Athena.
      await new Promise((resolve) => setTimeout(resolve, 2000));
      this.logger.log(
        `🔐 [${job.queueName}] Consulta de documentos restritos para ${numero} (TRT-${regionTRT})`,
      );

      // Busca os documentos restritos direto aqui — o login já foi feito
      // acima pra autenticar a busca de movimentações, então não faz mais
      // sentido delegar isso a um worker/fila separado que ia logar de novo.
      try {
        const documentos = await this.processDocsService.execute(
          numero,
          instances as ProcessosResponse[],
          regionTRT,
        );

        if (documentos.length === 0 || documentos[0].documentos.length === 0) {
          // Nenhum documento restrito relevante encontrado — as movimentações
          // em si foram coletadas com sucesso, então manda só elas em vez de
          // descartar tudo como erro.
          this.logger.warn(`⚠️ Nenhum documento encontrado para ${numero}`);
          const resp = normalizeResponse(
            numero,
            result as ProcessosResponse[],
            '',
            {
              origem,
              webhookId: `${correlationId}:docs-empty`,
            },
          );
          await sendOnce(resp);
        } else {
          const docsResult = documentos;
          const docsResponse = normalizeResponse(numero, docsResult, '', {
            autos: true,
            origem,
            webhookId: `${correlationId}:autos-success`,
          });
          await sendOnce(docsResponse);
        }
      } catch (docError) {
        // Falha ao buscar os documentos restritos, mas as movimentações já
        // foram coletadas com sucesso — manda o que temos em vez de perder
        // os dados de movimentação por causa de uma falha só nos documentos.
        this.logger.warn(
          `⚠️ Falha ao buscar documentos restritos para ${numero}, enviando webhook só com movimentações: ${docError instanceof Error ? docError.message : String(docError)}`,
        );
        const fallbackResponse = normalizeResponse(
          numero,
          result as ProcessosResponse[],
          '',
          {
            origem,
            webhookId: `${correlationId}:docs-error`,
          },
        );
        await sendOnce(fallbackResponse).catch((webhookErr) => {
          this.logger.error(
            `Falha ao enviar webhook de fallback (movimentações) para ${numero}: ${webhookErr instanceof Error ? webhookErr.stack : String(webhookErr)}`,
          );
        });
        throw docError instanceof Error
          ? docError
          : new Error(String(docError));
      } finally {
        try {
          await deleteByPattern(this.redis, `pje:token:captcha:${numero}*`, {
            log: (msg) => this.logger.debug(msg),
          });
          await deleteByPattern(this.redis, `tokencaptcha:${numero}*`, {
            log: (msg) => this.logger.debug(msg),
          });
        } catch (cleanupError) {
          this.logger.error(
            `Falha na limpeza de tokens para ${numero}: ${cleanupError instanceof Error ? cleanupError.stack : String(cleanupError)}`,
          );
        }
      }
    } catch (error) {
      this.logger.error(error);

      if (successWebhookSent) {
        throw error instanceof Error ? error : new Error(String(error));
      }

      const mensagem = axios.isAxiosError(error)
        ? `Erro PJE (HTTP ${error.response?.status ?? 'sem status'}): ${error.message}`
        : `Erro inesperado: ${error instanceof Error ? error.message : String(error)}`;

      const response: Root = normalizeResponse(numero, [], mensagem, {
        status: 'ERRO',
        motivoErro: 'PJE_ERRO',
        webhookId: `${correlationId}:process-error`,
        origem,
      });

      try {
        await axios.post(webhookUrl, response, { headers: webhookHeaders });
      } catch (webhookError) {
        this.logger.error(
          `Falha ao enviar webhook de erro para ${numero}: ${webhookError instanceof Error ? webhookError.stack : String(webhookError)}`,
        );
        // Não relança webhookError — preserva o erro original de scraping
      }

      throw error instanceof Error ? error : new Error(String(error));
    }
  }
}
