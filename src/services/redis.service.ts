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
  async flushAll(): Promise<void> {
    await this.redisClient.flushall();
    console.log('Redis limpo completamente.');
  }

  async reprocessAllFailedJobs(
    processJob: (jobData: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    try {
      // Busca todas as chaves de jobs falhados
      const failedKeys = await this.redisClient.keys('failed:*');

      if (failedKeys.length === 0) {
        console.log('Nenhum job com erro encontrado.');
        return;
      }

      console.log(`Reprocessando ${failedKeys.length} jobs com erro...`);

      for (const key of failedKeys) {
        try {
          const jobData = await this.redisClient.get(key);
          if (jobData) {
            let parsedData: Record<string, unknown> | null = null;
            try {
              parsedData = JSON.parse(jobData) as Record<string, unknown>;
            } catch (parseError) {
              console.error(
                `Erro ao parsear os dados do job ${key}:`,
                parseError,
              );
              continue;
            }

            if (parsedData) {
              await processJob(parsedData);
              await this.redisClient.del(key); // Remove o job da lista de falhas após o reprocessamento
              console.log(`Job ${key} reprocessado com sucesso.`);
            } else {
              console.error(`Job ${key} possui dados inválidos.`);
            }
          }
        } catch (error) {
          console.error(`Erro ao reprocessar o job ${key}:`, error);
        }
      }
    } catch (error) {
      console.error('Erro ao buscar jobs com erro:', error);
      throw error;
    }
  }
}
