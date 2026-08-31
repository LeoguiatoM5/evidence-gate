# ADR 0001: Monólito modular e toolchain local no disco D

## Status

Aceita.

## Contexto

O QualityGuard AI precisa entregar um MVP executável sem introduzir infraestrutura distribuída prematura. O disco `C:` do ambiente atual não pode ser usado para dados, dependências, temporários ou caches do projeto.

## Decisão

- Adotar monólito modular TypeScript com API Fastify e futuro worker separado.
- Usar npm workspaces neste ambiente, porque o runtime Node oficial e o npm que o acompanha podem ser isolados dentro do próprio projeto sem depender de uma instalação global.
- Manter runtime, cache npm, perfil temporário, banco SQLite e artefatos sob `D:\QUALITYGUARD_AI`.
- Usar `scripts/qg.ps1` como entrada para comandos locais.
- Fixar Node.js 22 e Prisma ORM 7 para compatibilidade com SQLite e posterior PostgreSQL.

## Consequências

- O projeto pode ser construído sem gravações no perfil do Windows localizado em `C:`.
- A pasta `.tooling` não é versionada; outro ambiente deverá provisionar o runtime local ou usar um Node compatível já instalado.
- A troca de npm workspaces por pnpm poderá ser reavaliada quando não exigir dependência global ou acesso ao disco comprometido.
