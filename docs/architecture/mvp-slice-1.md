# MVP — Fatia vertical 1

## Resultado entregue

Esta fatia implementa o primeiro caminho real do produto:

```text
Git Diff
  → arquivos e áreas afetadas
  → Risk Score explicável
  → Quality Score baseado em evidências
  → Quality Gate
  → persistência SQLite
  → resposta HTTP consultável
```

## Limites atuais

- O diff é enviado à API; leitura direta de um repositório local ainda não está habilitada.
- Evidências de testes são recebidas como dados estruturados e não são inventadas.
- O Playwright runner e o worker assíncrono pertencem ao próximo corte vertical.
- Pesos e thresholds usam políticas determinísticas versionadas em código; persistência e edição de políticas virão depois.
- O parser cobre o formato unificado produzido por `git diff --git` e rejeita entradas sem mudanças reconhecidas.

## Próximo corte vertical

1. Criar o worker e a máquina de estados persistente.
2. Implementar um adapter Playwright com comando permitido e timeout.
3. Normalizar o JSON reporter em `TestExecution` e `TestResult`.
4. Armazenar apenas metadados no SQLite e evidências em `artifacts/`.
5. Expor progresso da análise sem executar testes na thread HTTP.
6. Criar o dashboard React para consumir análises reais.

## Condição de segurança

O worker não aceitará comandos de shell vindos do payload nem de uma resposta de IA. Runner, script, argumentos e diretórios serão resolvidos por configuração previamente autorizada.
