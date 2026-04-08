import axios, { AxiosRequestConfig, AxiosResponse, Method } from 'axios';

export async function scraperRequest<T>(
  url: string,
  session?: string,
  headers: Record<string, string> = {},
  method: Method = 'GET',
  data?: unknown,
  useScraper = true, // 👈 controle importante
  configParams?: {
    ultra: boolean;
  },
): Promise<AxiosResponse<T>> {
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;

  const config: AxiosRequestConfig = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...headers,
    },
    timeout: 60000, // Aumente para 60 segundos
  };

  // 👇 só adiciona body se for POST/PUT/PATCH
  if (['POST', 'PUT', 'PATCH'].includes(method) && data) {
    if (typeof data === 'object' || typeof data === 'string') {
      config.data = data;
    } else {
      throw new Error('Data must be an object or string');
    }
  }
  const params: any = {
    api_key: SCRAPER_API_KEY,
    url,
    country_code: 'br',
    session_number: session,
    keep_headers: true,
    render: false,
  };

  if (configParams?.ultra) {
    params.ultra_premium = true;
  }
  try {
    if (useScraper) {
      const response = await axios.request<T>({
        ...config,
        url: 'https://api.scraperapi.com/',
        params,
      });

      return response;
    }

    // 👇 fallback direto (sem proxy)
    const response = await axios.request<T>({
      ...config,
      url,
    });

    return response;
  } catch (error: any) {
    if (useScraper) {
      console.warn('⚠️ Scraper falhou, fallback direto:', error.message);

      const fallback = await axios.request<T>({
        ...config,
        url,
        data: config.data,
      });

      return fallback;
    }

    throw error;
  }
}
