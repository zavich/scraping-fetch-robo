import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

import puppeteer from 'puppeteer';
import { userAgents } from 'src/utils/user-agents';
import { PjeLoginService } from './login.service';
import * as fs from 'fs';
import * as path from 'path';
import Redis from 'ioredis';

@Injectable()
export class DocumentoService {
  private readonly redis = new Redis({
    host: process.env.REDIS_HOST || 'redis',
    port: Number(process.env.REDIS_PORT) || 6379,
  });
  private readonly logger = new Logger(DocumentoService.name);
  constructor(private readonly loginService: PjeLoginService) {}
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
      const tokenCaptcha = await this.redis.get(
        `pje:token:captcha:${instancia}`,
      );
      const typeUrl = instancia === '3' ? 'tst' : `trt${regionTRT}`; // --- IGNORE ---

      const url = `https://pje.${typeUrl}.jus.br/pje-consulta-api/api/processos/${processId}/integra?tokenCaptcha=${tokenCaptcha}`;
      const response = await axios.get(url, {
        headers: {
          Cookie: cookies,
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
