// login-pool.service.ts
import { Injectable, Logger } from '@nestjs/common';
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

  async getCookies(trt: number): Promise<string> {
    const redisKey = `pje:session:${trt}`;
    try {
      let cookies = await this.redis.get(redisKey);

      if (!cookies) {
        const lockKey = `pje:lock:${trt}`;
        const lockAcquired = await (this.redis as any).set(
          lockKey,
          '1',
          'NX',
          'PX',
          10000,
        ); // lock 10s

        if (lockAcquired) {
          try {
            let loginSuccess = false;
            let lastError: any = null;

            for (let i = 0; i < this.contas.length; i++) {
              const { username, password } = this.getConta(true); // força alternância
              this.logger.debug(
                `🔒 Tentativa de login TRT ${trt} com ${username}...`,
              );
              try {
                const loginResult = await this.loginService.execute(
                  trt,
                  username,
                  password,
                );
                cookies = loginResult.cookies;
                loginSuccess = true;
                break; // saiu do loop se logou
              } catch (error) {
                lastError = error;
                this.logger.warn(`Conta ${username} falhou: ${error.message}`);
              }
            }

            if (!loginSuccess) {
              throw new Error(
                `Não foi possível acessar o PJe. Último erro: ${lastError?.message}`,
              );
            }

            // ✅ garante que foi salvo antes de liberar o lock
            if (cookies !== null) {
              await this.redis.set(redisKey, cookies, 'EX', 3600);
            } else {
              throw new Error('Cookies is null, cannot save to Redis');
            }
            await this.redis.set(`${redisKey}:ready`, '1', 'EX', 15);
          } finally {
            await this.redis.del(lockKey);
          }
        } else {
          // outro worker está logando, espera até cookie estar disponível
          let retries = 50;
          while (retries > 0 && !cookies) {
            await new Promise((r) => setTimeout(r, 500)); // espera 200ms
            cookies = await this.redis.get(redisKey);
            retries--;
          }

          if (!cookies) {
            throw new Error(`Não foi possível obter cookie para TRT ${trt}`);
          }
        }
      }
      const response = await axios.get(
        `https://pje.trt${trt}.jus.br/pje-consulta-api/api/auth/pje`,
        {
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
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

      // Converte string de cookie para objeto
      cookies.split(';').forEach((cookie) => {
        const [key, value] = cookie.split('=').map((c) => c.trim());
        if (key && value) cookieObj[key] = value;
      });

      // Atualiza token
      cookieObj.access_token_1g = response.data.access_token;

      // Converte de volta para string
      const updatedCookies = Object.entries(cookieObj)
        .map(([k, v]) => `${k}=${v}`)
        .join('; ');

      // Salva no Redis novamente
      await this.redis.set(redisKey, updatedCookies, 'EX', 3600);
      cookies = updatedCookies;

      return cookies;
    } catch (error) {
      if (error.response?.data?.codigoErro === 'ARQ-028') {
        this.logger.debug(`❌ Cookie expirado para TRT ${trt}, renovando...`);
        await this.redis.del(redisKey);
        return this.getCookies(trt); // força nova conta
      }
      this.logger.error(
        `Erro ao obter cookies para TRT ${trt}: ${error.message}`,
      );

      // ✅ Garante retorno consistente (evita erro de tipo)
      throw new Error(`Falha ao obter cookies para TRT ${trt}`);
    }
  }
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
}
