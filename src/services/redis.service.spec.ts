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

    await service.deleteQueue('queue');

    expect(redisClient.scan).toHaveBeenCalledTimes(2);
    expect(redisClient.del).toHaveBeenCalledWith(
      'bull:queue:1',
      'bull:queue:2',
      'bull:queue:3',
    );
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
