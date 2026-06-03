import { Inject, Injectable, Logger } from '@nestjs/common';
import { Redis } from 'ioredis';

@Injectable()
export class RedisService {
  private readonly logger = new Logger(RedisService.name);
  private static readonly SCAN_COUNT = 100;

  constructor(@Inject('REDIS_CLIENT') private readonly redisClient: Redis) {}

  private static readonly DELETE_BATCH_SIZE = 500;

  async deleteQueue(queueName: string): Promise<void> {
    try {
      const keys = await this.scanKeys(`*${queueName}*`);
      if (keys.length > 0) {
        for (let i = 0; i < keys.length; i += RedisService.DELETE_BATCH_SIZE) {
          const batch = keys.slice(i, i + RedisService.DELETE_BATCH_SIZE);
          await this.redisClient.del(...batch);
        }
        this.logger.log(`Fila ${queueName} deletada com sucesso (${keys.length} chaves).`);
      } else {
        this.logger.log(`Nenhuma fila encontrada para ${queueName}.`);
      }
    } catch (error) {
      this.logger.error(`Erro ao deletar a fila ${queueName}: ${error instanceof Error ? error.stack : String(error)}`);
      throw error;
    }
  }

  async flushDb(): Promise<void> {
    await this.redisClient.flushdb();
    this.logger.log('Redis do banco atual (DB 0) limpo.');
  }

  async reprocessAllFailedJobs(
    processJob: (jobData: Record<string, unknown>) => Promise<void>,
  ): Promise<void> {
    try {
      const failedKeys = await this.scanKeys('failed:*');

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

  private async scanKeys(pattern: string): Promise<string[]> {
    const keySet = new Set<string>();
    let cursor = '0';

    do {
      const [nextCursor, batch] = await this.redisClient.scan(
        cursor,
        'MATCH',
        pattern,
        'COUNT',
        RedisService.SCAN_COUNT,
      );
      cursor = nextCursor;
      batch.forEach((k) => keySet.add(k));
    } while (cursor !== '0');

    return Array.from(keySet);
  }
}
