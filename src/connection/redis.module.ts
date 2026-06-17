import { Module, Global, Logger } from '@nestjs/common';
import Redis from 'ioredis';

const logger = new Logger('RedisModule');

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
              logger.error(
                '[Redis] Maximo de tentativas atingido. Desistindo.',
              );
              return null; // para de tentar
            }
            const delay = Math.min(times * 200, 5000);
            logger.warn(
              `[Redis] Tentativa ${times} de reconexao em ${delay}ms`,
            );
            return delay;
          },
          reconnectOnError: (err: Error) => {
            const message = err.message.toLowerCase();
            return message.includes('readonly') ||
              message.includes('econnrefused') ||
              message.includes('connection is closed')
              ? 1
              : false;
          },
        });
        let maxmemoryPolicyConfigured = false;

        client.on('error', (err) => {
          logger.error(
            `[Redis] Erro de conexao: ${err instanceof Error ? err.stack : String(err)}`,
          );
        });

        client.on('reconnecting', (ms: number) => {
          logger.warn(`[Redis] Reconectando em ${ms}ms...`);
        });

        client.on('ready', () => {
          logger.log('[Redis] Conexao estabelecida com sucesso');
          if (maxmemoryPolicyConfigured) {
            return;
          }

          // Evita que o Redis rejeite escritas ao atingir maxmemory — remove chaves
          // menos usadas ao invés de retornar OOM (causa do "Missing lock" no BullMQ).
          void client
            .config('SET', 'maxmemory-policy', 'allkeys-lru')
            .then(() => {
              maxmemoryPolicyConfigured = true;
            })
            .catch((err: unknown) => {
              const errorMessage =
                err instanceof Error ? err.message : String(err);
              logger.warn(
                `[Redis] Nao foi possivel definir maxmemory-policy: ${errorMessage}`,
              );
            });
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
