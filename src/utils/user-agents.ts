export const userAgents = [
  // Chrome Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.102 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.199 Safari/537.36',

  // Firefox Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:116.0) Gecko/20100101 Firefox/116.0',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:115.0) Gecko/20100101 Firefox/115.0',

  // Safari macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6_8) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.6 Safari/605.1.15',

  // Chrome macOS
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_5_2) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.170 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 12_6_8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.198 Safari/537.36',

  // Mobile iOS
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',
  'Mozilla/5.0 (iPad; CPU OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1',

  // Mobile Android
  'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.171 Mobile Safari/537.36',
  'Mozilla/5.0 (Linux; Android 12; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.5735.199 Mobile Safari/537.36',

  // Edge Windows
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.102 Safari/537.36 Edg/115.0.1901.188',

  // Opera
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.5790.102 Safari/537.36 OPR/101.0.4843.70',
];

// Deriva sec-ch-ua/sec-ch-ua-platform consistentes com o User-Agent real,
// em vez de valores fixos que contradiziam o UA sorteado (ex: UA de Firefox
// com sec-ch-ua de Chromium — inconsistência que por si só é sinal de bot).
function buildClientHints(ua: string) {
  const chromeMatch = ua.match(/Chrome\/(\d+)/);
  const isMobile = /Mobile/.test(ua);

  let platform = '"Windows"';
  if (/Mac OS X/.test(ua)) platform = '"macOS"';
  else if (/Android/.test(ua)) platform = '"Android"';
  else if (/Linux/.test(ua)) platform = '"Linux"';

  if (!chromeMatch) {
    // Firefox/Safari reais não enviam Client Hints — omite os headers.
    return {
      secChUa: undefined,
      secChUaMobile: undefined,
      secChUaPlatform: undefined,
    };
  }

  const v = chromeMatch[1];
  return {
    secChUa: `"Not)A;Brand";v="8", "Chromium";v="${v}", "Google Chrome";v="${v}"`,
    secChUaMobile: isMobile ? '?1' : '?0',
    secChUaPlatform: platform,
  };
}

export function buildHeaders(
  numeroDoProcesso: string,
  instance: string,
  regionTRT: number,
  awswaftoken?: string,
  referer?: string,
  userAgent?: string,
) {
  // Prioriza o User-Agent real do Puppeteer que resolveu o desafio da AWS —
  // o aws-waf-token é validado junto com o fingerprint do navegador que o
  // emitiu, então replayar com um UA aleatório e diferente faz a AWS
  // rejeitar a request (405) mesmo com o token correto.
  const ua =
    userAgent || userAgents[Math.floor(Math.random() * userAgents.length)];
  const { secChUa, secChUaMobile, secChUaPlatform } = buildClientHints(ua);

  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'content-type': 'application/json',
    'x-grau-instancia': instance,
    priority: 'u=1, i', // Adicionado cabeçalho priority
    cookie: `${awswaftoken}`,
    origin: `https://pje.trt${regionTRT}.jus.br`,
    referer:
      referer ||
      `https://pje.trt${regionTRT}.jus.br/consultaprocessual/detalhe-processo/${numeroDoProcesso}/${instance}`,
    'user-agent': ua,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    ...(secChUa && {
      'sec-ch-ua': secChUa,
      'sec-ch-ua-mobile': secChUaMobile,
      'sec-ch-ua-platform': secChUaPlatform,
    }),
  };
}
