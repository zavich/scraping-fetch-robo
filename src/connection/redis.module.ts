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
          maxRetriesPerRequest: null, // obrigatório para BullMQ
        });

        // Evita logs de "Unhandled error event"
        client.on('error', (err) => {
          console.warn('[Redis] error event:', err.message);
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
