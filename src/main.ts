import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BrowserManager } from './utils/browser.manager';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const port = 8081;

  app.enableCors({
    origin: ['https://robo-api.juri.capital'],
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

  await app.listen(port, '0.0.0.0');
  console.log(`🚀 API rodando na porta ${port}`);
}

bootstrap();
