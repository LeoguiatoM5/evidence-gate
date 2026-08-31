# Incremento 3 — CLI, exemplo executável e relatório

Objetivo: transformar o projeto de "demonstração de arquitetura" em ferramenta que
alguém pluga no CI no mesmo dia, e dar a quem abre o repositório um caminho de 30
segundos até ver o gate decidindo.

## O que mudou

1. **`apps/cli` — `evidence-gate check`.** Roda a mesma pipeline do worker em um único
   processo, sem banco: diff → risco → seleção → execução → score → gate. Descobre o
   diff via `git diff <base>...HEAD`, com fallback para a árvore de trabalho, ou lê um
   patch com `--diff-file`. Sai com código 1 quando o gate reprova — é isso que trava um
   pipeline.

2. **Runner multi-formato.** `packages/test-runner-playwright` virou
   `packages/test-runner`, e cada suíte declara `reportFormat`:
   `playwright-json` ou `vitest-json` (formato compatível com Jest). O token
   `{{reportPath}}` nos argumentos é substituído pelo destino que o runner controla, de
   modo que o caminho do relatório continua sendo do runner e não da configuração.

3. **Relatório HTML autocontido.** Sem script, sem fonte externa, sem requisição de
   rede; claro e escuro; todo valor rotulado diretamente, sem depender de hover ou de
   cor sozinha. É o artefato que se anexa a um PR ou a um pipeline.

4. **`examples/checkout-service`.** Projeto real com 9 testes que passam, dois arquivos
   de configuração e um `changes.patch` versionado. `npm run demo` funciona sem
   configurar nada e sem instalar dependência adicional — reaproveita o vitest que já
   está no monorepo.

5. **Seleção e evidência movidas para `packages/quality-engine`.** Antes viviam em
   `apps/worker`; o CLI precisaria delas também. Como são política de domínio, e não
   infraestrutura, passaram para o núcleo. O worker e o CLI agora compartilham a mesma
   regra, sem duplicação.

## Falha de projeto corrigida pelo demo

O primeiro `npm run demo` executou **zero suítes**: risco MEDIUM selecionava apenas
suítes `SMOKE`, e o exemplo declarava só uma suíte `REGRESSION`. A release foi bloqueada
por ausência de evidência que a própria seleção tinha causado.

Rodar menos teste do que a estratégia pede é a direção insegura. `selectTests` passou a
executar todas as suítes permitidas quando nenhuma corresponde aos tipos preferidos, e
registra isso no motivo. Só quando não há nenhuma suíte declarada é que o resultado é
"nenhuma evidência será produzida".

## Idioma

A interface (CLI e relatório) é toda em inglês, alinhada às mensagens do domínio, que já
eram em inglês. A documentação segue em português. Antes disso, o relatório misturava os
dois no mesmo parágrafo.

## Limites

- O CLI é sem estado por opção: não grava no SQLite. Histórico é responsabilidade do
  modo servidor.
- `mutationScore` era informado na configuração; passou a ser medido no Incremento 5.
- A seleção continua por nível de risco, não por impacto real do diff (Incremento 6).
