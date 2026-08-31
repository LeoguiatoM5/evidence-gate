# Incremento 5 — Mutation testing executado

Objetivo: substituir o `mutationScore` informado por configuração por medição real, e
fechar a lacuna que o próprio repositório declarava em voz alta.

## O que mudou

1. **Porta no domínio** (`packages/core/src/mutation.ts`): `MutationRunnerPort`,
   `MutationReport`, totais por status e o cálculo padrão do score
   (`detected / valid`, onde `detected = killed + timeout` e
   `valid = detected + survived + noCoverage`). Mutantes que não compilaram ou foram
   ignorados ficam fora dos dois lados da conta.

2. **Parser** (`packages/test-runner/src/report-stryker.ts`) do
   *mutation-testing report schema*, que o Stryker emite com o reporter `json`.
   Defensivo como os demais: todo campo é tratado como não confiável.

3. **Adapter** (`packages/test-runner/src/mutation.ts`): mesma disciplina de execução
   do runner de testes — comando absoluto, `shell: false`, timeout com encerramento da
   árvore de processos, teto de saída, ambiente mínimo, artefatos com caminho relativo.
   O `reportPath` é validado para não escapar do diretório de trabalho.

4. **Integração no CLI**: bloco `execution.mutation` na configuração, com `runOn`
   (níveis de risco que justificam pagar o custo) e `criticalityThreshold`. Flags
   `--mutation` e `--no-mutation`.

5. **Exibição**: seção de mutation no terminal, no comentário do PR e no relatório HTML,
   com a lista de sobreviventes e destaque para os que estão em área crítica.

## Duas regras de precedência

- **Evidência executada vence a informada.** Se a configuração declarava
  `mutationScore: 90` e a execução mediu 61, vale 61.
- **Execução que falhou não cai de volta no valor informado.** Quando um run é
  tentado e falha, `mutationScore` fica *ausente* — vira lacuna de evidência, com a
  queda de confiança correspondente. O contrário permitiria que um número otimista de
  configuração sobrevivesse a uma medição quebrada.

Um run que falha **não** marca a análise como quebrada: os testes rodaram, o que faltou
foi uma dimensão de evidência. Isso é diferente de uma suíte que não terminou.

## O que a primeira execução real encontrou, e como foi paga

Escopo: `packages/quality-engine` e `packages/risk-engine` — os motores puros, onde a
decisão de release é calculada. 507 mutantes, 5 minutos e 36 segundos.

```text
mutation score  57.4
killed 284 · survived 172 · no coverage 44 · timeout 7
```

| Arquivo | Score |
|---|---|
| `packages/quality-engine/src/index.ts` | 45.2 |
| `packages/quality-engine/src/selection.ts` | 66.7 |
| `packages/quality-engine/src/evidence.ts` | 70.4 |
| `packages/risk-engine/src/index.ts` | 71.7 |

Os 86 testes passavam. Ainda assim, quase metade das mutações no arquivo que calcula o
Quality Gate sobrevivia — os testes exercitavam os caminhos, mas não fixavam o
comportamento com asserções fortes o bastante. É exatamente a tese do projeto,
verificada contra o próprio código.

### Pagando a dívida

A resposta não foi baixar o limiar de 75, foi escrever os testes que faltavam. O padrão
que funcionou: **asserção nos dois lados de cada limite**. Um `if (x < limite)` só fica
fixado quando existe um caso exatamente no limite e outro um passo abaixo — é isso que
mata mutantes de operador relacional.

Foram 69 testes novos, isolando cada fator de risco (zerando os demais pesos, para que
a asserção fixe uma fórmula só) e cada regra do gate.

| Arquivo | Antes | Depois |
|---|---|---|
| `packages/quality-engine/src/index.ts` | 45.2 | **83.9** |
| `packages/quality-engine/src/selection.ts` | 66.7 | **86.7** |
| `packages/quality-engine/src/evidence.ts` | 70.4 | **92.6** |
| `packages/risk-engine/src/index.ts` | 71.7 | **90.8** |
| **Geral** | **57.4** | **87.2** |

Mutantes sem cobertura caíram de 44 para 0; timeouts, de 7 para 0. O repositório passa
no próprio limiar sem que nenhum limiar tenha sido tocado.

Sobrevivem 65 mutantes. A maior parte é equivalente ou cosmética (arredondamento,
ordem de mensagens); levar o número a zero teria custo alto e valor baixo.

## O sandbox e o layout local

A primeira execução falhou copiando um log transitório do npm, e demorava demais. O
Stryker copia o projeto para um sandbox, e este repositório mantém runtime do Node,
cache do npm e temporários **dentro** do diretório do projeto, por causa da restrição
do disco `C:` da estação de desenvolvimento — 917 MB sendo copiados a cada run.

`ignorePatterns` no `stryker.config.json` resolve. Vale como aviso geral: qualquer
ferramenta que faça sandbox do projeto precisa saber o que não é código.

## Limites

- Mutation cobre só os motores de domínio. As suítes de integração levariam horas,
  porque mutation executa a suíte uma vez por mutante.
- `runOn` padrão é `["HIGH", "CRITICAL"]`: mudanças de baixo risco não pagam o custo.
- O adapter funciona com qualquer ferramenta que emita o mutation-testing report
  schema; não é acoplado ao Stryker.
