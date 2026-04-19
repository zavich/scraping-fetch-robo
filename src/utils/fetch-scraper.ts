import axios, { AxiosRequestConfig, AxiosResponse, Method } from 'axios';
const { HttpsProxyAgent } = require('https-proxy-agent');

type ProxyItem = {
  host: string;
  port: number;
  username: string;
  password: string;
};

const rawProxies = [
  '108.165.197.49:6288:cpaproxyscon:cpaproxys',
  '45.38.89.93:6028:cpaproxyscon:cpaproxys',
];

function parseProxy(raw: string): ProxyItem {
  const [host, port, username, password] = raw.split(':');
  return { host, port: Number(port), username, password };
}

const proxies = rawProxies.map(parseProxy);

function getProxy(session?: string): ProxyItem {
  return proxies[Math.floor(Math.random() * proxies.length)];
}

export async function scraperRequest<T>(
  url: string,
  session?: string,
  headers: Record<string, string> = {},
  method: Method = 'GET',
  data?: unknown,
  useProxy = false,
): Promise<AxiosResponse<T>> {
  const config: AxiosRequestConfig = {
    url,
    method,
    timeout: 180000,
    validateStatus: () => true,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
  };

  if (['POST', 'PUT', 'PATCH'].includes(method) && data) {
    config.data = data;
  }

  const proxy = getProxy(session);

  try {
    if (useProxy) {
      console.log(`🌐 Proxy usado: ${proxy.host}:${proxy.port}`);

      const proxyUrl = `http://${proxy.username}:${proxy.password}@${proxy.host}:${proxy.port}`;
      const agent = new HttpsProxyAgent(proxyUrl);

      const response = await axios.request<T>({
        ...config,
        httpAgent: agent,
        httpsAgent: agent,
        proxy: false,
      });
      return response;
    }

    const response = await axios.request<T>({
      ...config,
      proxy: false,
    });
    console.log('STATUS:', response.status);
    console.log('HEADERS:', response.headers);
    return response;
  } catch (error: any) {
    console.warn('⚠️ Proxy falhou:', error?.message || error);

    return await axios.request<T>({
      ...config,
      proxy: false,
    });
  }
}
