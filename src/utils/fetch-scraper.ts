import axios from 'axios';

export function scraperRequest<T>(
  url: string,
  session?: string,
  headers: Record<string, string> = {},
) {
  const SCRAPER_API_KEY = process.env.SCRAPER_API_KEY;
  return axios.get<T>('https://api.scraperapi.com/', {
    params: {
      api_key: SCRAPER_API_KEY,
      url,
      country_code: 'br',
      premium: true,
      session_number: session,
      keep_headers: true,
      render: false,
    },
    headers,
    timeout: 20000, // ScraperAPI é mais lento
  });
}
