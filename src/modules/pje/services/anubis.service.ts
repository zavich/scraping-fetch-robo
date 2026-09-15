import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import Redis from 'ioredis';
// `puppeteer` puro, NÃO `puppeteer-extra`: o StealthPlugin é registrado
// globalmente em browser.manager.ts e é específico de Chromium. Aplicá-lo a um
// Firefox é, no melhor caso, inócuo, e no pior injeta patch de `navigator` que
// não corresponde ao motor — exatamente o tipo de incoerência que um anti-bot
// procura.
import type { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer';

/**
 * Cookies do Anubis (Techaro), o anti-bot de prova-de-trabalho que alguns
 * tribunais colocaram na frente do domínio inteiro.
 *
 * Portado de `anubis_block.py` (communication-ingestor-juri), onde a solução
 * foi validada ao vivo em 08/09/2026: 54 SUCESSO em ~4 min, 0 resposta vazia,
 * 0 bloqueio, em 3 instâncias sa-east-1.
 *
 * Três achados de campo que o código precisa respeitar, e que não são óbvios:
 *
 * 1. VISITAR PÁGINA HTML, NUNCA A API. Ir direto no endpoint da API devolve
 *    500 "administrator has misconfigured Anubis". O desafio só é servido na
 *    navegação normal.
 *
 * 2. FIREFOX, NÃO CHROMIUM. De um host sa-east-1 real, Chromium headless leva
 *    403 do CloudFront ANTES de alcançar o Anubis — com ou sem os flags
 *    anti-detecção que o projeto já usa. Firefox passa e resolve em ~6s. Bate
 *    com o perfil TLS: `firefoxNNN` é o único que nunca leva 403.
 *
 * 3. SÓ FUNCIONA DE DENTRO DO BRASIL. Testado em 8 regiões fora e 21 perfis
 *    TLS cada: 100% bloqueado, antes mesmo do Anubis. Não é fingerprint, é
 *    origem — provavelmente allowlist de IP. Mover esta carga de sa-east-1
 *    para tudo.
 *
 * 4. O COOKIE SOZINHO NÃO BASTA. Medido em 15/09/2026 contra o CNJ
 *    0000661-71.2015.5.23.0071: com o cookie Anubis válido, `fetch` do Node
 *    leva 403; a MESMA requisição feita de dentro do Firefox devolve 200. O
 *    cookie só é aceito junto com o fingerprint TLS do motor que o obteve.
 *
 *    É por isso que este serviço não expõe "pegue o cookie" e sim "faça a
 *    requisição": a chamada precisa SAIR do Firefox. O original em Python não
 *    tem esse problema porque usa `curl_cffi` com perfil `firefoxNNN`, que
 *    imita o TLS do Firefox — não há equivalente em uso neste projeto.
 *
 * Duas diferenças deliberadas em relação ao original:
 *
 *   O cache de cookie vai no REDIS, não em memória: o Python roda num processo
 *   só, aqui a frota tem vários workers e cada um resolveria o próprio desafio.
 *
 *   A página do Firefox fica VIVA entre requisições. Levantar browser por
 *   chamada custaria ~6s cada; mantida, o custo é só da primeira.
 */
export interface RespostaAnubis {
  status: number;
  corpo: string;
  headers: Record<string, string>;
}

@Injectable()
export class AnubisService implements OnModuleDestroy {
  private readonly sessoes = new Map<
    number,
    { browser: Browser; page: Page; expiraEm: number }
  >();
  private readonly fila = new Map<number, Promise<void>>();

  private readonly logger = new Logger(AnubisService.name);

  /** TRTs atrás do Anubis. TRT23 confirmado em 08/09/2026. */
  private static readonly TRTS = new Set(
    (process.env.ANUBIS_TRTS ?? '23')
      .split(',')
      .map((t) => Number(t.trim()))
      .filter((t) => Number.isInteger(t) && t > 0),
  );

  private static readonly TIMEOUT_MS = Number(
    process.env.ANUBIS_REFRESH_TIMEOUT_MS ?? 60_000,
  );

  /**
   * Cada tentativa custa um browser inteiro. Sem cooldown, um Anubis fora do
   * ar vira tempestade de re-tentativa — cada worker subindo Firefox em loop.
   */
  private static readonly COOLDOWN_S = Number(
    process.env.ANUBIS_REFRESH_FAILURE_COOLDOWN_S ?? 300,
  );

  /** Evita que N workers resolvam o mesmo desafio ao mesmo tempo. */
  private static readonly LOCK_TTL_S = 90;

  /**
   * Teto de vida do browser, independente do prazo do cookie.
   *
   * O JWT do Anubis vem com validade longa — medido em 15/09/2026, ~7 dias.
   * Segurar um Firefox aberto por uma semana troca o custo de re-resolver o
   * desafio (~4s) por vazamento de memória e uma sessão que ninguém sabe se
   * ainda está de pé. Uma hora é curto o bastante para o processo não engordar
   * e longo o bastante para o custo de recriar ser irrelevante.
   */
  private static readonly SESSAO_MAX_S = Number(
    process.env.ANUBIS_SESSAO_MAX_S ?? 3600,
  );

  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}

  estaAtras(regionTRT: number): boolean {
    return AnubisService.TRTS.has(regionTRT);
  }

  /**
   * Faz a requisição DE DENTRO do Firefox que resolveu o desafio.
   *
   * Não existe versão "me dê o cookie e eu chamo pelo axios": ver achado (4)
   * no topo — o cookie só vale acompanhado do fingerprint TLS do motor.
   *
   * Devolve `null` quando o TRT não está atrás do Anubis (o chamador segue
   * pelo caminho normal) ou quando o desafio não pôde ser resolvido.
   */
  async requisitar(
    regionTRT: number,
    url: string,
    headers: Record<string, string>,
  ): Promise<RespostaAnubis | null> {
    if (!this.estaAtras(regionTRT)) return null;

    // Uma página por TRT, uma requisição por vez: são chamadas de dentro de um
    // browser, não um pool HTTP. Serializar é o que evita corrida por cookie e
    // por contexto — o ganho de paralelismo aqui não compensaria o risco de
    // invalidar a sessão do desafio.
    const anterior = this.fila.get(regionTRT) ?? Promise.resolve();
    const atual = anterior
      .catch(() => undefined)
      .then(() => this.requisitarSerial(regionTRT, url, headers));
    this.fila.set(
      regionTRT,
      atual.then(
        () => undefined,
        () => undefined,
      ),
    );
    return atual;
  }

  private async requisitarSerial(
    regionTRT: number,
    url: string,
    headers: Record<string, string>,
  ): Promise<RespostaAnubis | null> {
    try {
      const page = await this.paginaPronta(regionTRT);
      if (!page) return null;

      // Os headers de resposta importam: `fetchProcess` lê `captchatoken`
      // dali. Como a chamada é same-origin dentro do browser, todos estão
      // acessíveis — de fora seriam filtrados pelo CORS.
      return await page.evaluate(
        async (u: string, h: Record<string, string>) => {
          const r = await fetch(u, { headers: h, credentials: 'include' });
          const cabecalhos: Record<string, string> = {};
          r.headers.forEach((v, k) => {
            cabecalhos[k.toLowerCase()] = v;
          });
          return {
            status: r.status,
            corpo: await r.text(),
            headers: cabecalhos,
          };
        },
        url,
        headers,
      );
    } catch (erro) {
      this.logger.warn(
        `anubis: requisição ao TRT${regionTRT} falhou: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      // Página pode ter morrido junto — descarta para a próxima recriar.
      await this.descartar(regionTRT);
      return null;
    }
  }

  /**
   * Página do Firefox com o desafio já resolvido, criada sob demanda e
   * reaproveitada. Reciclada quando o cookie de auth some do contexto, que é o
   * sinal de que o desafio expirou.
   */
  private async paginaPronta(regionTRT: number): Promise<Page | null> {
    const viva = this.sessoes.get(regionTRT);
    if (viva && !viva.page.isClosed()) {
      const aindaVale = (await viva.browser.cookies()).some((c) =>
        c.name.includes('anubis-auth'),
      );
      if (aindaVale && Date.now() < viva.expiraEm) return viva.page;
      await this.descartar(regionTRT);
    }

    if (await this.redis.exists(this.chaveFalha(regionTRT))) return null;

    const lock = await this.redis.set(
      this.chaveLock(regionTRT),
      '1',
      'EX',
      AnubisService.LOCK_TTL_S,
      'NX',
    );
    if (!lock) return null;

    let browser: Browser | null = null;
    try {
      browser = await puppeteer.launch({
        browser: 'firefox',
        executablePath: process.env.FIREFOX_EXECUTABLE_PATH,
        headless: true,
        timeout: AnubisService.TIMEOUT_MS,
        protocolTimeout: AnubisService.TIMEOUT_MS + 30_000,
      });
      const page = await browser.newPage();
      await page.goto(
        `https://pje.trt${regionTRT}.jus.br/consultaprocessual/`,
        {
          timeout: AnubisService.TIMEOUT_MS,
          waitUntil: 'domcontentloaded',
        },
      );

      const limite = Date.now() + AnubisService.TIMEOUT_MS;
      let cookies: { name: string; value: string }[] = [];
      while (Date.now() < limite) {
        cookies = (await browser.cookies()).filter((c) =>
          c.name.startsWith('techaro.lol-anubis-'),
        );
        if (cookies.some((c) => c.name.includes('auth'))) break;
        await new Promise((r) => setTimeout(r, 500));
      }

      if (!cookies.some((c) => c.name.includes('auth'))) {
        await browser.close().catch(() => undefined);
        await this.redis.set(
          this.chaveFalha(regionTRT),
          '1',
          'EX',
          AnubisService.COOLDOWN_S,
        );
        this.logger.warn(
          `anubis: desafio do TRT${regionTRT} não resolveu — pausando por ${AnubisService.COOLDOWN_S}s`,
        );
        return null;
      }

      const ttl = this.ttlDoJwt(
        Object.fromEntries(cookies.map((c) => [c.name, c.value])),
      );
      const vida = Math.min(ttl, AnubisService.SESSAO_MAX_S);
      this.sessoes.set(regionTRT, {
        browser,
        page,
        expiraEm: Date.now() + vida * 1000,
      });
      await this.redis.del(this.chaveFalha(regionTRT));
      this.logger.log(
        `anubis: sessão do TRT${regionTRT} pronta — cookie vale ${ttl}s, browser reciclado em ${vida}s`,
      );
      return page;
    } catch (erro) {
      await browser?.close().catch(() => undefined);
      await this.redis.set(
        this.chaveFalha(regionTRT),
        '1',
        'EX',
        AnubisService.COOLDOWN_S,
      );
      this.logger.warn(
        `anubis: falha ao abrir sessão do TRT${regionTRT}: ${erro instanceof Error ? erro.message : String(erro)}`,
      );
      return null;
    } finally {
      await this.redis.del(this.chaveLock(regionTRT));
    }
  }

  private async descartar(regionTRT: number): Promise<void> {
    const s = this.sessoes.get(regionTRT);
    this.sessoes.delete(regionTRT);
    await s?.browser.close().catch(() => undefined);
  }

  /** Fecha os browsers no shutdown — senão ficam Firefox órfãos no container. */
  async onModuleDestroy(): Promise<void> {
    for (const trt of [...this.sessoes.keys()]) await this.descartar(trt);
  }

  private chaveCache = (trt: number) => `anubis:cookies:trt${trt}`;
  private chaveFalha = (trt: number) => `anubis:falha:trt${trt}`;
  private chaveLock = (trt: number) => `anubis:lock:trt${trt}`;

  /**
   * Prazo do cookie, lido do `exp` do JWT em `techaro.lol-anubis-auth-*`.
   *
   * A assinatura NÃO é verificada de propósito: quem valida é o tribunal a
   * cada chamada. Aqui só se quer saber quando renovar. Margem de 1h para
   * nunca usar cookie vencido por um triz, e piso de 5 min para um `exp`
   * estranho não virar renovação em loop.
   */
  private ttlDoJwt(cookies: Record<string, string>): number {
    for (const [nome, valor] of Object.entries(cookies)) {
      if (!nome.includes('anubis-auth')) continue;
      try {
        const payload = JSON.parse(
          Buffer.from(valor.split('.')[1], 'base64url').toString('utf8'),
        ) as { exp?: number };
        if (typeof payload.exp === 'number') {
          return Math.max(
            300,
            Math.floor(payload.exp - Date.now() / 1000 - 3600),
          );
        }
      } catch {
        continue;
      }
    }
    // Sem `exp` legível, 6h — conservador o bastante para nunca cachear "para
    // sempre" por engano.
    return 6 * 3600;
  }
}
