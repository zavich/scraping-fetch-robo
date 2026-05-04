import { Injectable, Logger } from '@nestjs/common';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import axios from 'axios';
import { CaptchaService } from 'src/services/captcha.service';
import { AwsS3Service } from 'src/services/aws-s3.service';
import { BrowserManager } from 'src/utils/browser.manager';

@Injectable()
export class CndtScraperService {
  private readonly logger = new Logger(CndtScraperService.name);

  constructor(
    private readonly captchaService: CaptchaService,
    private readonly awsS3Service: AwsS3Service,
  ) {}

  async execute(cnpj: string) {
    this.logger.log(`Iniciando processo para CNPJ: ${cnpj}`);

    // 🚀 Agora usando BrowserManager
    const { page, context } = await BrowserManager.createPage();

    try {
      await page.goto('https://cndt-certidao.tst.jus.br/gerarCertidao.faces', {
        waitUntil: 'networkidle2',
        timeout: 60000,
      });

      // Preenche CNPJ
      await page.waitForSelector('input[name="gerarCertidaoForm:cpfCnpj"]', {
        visible: true,
        timeout: 120000,
      });
      await page.type('input[name="gerarCertidaoForm:cpfCnpj"]', cnpj, {
        delay: 120,
      });
      await new Promise((r) => setTimeout(r, 1200));
      // Captura captcha Base64
      await page.waitForSelector('#idImgBase64', { visible: true });

      const captchaBase64 = await page.$eval(
        '#idImgBase64',
        (img: HTMLImageElement) =>
          img.src.replace(/^data:image\/\w+;base64,/, ''),
      );

      // Resolve captcha via 2Captcha
      const solved = await this.captchaService.resolveCaptcha(captchaBase64);

      if (!solved?.resposta || typeof solved.resposta !== 'string') {
        this.logger.error('Resposta inválida do 2Captcha:', solved);
        throw new Error('Erro ao resolver captcha');
      }

      const resposta = solved.resposta.trim();
      this.logger.log(`Captcha resolvido: ${resposta}`);

      await page.type('#idCampoResposta', resposta, { delay: 100 });

      // --- Configura download ---
      const downloadPath = path.join(os.tmpdir(), 'cndt-downloads');
      if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

      const client = await page.target().createCDPSession();
      await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath,
      });

      // Limpa PDFs antigos
      fs.readdirSync(downloadPath)
        .filter((f) => f.endsWith('.pdf'))
        .forEach((f) => fs.unlinkSync(path.join(downloadPath, f)));

      // Emitir certidão
      await page.click('#gerarCertidaoForm\\:btnEmitirCertidao');

      const fileName: string = await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Timeout aguardando PDF')),
          60000,
        );

        const interval = setInterval(() => {
          const files = fs
            .readdirSync(downloadPath)
            .filter((f) => f.endsWith('.pdf'));
          if (files.length > 0) {
            clearInterval(interval);
            clearTimeout(timeout);
            resolve(path.join(downloadPath, files[0]));
          }
        }, 500);
      });

      const buffer = fs.readFileSync(fileName);

      // S3 Upload
      // const url = await this.awsS3Service.uploadPdf(
      //   buffer,
      //   path.basename(fileName),
      // );
      const fileKey = `${cnpj}_cndt_${Date.now()}.pdf`;
      await this.awsS3Service.uploadS3Object(
        process.env.AWS_S3_BUCKET_NAME as string,
        fileKey,
        buffer,
        'application/pdf',
      );
      this.logger.log(`PDF enviado para S3: ${fileKey}`);

      fs.unlinkSync(fileName);

      const webhookUrl = `${process.env.WEBHOOK_URL}/company/webhook?type=cndt`;

      await axios.post(
        webhookUrl,
        {
          cnpj,
          temp_link: fileKey,
        },
        {
          headers: { Authorization: `${process.env.AUTHORIZATION_ESCAVADOR}` },
        },
      );

      return { cnpj, url: fileKey };
    } catch (error) {
      this.logger.error('Erro no scraping CNDt:', error);
      throw error;
    } finally {
      // 🔥 Fecha apenas o contexto, mantendo o browser vivo
      await BrowserManager.closeContext(context);
    }
  }
}
