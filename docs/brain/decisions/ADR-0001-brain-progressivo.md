# ADR-0001: Brain Progressivo

## Status

Aceita

## Contexto

O scraping-fetch-robo e um servico complexo com 49 filas BullMQ, integracao com 24 TRTs, login pool, resolucao de CAPTCHA e automacao de browser. Sem documentacao estruturada, cada task exige re-exploracao do codebase.

## Decisao

Adotar o padrao Brain progressivo: documentacao LLM-oriented que cresce incrementalmente. Comeca com os mapas core (INDEX, architecture, features) e expande conforme novas areas sao tocadas.

## Consequencias

### Positivas

- Reduz tempo de contextualizacao por task.
- Investigacao guiada por sintoma (debug-index) e por keyword (task-router).
- Feature maps evitam leitura desnecessaria de codigo.
- Novos contribuidores (humanos ou LLMs) tem onboarding rapido.

### Negativas

- Brain precisa ser atualizado quando o codigo muda.
- Risco de documentacao desatualizada se nao mantida.

## Notas

- Manter brain atualizado a cada mudanca significativa.
- Usar CHANGELOG.md para rastrear evolucao.
