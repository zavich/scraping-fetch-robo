import { Global, Module } from '@nestjs/common';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        const url = process.env.REDIS_URL;

        if (!url) {
          throw new Error('REDIS_URL não definido no ambiente');
        }

        const client = new Redis(url, {
          maxRetriesPerRequest: null,
          enableReadyCheck: true,
          lazyConnect: false,
          reconnectOnError: (err) => {
            console.error('[Redis reconnect error]', err.message);
            return true;
          },
        });

        client.on('connect', () => {
          console.log('[Redis] connected');
        });

        client.on('error', (err) => {
          console.error('[Redis] error:', err.message);
        });

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
