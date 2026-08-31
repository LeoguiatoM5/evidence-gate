# Incremento 2 — Worker, execução controlada e persistência de evidência

Objetivo entregue: substituir evidência de regressão fornecida manualmente por execução
controlada, persistida e explicável, sem bloquear a requisição HTTP.

## Fluxo

```text
POST /api/v1/analyses
  → parser de diff (síncrono, sem processo externo)
  → Analysis PENDING + AnalysisJob QUEUED
  → 202 Accepted

Worker (lease no SQLite)
  → ANALYZING          risco a partir das mudanças persistidas
  → SELECTING_TESTS    suítes permitidas escolhidas por nível de risco
  → EXECUTING           Playwright em processo isolado, com timeout e teto de saída
  → CALCULATING         Quality Score e Quality Gate a partir do que executou
  → COMPLETED
```

Estados terminais alternativos: `FAILED`, `CANCELLED`, `TIMED_OUT`.

## Por que o parser roda na API

O raw diff não é persistido (somente hash e mudanças normalizadas). Como o worker não
teria o diff depois que a requisição termina, o parsing acontece no intake, que é
determinístico, barato e não executa processo algum. O worker começa a partir das
mudanças já normalizadas no banco.

## Idempotência e retomada

- Um job por análise (`AnalysisJob.analysisId` é único), então reenfileirar é inócuo.
- Cada etapa grava `AnalysisStage`; uma etapa `COMPLETED` nunca é reexecutada.
- O lease expira: se o worker morrer, o job volta para `QUEUED` e a análise retoma na
  primeira etapa não concluída. Esgotadas as tentativas, o job vai para `FAILED`.
- `saveExecution` apaga a execução anterior da mesma suíte antes de gravar, então uma
  retentativa não duplica resultados.

## Segurança de execução

- Nada vindo do payload vira comando, argumento ou diretório. O allow list está em
  `config/execution-policy.json`, apontado por `QG_EXECUTION_POLICY_FILE`.
- `spawn` sem shell (`shell: false`), comando obrigatoriamente absoluto e existente.
- Timeout com encerramento da árvore de processos (`taskkill /T /F` no Windows).
- Saída limitada por `maxOutputBytes`; o excedente é descartado e marcado como truncado.
- O processo filho recebe apenas variáveis de ambiente de uma lista fixa, mais
  `PLAYWRIGHT_JSON_OUTPUT_NAME`; nada do ambiente do worker vaza.
- Artefatos ficam em `D:\QUALITYGUARD_AI\artifacts\<analysisId>\<suiteKey>` e são
  registrados por caminho relativo, nunca absoluto.
- `redactText`/`redactValue` (em `@qualityguard/core`) mascaram `Authorization`,
  `Cookie`, `Set-Cookie`, tokens de provedor, JWT e chaves privadas antes de qualquer
  gravação de mensagem de erro ou log de processo.

## Evidência

| Sinal | Origem no Incremento 2 |
|---|---|
| regressão (passed/failed/criticalFailures) | somente execução real |
| API (passed/failed) | somente execução real, suítes de kind `API` |
| flaky rate | retentativas observadas na execução |
| mutation, coverage, mitigação, segurança | valores informados no intake (`suppliedEvidence`) |

O contrato assíncrono não aceita resultados de regressão no payload: o schema rejeita
campos desconhecidos e `removeAdditional` está desligado, então o cliente recebe 400 em
vez de ter o campo silenciosamente descartado.

Se a execução não produzir evidência utilizável (crash, relatório ausente, timeout), a
etapa falha e **nenhum Quality Gate é gravado**. Não existe decisão a partir de execução
quebrada.

## Modo determinístico

`POST /api/v1/analyses/deterministic` mantém o comportamento síncrono anterior: nenhum
processo é executado e todo resultado vem da evidência do payload. Serve para verificar
política de forma reprodutível — não para evidência de release.

## Cancelamento

`POST /api/v1/analyses/:id/cancel` cancela um job `QUEUED` imediatamente. Um job
`RUNNING` recebe `cancelRequested`, e o worker para entre etapas, nunca no meio de uma
escrita parcial.

## Como executar

```powershell
copy config\execution-policy.example.json config\execution-policy.json
# ajustar workingDirectory, command e args para o projeto alvo
.\scripts\qg.ps1 npm run db:generate
.\scripts\qg.ps1 npm run dev:api
.\scripts\qg.ps1 npm run dev:worker
```

## Limites conhecidos

- A seleção por impacto (suítes relacionadas ao diff) depende do mapa de impacto do
  Incremento 4. Hoje a seleção é por nível de risco sobre o allow list, e o motivo
  gravado em `TestSelection.reason` diz isso explicitamente.
- Mutation testing continua sendo valor informado; o adapter Stryker é do Incremento 5.
- Um worker por vez. SQLite com lease serve ao MVP; múltiplos workers exigem PostgreSQL.
