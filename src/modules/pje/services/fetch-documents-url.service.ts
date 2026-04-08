import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import * as fs from 'fs';
import Redis from 'ioredis';
import * as path from 'path';
import { CaptchaService } from 'src/services/captcha.service';

@Injectable()
export class FetchDocumentoService {
  constructor(
    @Inject('REDIS_CLIENT') private readonly redis: Redis,
    private readonly captchaService: CaptchaService,
  ) {}
  private readonly logger = new Logger(FetchDocumentoService.name);
  async execute(
    processId: number,
    regionTRT: number,
    instancia: string,
    processNumber: string,
  ): Promise<string> {
    try {
      if (!processId || !regionTRT || !instancia) {
        this.logger.error('Parâmetros inválidos fornecidos');
        return '';
      }
      const redisKey = `pje:session:${regionTRT}`;
      const cookies = (await this.redis.get(redisKey)) as string;
      // 🔹 Recupera tokenCaptcha específico do processo
      // Log detalhado para verificar o fluxo do tokenCaptcha
      this.logger.debug(
        `Iniciando busca do tokenCaptcha para o processo ${processNumber}, instância ${instancia}`,
      );

      // Tenta buscar a chave alternativa caso a original não exista
      const catchaTokenRedisKey = `tokencaptcha:${processNumber}:${instancia}`;
      let tokenCaptcha = await this.redis.get(catchaTokenRedisKey);

      if (!tokenCaptcha) {
        this.logger.warn(
          `⚠️ Nenhum tokenCaptcha encontrado para ${processNumber} (instância ${instancia}). Tentando outras instâncias...`,
        );

        // Itera por outras instâncias possíveis (1 e 2, por exemplo)
        const outrasInstancias = ['1', '2', '3'].filter(
          (inst) => inst !== instancia,
        );
        for (const inst of outrasInstancias) {
          const alternativaKey = `tokencaptcha:${processNumber}:${inst}`;
          tokenCaptcha = await this.redis.get(alternativaKey);
          if (tokenCaptcha) {
            this.logger.debug(
              `Token CAPTCHA encontrado para ${processNumber} na instância alternativa ${inst}: ${tokenCaptcha}`,
            );
            break;
          }
        }
      }

      if (!tokenCaptcha) {
        this.logger.warn(
          `⚠️ Nenhum tokenCaptcha encontrado para ${processNumber} em nenhuma instância`,
        );
      } else {
        this.logger.debug(`Token CAPTCHA obtido: ${tokenCaptcha}`);
      }

      const redisKeyAWS = `aws-waf-token:${processNumber}`;

      const aws = await this.redis.get(redisKeyAWS);
      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;
      const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/integra?tokenCaptcha=${tokenCaptcha || ''}`;

      // 🔹 Extrai access_token_1g do cookie
      const match = cookies.match(/access_token_1g=([^;]+)/);
      const accessToken1g = match ? match[1] : null;

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken1g}`,
          Cookie: `${aws}`,
          'x-grau-instancia': instancia,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instancia}`,
          'user-agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
          'sec-ch-ua':
            '"Chromium";v="146", "Not-A.Brand";v="24", "Google Chrome";v="146"',
          'sec-ch-ua-mobile': '?0',
          'sec-ch-ua-platform': '"macOS"',
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
        },
        timeout: 180000, // Aumente para 180 segundos para casos mais complexos
        responseType: 'arraybuffer',
        withCredentials: true,
      });

      // Validação do conteúdo antes de salvar como PDF
      if (!Buffer.isBuffer(response.data)) {
        this.logger.error(
          'Erro: O conteúdo retornado pela API não é um PDF válido.',
        );
        throw new Error('Invalid PDF structure.');
      }

      const buffer = Buffer.from(response.data);

      // cria pasta temp se não existir
      const tempDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      const sanitizedProcessNumber = processNumber.replace(/\D+/g, '');

      const fileName = `proc_${sanitizedProcessNumber}_${instancia}_${processId}_${Date.now()}_${Math.random()
        .toString(36)
        .slice(2, 8)}.pdf`;

      const filePath = path.join(tempDir, fileName);

      // salva no disco
      fs.writeFileSync(filePath, buffer);

      this.logger.log(`PDF salvo em: ${filePath}`);

      return filePath;
    } catch (error) {
      this.logger.error('Erro ao executar DocumentoService', error);
      throw error; // deixa o Nest lançar 500 mas logado corretamente
    }
  }
}
