import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        if (!process.env.REDIS_URL) {
          throw new Error('REDIS_URL não está definido!');
        }

        const client = new Redis(process.env.REDIS_URL, {
          maxRetriesPerRequest: null, // obrigatorio para BullMQ
          retryStrategy: (times: number) => {
            if (times > 20) {
              console.error('[Redis] Maximo de tentativas atingido. Desistindo.');
              return null; // para de tentar
            }
            const delay = Math.min(times * 200, 5000);
            console.warn(`[Redis] Tentativa ${times} de reconexao em ${delay}ms`);
            return delay;
          },
        });

        client.on('error', (err) => {
          console.error('[Redis] Erro de conexao:', err.message);
        });

        client.on('reconnecting', (ms: number) => {
          console.warn(`[Redis] Reconectando em ${ms}ms...`);
        });

        client.on('ready', () => {
          console.log('[Redis] Conexao estabelecida com sucesso');
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
