import { Inject, Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import * as fs from 'fs';
import Redis from 'ioredis';
import * as path from 'path';

@Injectable()
export class FetchDocumentoService {
  constructor(@Inject('REDIS_CLIENT') private readonly redis: Redis) {}
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
      const cookies = (await this.redis.get(redisKey)) || '';
      const awsWafTokenKey = `aws-waf-token:${processNumber}`;
      const awsWafToken = await this.redis.get(awsWafTokenKey);
      // 🔹 tokenCaptcha
      this.logger.debug(
        `Iniciando busca do tokenCaptcha para o processo ${processNumber}, instância ${instancia}`,
      );

      const catchaTokenRedisKey = `tokencaptcha:${processNumber}:${instancia}`;
      let tokenCaptcha = await this.redis.get(catchaTokenRedisKey);

      // fallback entre instâncias
      if (!tokenCaptcha) {
        this.logger.warn(
          `⚠️ Nenhum tokenCaptcha para ${processNumber} (instância ${instancia}), tentando fallback...`,
        );

        for (const inst of ['1', '2', '3']) {
          if (inst === instancia) continue;

          const alternativaKey = `tokencaptcha:${processNumber}:${inst}`;
          tokenCaptcha = await this.redis.get(alternativaKey);

          if (tokenCaptcha) {
            this.logger.debug(
              `Token encontrado na instância ${inst}: ${tokenCaptcha}`,
            );
            break;
          }
        }
      }

      if (!tokenCaptcha) {
        this.logger.warn(
          `⚠️ Nenhum tokenCaptcha encontrado para ${processNumber}`,
        );
      }

      // 🔹 URL
      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;
      const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/integra?tokenCaptcha=${tokenCaptcha || ''}`;

      // 🔹 extrai token do cookie
      const match = cookies.match(/access_token_1g=([^;]+)/);
      const accessToken1g = match?.[1];

      if (!accessToken1g) {
        this.logger.error(`❌ access_token_1g não encontrado no cookie`);
        throw new Error('Sessão inválida (sem access_token_1g)');
      }
      // 🔹 headers
      const headers = {
        Authorization: `Bearer ${accessToken1g}`,
        'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
        Cookie: `${awsWafToken || ''}`, // 👈 importante juntar tudo
        'x-grau-instancia': instancia,
        referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instancia}`,
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
        accept: 'application/json, text/plain, */*',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'sec-ch-ua': '"Chromium";v="146", "Not A(Brand";v="99"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"Windows"',
      };
      if (awsWafToken) {
        headers['Cookie'] = `${awsWafToken}`;
      }
      const response = await axios.get(url, {
        headers,
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
      this.logger.error(
        `Erro ao buscar documento para processo ${processNumber}:`,
        error.message,
      );
      throw new Error('Erro ao executar DocumentoService');
    }
  }
}
