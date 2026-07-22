import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import Redis from 'ioredis';
import { CaptchaService } from 'src/services/captcha.service';
import { LoginErrorTrt } from 'src/utils/trt-validate';
import { userAgents } from 'src/utils/user-agents';

export interface LoginResponse {
  instancia: string;
  papel: string;
  interno: boolean;
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  xsrf_token: string;
}

@Injectable()
export class PjeLoginService {
  private readonly logger = new Logger(PjeLoginService.name);
  constructor(
    private readonly captchaService: CaptchaService,
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
  ) {
    // this.pool.init(); // inicializa o pool
  }
  async execute(
    regionTRT: number,
    username: string,
    password: string,
    number: string,
  ): Promise<{ cookies: string }> {
    const regionTRTValidate = LoginErrorTrt.includes(regionTRT) ? 2 : regionTRT;
    const url = `https://pje.trt${regionTRTValidate}.jus.br/pje-consulta-api/api/auth`;
    await new Promise((resolve) => setTimeout(resolve, 1000));
    const headersRedisRaw = await this.redis.get(`headers:${regionTRT}`);

    let headersRedis: Record<string, string> = {};
    if (headersRedisRaw) {
      try {
        headersRedis = JSON.parse(headersRedisRaw) as Record<string, string>;
      } catch (e) {
        this.logger.warn(
          'Falha ao fazer parse dos headers do Redis, usando objeto vazio.',
        );
        headersRedis = {};
      }
    } else {
      headersRedis = {
        'x-grau-instancia': '1',
        accept: 'application/json, text/plain, */*',
        'user-agent': userAgents[Math.floor(Math.random() * userAgents.length)],
        'content-type': 'application/json',
        'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
      };
    }
    const awsWafTokenKey = `aws-waf-token:${number}`;
    const awsWafToken = await this.redis.get(awsWafTokenKey);
    const headers = {
      ...headersRedis,
      referer: `https://pje.trt${regionTRTValidate}.jus.br/consultaprocessual/login`,
      Cookie: `${awsWafToken || ''}`,
    };

    const response = await axios.post(
      url,
      {
        login: username,
        senha: password,
      },
      {
        headers,
      },
    );
    const login = response.data as LoginResponse;
    const redisKey = `pje:session:${regionTRTValidate}`;
    const cookieString = `access_token_1g=${login.access_token}; refresh_token_1g=${login.refresh_token}; instancia=${login.instancia}`;
    await this.redis.set(
      redisKey,
      cookieString,
      'EX',
      login.expires_in || 3600,
    );
    this.logger.debug(`✅ Sessão Puppeteer salva em ${redisKey}`);
    return { cookies: cookieString };
  }
}
