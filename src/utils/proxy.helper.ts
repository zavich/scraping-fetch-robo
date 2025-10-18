// src/utils/proxy.helper.ts
import { AxiosRequestConfig } from 'axios';

/**
 * Usa ScraperAPI para contornar bloqueios de CloudFront.
 * Ele encapsula a URL original dentro da ScraperAPI.
 */
export function applyScraperApiProxy(
  config: AxiosRequestConfig,
): AxiosRequestConfig {
  if (process.env.USE_PROXY !== 'true') return config;

  const apiKey = process.env.SCRAPER_API_KEY;
  if (!apiKey) {
    throw new Error('SCRAPER_API_KEY não configurada no .env');
  }

  const originalUrl = config.url ?? '';
  // ⚙️ A ScraperAPI aceita parâmetros como render, country_code, premium, etc.
  const scraperUrl = `https://api.scraperapi.com?api_key=${apiKey}&url=${encodeURIComponent(
    originalUrl,
  )}`;

  return {
    ...config,
    url: scraperUrl,
    proxy: false, // o axios não deve tentar proxy local
  };
}
