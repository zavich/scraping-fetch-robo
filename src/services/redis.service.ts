import { Inject, Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  async deleteQueue(queueName: string): Promise<void> {
    try {
      // Ajusta o padrão para buscar as filas corretamente
      const keys = await this.redisClient.keys(`*${queueName}*`);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
        console.log(`Fila ${queueName} deletada com sucesso.`);
      } else {
        console.log(`Nenhuma fila encontrada para ${queueName}.`);
      }
    } catch (error) {
      console.error(`Erro ao deletar a fila ${queueName}:`, error);
      throw error;
    }
  }
}
