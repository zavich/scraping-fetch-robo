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

@Injectable()
export class LoginPoolService {
  private readonly logger = new Logger(LoginPoolService.name);

  constructor(
    private readonly loginService: PjeLoginService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {}

  private contas = [
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
  ];
  private contaIndex = 0;
  private contadorProcessos = 0;
  getConta(force = false): { username: string; password: string } {
    if (force || this.contadorProcessos >= 5) {
      this.contaIndex = (this.contaIndex + 1) % this.contas.length;
      this.contadorProcessos = 0;
      this.logger.debug(
        `🔄 Alternando para a conta: ${this.contas[this.contaIndex].username}`,
      );
    }
    this.contadorProcessos++;
    return this.contas[this.contaIndex];
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
    numero: string,
  ): Promise<{
    cookies: string;
    account: { username: string; password: string };
  }> {
    const redisKey = `pje:session:${trt}`;
    const readyKey = `${redisKey}:ready`;
    const lockKey = `pje:lock:${trt}`;
    const lockTTL = 15000;
    const waitInterval = 500;
    const maxWait = 60000;

    let cookies = await this.redis.get(redisKey);
    let usedAccount: { username: string; password: string } | null = null;

    // ✅ 1) Valida cookie salvo no Redis antes de qualquer coisa
    if (cookies) {
      this.logger.debug(`🔍 Validando cookie salvo do TRT-${trt}...`);

      // Verifica TTL do cookie no Redis
      const ttl = await this.redis.ttl(redisKey);

      // 1) Se chave não existe → renovar
      if (ttl === -2) {
        this.logger.warn(
          `⚠️ Cookie TRT-${trt} não existe no Redis. Renovando...`,
        );
        return await this.renovarSessao(trt, redisKey, readyKey, numero);
      }

      // 2) Verifica se cookie tem tokens essenciais
      const hasAccess = /access_token/.test(cookies);
      const hasRefresh = /refresh_token/.test(cookies);

      // Se cookie existe no Redis mas está quebrado → renovar
      if (!hasAccess || !hasRefresh) {
        this.logger.warn(
          `⚠️ Cookie TRT-${trt} inválido (faltam tokens). Renovando sessão...`,
        );
        await this.redis.del(redisKey, readyKey);
        return await this.getCookies(trt, numero);
      }

      // 3) Cookie válido
      this.logger.debug(`✅ Cookie TRT-${trt} válido. Expira em ${ttl}s`);
      usedAccount = this.getConta();
      return { cookies, account: usedAccount };
    }

    // ✅ 2) Se não existe cookie → checa disponibilidade do site antes do login
    await this.checkSiteAvailability(trt);

    // ✅ 3) LOCK para garantir somente 1 login simultâneo
    const lockAcquired = await (this.redis as any).set(
      lockKey,
      '1',
      'NX',
      'PX',
      lockTTL,
    );

    if (lockAcquired) {
      try {
        let success = false;
        let attempts = 0;

        while (!success && attempts < this.contas.length) {
          const account = this.getConta(attempts > 0);
          const { username, password } = account;

          this.logger.debug(
            `🔒 Tentando login TRT ${trt} com conta ${username}...`,
          );

          try {
            const loginResult = await this.loginService.execute(
              trt,
              username,
              password,
              numero,
            );

            if (!loginResult?.cookies || loginResult.cookies.length === 0)
              throw new Error(`Login TRT ${trt} não retornou cookies.`);

            cookies = loginResult.cookies;
            usedAccount = account;

            const hasAccess = /access_token/.test(cookies);
            const hasRefresh = /refresh_token/.test(cookies);

            if (!hasAccess || !hasRefresh) {
              throw new Error(`Login TRT ${trt} retornou cookies inválidos.`);
            }
            await this.redis.set(redisKey, cookies, 'EX', 3600);
            await this.redis.set(readyKey, '1', 'EX', 30);

            success = true;
          } catch (err: any) {
            if (
              err instanceof ServiceUnavailableException &&
              /fora do ar/.test(err.message)
            ) {
              this.logger.warn(
                `❌ Site TRT-${trt} fora do ar, abortando login.`,
              );
              throw err;
            }
            this.logger.warn(
              `❌ Falha ao logar com conta ${username}, tentando próxima...`,
            );
            attempts++;
          }
        }

        if (!success)
          throw new Error(
            `Não foi possível logar no TRT ${trt} com nenhuma conta.`,
          );

        await this.redis.del(lockKey);
      } catch (err) {
        await this.redis.del(lockKey);
        throw err;
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
      await new Promise((r) => setTimeout(r, waitInterval));
    }

    // ✅ 5) Timeout → força login com outra conta
    if (!cookies) {
      this.logger.warn(
        `⚠️ Timeout esperando cookie TRT ${trt}, forçando nova conta.`,
      );

      const account = this.getConta(true);
      const loginResult = await this.loginService.execute(
        trt,
        account.username,
        account.password,
        numero,
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
    numero: string,
  ): Promise<{
    cookies: string;
    account: { username: string; password: string };
  }> {
    const redisKey = `pje:session:${trt}`;
    const readyKey = `${redisKey}:ready`;
    await this.redis.del(redisKey, readyKey);
    return this.getCookies(trt, numero); // Isso vai gerar um novo login
  }
  private async renovarSessao(
    trt: number,
    redisKey: string,
    readyKey: string,
    numero: string,
  ) {
    await this.redis.del(redisKey, readyKey);

    const account = this.getConta(true);

    const loginResult = await this.loginService.execute(
      trt,
      account.username,
      account.password,
      numero,
    );

    const newCookies = loginResult.cookies;

    await this.redis.set(redisKey, newCookies, 'EX', 3600);
    await this.redis.set(readyKey, '1', 'EX', 30);

    return { cookies: newCookies, account };
  }
}
