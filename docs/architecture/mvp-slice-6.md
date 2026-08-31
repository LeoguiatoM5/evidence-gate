# Incremento 6 — Métricas de risco derivadas do histórico

Objetivo: parar de pedir que alguém **digite** quantos bugs uma área teve.

## O problema

A configuração pedia `bugCount`, `changesLast90Days` e `relatedTests` à mão. Isso tem
dois defeitos, e o segundo é pior que o primeiro:

1. Ninguém sabe esses números de cabeça.
2. Quem chutar vai chutar para o lado que dá o resultado desejado — e o gate perde o
   sentido.

Havia também um sintoma já registrado: uma mudança só de documentação pontuava risco 45,
porque seis dos oito fatores usavam fallback pessimista. O risco media "não sabemos nada
sobre este repositório", não a mudança.

## O que o histórico responde

`packages/git-history` executa `git log` e conta:

| Métrica | Como é contada |
|---|---|
| `changesLast90Days` | commits que tocaram o arquivo na janela |
| `bugCount` | commits que tocaram o arquivo e **declaram** correção |
| `relatedTests` | arquivos de teste que cobrem o arquivo de origem |

Um commit conta como correção por Conventional Commits (`fix:`, `fix(escopo):`) ou por
palavra-chave, em inglês e português. Um commit que declara outro tipo é levado a sério:
`refactor: simplify the fix routine` **não** é correção. E `fixture` ou `prefix` não
contam — os padrões exigem limite de palavra.

Teste relacionado usa dois sinais determinísticos: o nome do arquivo de teste carrega o
radical do arquivo de origem (`limit.ts` → `limit.test.ts`), ou o teste importa o
módulo. Um arquivo que casa pelos dois conta uma vez.

## Agregação

O risco é do conjunto da mudança, mas as métricas são por arquivo:

- **O arquivo mais quente decide.** Uma mudança que toca um arquivo historicamente
  problemático mais vinte estáveis é tão arriscada quanto aquele arquivo. Daí `max`
  para mudanças e correções.
- **O arquivo menos coberto decide a lacuna de teste.** Daí `min` para testes
  relacionados, considerando apenas arquivos de origem — documentação e teste não têm
  lacuna de teste própria.

## Precedência

**Contado vence declarado.** Um número lido do histórico substitui o que a configuração
tinha. O que o histórico não sabe contar (`previousFailureRate`, `coverage`) continua
vindo da configuração.

O que o histórico não consegue ler fica **ausente**, não zerado — e o motor de risco já
trata ausência como ausência, com fallback conservador e queda de confiança.

## Efeito medido neste repositório

```text
antes:  risco 45–52, com seis de oito fatores em fallback
depois: risco 66 (HIGH), a partir de 8 commits reais na janela
```

O número subiu porque passou a refletir a verdade: os pacotes tocados mudam com
frequência e têm correções recentes.

## O exemplo é a exceção que confirma a regra

`examples/checkout-service` mantém as métricas declaradas na configuração e o demo passa
`--no-history`. O exemplo não é um repositório git próprio — vive dentro do Evidence
Gate. Sem a flag, a derivação leria o histórico *deste* repositório procurando caminhos
de um projeto fictício e devolveria zeros, o que seria pior que o valor declarado.

É o caso geral de uso da flag: quando o histórico disponível não é o histórico do código
avaliado, `--no-history` é a resposta honesta.

## Limites

- A janela padrão é 90 dias e ainda não é configurável.
- `previousFailureRate` continua sem fonte: exigiria histórico de execuções de CI.
- A detecção de correção depende de mensagens de commit descritivas. Num repositório com
  histórico de "wip" e "ajustes", `bugCount` será subestimado — e o relatório não tem
  como saber disso.
