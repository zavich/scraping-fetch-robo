import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  async deleteQueue(queueName: string): Promise<void> {
    try {
      const keys = await this.redisClient.keys(`*${queueName}*`);
      if (keys.length > 0) {
        await this.redisClient.del(...keys);
        this.logger.log(`Fila ${queueName} deletada com sucesso.`);
      } else {
        this.logger.log(`Nenhuma fila encontrada para ${queueName}.`);
      }
    } catch (error) {
      this.logger.error(`Erro ao deletar a fila ${queueName}:`, error);
      throw error;
    }
  }

  async flushAll(): Promise<void> {
    await this.redisClient.flushdb();
    this.logger.log('Redis do banco atual limpo completamente.');
  }

  async reprocessAllFailedJobs(
    processJob: (jobData: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    try {
      const failedKeys = await this.redisClient.keys('failed:*');

      if (failedKeys.length === 0) {
        this.logger.log('Nenhum job com erro encontrado.');
        return;
      }

      this.logger.log(`Reprocessando ${failedKeys.length} jobs com erro...`);

      for (const key of failedKeys) {
        try {
          const jobData = await this.redisClient.get(key);
          if (jobData) {
            let parsedData: Record<string, unknown> | null = null;
            try {
              parsedData = JSON.parse(jobData) as Record<string, unknown>;
            } catch (parseError) {
              this.logger.error(`Erro ao parsear os dados do job ${key}:`, parseError);
              continue;
            }

            if (parsedData) {
              await processJob(parsedData);
              await this.redisClient.del(key);
              this.logger.log(`Job ${key} reprocessado com sucesso.`);
            } else {
              this.logger.error(`Job ${key} possui dados inválidos.`);
            }
          }
        } catch (error) {
          this.logger.error(`Erro ao reprocessar o job ${key}:`, error);
        }
      }
    } catch (error) {
      this.logger.error('Erro ao buscar jobs com erro:', error);
      throw error;
    }
  }
}
