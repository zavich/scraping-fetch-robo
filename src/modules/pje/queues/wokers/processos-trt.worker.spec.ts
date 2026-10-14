import axios from 'axios';
import { Job } from 'bullmq';
import Redis from 'ioredis';
import { ScrapingService } from 'src/helpers/scraping.service';
import { FetchUrlMovimentService } from '../../services/fetch-url.service';
import { LoginPoolService } from '../../services/login-pool.service';
import { ProcessDocumentsFindService } from '../../services/process-documents-find.service';
import { GenericProcessoWorker } from './processos-trt.worker';

// TRT8: fora do caminho do ScrapingService (só TRT3/TRT9 passam por ele).
const NUMERO = '0000029-81.2021.5.08.0126';

type JobData = {
  numero: string;
  documents?: boolean;
  webhook?: string;
  correlationId?: string;
};

type WebhookEnviado = {
  status?: string;
  motivo_erro?: string | null;
  webhookId?: string;
};

const makeJob = (): Job<JobData> =>
  ({
    id: '1',
    queueName: 'pje-trt8',
    timestamp: Date.now(),
    data: {
      numero: NUMERO,
      documents: false,
      webhook: 'http://webhook.test/internal/scraping-webhook',
      correlationId: 'corr-1',
    },
  }) as unknown as Job<JobData>;

describe('GenericProcessoWorker — processo sem nenhuma instância', () => {
  let execute: jest.Mock;
  let worker: GenericProcessoWorker;
  let post: jest.SpyInstance<
    ReturnType<typeof axios.post>,
    Parameters<typeof axios.post>
  >;

  const webhookEnviado = (): WebhookEnviado =>
    post.mock.calls[0][1] as WebhookEnviado;

  beforeEach(() => {
    execute = jest.fn();
    worker = new GenericProcessoWorker(
      { execute } as unknown as FetchUrlMovimentService,
      {} as LoginPoolService,
      {} as ProcessDocumentsFindService,
      { execute: jest.fn() } as unknown as ScrapingService,
      {} as Redis,
    );
    post = jest.spyOn(axios, 'post').mockResolvedValue({ data: {} });
  });

  afterEach(() => post.mockRestore());

  it('reporta ERRO/PJE_FORA_DO_AR, não NAO_ENCONTRADO, quando alguma instância falhou', async () => {
    // Caso real: TRT8 respondendo 403 nas instâncias 1 e 2.
    execute.mockResolvedValue({ instances: [], houveFalha: true });

    await expect(worker.process(makeJob())).resolves.toBeUndefined();

    expect(post).toHaveBeenCalledTimes(1);
    expect(webhookEnviado()).toMatchObject({
      status: 'ERRO',
      motivo_erro: 'PJE_FORA_DO_AR',
      webhookId: 'corr-1:sem-resposta',
    });
  });

  it('mantém NAO_ENCONTRADO quando todas as instâncias responderam sem o processo', async () => {
    execute.mockResolvedValue({ instances: [], houveFalha: false });

    await worker.process(makeJob());

    expect(post).toHaveBeenCalledTimes(1);
    expect(webhookEnviado()).toMatchObject({
      status: 'NAO_ENCONTRADO',
      webhookId: 'corr-1:not-found',
    });
  });
});
