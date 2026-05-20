# Project Context

## Produto

`scraping-fetch-robo` (scraping-robo-api) e um microservico NestJS para scraping automatizado de sistemas judiciais brasileiros (PJE) e Receita Federal. Coleta dados de processos, documentos, movimentos, certidoes CNPJ e CNDT.

## Vocabulario

- PJE: Processo Judicial Eletronico, sistema dos tribunais trabalhistas.
- TRT: Tribunal Regional do Trabalho (1 a 24, um por regiao).
- TST: Tribunal Superior do Trabalho.
- Processo: caso judicial com numero, partes, movimentos e documentos.
- Movimento: evento processual com data e descricao.
- Documento: arquivo PDF do processo judicial.
- Bookmark: marcador dentro de um PDF indicando documentos individuais.
- CAPTCHA: desafio anti-bot (hCaptcha, imagem, AWS WAF).
- 2Captcha: servico externo de resolucao de CAPTCHA.
- Sessao: cookies de autenticacao no PJE, armazenados no Redis com TTL.
- Pool de contas: 6 contas PJE com rotacao a cada 5 processos.
- WAF token: token AWS WAF necessario para acessar alguns PJE endpoints.
- CNPJ: cadastro nacional de pessoa juridica.
- CNDT: certidao negativa de debitos trabalhistas.
- Receita Federal: orgao fiscal federal, fonte de certidoes CNPJ.

## Dominios principais

- Scraping judicial: consulta de processos, movimentos e documentos via PJE.
- Scraping fiscal: obtencao de certidoes CNPJ e CNDT via Receita Federal.
- Automacao de browser: Puppeteer com stealth plugin para navegacao automatizada.
- Gerenciamento de filas: 49 filas BullMQ para distribuicao de carga por TRT.
- Resolucao de CAPTCHA: integracao com 2Captcha para desafios anti-bot.
- Gerenciamento de sessao: pool de contas PJE com rotacao e cache Redis.

## Pendencias de mapeamento

- Detalhar integracoes especificas por TRT quando houver task.
- Mapear fluxo de Tesseract/OCR quando for ativado.
