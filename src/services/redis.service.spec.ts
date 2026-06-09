import { RedisService } from './redis.service';

const makeRedisClient = () => ({
  del: jest.fn(),
  flushdb: jest.fn(),
  get: jest.fn(),
  scan: jest.fn(),
});

describe('RedisService', () => {
  let service: RedisService;
  let redisClient: ReturnType<typeof makeRedisClient>;

  beforeEach(() => {
    redisClient = makeRedisClient();
    service = new RedisService(redisClient as any);
  });

  it('deletes queue keys using SCAN batches instead of KEYS', async () => {
    redisClient.scan
      .mockResolvedValueOnce(['5', ['bull:queue:1', 'bull:queue:2']])
      .mockResolvedValueOnce(['0', ['bull:queue:3']]);
    // Real Redis DEL retorna o numero de chaves removidas; mockar para nao
    // virar NaN quando o servico fizer totalDeleted += deleted.
    redisClient.del.mockResolvedValueOnce(2).mockResolvedValueOnce(1);

    await service.deleteQueue('queue');

    expect(redisClient.scan).toHaveBeenCalledTimes(2);
    // Streaming: del() é chamado por batch do SCAN, não uma vez com todas as chaves
    expect(redisClient.del).toHaveBeenCalledTimes(2);
    expect(redisClient.del).toHaveBeenNthCalledWith(1, 'bull:queue:1', 'bull:queue:2');
    expect(redisClient.del).toHaveBeenNthCalledWith(2, 'bull:queue:3');
  });

  it('reprocesses failed jobs and removes only valid processed keys', async () => {
    const processJob = jest.fn().mockResolvedValue(undefined);

    redisClient.scan.mockResolvedValueOnce(['0', ['failed:1', 'failed:2']]);
    redisClient.get
      .mockResolvedValueOnce(JSON.stringify({ processNumber: '0001' }))
      .mockResolvedValueOnce('not-json');

    await service.reprocessAllFailedJobs(processJob);

    expect(processJob).toHaveBeenCalledWith({ processNumber: '0001' });
    expect(redisClient.del).toHaveBeenCalledWith('failed:1');
    expect(redisClient.del).not.toHaveBeenCalledWith('failed:2');
  });

  it('flushes only the current redis database', async () => {
    await service.flushDb();

    expect(redisClient.flushdb).toHaveBeenCalled();
  });
});
