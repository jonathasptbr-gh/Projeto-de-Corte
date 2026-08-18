# lab — laboratório do otimizador

Pasta **fora do app**: nada aqui é carregado pelo `index.html`, servido pelo
GitHub Pages ou cacheado pelo Service Worker. É um banco de ensaios em Node
para testar ideias de empacotamento contra o otimizador de verdade
(`js/optimizer.js`), com casos reais e um validador que barra plano bonito
porém inexecutável.

```bash
node lab/bench.js              # casos reais, busca rápida do app (optimize)
node lab/bench.js --full       # casos reais, busca completa (o que o app entrega na tela)
node lab/bench.js --rand 40    # 40 projetos aleatórios determinísticos
node lab/bench.js --full --rand 12
```

| Arquivo | O que é |
|---|---|
| `cases.js` | Casos reais (extraídos de registros `.md` exportados pelo app) + gerador aleatório determinístico. |
| `validate.js` | Valida um plano: peça dentro da chapa, **kerf** entre vizinhas, layout **guilhotinável**, multiset de peças intacto, veio respeitado. Também calcula as métricas. |
| `strip-packer.js` | O empacotador experimental (tiras por knapsack). |
| `bench.js` | Roda app × experimental × híbrido, valida e resume. |

## O problema atacado

O otimizador do app encaixa peça a peça (MaxRects/BSSF + busca). Ele acerta o
número de chapas, mas costuma deixar as sobras em faixas estreitas espalhadas:
no projeto "escola" (50 peças, 3 chapas) a busca completa entrega
**89,6 / 87,8 / 68,7** — as duas primeiras chapas ficam com aparas que não
recebem mais nada.

## A ideia experimental: tiras ótimas

`strip-packer.js` raciocina como quem opera a seccionadora: corta uma **tira**
de lado a lado e resolve, dentro dela, *quais peças enfileirar para gastar o
mínimo de material*. Cada tira é um **knapsack 1D exato** (DP com limite de
quantidade por tipo), resolvido nos dois eixos; fica a de maior densidade. O
que sobra — a apara no fim da tira, o vão abaixo de cada peça mais baixa que a
tira, e o resto da chapa — vira uma nova região tratada do mesmo jeito. Isso
produz cortes de vários estágios sem nunca sair da guilhotina.

Detalhes que importam:

- Tudo em **décimos de centímetro inteiros** — nada de erro acumulado de ponto
  flutuante nas somas de kerf.
- O **kerf** entra no knapsack como custo por peça (`len + kerf`, capacidade
  `cap + kerf`), então N peças em fila gastam exatamente N−1 cortes.
- Uma chapa é enchida ao máximo antes de abrir a próxima — a sobra se acumula
  naturalmente na última.
- **Multi-start**: 36 variantes (3 critérios de tira × 2 ordens de região ×
  3 preferências de eixo × plantar ou não a maior peça no canto); fica o melhor
  plano pelo critério do app.

## Resultados

Casos reais, contra a **busca completa** do app (o que aparece na tela):

| Caso | app (busca completa) | experimental |
|---|---|---|
| cristaleira (9 pç, 1 chapa) | 79,4% · 1,4 s | 79,4% · **0,06 s** |
| escola (50 pç, 3 chapas) | 89,6 / 87,8 / 68,7 · 62,4 s | **95,8 / 89,8 / 60,5** · **2,0 s** |
| balcão dark grey (30 pç) | 92,7 / 40,8 · 39,8 s | **94,9 / 38,6** · **0,7 s** |
| balcão oak (12 pç) | 80,5% · 3,8 s | 80,5% · **0,07 s** |

Nesses 4 casos: **2 melhores, 2 empates, 0 piores** — em uma fração do tempo
(30× mais rápido na escola, 55× no balcão).

40 projetos aleatórios, contra a busca rápida do app:

```
experimental: menos chapas=1 · MAIS chapas=4 · distribuição melhor=23 · pior=11 · empate=1
híbrido     : menos chapas=1 · MAIS chapas=0 · distribuição melhor=23 · pior=0  · empate=16
```

O validador rodou em **104 planos experimentais** (4 reais + 100 aleatórios):
nenhum inválido — sem peça fora da chapa, sem vizinha a menos de kerf, todos
cortáveis por guilhotina e com o multiset de peças intacto.

Leitura: sozinho, o algoritmo de tiras **não substitui** o do app — em 4 de 40
projetos ele enche demais as primeiras chapas e sobra peça grande sem par no
fim, gastando uma chapa a mais. Mas como **candidato adicional** (o "híbrido":
gera o plano por tiras e fica com ele só quando vence pelo critério do app —
menos peças fora, menos chapas, chapas mais cheias) ele nunca piora e melhora
metade dos casos. E custa pouco: décimos de segundo contra dezenas de segundos
da busca atual.

## Limitações do protótipo

Ainda não é um substituto pronto — o experimental cobre menos terreno que o
otimizador do app:

- **um tamanho de chapa** (`cs.stock[0]`), sem a cascata de tamanhos do app;
- **um material por rodada** (o app agrupa por cor+espessura e roda cada grupo);
- não calcula `free`/`cuts` (sobras e nº de cortes) — quem consome o plano no
  app precisaria rodar o pós-processamento normal;
- não tem teto de chapas por linha de estoque além do `qty` da primeira linha.

Nada disso é impeditivo para a integração sugerida abaixo (o plano por tiras
entraria como candidato, e o resto do fluxo do app continua igual), mas explica
por que os números daqui não são "o app com o algoritmo novo" — são "o algoritmo
novo no cenário que ele já cobre".

## Próximo passo sugerido

Integrar o `strip-packer` ao `createSearch` como mais uma estratégia (uma
passada no primeiro `step()`, junto de `packMaxFill`/`packShelf`), deixando o
`better()` decidir. Ganho esperado: os planos do tipo "escola" (sobra
concentrada e chapas mais cheias) sem risco de regressão, já que o critério só
troca de plano quando o novo é melhor.

O que ainda vale investigar antes disso:

- reduzir os casos em que o guloso gasta uma chapa a mais (reserva de peças
  grandes para a última chapa, ou um passo de rebalanceamento final);
- aproveitar o knapsack para **preencher as aparas** das chapas já fechadas
  pelo otimizador atual — atacaria o mesmo problema por outro lado.
