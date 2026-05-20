# Runbook: Browser Crash

## Severidade

Alta

## Sintoma

- Workers param de processar jobs.
- Logs mostram `browser disconnected`, `Target closed`, ou `Navigation timeout`.
- Jobs ficam stuck em active no Bull Board.
- Memoria do container ECS cresce continuamente.

## Impacto

Todas as filas de scraping param. Jobs acumulam em waiting. Nenhum processo e coletado ate resolucao.

## Diagnostico

1. Verificar logs do container ECS por erros de browser.
2. Verificar metricas de memoria do container (Puppeteer consome ~100-300MB por contexto).
3. Verificar se `BrowserManager` tem contextos abertos nao finalizados.
4. Verificar se o Chromium foi instalado corretamente no container.
5. Verificar se `puppeteer-extra-plugin-stealth` esta ativo.

## Resolucao

1. **Restart do container**: se o browser crashou, restart do ECS task resolve.
2. **Limpar jobs stuck**: no Bull Board, mover jobs active ha muito tempo para failed.
3. **Verificar memoria**: se memoria esta alta, pode ser leak de contextos nao fechados.
4. **Verificar Dockerfile**: garantir que dependencias do Chromium estao instaladas.
   - `chromium`, `nss`, `freetype`, `harfbuzz`, `ca-certificates`, `ttf-freefont`.

## Prevencao

- `BrowserManager` deve sempre fechar contextos em blocos finally.
- Monitorar memoria do container com alarmes CloudWatch.
- Timeout de navegacao configurado para evitar hang infinito.
- Concorrencia limitada por worker para nao sobrecarregar memoria.

## Historico

| Data | Descricao |
|------|-----------|
| - | Nenhum incidente registrado ainda |
