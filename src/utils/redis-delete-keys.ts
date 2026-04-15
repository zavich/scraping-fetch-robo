import { Redis } from 'ioredis';

export async function deleteByPattern(
  redis: Redis,
  pattern: string,
  options?: {
    batchSize?: number;
    log?: (msg: string) => void;
  },
): Promise<number> {
  const batchSize = options?.batchSize ?? 100;
  const log = options?.log ?? (() => {});

  let cursor = '0';
  let totalDeleted = 0;

  do {
    const [nextCursor, foundKeys] = await redis.scan(
      cursor,
      'MATCH',
      pattern,
      'COUNT',
      batchSize,
    );

    cursor = nextCursor;

    if (foundKeys.length > 0) {
      const deleted = await redis.del(...foundKeys);
      totalDeleted += deleted;

      log(`🧹 Deletadas ${deleted} keys (pattern: ${pattern})`);
    }
  } while (cursor !== '0');

  log(`✅ Total removido: ${totalDeleted} keys (pattern: ${pattern})`);

  return totalDeleted;
}
