# Evidence Gate

[![CI](https://github.com/LeoguiatoM5/evidence-gate/actions/workflows/ci.yml/badge.svg)](https://github.com/LeoguiatoM5/evidence-gate/actions/workflows/ci.yml)

**Seu CI diz que passou. Isto diz se dá para confiar.**

Um quality gate que recebe uma mudança de código, executa os testes que o risco daquela
mudança exige, e devolve uma decisão explicável:

```text
RELEASE_APPROVED | REVIEW_REQUIRED | RELEASE_BLOCKED
```

## O problema

Uma mudança em `src/payment/limit.ts`. Cinco testes passam. Coverage 72%. O CI fica verde.

O Evidence Gate olha a mesma mudança e responde **RELEASE_BLOCKED**:

```text
  [FAIL] RELEASE_BLOCKED  checkout-service

  Quality Score  68  ████████████████░░░░░░░░
  Risk Score     45  ███████████░░░░░░░░░░░░░  MEDIUM
  Confidence     79  ███████████████████░░░░░

  Why
   × Mutation score is below the configured minimum. (actual 61, expected >= 75)
   ! Missing quality evidence: riskControl.
   ! Quality evidence confidence is below the configured minimum. (actual 79, expected >= 80)

  Execution
   ok unit               REGRESSION · 1034ms · vitest
   ok api-contract       API · 962ms · vitest
   9 passed · 0 failed · 0 flaky · 0 skipped
```

Nenhum teste falhou. A release foi bloqueada mesmo assim, porque a área alterada é
crítica (Payments, criticidade 90), o mutation score está abaixo do mínimo e não há
evidência de mitigação. **Teste verde não é prova de qualidade.**

## Experimente em 30 segundos

```bash
npm install
npm run demo
```

Isso executa o gate contra `examples/checkout-service` — código e testes reais, nada
simulado — e gera `examples/checkout-service/evidence-gate-report.html`.

A variante saudável do mesmo projeto passa:

```bash
npm run demo:healthy    # RELEASE_APPROVED, exit 0
```

O `npm run demo` termina com **exit code 1** de propósito: é assim que ele trava um
pipeline.

## Use no seu projeto

Crie um `evidence-gate.config.json` na raiz do repositório a ser avaliado:

```json
{
  "project": "checkout-service",
  "baseRef": "origin/main",
  "criticalityRules": [
    { "pathPrefix": "src/payment/", "area": "Payments", "businessCriticality": 90 }
  ],
  "riskMetrics": { "bugCount": 3, "coverage": 72, "changesLast90Days": 14, "relatedTests": 2 },
  "suppliedEvidence": { "coverage": 72, "mutationScore": 61 },
  "execution": {
    "workingDirectory": ".",
    "suites": [
      {
        "key": "unit",
        "kind": "REGRESSION",
        "command": "node",
        "args": ["./node_modules/vitest/vitest.mjs", "run", "--reporter=json", "--outputFile={{reportPath}}"],
        "reportFormat": "vitest-json"
      }
    ]
  }
}
```

E rode:

```bash
evidence-gate check                 # descobre o diff via git diff origin/main...HEAD
evidence-gate check --fail-on blocked
evidence-gate check --diff-file changes.patch --json
```

Formatos de relatório suportados: **vitest/jest** (`vitest-json`) e **Playwright**
(`playwright-json`).

Exit codes: `0` decisão aceitável · `1` gate reprovou · `2` erro operacional.

## No Pull Request

A Action publica a decisão como comentário, atualiza o mesmo comentário a cada push
(em vez de acumular duplicatas), anexa o relatório HTML como artifact e falha o job
quando o gate reprova.

```yaml
name: Evidence Gate
on: pull_request

permissions:
  contents: read
  pull-requests: write

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0          # o gate compara com a branch base
      - uses: actions/setup-node@v4
        with:
          node-version: "22.12"
      - run: npm ci
      - uses: LeoguiatoM5/evidence-gate@main
        with:
          fail-on: blocked
```

Entradas: `config`, `working-directory`, `base`, `fail-on`, `comment`, `github-token`.
Saídas: `decision`, `quality-score`, `risk-score`, `summary-file`.

Este repositório usa a própria ferramenta nos seus PRs — veja
`.github/workflows/evidence-gate.yml` e o `evidence-gate.config.json` da raiz.

## Política do projeto

Peso e limiar são política, não verdade universal. Um time sem mutation testing declara
isso, em vez de ser pontuado por evidência que nunca produz:

```json
{
  "qualityPolicy": {
    "version": "quality-v1-acme",
    "weights": { "regression": 40, "api": 20, "mutation": 8, "coverage": 5 },
    "approvedMinimum": 85,
    "mutationMinimum": 75
  },
  "riskPolicy": { "levels": { "critical": 70 } }
}
```

Os mapas são mesclados sobre o padrão, e chave desconhecida é rejeitada em vez de
ignorada. **O que a configuração não faz é silenciar uma lacuna:** um componente
continua listado como evidência ausente, continua derrubando a confiança e continua
impedindo aprovação automática — muda apenas quanto ele pesa no score.

É por isso que este repositório fica em `REVIEW_REQUIRED` no próprio gate: os 64 testes
passam, mas ele ainda não mede mutation nem coverage, e diz isso.

## Como a decisão é formada

```text
diff → risco → seleção de suítes por risco → execução → score → gate
```

1. **Risco** (0–100) por criticidade da área, tamanho da mudança, histórico de bugs,
   lacunas de coverage e mutation, falhas anteriores, frequência e testes relacionados.
2. **Seleção**: LOW/MEDIUM roda smoke; HIGH/CRITICAL roda regressão + API. Se o projeto
   não declara suíte do tipo pedido, roda todas as permitidas — errar para o lado seguro.
3. **Execução** de verdade, em subprocesso isolado, com timeout e teto de saída.
4. **Quality Score** ponderado por regressão, mutation, controle de risco, API,
   estabilidade, coverage e completude da evidência.
5. **Gate**, que é separado do score: teste crítico falho, issue crítica de segurança,
   mutation abaixo do mínimo ou risco crítico não mitigado **bloqueiam antes do score**.

Regras que valem sempre:

- **Evidência ausente nunca vira sucesso** — ela derruba a confiança e impede aprovação.
- **Execução quebrada não gera decisão** — crash, timeout ou relatório ausente produzem
  erro operacional, não um gate verde.
- **Regressão e API só vêm de execução real.** Não há como informá-las por configuração.

## Segurança de execução

A ferramenta executa processos, então isso não é detalhe:

- Só executa o que está no allow list da configuração. Nada vindo de payload, diff ou
  modelo vira comando, argumento ou diretório.
- `spawn` sem shell; comando resolvido para caminho absoluto e validado antes de rodar.
- Timeout encerra a árvore de processos; saída limitada e marcada como truncada.
- O processo filho recebe apenas uma lista fixa de variáveis de ambiente.
- `Authorization`, `Cookie`, `Set-Cookie`, senhas, JWT e tokens de provedor são
  mascarados antes de qualquer gravação em relatório, log ou artefato.

Esse último item nasceu de um bug real: `authorization: Bearer <token>` mascarava a
palavra "Bearer" e deixava o token exposto. Foi encontrado por um teste da própria
suíte, corrigido, e hoje tem teste de regressão
(`packages/core/src/redaction.test.ts`).

## Modo servidor (opcional)

Além do CLI existe uma API assíncrona com worker, fila e persistência em SQLite, para
quem quer histórico e execução fora do processo:

| Método | Rota | Descrição |
|---|---|---|
| `POST` | `/api/v1/analyses` | Enfileira a análise, responde `202` com `PENDING`. |
| `POST` | `/api/v1/analyses/deterministic` | Modo fixture síncrono: nada executa. |
| `GET` | `/api/v1/analyses/:id` | Etapas, execuções, artefatos, risco, score e gate. |
| `POST` | `/api/v1/analyses/:id/cancel` | Cancela na fila ou entre etapas. |

```bash
npm run db:generate
npm run dev:api      # http://127.0.0.1:3333
npm run dev:worker
```

O worker tem máquina de estados idempotente
(`PENDING → ANALYZING → SELECTING_TESTS → EXECUTING → CALCULATING → COMPLETED`), lease
no SQLite e retomada após crash sem repetir etapa concluída.

## Arquitetura

```text
apps/cli/                  evidence-gate check — CLI, relatório HTML e exit code
apps/api/                  API Fastify (modo servidor)
apps/worker/               fila, lease e máquina de estados
packages/core/             tipos, portas de execução, redação de segredos
packages/git-analyzer/     parser determinístico de Git Diff
packages/risk-engine/      cálculo de risco explicável
packages/quality-engine/   Quality Score, Quality Gate, seleção e evidência
packages/test-runner/      execução allow-listed e parsers de relatório
packages/persistence-prisma/ schema, migrations e repositórios SQLite
examples/checkout-service/ projeto de exemplo com código e testes reais
```

O domínio não conhece Fastify, Prisma, Playwright nem vitest. Os adapters dependem das
portas do núcleo, nunca o contrário — é por isso que o CLI e o worker compartilham a
mesma política sem duplicar regra.

Decisões e trade-offs: `docs/adr/`. Escopo de cada incremento:
`docs/architecture/`.

## Estado e limites

Funciona hoje: CLI, relatório HTML, execução vitest/jest e Playwright, API, worker,
persistência.

Ainda **não** existe: mutation testing executado (o `mutationScore` é informado por
você; o adapter Stryker é o próximo passo), seleção por impacto real do diff, dashboard
web, integração com GitHub/PR, autenticação. O `TestSelection.reason` gravado em cada
análise diz explicitamente o que foi e o que não foi resolvido.

## Desenvolvimento

Requer Node 22.12+.

```bash
npm install
npm run quality    # lint + typecheck + 62 testes
```

Os testes de execução rodam subprocessos reais e usam um SQLite temporário; não há mock
de runner nos casos de sucesso, timeout e crash.
