import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import * as fs from 'fs';
import Redis from 'ioredis';
import * as path from 'path';
import puppeteer from 'puppeteer';
import { userAgents } from 'src/utils/user-agents';

@Injectable()
export class DocumentoService {
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });
  private readonly logger = new Logger(DocumentoService.name);
  async execute(
    processId: number,
    regionTRT: number,
    instancia: string,
    cookies: string,
    processNumber: string,
  ): Promise<string> {
    try {
      if (!processId || !regionTRT || !instancia) {
        this.logger.error('Parâmetros inválidos fornecidos');
        return '';
      }

      // 🔹 Recupera tokenCaptcha específico do processo
      const tokenCaptchaKey = `pje:token:captcha:${processNumber}:${instancia}`;
      const tokenCaptcha = await this.redis.get(tokenCaptchaKey);

      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`;
      const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/integra?tokenCaptcha=${tokenCaptcha || ''}`;

      // 🔹 Extrai access_token_1g do cookie
      const match = cookies.match(/access_token_1g=([^;]+)/);
      const accessToken1g = match ? match[1] : null;

      if (!accessToken1g) {
        this.logger.warn('access_token_1g não encontrado no cookie');
      } else {
        console.log('Access Token:', accessToken1g);
      }

      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken1g}`,
          'x-grau-instancia': instancia,
          referer: `https://pje.${typeUrl}.jus.br/consultaprocessual/detalhe-processo/${processNumber}/${instancia}`,
          'user-agent':
            userAgents[Math.floor(Math.random() * userAgents.length)],
        },
        responseType: 'arraybuffer',
        withCredentials: true,
      });

      const buffer = Buffer.from(response.data);

      // cria pasta temp se não existir
      const tempDir = path.join(process.cwd(), 'tmp');
      if (!fs.existsSync(tempDir)) {
        fs.mkdirSync(tempDir, { recursive: true });
      }

      // gera nome de arquivo único
      const filePath = path.join(tempDir, `${processId}.pdf`);

      // salva no disco
      fs.writeFileSync(filePath, buffer);

      this.logger.log(`PDF salvo em: ${filePath}`);

      return filePath;
    } catch (error) {
      this.logger.error('Erro ao executar DocumentoService', error);
      throw error; // deixa o Nest lançar 500 mas logado corretamente
    }
  }

  async htmlToPdfBuffer(html: string) {
    const browser = await puppeteer.launch({
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--disable-dev-shm-usage',
        '--single-process',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0' });
      const pdfBuffer = await page.pdf({ format: 'A4' });
      return pdfBuffer;
    } finally {
      await browser.close();
    }
  }
}
