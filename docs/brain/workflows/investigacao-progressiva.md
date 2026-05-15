# Workflow: Investigacao Progressiva

## Sintoma

Qualquer task que exija entender o codebase antes de agir.

## Pre-condicoes

- [ ] Brain carregado (INDEX.md lido).
- [ ] Task claramente definida.

## Passos

1. Leia `INDEX.md` e identifique a area afetada.
2. Consulte `task-router.md` para encontrar arquivos relevantes.
3. Leia o feature map da area (em `features/`).
4. Se for debug, consulte `debug-index.md` pelo sintoma.
5. Se houver workflow especifico, siga-o (em `workflows/`).
6. Leia os arquivos-fonte indicados nos pontos de entrada.
7. Faca a alteracao ou diagnostico.
8. Valide com os testes indicados em `test-matrix.md`.
9. Atualize o brain se a mudanca afetar documentacao.

## Resultado esperado

Alteracao feita com contexto completo, sem quebrar funcionalidades adjacentes.

## Quando escalar

- Se a area nao estiver coberta pelo brain.
- Se envolver multiplos modulos simultaneamente.
