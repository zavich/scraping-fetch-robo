import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ExpressAdapter } from '@bull-board/express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { Queue } from 'bullmq';
import { BrowserManager } from './utils/browser.manager';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = 8081;

  app.enableCors({
    origin: ['https://robo-api.juri.capital'],
    credentials: true,
  });

  // Fecha browser ao receber sinal de terminacao (Docker stop, Kubernetes)
  const gracefulShutdown = async (signal: string) => {
    console.log(`[${signal}] Encerrando servico gracefully...`);
    try {
      const browser = await BrowserManager.getBrowser();
      await browser.close().catch(() => {});
    } catch {}
    process.exit(0);
  };

  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

  // Previne crash do processo por promises nao tratadas
  process.on('unhandledRejection', (reason: unknown) => {
    console.error('[unhandledRejection] Promise rejeitada sem handler:', reason);
    // Log mas nao crasha — deixa o NestJS/BullMQ tratar o job
  });

  process.on('uncaughtException', async (error: Error) => {
    console.error('[uncaughtException] Excecao nao capturada:', error);
    try {
      const browser = await BrowserManager.getBrowser();
      await browser.close().catch(() => {});
    } catch {}
    process.exit(1);
  });
  // 🔥 Bull Board apenas fora de produção
  if (process.env?.ENVIRONMENT !== 'production') {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/bull-board');

    // ✅ Captura todas as filas dinamicamente
    const bullQueues: Queue[] = [];

    // 24 TRTs
    for (let i = 1; i <= 24; i++) {
      const queueName = `BullQueue_pje-trt${i}`;
      try {
        const queue = app.get<Queue>(queueName);
        if (queue) bullQueues.push(queue);
      } catch {}
    }
    for (let i = 1; i <= 24; i++) {
      const queueName = `BullQueue_pje-documentos-trt${i}`;
      try {
        const queue = app.get<Queue>(queueName);
        if (queue) bullQueues.push(queue);
      } catch {}
    }
    // Fila TST
    try {
      const tstQueue = app.get<Queue>('BullQueue_pje-tst');
      if (tstQueue) bullQueues.push(tstQueue);
    } catch {}

    // ✅ Inicializa o Bull Board com TODAS as filas
    createBullBoard({
      queues: bullQueues.map((q) => new BullMQAdapter(q)),
      serverAdapter,
    });

    app.use('/bull-board', serverAdapter.getRouter());

    console.log(
      `✅ Bull Board carregado com ${bullQueues.length} filas registradas`,
    );
  }
  await app.listen(port, '0.0.0.0');
  console.log(`🚀 API rodando na porta ${port}`);
}

bootstrap();
