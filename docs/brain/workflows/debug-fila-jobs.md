# Workflow: Debug Fila de Jobs

## Sintoma

Jobs acumulando na fila, jobs falhando repetidamente, ou workers nao consumindo.

## Pre-condicoes

- [ ] Acesso ao Bull Board (`/admin/queues`).
- [ ] Acesso ao Redis.
- [ ] Acesso aos logs do servico.

## Passos

1. **Verificar estado da fila no Bull Board**:
   - Quantos jobs em waiting, active, completed, failed?
   - Ha jobs stuck em active ha muito tempo?
   - Ha padrao nos jobs que falham (mesmo TRT, mesmo tipo)?

2. **Jobs acumulando (waiting crescendo)**:
   - Verifique se o worker esta rodando (logs).
   - Verifique concorrencia configurada:
     - `pje-trt3`, `pje-trt9`, `pje-tst`: concorrencia 1.
     - Demais TRTs: concorrencia 3.
     - Documentos: concorrencia 3 por TRT.
   - Verifique se ha lock travado no Redis (`bull:pje-trt{N}:*`).
   - Verifique conexao com Redis.

3. **Jobs falhando repetidamente**:
   - Leia o stacktrace do job no Bull Board.
   - Verifique attempts e backoff configurados.
   - Verifique se o erro e transiente (timeout, rede) ou permanente (seletor quebrado).
   - Jobs tem retry com backoff exponencial (delay * 2^attempt).

4. **Workers nao consumindo**:
   - Verifique se o modulo foi inicializado (NestJS bootstrap logs).
   - Verifique se o provider dinamico criou os workers (`DynamicWorkerProvider`).
   - Verifique conexao Redis (host, porta, auth).
   - Verifique se ha erro de memoria ou CPU no container ECS.

5. **Jobs stuck em active**:
   - Pode indicar browser travado ou deadlock.
   - Verifique se `BrowserManager` tem contextos abertos demais.
   - Considere restart do container se necessario.

## Resultado esperado

Fila normalizada, jobs sendo processados, causa raiz documentada.

## Quando escalar

- Se o Redis estiver com problemas de memoria.
- Se o container ECS estiver em crash loop.
- Se o problema afetar multiplas filas simultaneamente.
