import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Queue } from 'bullmq';
import { BrowserManager } from './utils/browser.manager';
async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = process.env.PORT || 8081;
  app.enableCors({
    origin: ['https://api.analisesprosolutti.com'],
    credentials: true, // Permite o envio de cookies
  });

  process.on('SIGINT', () => {
    (async () => {
      console.log('🧹 Encerrando browser...');
      const browser = await BrowserManager.getBrowser();
      await browser.close().catch(() => {});
      process.exit(0);
    })();
  });
  if (process.env?.ENVIRONMENT !== 'production') {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/bull-board');

    // Pega as filas registradas no AppModule
    const documentosQueue = app.get<Queue>(`BullQueue_pje-documentos`);
    const processosQueue = app.get<Queue>(`BullQueue_pje-processos`);

    createBullBoard({
      queues: [
        new BullMQAdapter(documentosQueue),
        new BullMQAdapter(processosQueue),
      ],
      serverAdapter,
    });

    app.use('/bull-board', serverAdapter.getRouter());
  }
  await app.listen(port);
}
bootstrap();
