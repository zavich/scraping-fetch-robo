import { Module, Global } from '@nestjs/common';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: () => {
        const client = new Redis(process.env.REDIS_URL!, {
          maxRetriesPerRequest: null,

          tls: {},

          enableReadyCheck: false,

          retryStrategy(times) {
            return Math.min(times * 1000, 5000);
          },
        });

        client.on('connect', () => console.log('Redis conectado'));
        client.on('ready', () => console.log('Redis pronto'));
        client.on('error', (err) => console.log('Redis erro:', err.message));

        return client;
      },
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
