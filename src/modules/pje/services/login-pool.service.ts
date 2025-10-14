// login-pool.service.ts
import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import Redis from 'ioredis';
import { PjeLoginService } from './login.service';
import axios from 'axios';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class LoginPoolService {
  private readonly logger = new Logger(LoginPoolService.name);
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });

  constructor(private readonly loginService: PjeLoginService) {}

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

  private getConta(force = false): { username: string; password: string } {
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

  async getCookies(trt: number): Promise<string> {
    const redisKey = `pje:session:${trt}`;
    const readyKey = `${redisKey}:ready`;
    const lockKey = `pje:lock:${trt}`;
    const lockTTL = 15000;
    const waitInterval = 500;
    const maxWait = 60000;

    let cookies = await this.redis.get(redisKey);
    if (cookies) return this.refreshToken(trt, cookies);

    // Checa disponibilidade do site antes de gastar contas
    await this.checkSiteAvailability(trt);

    // Tenta adquirir lock
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
          const { username, password } = this.getConta(attempts > 0);
          this.logger.debug(
            `🔒 Tentando login TRT ${trt} com conta ${username}...`,
          );

          try {
            const loginResult = await this.loginService.execute(
              trt,
              username,
              password,
            );
            cookies = loginResult.cookies;

            await this.redis.set(redisKey, cookies, 'EX', 3600);
            await this.redis.set(readyKey, '1', 'EX', 30);

            success = true;
          } catch (err: any) {
            // Se for erro de site (503), não tenta outra conta
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

        if (!success) {
          throw new Error(
            `Não foi possível logar no TRT ${trt} com nenhuma conta.`,
          );
        }
      } finally {
        await this.redis.del(lockKey);
      }

      return this.refreshToken(trt, cookies as string);
    }

    // Espera outro worker finalizar login
    const start = Date.now();
    while (!cookies && Date.now() - start < maxWait) {
      const ready = await this.redis.get(readyKey);
      if (ready) {
        cookies = await this.redis.get(redisKey);
        if (cookies) break;
      }
      await new Promise((r) => setTimeout(r, waitInterval));
    }

    if (!cookies) {
      // Nenhum cookie disponível após espera, tenta nova conta
      this.logger.warn(
        `⚠️ Timeout esperando cookie TRT ${trt}, forçando nova conta.`,
      );
      const { username, password } = this.getConta(true);
      const loginResult = await this.loginService.execute(
        trt,
        username,
        password,
      );
      cookies = loginResult.cookies;
      await this.redis.set(redisKey, cookies, 'EX', 3600);
      await this.redis.set(readyKey, '1', 'EX', 30);
    }

    return this.refreshToken(trt, cookies);
  }

  private async refreshToken(trt: number, cookies: string): Promise<string> {
    const redisKey = `pje:session:${trt}`;
    try {
      const response = await axios.get(
        `https://pje.trt${trt}.jus.br/pje-consulta-api/api/auth/pje`,
        {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9',
            'content-type': 'application/json',
            referer: `https://pje.trt${trt}.jus.br/consultaprocessual/`,
            'user-agent':
              userAgents[Math.floor(Math.random() * userAgents.length)],
            'x-grau-instancia': '1',
            Cookie: cookies,
          },
        },
      );

      const cookieObj: Record<string, string> = {};
      cookies.split(';').forEach((c) => {
        const [key, value] = c.split('=').map((x) => x.trim());
        if (key && value) cookieObj[key] = value;
      });

      cookieObj.access_token_1g = response.data.access_token;

      const updatedCookies = Object.entries(cookieObj)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      await this.redis.set(redisKey, updatedCookies, 'EX', 3600);
      return updatedCookies;
    } catch (err) {
      this.logger.warn(
        `❌ Não foi possível atualizar access_token TRT ${trt}, usando cookie existente.`,
      );
      return cookies;
    }
  }
}
