# Evidence Gate — Handoff do agente

Atualizado em 31/08/2026 (Incrementos 1–3 concluídos). Este arquivo registra o estado verificável do projeto, decisões já tomadas e a sequência segura para continuar sem recomeçar ou simular funcionalidades.

## Objetivo do produto

Evidence Gate é um Intelligent QA Gate: recebe uma alteração de software e evidências reais, calcula risco e qualidade, e retorna uma decisão explicável:

```text
RELEASE_APPROVED | REVIEW_REQUIRED | RELEASE_BLOCKED
```

Princípio obrigatório: testes verdes e coverage alto não comprovam qualidade por si só. Mutation testing, risco, criticidade, estabilidade e evidência disponível precisam influenciar a decisão.

## Restrição da máquina de desenvolvimento (não se aplica a quem clona o repositório)

Esta seção descreve **apenas** a estação onde o projeto foi desenvolvido. Quem clona o
repositório usa `npm` normalmente, como está no README; nada aqui é requisito do produto.

Nessa estação o disco `C:` não é confiável, então todo arquivo gravável do projeto
permanece em `D:\QUALITYGUARD_AI`.

- Runtime local: `D:\QUALITYGUARD_AI\.tooling\node\node-v22.23.2-win-x64`
- Cache npm: `D:\QUALITYGUARD_AI\.cache\npm`
- Perfil isolado e temporários: `D:\QUALITYGUARD_AI\.local` e `D:\QUALITYGUARD_AI\.tmp`
- SQLite: `D:\QUALITYGUARD_AI\data\evidence-gate.db`
- Artefatos de execução: `D:\QUALITYGUARD_AI\artifacts`
- Allow list de execução do worker: `D:\QUALITYGUARD_AI\config\execution-policy.json`

Use sempre o wrapper abaixo para comandos Node/npm:

```powershell
.\scripts\qg.ps1 npm <comando>
```

O wrapper ajusta `PATH`, `TEMP`, `TMP`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, cache npm e `DATABASE_URL` para o `D:`. Não usar `npm`, `npx`, `pnpm` ou Node global diretamente, pois eles podem acessar o perfil do `C:`.

Observação: o wrapper não é apropriado para encaminhar flags isoladas iniciadas por hífen ao próprio `node`. Criar scripts npm explícitos para operações recorrentes, como já foi feito para migrations.

## Estado entregue

Incremento 1 — fatia vertical determinística e persistida:

```text
Git Diff
  → Repository Analyzer
  → Risk Engine
  → Quality Score
  → Quality Gate
  → SQLite
  → Fastify API
```

Incremento 2 — execução assíncrona real, controlada e persistida:

```text
POST /api/v1/analyses
  → parser de diff no intake (sem processo externo)
  → Analysis PENDING + AnalysisJob QUEUED
  → 202 Accepted

Worker (lease no SQLite)
  → ANALYZING → SELECTING_TESTS → EXECUTING (Playwright) → CALCULATING → COMPLETED
```

Incremento 3 — CLI, exemplo executável e relatório HTML:

```text
evidence-gate check
  → descobre o diff (git ou --diff-file)
  → mesma pipeline do worker, em um processo, sem banco
  → saída no terminal + relatório HTML autocontido
  → exit code 0/1/2
```

Não há dashboard web, mutation testing executado (Stryker), IA nem integração com GitHub. Esses itens pertencem aos incrementos 4–6 e não devem ser apresentados como prontos.

### Monorepo atual

```text
apps/cli/                         CLI evidence-gate check, relatório HTML e exit code
apps/api/                         API Fastify (modo servidor)
apps/worker/                      worker, fila e máquina de estados
packages/core/                    tipos, portas de execução e redação de segredos
packages/contracts/               contratos TypeBox da API
packages/git-analyzer/            parser determinístico de Git Diff
packages/risk-engine/             cálculo de risco
packages/quality-engine/          Quality Score, Gate, seleção por risco e evidência
packages/test-runner/             execução allow-listed e parsers de relatório
packages/persistence-prisma/      schema, migrations, fila e repositórios SQLite
config/                           allow list de execução do worker (exemplo versionado)
examples/checkout-service/        projeto de exemplo com código e testes reais
scripts/qg.ps1                    execução isolada no D:
tests/helpers/                    helper de banco temporário para testes de integração
docs/adr/                         decisões arquiteturais
docs/architecture/                documentação de incrementos
```

### Funcionalidades implementadas

1. Repository Analyzer

   - Processa diff unificado iniciado por `diff --git`.
   - Identifica arquivos adicionados, modificados, removidos e renomeados.
   - Conta adições, remoções, linhas alteradas e extensões.
   - Infere áreas por path e permite regras explícitas de criticidade por prefixo.
   - Rejeita diff sem mudanças reconhecidas; não inventa arquivos ou áreas.

2. Risk Engine

   - Score de 0 a 100, classificação LOW/MEDIUM/HIGH/CRITICAL.
   - Pesos padrão: criticidade 25, tamanho 15, histórico de bugs 13, gap de coverage 12, gap de mutation 12, falhas anteriores 10, frequência 8 e gap de testes relacionados 5.
   - Todos os pesos, thresholds e fallbacks estão concentrados em `DEFAULT_RISK_POLICY`.
   - Métricas ausentes recebem fallback conservador, ficam marcadas como ausentes e reduzem `confidence`; não são tratadas como sucesso.
   - Mantém contribuição individual de cada fator para explicabilidade.

3. Quality Engine e Gate

   - Score ponderado por regression, mutation, controle de risco, API, estabilidade, coverage e completude de evidência.
   - Teste crítico falho, issue crítica de segurança, mutation abaixo do mínimo e risco crítico não mitigado bloqueiam a release antes do score.
   - Mutation score padrão mínimo: 75.
   - Quality Score mínimo para revisão: 65; para aprovação: 85.
   - Evidências ausentes nunca permitem aprovação automática.

4. API e persistência

   - `POST /api/v1/analyses`: intake assíncrono. Faz o parsing do diff, cria `Analysis` em `PENDING` com `AnalysisJob` `QUEUED` e responde `202`. Não executa processo na thread HTTP.
   - `POST /api/v1/analyses/deterministic`: modo fixture síncrono, comportamento original do Incremento 1. Nenhum processo executa; todo resultado vem do payload.
   - `GET /api/v1/analyses/:id`: análise persistida com etapas, job, seleção, execuções, suítes, resultados e artefatos.
   - `POST /api/v1/analyses/:id/cancel`: cancela job `QUEUED`; job `RUNNING` recebe `cancelRequested` e para entre etapas.
   - Idempotência por projeto, repositório, commit, hash do diff, versão de política e modo (async/deterministic são chaves distintas).
   - O raw diff não é persistido; somente hash e mudanças normalizadas.
   - `removeAdditional` do Ajv está desligado: campo desconhecido no payload gera `400`, em vez de ser silenciosamente descartado.
   - Prisma ORM 7.10 + `@prisma/adapter-better-sqlite3` + SQLite.
   - Migrations aplicadas: `20260831115502_init` e `20260831125335_worker_execution`.

5. Worker e máquina de estados (Incremento 2)

   - `apps/worker` faz polling com lease no SQLite; um job por análise (`AnalysisJob.analysisId` único).
   - Estados: `PENDING → ANALYZING → SELECTING_TESTS → EXECUTING → CALCULATING → COMPLETED`, com `FAILED`, `CANCELLED` e `TIMED_OUT`.
   - Cada etapa grava `AnalysisStage`; etapa `COMPLETED` nunca é reexecutada, então retomada não repete trabalho.
   - Lease expirado devolve o job para `QUEUED`; esgotadas as tentativas, o job vai para `FAILED`.
   - `saveExecution` apaga a execução anterior da mesma suíte antes de gravar; retentativa não duplica resultados.
   - O parsing do diff fica no intake porque o raw diff não é persistido — o worker parte das mudanças já normalizadas.

6. Execução de testes (`packages/test-runner`)

   - Executa somente suítes declaradas em `config/execution-policy.json` (`EG_EXECUTION_POLICY_FILE`). Nada do payload vira comando, argumento ou diretório.
   - `spawn` com `shell: false`; comando obrigatoriamente absoluto e existente; policy validada antes de qualquer job.
   - Timeout encerra a árvore de processos (`taskkill /T /F` no Windows); saída limitada por `maxOutputBytes` e marcada como truncada.
   - O processo filho recebe apenas variáveis de uma lista fixa mais `PLAYWRIGHT_JSON_OUTPUT_NAME`; o ambiente do worker não vaza.
   - Parser defensivo do reporter JSON: suítes aninhadas, tags `@critical`, flaky por retentativa, identidade estável por teste.
   - Artefatos em `D:\QUALITYGUARD_AI\artifacts\<analysisId>\<suiteKey>`, registrados por caminho relativo; anexos copiados com teto de 20 arquivos e 10 MB.
   - Crash, relatório ausente ou timeout produzem `FAILED`/`TIMED_OUT` — nunca resultado inventado, e nenhum Quality Gate é gravado.

7. Seleção de testes e evidência

   - Seleção por nível de risco sobre o allow list: LOW/MEDIUM → smoke; HIGH/CRITICAL → smoke + regressão + API.
   - Seleção por impacto real depende do mapa do Incremento 4; `TestSelection.reason` registra explicitamente essa limitação.
   - Regressão, API e flaky rate vêm exclusivamente da execução; mutation, coverage, mitigação e segurança continuam sendo valores informados no intake (`suppliedEvidence`).
   - O contrato assíncrono não aceita resultados de regressão no payload.

8. CLI (`apps/cli`) — Incremento 3

   - `evidence-gate check` roda a mesma pipeline do worker em um processo, sem banco.
   - Origem do diff: `git diff <base>...HEAD`, fallback para a árvore de trabalho, ou `--diff-file`.
   - Configuração no repositório avaliado: `evidence-gate.config.json`. O comando só aceita o literal `node`, um caminho absoluto ou um caminho relativo ao `workingDirectory` — nunca texto livre de shell.
   - Exit codes: `0` decisão aceitável, `1` gate reprovou, `2` erro operacional. `--fail-on blocked|review` controla o limiar.
   - Relatório HTML autocontido: sem script, sem fonte externa, sem requisição de rede; claro e escuro; todo valor rotulado, sem depender de cor sozinha. Valores vindos do projeto avaliado são escapados (coberto por teste).
   - `npm run demo` e `npm run demo:healthy` executam contra `examples/checkout-service` sem configuração adicional.

9. Formatos de relatório de teste

   - `playwright-json` e `vitest-json` (compatível com Jest). A suíte declara `reportFormat`.
   - O token `{{reportPath}}` nos argumentos é substituído pelo destino que o runner controla; a configuração não escolhe onde o relatório é gravado.
   - O parser do vitest não infere flakiness: o relatório não expõe retentativas, então `retries` fica em 0 em vez de ser adivinhado.

10. Segurança já aplicada

   - Body limit da API: aproximadamente 2 MB.
   - `redactText` / `redactValue` / `redactHeaders` em `@evidence-gate/core` mascaram `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `password`, `secret`, tokens de provedor (GitHub, OpenAI, Slack, AWS), JWT e chaves privadas antes de qualquer gravação de mensagem de erro, log de processo ou artefato.
   - Segredo após esquema de autenticação (`authorization: Bearer <token>`) é mascarado junto com o esquema; isso foi um bug real corrigido e coberto por teste de regressão.
   - Artefatos, caches, banco, temporários e `config/execution-policy.json` são ignorados pelo Git.
   - O worker não executa comando proveniente de payload ou IA.

## Arquivos de referência

| Assunto | Arquivo |
|---|---|
| Contratos HTTP | `packages/contracts/src/index.ts` |
| Tipos de domínio | `packages/core/src/index.ts` |
| Ciclo de vida e portas de execução | `packages/core/src/execution.ts` |
| Redação de segredos | `packages/core/src/redaction.ts` |
| Parser de diff | `packages/git-analyzer/src/index.ts` |
| Risk Engine | `packages/risk-engine/src/index.ts` |
| Quality Engine | `packages/quality-engine/src/index.ts` |
| Schema e migration | `packages/persistence-prisma/prisma/` |
| Repositório Prisma | `packages/persistence-prisma/src/index.ts` |
| Repositório do worker | `packages/persistence-prisma/src/worker-repository.ts` |
| Fila com lease | `packages/persistence-prisma/src/job-queue.ts` |
| Allow list e validação de execução | `packages/test-runner/src/policy.ts` |
| Processo isolado e timeout | `packages/test-runner/src/process.ts` |
| Parser do reporter Playwright | `packages/test-runner/src/report.ts` |
| Adapter de execução | `packages/test-runner/src/index.ts` |
| Máquina de estados | `apps/worker/src/pipeline.ts` |
| Loop, lease e heartbeat | `apps/worker/src/worker.ts` |
| Config do worker | `apps/worker/src/config.ts` |
| Allow list de exemplo | `config/execution-policy.example.json` |
| CLI e exit codes | `apps/cli/src/main.ts` |
| Pipeline do CLI | `apps/cli/src/run-check.ts` |
| Relatório HTML | `apps/cli/src/report-html.ts` |
| Configuração do projeto avaliado | `apps/cli/src/config.ts` |
| Origem do diff | `apps/cli/src/diff-source.ts` |
| Seleção por risco | `packages/quality-engine/src/selection.ts` |
| Evidência derivada da execução | `packages/quality-engine/src/evidence.ts` |
| Parser vitest/jest | `packages/test-runner/src/report-vitest.ts` |
| Projeto de exemplo | `examples/checkout-service/` |
| Rotas Fastify | `apps/api/src/app.ts` |
| Servidor | `apps/api/src/server.ts` |
| Isolamento no D: | `scripts/qg.ps1` |
| Decisão técnica | `docs/adr/0001-modular-monolith-and-local-toolchain.md` |
| Escopo do incremento 1 | `docs/architecture/mvp-slice-1.md` |
| Escopo do incremento 2 | `docs/architecture/mvp-slice-2.md` |
| Escopo do incremento 3 | `docs/architecture/mvp-slice-3.md` |

## Validações já executadas

Última validação concluída com sucesso:

```text
npm run lint       aprovado
npm run typecheck  aprovado
npm test           10 arquivos, 62 testes aprovados
```

Os testes existentes cobrem:

- parsing de Git Diff, áreas, criticidade e rejeição de input inválido;
- pesos, thresholds e ausência de evidência do Risk Engine;
- aprovação, bloqueio por mutation, bloqueio por teste crítico e ausência de evidência no Quality Gate;
- API + SQLite temporário: modo determinístico, intake assíncrono, idempotência, rejeição de campo desconhecido, cancelamento e recuperação por `GET`;
- redação de segredos em headers, texto livre, estruturas aninhadas e credencial após esquema de autenticação;
- execução real via subprocesso: relatório normalizado, suíte fora do allow list recusada, crash, timeout com encerramento do processo e truncamento de saída;
- worker de ponta a ponta com banco real: sucesso completo, bloqueio por teste crítico falho, timeout sem gate gravado, job duplicado, retomada após crash sem repetir etapa concluída, lease expirado e job cancelado na fila;
- seleção por risco, fallback quando nenhuma suíte corresponde à estratégia, e evidência derivada apenas do que executou;
- parser vitest/jest: normalização, tag `@critical`, redação de segredo em mensagem de falha, arquivo que não carregou e relatório fora de formato;
- CLI: parsing de argumentos, origem do diff, validação de configuração, aprovação, bloqueio por teste crítico, escape de HTML no relatório e saída de terminal sem caracteres de controle.

Os testes de execução usam scripts Node reais gravados em `.tmp`, executados como subprocesso de verdade. Não há mock do runner nos casos de sucesso e timeout.

Antes de entregar qualquer incremento futuro, executar:

```powershell
.\scripts\qg.ps1 npm run db:generate
.\scripts\qg.ps1 npm run quality
```

Para criar ou atualizar migrations em ambiente novo:

```powershell
.\scripts\qg.ps1 npm run db:migrate:init
.\scripts\qg.ps1 npm run db:migrate:worker
```

Para rodar o worker localmente:

```powershell
copy config\execution-policy.example.json config\execution-policy.json
.\scripts\qg.ps1 npm run dev:worker
```

Não usar `db:migrate:dev` com flags via wrapper sem primeiro corrigir o encaminhamento de flags. Preferir adicionar um script npm nomeado e não interativo.

## Decisões arquiteturais vigentes

1. Monólito modular agora, worker separado quando a execução de testes entrar. Não introduzir microserviços, Redis, filas externas ou Kubernetes no MVP.
2. Domínio não conhece Fastify, Prisma, Playwright, Stryker ou IA. Adapters dependem das portas do núcleo, e não o contrário.
3. SQLite é adequado para um worker no MVP. Migrar para PostgreSQL antes de múltiplos workers concorrentes ou produção multiusuário.
4. Prisma ORM 7 foi fixado porque suporta SQLite e PostgreSQL; Prisma 8 atual não deve ser adotado enquanto SQLite não for suportado para esta arquitetura.
5. IA será apoio explicável e jamais fonte única de risco, teste, falha ou decisão.
6. Policy/configuração aplicada deve ser versionada e persistida com a análise. Hoje existe em código; edição e persistence de policies ainda são pendências.
7. `QualityGate` é separado de `QualityScore`. Score alto não pode sobrescrever bloqueadores.

## Pendências e sequência de implementação

### Incremento 2 — Worker e Playwright (concluído)

Entregue e validado. Detalhes em `docs/architecture/mvp-slice-2.md`.

- `apps/worker` com polling e lease no SQLite.
- API cria `Analysis` como `PENDING` e responde `202`; nada executa na thread HTTP.
- Máquina de estados idempotente com etapas persistidas e retomada após crash.
- `packages/test-runner` com allow list, `shell: false`, timeout com kill de árvore, teto de saída, ambiente mínimo e artefatos em `D:\QUALITYGUARD_AI\artifacts`.
- Reporter JSON do Playwright lido e persistido em `TestExecution`, `TestSuite`, `TestResult` e `Artifact`.
- Redação de segredos aplicada antes de qualquer gravação.
- Endpoint síncrono preservado como modo determinístico/fixture em `POST /api/v1/analyses/deterministic`.

Pendências deixadas conscientemente para os incrementos seguintes:

- Seleção por impacto real (mapa path/módulo → suítes) é do Incremento 4; hoje a seleção é por nível de risco sobre o allow list.
- Mascaramento de request/response de testes de API só terá efeito prático quando o Incremento 4 normalizar essas evidências; a função de redação já existe e está testada.
- Retenção e limpeza de artefatos ainda não existem.

### Incremento 3 — CLI, exemplo e relatório (concluído)

Entregue e validado. Detalhes em `docs/architecture/mvp-slice-3.md`.

- `apps/cli` com `evidence-gate check`, exit codes e relatório HTML autocontido.
- Runner multi-formato: `playwright-json` e `vitest-json`; pacote renomeado para `packages/test-runner`.
- `examples/checkout-service` com código e testes reais; `npm run demo` e `npm run demo:healthy`.
- Seleção e evidência movidas de `apps/worker` para `packages/quality-engine`, eliminando duplicação entre worker e CLI.
- Correção de projeto: risco MEDIUM sem suíte `SMOKE` declarada executava zero testes. Agora, se nenhuma suíte corresponde aos tipos preferidos, todas as permitidas rodam, e o motivo é registrado.
- Interface (CLI e relatório) unificada em inglês, alinhada às mensagens do domínio; documentação segue em português.

### Próxima decisão — GitHub Action ou Dashboard

Duas frentes concorrentes, a decidir com o usuário. A numeração 4–7 abaixo permanece
como estava; esta seção é a escolha do que vem primeiro.

**Opção A — GitHub Action (maior impacto de adoção).**

1. Action que roda `evidence-gate check` no PR e publica a decisão como comentário.
2. Idempotência por SHA: reexecutar não duplica comentário.
3. Anexar o relatório HTML como artifact do workflow.
4. Nunca colocar token do GitHub em log, artefato ou relatório.

Critério de saída: abrir um PR produz um comentário com decisão, motivos e números, sem
ninguém rodar comando manualmente.

**Opção B — Dashboard React (maior valor visual, depende do modo servidor).**

1. Criar `apps/web` com React, TypeScript e Vite.
2. Dashboard inicial: decisão destacada, Quality Score, Risk Score, confiança, testes, coverage, mutation, áreas afetadas e motivos do gate.
3. Tela de análise com timeline de etapas, mudanças e contribuições do risco.
4. Polling inicial do status; SSE somente se houver necessidade real.
5. Criar E2E Playwright do dashboard após a primeira tela estar funcionando.

Critério de saída: usuário entende o que mudou, por que a decisão ocorreu e qual ação é
necessária sem consultar logs.

### Incremento 4 — Test Impact Analysis e API Testing

1. Criar mapa determinístico path/módulo → funcionalidades → tags/suítes Playwright.
2. Implementar Test Selection Engine por risco:

   - LOW: smoke;
   - MEDIUM: smoke + relacionados;
   - HIGH: regressão parcial + API;
   - CRITICAL: regressão completa + API + mutation.

3. Integrar Playwright API e normalizar request, response sanitizada, schema, headers e duração.
4. Persistir histórico por identidade estável do teste.
5. Adicionar GitHub Actions: install, lint, typecheck, unit, API, E2E, build e Quality Gate.

### Incremento 5 — Mutation, Flakiness e Failure Analysis

1. Criar adapter StrykerJS, preferindo relatório JSON e execução incremental em PRs.
2. Persistir killed, survived, timeout e no coverage; criar issues para survived mutants críticos.
3. Criar cálculo de flaky score por janela de execuções:

   ```text
   0–2% STABLE | 2–5% ATTENTION | 5–10% FLAKY | >10% HIGHLY_FLAKY
   ```

4. Implementar Failure Analyzer determinístico com evidência: assertion, timeout, network, environment, selector, API, authentication, infrastructure, application bug e unknown.
5. Conectar sinais ao Quality Engine sem duplicar penalidades indevidamente.

### Incremento 6 — IA e GitHub

1. Criar `AIProvider` e contratos: `analyzeDiff`, `generateTestScenarios`, `analyzeFailure`, `calculateRisk`, `explainQualityGate`.
2. Enviar ao modelo apenas fatos estruturados e referências de evidência.
3. Exigir saída estruturada em `FACT`, `INFERENCE`, `RECOMMENDATION`.
4. Rejeitar fatos não sustentados; retornar `INSUFFICIENT EVIDENCE` quando necessário.
5. Criar GitHub App, webhook, recebimento de PR, idempotência por SHA e comentário de PR.
6. Nunca colocar token do GitHub, OpenAI ou outro provedor no banco, log, artefato ou resposta HTTP.

### Incremento 7 — Produto operacional

1. Trends de Quality Score, mutation, coverage, flaky rate, duração e detecção de bugs.
2. Migração ensaiada SQLite → PostgreSQL.
3. OpenTelemetry, métricas Prometheus e dashboards de operação.
4. Retenção de artefatos, autenticação/autorização e políticas por projeto.
5. Docker Compose, documentação de deploy e segurança de execução.

## Regras de continuidade

- Antes de editar: inspecionar o estado atual e executar testes afetados.
- Usar `apply_patch` para editar arquivos.
- Não criar arquivos vazios ou TODOs para representar funcionalidades essenciais.
- Não simular teste, diff, mutation, API response ou resultado de execução.
- Não persistir dados sensíveis e não aceitar comandos arbitrários de payload/IA.
- Sempre criar ou atualizar testes junto com regra de domínio, parser, adapter ou gate alterado.
- Preferir mudanças incrementais, com `npm run quality` ao fim de cada incremento.
- Avisar ao usuário se uma ação precisar escrever fora de `D:\QUALITYGUARD_AI` ou se algum tool tentar usar o `C:`.
- Não reinicializar Git pelo usuário do sandbox: a tentativa anterior foi removida porque o ownership do sandbox impedia comandos. O usuário real pode inicializá-lo futuramente no próprio terminal.

## Riscos conhecidos

| Risco | Situação / mitigação |
|---|---|
| I/O lento no D: | Instalação inicial levou cerca de 7 minutos; evitar instalações concorrentes e elevar apenas timeouts de testes de integração, não esconder travamentos de produção. |
| `better-sqlite3` transitivo | O install emite aviso de `prebuild-install` descontinuado. Monitorar atualização do adapter/Prisma e auditar lockfile em CI. |
| SQLite concorrente | Adequado para um worker MVP. Não iniciar múltiplos workers até migração para PostgreSQL ou mecanismo de lease devidamente testado. |
| Parser de diff | Suporta formato unificado comum; ampliar fixtures antes de alegar suporte total a paths complexos, binaries ou submodules. |
| Políticas em código | Adequadas para o primeiro corte; devem migrar para `ProjectPolicy` versionada antes de multi-projeto. |
| API síncrona | Preservada apenas como modo determinístico/fixture em `/api/v1/analyses/deterministic`. Não deve executar Playwright/Stryker na thread HTTP. |
| Artefatos sem retenção | `artifacts/` cresce sem limpeza. Definir política de retenção antes de uso prolongado. |
| Allow list de execução | `config/execution-policy.json` é confiança de operador e não é versionado. Um comando errado ali executa de verdade; revisar como se revisa um script de CI. |
| Um worker por vez | O lease no SQLite protege contra dupla execução do mesmo job, mas concorrência real de múltiplos workers só depois do PostgreSQL. |

