# Incremento 4 — GitHub Action, política por projeto e dogfooding

Objetivo: levar a decisão para onde ela é tomada — o Pull Request — e tornar a
ferramenta adotável por um projeto real.

## O que mudou

1. **Action composta (`action.yml`).** Instala a própria ferramenta a partir do
   `github.action_path`, roda o gate, escreve o resumo no Job Summary, anexa o
   relatório HTML como artifact, comenta no PR e falha o job conforme `fail-on`.

2. **Comentário idempotente.** O corpo começa com o marcador
   `<!-- evidence-gate-report -->`. A Action procura um comentário existente com esse
   marcador e o atualiza; só cria um novo se não houver. Uma branch de vida longa não
   acumula dezenas de comentários.

3. **`--summary` e `--output-json`.** O Markdown serve ao comentário e ao
   `$GITHUB_STEP_SUMMARY` ao mesmo tempo; o JSON alimenta as saídas `decision`,
   `quality-score` e `risk-score` da Action.

4. **Política por projeto.** `qualityPolicy` e `riskPolicy` no arquivo de configuração,
   mesclados sobre o padrão. Chave desconhecida é erro, não algo ignorado em silêncio.
   O `policyVersion` do relatório passa a dizer `(project override)` quando o projeto
   customizou algo.

5. **Dogfooding.** O repositório tem `evidence-gate.config.json` na raiz e se avalia
   nos próprios PRs, com duas suítes reais: `unit` (packages, CLI, worker) e `api`
   (apps/api).

## Por que a política precisou ser configurável

O primeiro self-check deu `RELEASE_BLOCKED` com Quality Score 37, apesar de todos os
testes passarem. Metade do peso padrão (mutation 20, riskControl 20, coverage 10) exige
evidência que este projeto ainda não produz.

Isso não era um problema deste repositório: **nenhum projeto real adotaria a ferramenta**
tendo que atingir um perfil de evidência que ele não tem. Peso e limiar são política de
time, não constante universal.

O limite dessa flexibilidade está no código e é o que impede a configuração de virar
"baixar a régua até ficar verde": um componente sem evidência continua listado em
`missingEvidence`, continua derrubando a confiança e continua impedindo aprovação
automática. Só o peso dele no score muda.

Uma primeira tentativa zerou os pesos de mutation, riskControl e coverage. O resultado
foi Quality Score 100 e confiança 100 ao lado de "missing evidence: mutation,
riskControl, coverage" — coerente com a fórmula, mas contraditório para quem lê, e em
conflito com o que o README promete. A configuração final mantém peso real
(mutation 8, riskControl 7, coverage 5), então o repositório fica em
`REVIEW_REQUIRED` com score 78 e confiança 78: números que contam a verdade.

## Como o repositório se avalia hoje

```text
64 testes passam · unit (REGRESSION) + api (API)
Quality Score 78 · Risk 52 (MEDIUM) · Confiança 78
REVIEW_REQUIRED — missing evidence: mutation, riskControl, coverage
```

Com `fail-on: blocked` o CI fica verde, e o comentário do PR continua dizendo em voz
alta o que falta. Quando o adapter Stryker entrar (Incremento 5), esses três
componentes passam a ter evidência real e o peso volta ao padrão.

## Limites

- A Action roda `npm ci` no diretório dela a cada execução. Funciona, mas é lento;
  publicar o CLI no npm, ou cachear, é o próximo passo de performance.
- Consumidor precisa de Node 22.12+ configurado antes do passo.
- A Action foi escrita e revisada, mas ainda não executou em um PR real; a primeira
  execução é a validação que falta.
