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
    origin: ['https://robo-api-prd.juri.capital'],
    credentials: true,
  });

  // 🧹 Encerra browser ao finalizar
  process.on('SIGINT', () => {
    (async () => {
      console.log('🧹 Encerrando browser...');
      const browser = await BrowserManager.getBrowser();
      await browser.close().catch(() => {});
      process.exit(0);
    })();
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
