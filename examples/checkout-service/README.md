# checkout-service (exemplo)

Projeto de exemplo avaliado pelo QualityGuard. **Código e testes são reais** — nada aqui
é simulado. As suítes rodam de verdade com vitest e produzem o relatório JSON que o
QualityGuard normaliza.

```text
src/payment/limit.ts      regra de limite de pagamento por tier
src/api/quote-handler.ts  contrato de POST /quote, sem framework HTTP
tests/unit/               5 testes da regra de limite
tests/api/                4 testes do contrato da API
changes.patch             o diff analisado pelo demo
```

Duas configurações, mesmo código e mesmos testes:

| Arquivo | Cenário | Decisão |
|---|---|---|
| `qualityguard.config.json` | mutation 61, coverage 72, 3 bugs em 90 dias, 2 testes relacionados | `RELEASE_BLOCKED` |
| `qualityguard.healthy.json` | mutation 88, coverage 94, sem bugs recentes, 9 testes relacionados | `RELEASE_APPROVED` |

Em ambos os casos **todos os 9 testes passam**. A diferença na decisão vem do risco da
área alterada e da evidência disponível — não de teste falhando.

Da raiz do repositório:

```powershell
.\scripts\qg.ps1 npm run demo            # bloqueado, exit 1
.\scripts\qg.ps1 npm run demo:healthy    # aprovado, exit 0
```
