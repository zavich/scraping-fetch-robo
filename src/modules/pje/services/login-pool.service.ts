// login-pool.service.ts
import {
  Inject,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import axios from 'axios';
import { PjeLoginService } from './login.service';
import Redis from 'ioredis';
import { LoginErrorTrt } from 'src/utils/trt-validate';

@Injectable()
export class LoginPoolService {
  private readonly logger = new Logger(LoginPoolService.name);

  constructor(
    private readonly loginService: PjeLoginService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  // SEG-007: não armazenar credenciais como propriedade persistente — usar getter
  // para que os valores residam apenas em process.env (não duplicados no heap)
  private get contas(): { username: string; password: string }[] {
    return [
      {
        username: process.env.PJE_USER_FIRST as string,
        password: process.env.PJE_PASS_FIRST as string,
      },
      {
        username: process.env.PJE_USER_SECOND as string,
        password: process.env.PJE_PASS_SECOND as string,
      },
      {
        username: process.env.PJE_USER_THIRD as string,
        password: process.env.PJE_PASS_THIRD as string,
      },
      {
        username: process.env.PJE_USER_FOURTH as string,
        password: process.env.PJE_PASS_FOURTH as string,
      },
      {
        username: process.env.PJE_USER_FIFTH as string,
        password: process.env.PJE_PASS_FIFTH as string,
      },
      {
        username: process.env.PJE_USER_SIXTH as string,
        password: process.env.PJE_PASS_SIXTH as string,
      },
    ];
  }
  private contaIndex = 0;
  private contadorProcessos = 0;
  getConta(force = false): { username: string; password: string } {
    const contas = this.contas;
    if (force || this.contadorProcessos >= 5) {
      this.contaIndex = (this.contaIndex + 1) % contas.length;
      this.contadorProcessos = 0;
      // SEG-007: não logar credenciais — apenas o índice
      this.logger.debug(`🔄 Alternando para conta #${this.contaIndex + 1}`);
    }
    this.contadorProcessos++;
    return contas[this.contaIndex];
  }

  // Adicione um parâmetro opcional "simulateDown" para testes
  private async checkSiteAvailability(trt: number, simulateDown = false) {
    if (simulateDown) {
      this.logger.warn(`Simulando TRT-${trt} fora do ar`);
      throw new ServiceUnavailableException(
        `TRT-${trt} fora do ar (simulação)`,
      );
    }

    const loginUrl = `https://pje.trt${trt}.jus.br/primeirograu/login.seam`;
    try {
      const res = await axios.get(loginUrl, {
        timeout: 10000,
        validateStatus: () => true,
      });
      if (res.status >= 500) {
        throw new ServiceUnavailableException(
          `TRT-${trt} fora do ar (status ${res.status})`,
        );
      }
    } catch (err) {
      throw new ServiceUnavailableException(
        `Não foi possível acessar TRT-${trt}: ${err}`,
      );
    }
  }

  async getCookies(
    trt: number,
    processNumber: string,
  ): Promise<{
    cookies: string;
    account: { username: string; password: string };
  }> {
    const normalizedTrt = LoginErrorTrt.includes(trt) ? 2 : trt;
    if (normalizedTrt !== trt) {
      this.logger.warn(
        `TRT-${trt} usando fallback de sessão/login para TRT-${normalizedTrt}`,
      );
    }

    const redisKey = `pje:session:${normalizedTrt}`;
    const readyKey = `${redisKey}:ready`;
    const lockKey = `pje:lock:${normalizedTrt}`;
    const lockTTL = 60000;
    const waitInterval = 500;
    const maxWait = 60000;

    let cookies = await this.redis.get(redisKey);
    let usedAccount: { username: string; password: string } | null = null;

    // ✅ 1) Valida cookie salvo no Redis antes de qualquer coisa
    if (cookies) {
      this.logger.debug(`🔍 Validando cookie salvo do TRT-${normalizedTrt}...`);

      // Verifica TTL do cookie no Redis
      const ttl = await this.redis.ttl(redisKey);

      // 1) Se chave não existe → renovar
      if (ttl === -2) {
        this.logger.warn(
          `⚠️ Cookie TRT-${normalizedTrt} não existe no Redis. Renovando...`,
        );
        return await this.renovarSessao(
          normalizedTrt,
          redisKey,
          readyKey,
          processNumber,
        );
      }

      // 2) Verifica se cookie tem tokens essenciais
      const hasAccess = this.hasAnyValidJwtCookie(cookies, [
        'access_token',
        'access_token_1g',
      ]);
      const hasRefresh = this.hasAnyValidJwtCookie(cookies, [
        'refresh_token',
        'refresh_token_1g',
      ]);

      // Se cookie existe no Redis mas está quebrado → renovar
      if (!hasAccess || !hasRefresh) {
        this.logger.warn(
          `⚠️ Cookie TRT-${normalizedTrt} inválido (faltam tokens). Renovando sessão...`,
        );
        await this.redis.del(redisKey, readyKey);
        return await this.getCookies(normalizedTrt, processNumber);
      }

      // 3) Cookie válido
      this.logger.debug(
        `✅ Cookie TRT-${normalizedTrt} válido. Expira em ${ttl}s`,
      );
      usedAccount = this.getConta();
      return { cookies, account: usedAccount };
    }

    // ✅ 2) Se não existe cookie → checa disponibilidade do site antes do login
    await this.checkSiteAvailability(normalizedTrt);

    // ✅ 3) LOCK para garantir somente 1 login simultâneo
    const lockAcquired = await this.redis.set(
      lockKey,
      '1',
      'PX',
      lockTTL,
      'NX',
    );

    if (lockAcquired) {
      try {
        let success = false;
        let attempts = 0;

        while (!success && attempts < this.contas.length) {
          const account = this.getConta(attempts > 0);
          const { username, password } = account;

          this.logger.debug(
            `🔒 Tentando login TRT ${normalizedTrt} com conta ${username}...`,
          );

          try {
            const loginResult = await this.loginService.execute(
              normalizedTrt,
              username,
              password,
              processNumber,
            );

            if (!loginResult?.cookies || loginResult.cookies.length === 0)
              throw new Error(
                `Login TRT ${normalizedTrt} não retornou cookies.`,
              );

            cookies = loginResult.cookies;
            usedAccount = account;

            const hasAccess = this.hasAnyValidJwtCookie(cookies, [
              'access_token',
              'access_token_1g',
            ]);
            const hasRefresh = this.hasAnyValidJwtCookie(cookies, [
              'refresh_token',
              'refresh_token_1g',
            ]);

            if (!hasAccess || !hasRefresh) {
              throw new Error(
                `Login TRT ${normalizedTrt} retornou cookies inválidos.`,
              );
            }
            await this.redis.set(redisKey, cookies, 'EX', 3600);
            await this.redis.set(readyKey, '1', 'EX', 30);

            success = true;
          } catch (err: unknown) {
            if (
              err instanceof ServiceUnavailableException &&
              /fora do ar/.test(err.message)
            ) {
              this.logger.warn(
                `❌ Site TRT-${normalizedTrt} fora do ar, abortando login.`,
              );
              throw err;
            }
            this.logger.warn(
              `❌ Falha ao logar com conta ${username}, tentando próxima...`,
            );
            attempts++;
          }
        }

        if (!success) {
          this.logger.error(
            `Todas as contas falharam ao logar no TRT-${normalizedTrt}. Verificar credenciais e disponibilidade do site.`,
          );
          // Falha explicita: callers nao devem tratar isso como sucesso silencioso.
          throw new Error(
            `Login pool exausto para TRT-${normalizedTrt}: todas as contas falharam`,
          );
        }

        this.logger.debug(
          `✅ Login TRT-${normalizedTrt} concluído com sucesso. Retornando cookie da sessão.`,
        );
        return { cookies: cookies!, account: usedAccount! };
      } finally {
        await this.redis.del(lockKey);
      }
    }

    // ✅ 4) Espera cookie gerado por outro worker, se for o caso
    const start = Date.now();
    while (!cookies && Date.now() - start < maxWait) {
      const ready = await this.redis.get(readyKey);
      if (ready) {
        cookies = await this.redis.get(redisKey);
        if (cookies) {
          usedAccount = this.getConta(true); // fallback
          break;
        }
      }
      // Se o lock sumiu mas readyKey não foi setado, o holder falhou
      const lockStillExists = await this.redis.exists(lockKey);
      if (!lockStillExists) {
        this.logger.warn(
          `⚠️ Lock TRT ${normalizedTrt} expirou sem readyKey — holder falhou. Tentando login próprio.`,
        );
        break;
      }
      await new Promise((r) => setTimeout(r, waitInterval));
    }

    // ✅ 5) Timeout → força login com outra conta
    if (!cookies) {
      this.logger.warn(
        `⚠️ Timeout esperando cookie TRT ${normalizedTrt}, forçando nova conta.`,
      );

      const account = this.getConta(true);
      const loginResult = await this.loginService.execute(
        normalizedTrt,
        account.username,
        account.password,
        processNumber,
      );

      cookies = loginResult.cookies;
      usedAccount = account;

      await this.redis.set(redisKey, cookies, 'EX', 3600);
      await this.redis.set(readyKey, '1', 'EX', 30);
    }

    return { cookies: cookies, account: usedAccount! };
  }

  async forceRefreshCookies(
    trt: number,
    number: string,
  ): Promise<{
    cookies: string;
    account: { username: string; password: string };
  }> {
    const normalizedTrt = LoginErrorTrt.includes(trt) ? 2 : trt;
    const redisKey = `pje:session:${normalizedTrt}`;
    const readyKey = `${redisKey}:ready`;
    await this.redis.del(redisKey, readyKey);
    return this.getCookies(normalizedTrt, number); // Isso vai gerar um novo login
  }
  private async renovarSessao(
    trt: number,
    redisKey: string,
    readyKey: string,
    processNumber: string,
  ): Promise<{
    cookies: string;
    account: { username: string; password: string };
  }> {
    await this.redis.del(redisKey, readyKey);

    const account = this.getConta(true);

    const loginResult = await this.loginService.execute(
      trt,
      account.username,
      account.password,
      processNumber,
    );

    const newCookies = loginResult.cookies;

    await this.redis.set(redisKey, newCookies, 'EX', 3600);
    await this.redis.set(readyKey, '1', 'EX', 30);

    return { cookies: newCookies, account };
  }

  private hasValidJwtCookie(cookieHeader: string, cookieName: string): boolean {
    // (?:^|;\s*) exige boundary: evita match parcial em nomes que CONTÊM cookieName
    const match = cookieHeader.match(
      new RegExp(`(?:^|;\\s*)${cookieName}=([^;]+)`),
    );

    if (!match?.[1]) {
      return false;
    }

    const token = match[1];
    const parts = token.split('.');
    if (parts.length !== 3) {
      return false;
    }

    try {
      const payload = JSON.parse(
        Buffer.from(parts[1], 'base64url').toString('utf8'),
      ) as { exp?: number };

      return typeof payload.exp === 'number' && payload.exp * 1000 > Date.now();
    } catch {
      return false;
    }
  }

  private hasAnyValidJwtCookie(
    cookieHeader: string,
    cookieNames: string[],
  ): boolean {
    return cookieNames.some((cookieName) =>
      this.hasValidJwtCookie(cookieHeader, cookieName),
    );
  }
}
