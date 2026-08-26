/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/* eslint-disable @typescript-eslint/no-unsafe-member-access */
import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import {
  DetalheProcesso,
  ItensProcesso,
  ProcessosResponse,
} from 'src/interfaces';
import { CaptchaService } from 'src/services/captcha.service';
import {
  DocumentoExtraido,
  FetchPublicDocumentsService,
} from './fetch-public-documents.service';
import { userAgents } from 'src/utils/user-agents';
import { findUltimaInstancia } from 'src/utils/find-ultima-instancia';

interface AxiosLikeError {
  response?: { status?: number };
  code?: string;
  message?: string;
}

// Configura um timeout global para o axios
axios.defaults.timeout = 10000; // 10 segundos

@Injectable()
export class FetchUrlMovimentService {
  private readonly logger = new Logger(FetchUrlMovimentService.name);

  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly fetchPublicDocumentsService: FetchPublicDocumentsService,
  ) {}
  private async delay(ms: number) {
    return new Promise((res) => setTimeout(res, ms));
  }
  private getDelayMs(): number {
    return Math.floor(Math.random() * 10_001) + 5_000;
  }
  private buildAuthHeaders(sessionCookies: string): Record<string, string> {
    const match = sessionCookies.match(/access_token_1g=([^;]+)/);
    const accessToken1g = match?.[1];
    return accessToken1g ? { Authorization: `Bearer ${accessToken1g}` } : {};
  }

  async execute(
    numeroDoProcesso: string,
    origem?: string,
    sessionCookies?: string,
  ): Promise<Partial<ProcessosResponse>[]> {
    const regionTRT = numeroDoProcesso?.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const instances: Partial<ProcessosResponse>[] = [];

    try {
      const useLambdaCaptcha =
        process.env.USE_LAMBDA_CAPTCHA === 'true' &&
        !!process.env.LAMBDA_CAPTCHA_URL &&
        !!process.env.LAMBDA_CAPTCHA_API_KEY;
      const useBedrockCaptcha =
        process.env.USE_BEDROCK_CAPTCHA === 'true' &&
        !!process.env.AWS_S3_REGION &&
        !!process.env.GRID_SOLVER_LAMBDA_API_KEY &&
        !!process.env.GRID_SOLVER_LAMBDA_X_API_KEY;
      // Só exige saldo no 2Captcha quando ele é necessário. Com o Lambda
      // ativo para captchas de imagem E o Bedrock ativo para o grid do WAF,
      // o 2Captcha é irrelevante — se o Lambda falhar, o fallback reporta o
      // erro. Mas se o Bedrock estiver desativado/mal configurado, o fluxo
      // do WAF ainda depende do 2Captcha, então o saldo precisa ser validado.
      const shouldValidate2CaptchaBalance = !(useLambdaCaptcha && useBedrockCaptcha);

      if (shouldValidate2CaptchaBalance) {
        const balance = await this.captchaService.getBalance();
        if (balance < 0.001)
          throw new Error(`Saldo insuficiente no 2Captcha: ${balance}`);
      }

      // Sempre tenta as 3 instâncias (1º grau, 2º grau e TST) — o try/catch
      // por instância abaixo já lida com quem não existir para esse processo.
      const grauMax = 3;
      const initialGrau = 1;
      for (let i = initialGrau; i <= grauMax; i++) {
        try {
          // A 3ª instância é o TST — um domínio totalmente à parte do TRT de
          // origem, não "mais um grau" dentro do mesmo `pje.trt{regionTRT}`.
          // Usar o domínio do TRT pra consultar dadosbasicos da instância 3
          // fazia o PJE devolver vazio/sem id, e a instância era pulada.
          const typeUrl = i === 3 ? 'tst' : `trt${regionTRT}`;

          // Mesma chave usada em toda gravação/leitura de tokenCaptcha nesta
          // classe (`fetchProcess`/`refreshTokenCaptcha`, linhas ~199/306/423)
          // — antes lia de `pje:token:captcha:*`, uma chave em que nada nunca
          // grava, então o token recém-resolvido nunca era reaproveitado.
          const tokenCaptcha = (await this.redis.get(
            `tokencaptcha:${numeroDoProcesso}:${i}`,
          )) as string;
          const headersRedisRaw = await this.redis.get(`headers:${regionTRT}`);
          let headersRedis: Record<string, string> = {};
          if (headersRedisRaw) {
            try {
              headersRedis = JSON.parse(headersRedisRaw) as Record<
                string,
                string
              >;
            } catch (error: unknown) {
              this.logger.warn(
                'Falha ao fazer parse dos headers do Redis, usando objeto vazio.',
              );
              headersRedis = {};
            }
          } else {
            headersRedis = {
              'x-grau-instancia': i.toString(),
              referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${i}`,
              accept: 'application/json, text/plain, */*',
              'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
              'user-agent':
                userAgents[Math.floor(Math.random() * userAgents.length)],
            };
          }
          const awsWafTokenKey = `aws-waf-token:${numeroDoProcesso}`;
          const awsWafToken = await this.redis.get(awsWafTokenKey);

          const url = `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}`;
          // Resolve o desafio de captcha SEM autenticação — autenticar essa
          // etapa faz o PJE invalidar a resposta do captcha (visto em
          // produção: instância que resolvia de primeira sem login passou a
          // falhar sempre com Authorization/Cookie de sessão presentes).
          const headers = {
            ...headersRedis,
            referer: url,
            Cookie: `${awsWafToken || ''}`,
          };
          const data = await this.fetchDadosBasicos(
            `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/dadosbasicos/${numeroDoProcesso}`,
            headers,
            numeroDoProcesso,
            i,
          );

          const detalheProcesso = data[0];
          if (!detalheProcesso?.id) {
            this.logger.warn(
              `⚠️ dadosbasicos sem id para ${numeroDoProcesso} (instância ${i}), pulando`,
            );
            continue;
          }

          if (
            instances.some(
              (instance) => instance.id === Number(detalheProcesso.id),
            )
          ) {
            this.logger.warn(
              `ID ${detalheProcesso.id} já existe na instância ${i}. Ignorando duplicata.`,
            );
            continue;
          }

          let processoResponse = await this.fetchProcess(
            headers,
            numeroDoProcesso,
            detalheProcesso.id,
            i.toString(),
            tokenCaptcha,
          );

          // Caso retorne captcha, resolve e tenta de novo — em até 3
          // tentativas, já que a resolução pode vir com resposta errada e o
          // PJE simplesmente devolver outro desafio em vez dos dados reais.
          let captchaAttempts = 0;
          const temDesafioDeCaptcha = (resp: ProcessosResponse) =>
            !!resp &&
            'imagem' in resp &&
            'tokenDesafio' in resp &&
            !resp.itensProcesso?.length;

          while (temDesafioDeCaptcha(processoResponse) && captchaAttempts < 3) {
            captchaAttempts++;
            this.logger.warn(
              `⚠️ PJE retornou desafio de captcha para ${numeroDoProcesso} (instância ${i}), tentativa ${captchaAttempts}/3`,
            );
            const resposta = await this.fetchCaptcha(
              processoResponse.imagem,
              regionTRT,
            );
            processoResponse = await this.fetchProcess(
              headers,
              numeroDoProcesso,
              detalheProcesso.id,
              i.toString(),
              undefined,
              processoResponse.tokenDesafio,
              resposta,
            );
          }

          if (!processoResponse?.itensProcesso?.length) {
            this.logger.warn(
              `⚠️ Instância ${i} do processo ${numeroDoProcesso} não retornou itensProcesso após ${captchaAttempts} tentativa(s) de captcha`,
            );
          } else if (sessionCookies) {
            // Captcha já resolvido (tokenCaptcha válido salvo no Redis por
            // fetchProcess) — agora sim busca a versão autenticada, que traz
            // itensProcesso mais completo (com documentos restritos).
            const tokenCaptchaValido = await this.redis.get(
              `tokencaptcha:${numeroDoProcesso}:${i}`,
            );

            if (tokenCaptchaValido) {
              const authHeaders = {
                ...headers,
                ...this.buildAuthHeaders(sessionCookies),
                Cookie: [sessionCookies, awsWafToken]
                  .filter(Boolean)
                  .join('; '),
              };

              try {
                const authResponse = await this.fetchProcess(
                  authHeaders,
                  numeroDoProcesso,
                  detalheProcesso.id,
                  i.toString(),
                  tokenCaptchaValido,
                );

                if (authResponse?.itensProcesso?.length) {
                  processoResponse = authResponse;
                } else {
                  this.logger.warn(
                    `⚠️ Busca autenticada da instância ${i} não retornou itensProcesso, mantendo versão sem login`,
                  );
                }
              } catch (authError: unknown) {
                this.logger.warn(
                  `⚠️ Falha ao buscar versão autenticada da instância ${i} de ${numeroDoProcesso}: ${authError instanceof Error ? authError.message : String(authError)}`,
                );
              }
            }
          }

          if (processoResponse?.itensProcesso?.length) {
            const docs = processoResponse.itensProcesso.filter(
              (item) => item.documento,
            );
            const publicos = docs.filter((item) => item.publico).length;
            this.logger.log(
              `📊 Instância ${i} (${numeroDoProcesso}): ${docs.length} documento(s) no itensProcesso (${publicos} público(s), ${docs.length - publicos} restrito(s))`,
            );
          }

          // Não inclui a instância se ela ficou travada num desafio de
          // captcha não resolvido (só `imagem`/`tokenDesafio`, sem
          // `itensProcesso`) — sem isso, o worker via `instances.length > 0`
          // e tratava um payload incompleto como sucesso, mandando um
          // webhook com uma "instância" que na verdade é só um captcha.
          if (temDesafioDeCaptcha(processoResponse)) {
            this.logger.warn(
              `⚠️ Instância ${i} do processo ${numeroDoProcesso} ficou travada em desafio de captcha após ${captchaAttempts} tentativa(s) — não será incluída no resultado.`,
            );
            continue;
          }

          // Carimba o grau real (o `i` do loop) na resposta — o JSON do PJe
          // não vem com esse campo, e sem ele quem consome `instances` não
          // tem como saber a que grau cada elemento pertence quando alguma
          // instância é pulada (ex.: Ação Rescisória, que não tem 1º grau) e
          // a posição no array deixa de corresponder ao grau real.
          instances.push({ ...processoResponse, instance: i.toString() });
        } catch (err: unknown) {
          // Sempre continua pras próximas instâncias, mesmo quando a 1ª
          // falha — um 403/429/erro transitório na instância 1 (ex.: WAF,
          // rate limit) não significa que o processo não existe em 2º grau
          // ou no TST. Abortar o loop aqui fazia o worker devolver "nenhum
          // resultado encontrado" com dado real esperando nas outras
          // instâncias, nunca consultadas.
          if (i === 1) {
            this.logger.error(
              `Erro ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err}`,
            );
          } else {
            this.logger.warn(
              `Falha ao buscar instância ${i} para o processo ${numeroDoProcesso}: ${err}`,
            );
          }
          continue;
        }
      }

      return instances;
    } catch (error: unknown) {
      this.logger.error(`Erro ao buscar processo ${numeroDoProcesso}`, error);
      return [];
    }
  }

  // Mesmo retry-em-403/429 que já existe em `fetchProcess` — sem isso, um
  // bloqueio transitório do WAF na consulta de dadosbasicos (visto em
  // produção: falha na 1ª tentativa, mas passa ao rodar o job de novo minutos
  // depois) derrubava a instância inteira em vez de se recuperar sozinho.
  //
  // Não é por sessão/token (confirmado: nenhum aws-waf-token existe no Redis
  // nem antes nem depois de uma execução bem-sucedida) nem só por
  // `user-agent` (confirmado: 5 tentativas trocando o user-agent a cada uma,
  // sem nenhum delay entre elas, falharam as 5 com 403 — se fosse só o header,
  // pelo menos uma das 5 aleatórias teria passado). O que muda entre "falha
  // agora" e "funciona rodando de novo minutos depois" é só TEMPO — por isso
  // o retry agora espera um pouco (crescente) antes de cada nova tentativa,
  // além de trocar o user-agent.
  private async fetchDadosBasicos(
    url: string,
    headers: Record<string, string>,
    numeroDoProcesso: string,
    instance: number,
    attempt = 1,
  ): Promise<DetalheProcesso[]> {
    const retryStatus = [403, 429];
    const maxAttempts = 5;

    try {
      const { data } = await axios.get<DetalheProcesso[]>(url, { headers });
      return data;
    } catch (error: unknown) {
      const axiosError = error as AxiosLikeError;

      if (
        retryStatus.includes(axiosError.response?.status ?? 0) &&
        attempt < maxAttempts
      ) {
        const delayMs = 3000 * 2 ** (attempt - 1); // 3s, 6s, 12s, 24s
        this.logger.warn(
          `⚠️ dadosbasicos de ${numeroDoProcesso} (instância ${instance}) falhou com status ${axiosError.response?.status} — tentativa ${attempt}/${maxAttempts}, aguardando ${delayMs}ms e trocando user-agent`,
        );
        await this.delay(delayMs);
        const retryHeaders = {
          ...headers,
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
        };
        return this.fetchDadosBasicos(
          url,
          retryHeaders,
          numeroDoProcesso,
          instance,
          attempt + 1,
        );
      }

      throw error;
    }
  }

  async fetchProcess(
    headers: Record<string, string>,
    numeroDoProcesso: string,
    detalheProcessoId: string,
    instance: string,
    tockenCaptcha?: string,
    tokenDesafio?: string,
    resposta?: string,
    attempt = 1,
  ): Promise<ProcessosResponse> {
    const regionTRT = numeroDoProcesso.includes('.')
      ? Number(numeroDoProcesso.split('.')[3])
      : null;
    if (!regionTRT)
      throw new Error(`Invalid process number: ${numeroDoProcesso}`);

    const typeUrl = instance === '3' ? 'tst' : `trt${regionTRT}`;
    let url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${detalheProcessoId}`;
    if (tockenCaptcha)
      url += `?tokenCaptcha=${encodeURIComponent(tockenCaptcha)}`;
    else if (tokenDesafio && resposta)
      url += `?tokenDesafio=${encodeURIComponent(tokenDesafio)}&resposta=${encodeURIComponent(resposta)}`;

    try {
      const response = await axios.get<ProcessosResponse>(url, {
        headers,
      });
      const captchaToken = response.headers['captchatoken'] as string;
      this.logger.debug(
        `Token CAPTCHA recebido para ${numeroDoProcesso} (instância ${instance})`,
      );
      // Só grava quando vem um token novo — chamadas subsequentes (ex.: a
      // busca autenticada extra, que reaproveita um tokenCaptcha já válido)
      // não recebem um captchatoken novo, e gravar undefined aqui apagava o
      // token bom salvo segundos antes (ioredis grava undefined como '').
      if (captchaToken) {
        const catchaTokenRedisKey = `tokencaptcha:${numeroDoProcesso}:${instance}`;
        await this.redis.set(
          catchaTokenRedisKey,
          captchaToken,
          'EX',
          600, // expira em 10 minutos (captcha válido por ~5 min)
        );
      }
      return response.data;
    } catch (error: unknown) {
      const isTRT15 = regionTRT === 15;
      const retryStatus = [429, 403];
      const maxAttempts = isTRT15 ? 7 : 5;
      const axiosError = error as AxiosLikeError;

      if (
        retryStatus.includes(axiosError.response?.status ?? 0) &&
        attempt < maxAttempts
      ) {
        // REFRESH token CAPTCHA a cada tentativa TRT15
        const newTokenCaptcha =
          isTRT15 && attempt > 1 ? undefined : tockenCaptcha;

        return this.fetchProcess(
          headers,
          numeroDoProcesso,
          detalheProcessoId,
          instance,
          newTokenCaptcha,
          tokenDesafio,
          resposta,
          attempt + 1,
        );
      }

      throw error;
    }
  }

  // Renova o tokenCaptcha de uma instância/processo específico, repetindo o
  // mesmo desafio de captcha resolvido em `execute()` (o endpoint de
  // documento não tem desafio próprio — só consome um tokenCaptcha já
  // resolvido por aqui). Usado quando `FetchDocumentoService` detecta que o
  // token salvo no Redis foi rejeitado pelo PJe.
  async refreshTokenCaptcha(
    numeroDoProcesso: string,
    processId: number | string,
    instancia: string,
    regionTRT: number,
  ): Promise<string | null> {
    try {
      // Mesmo caso da instância 3 (TST) em `execute()` — domínio próprio,
      // não é "mais um grau" dentro do `pje.trt{regionTRT}`.
      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;

      const headersRedisRaw = await this.redis.get(`headers:${regionTRT}`);
      let headersRedis: Record<string, string> = {};
      if (headersRedisRaw) {
        try {
          headersRedis = JSON.parse(headersRedisRaw) as Record<string, string>;
        } catch (error: unknown) {
          headersRedis = {};
        }
      } else {
        headersRedis = {
          'x-grau-instancia': instancia,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instancia}`,
          accept: 'application/json, text/plain, */*',
          'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
        };
      }
      const awsWafToken = await this.redis.get(
        `aws-waf-token:${numeroDoProcesso}`,
      );
      const url = `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}`;
      const headers = {
        ...headersRedis,
        referer: url,
        Cookie: `${awsWafToken || ''}`,
      };

      let processoResponse = await this.fetchProcess(
        headers,
        numeroDoProcesso,
        String(processId),
        instancia,
      );

      const temDesafioDeCaptcha = (resp: ProcessosResponse) =>
        !!resp &&
        'imagem' in resp &&
        'tokenDesafio' in resp &&
        !resp.itensProcesso?.length;

      let tentativas = 0;
      while (temDesafioDeCaptcha(processoResponse) && tentativas < 3) {
        tentativas++;
        const resposta = await this.fetchCaptcha(
          processoResponse.imagem,
          regionTRT,
        );
        processoResponse = await this.fetchProcess(
          headers,
          numeroDoProcesso,
          String(processId),
          instancia,
          undefined,
          processoResponse.tokenDesafio,
          resposta,
        );
      }

      const tokenCaptchaRenovado = await this.redis.get(
        `tokencaptcha:${numeroDoProcesso}:${instancia}`,
      );

      if (!tokenCaptchaRenovado) {
        this.logger.warn(
          `⚠️ Não foi possível renovar o tokenCaptcha de ${numeroDoProcesso} (instância ${instancia})`,
        );
      }

      return tokenCaptchaRenovado || null;
    } catch (error: unknown) {
      this.logger.warn(
        `⚠️ Falha ao renovar tokenCaptcha de ${numeroDoProcesso} (instância ${instancia}): ${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }

  async fetchCaptcha(imagem: string, regionTRT?: number): Promise<string> {
    const MAX_RETRIES = 3;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const captcha = await this.captchaService.resolveCaptcha(
          imagem,
          regionTRT,
        );

        if (captcha?.resposta) {
          return captcha.resposta;
        }

        this.logger.warn(
          `Captcha vazio ou inválido na tentativa ${attempt}/${MAX_RETRIES}`,
        );
      } catch (error: unknown) {
        const nodeError = error as AxiosLikeError;
        // Erro clássico do DNS do Railway
        if (nodeError.code === 'ENOTFOUND') {
          this.logger.warn(
            `⚠️ DNS falhou ao resolver 2captcha.com (ENOTFOUND) — tentativa ${attempt}/${MAX_RETRIES}`,
          );
        } else {
          this.logger.error(
            `Erro ao buscar captcha (tentativa ${attempt}/${MAX_RETRIES}):`,
            nodeError.message,
          );
          throw error;
        }

        // Última tentativa → retorna vazio
        if (attempt === MAX_RETRIES) {
          return '';
        }

        // Pequeno delay entre os retries
        await new Promise((r) => setTimeout(r, 300 * attempt));
      }
    }

    // fallback final
    return '';
  }
  async fetchPublicDocuments(
    processNumber: string,
    instances: ProcessosResponse[],
    regionTRT: number,
    includeRestricted = false,
  ): Promise<DocumentoExtraido[]> {
    const ultimaInstancia = findUltimaInstancia(instances);

    if (!ultimaInstancia) {
      this.logger.warn(
        `⚠️ Nenhuma movimentação encontrada para ${processNumber}`,
      );
      return [];
    }

    const delayMs = this.getDelayMs();
    this.logger.debug(
      `⏱ Delay de ${delayMs}ms antes de buscar documentos públicos da ${ultimaInstancia.instance}ª instância`,
    );
    await this.delay(delayMs);

    // Quando includeRestricted, busca também os documentos restritos (todos,
    // sem filtro por título) via /documentos/{id}, sem depender do fluxo de
    // login + /integra.
    const filter = includeRestricted
      ? (item: ItensProcesso) =>
          Boolean(item.documento && item.idUnicoDocumento)
      : undefined;

    return this.fetchPublicDocumentsService.execute(
      ultimaInstancia.id,
      regionTRT,
      ultimaInstancia.instance,
      processNumber,
      ultimaInstancia.itensProcesso,
      filter,
    );
  }
}
