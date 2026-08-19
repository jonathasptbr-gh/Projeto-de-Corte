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
| `cutplan.js` | Custo **operacional** de um plano: cortes, giros de 90° e estágios de guilhotina. |
| `bench.js` | Roda app × experimental × híbrido, valida e resume. |
| `pareto.js` | Área × custo de execução: `app` vs `tiras/área` vs `tiras/operação`. |

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

12 projetos aleatórios, contra a **busca completa** (o cenário mais duro — ali o
app tem dezenas de segundos para refinar):

```
experimental: menos chapas=0 · MAIS chapas=2 · distribuição melhor=6 · pior=4 · empate=0
híbrido     : menos chapas=0 · MAIS chapas=0 · distribuição melhor=6 · pior=0 · empate=6
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

## Área não é o único preço: cortes e giros

`cutplan.js` reconstrói a árvore de cortes guilhotinados do plano (escolhendo a
ordem de execução mais barata) e mede o que custa na máquina:

- **cortes** — passadas de serra, incluindo os refilos que liberam a peça;
- **giros** — passadas que mudam de direção em relação ao corte que gerou o
  pedaço: cada uma é um reposicionamento de 90° na seccionadora;
- **estágios** — alternâncias de direção no caminho mais fundo. 2 é o padrão
  "tiras + peças"; 4+ é layout trabalhoso de executar.

O analisador foi conferido em seis layouts montados à mão (peça exata, refilo de
um lado, grade 2×2, colunas, escada) antes de valer como medida.

Com isso, o `strip-packer` ganhou um segundo objetivo: entre os planos que
empatam em peças e chapas, `objective:'oper'` fica com o **mais barato de
executar** em vez do de maior aproveitamento.

Casos reais (`node lab/pareto.js`):

| Caso | estratégia | 1ª chapa | cortes | giros | estágios |
|---|---|---|---|---|---|
| escola | app | 91,5% | 88 | 38 | 5 |
| | tiras/área | 95,8% | 81 | 40 | **7** |
| | tiras/oper | 95,3% | 81 | **32** | **3** |
| balcão dark grey | app | 92,7% | 50 | 24 | 5 |
| | tiras/área | 94,9% | 50 | 26 | 5 |
| | tiras/oper | 93,4% | **47** | **17** | **3** |
| balcão oak | app | 80,5% | 18 | 9 | 5 |
| | tiras/área | 80,5% | 19 | 8 | 3 |
| | tiras/oper | 80,5% | **17** | **6** | **3** |

Agregado nos 3 casos com o mesmo número de chapas:

```
app         1ª chapa 88,2% · cortes 156 · giros 71 · estágios máx 5
tiras/área  1ª chapa 90,4% · cortes 150 · giros 74 · estágios máx 7
tiras/oper  1ª chapa 89,7% · cortes 145 · giros 55 · estágios máx 3
```

Ou seja: pedir o plano mais simples custou **0,7% de aproveitamento na primeira
chapa** e economizou **7% dos cortes e 22,5% dos giros**, derrubando o pior caso
de 7 para 3 estágios. E o plano de maior área (`tiras/área`) é justamente o mais
caro de executar — 7 estágios na escola.

Em 30 projetos aleatórios (26 com o mesmo número de chapas), o retrato é outro:

```
app         1ª chapa 92,7% · sobra na última 60,0% · cortes 1698 · giros 905 · estágios médio 4,5 (máx 8)
tiras/área  1ª chapa 93,8% · sobra na última 54,1% · cortes 1686 · giros 860 · estágios médio 4,0 (máx 5)
tiras/oper  1ª chapa 90,7% · sobra na última 48,2% · cortes 1627 · giros 762 · estágios médio 3,8 (máx 5)

tiras/oper vs app:        1ª chapa -2,2% · cortes -4,2% · giros -15,8%
tiras/área vs app:        1ª chapa +1,2% · cortes -0,7% · giros -5,0%
```

**Aqui existe trade-off de verdade**: economizar 16% dos giros custa 2,2% da
primeira chapa e espalha mais a sobra. A diferença entre os dois retratos não é
ruído — é a natureza dos projetos. Projeto real de marcenaria tem poucas medidas
distintas repetidas muitas vezes, e medidas repetidas formam tiras cheias
naturalmente: dá para ter área E simplicidade. Projeto aleatório tem 50 medidas
diferentes, e aí encher a chapa exige um quebra-cabeça de vários estágios.

**Conclusão para o produto**: não existe um critério único que sirva sempre. Um
"híbrido" guiado só por área escolheria, na escola, justamente o plano de 7
estágios. O caminho é **prioridade escolhida pelo usuário** — com padrão
equilibrado (área primeiro, custo de execução como desempate), que nos projetos
reais medidos sai de graça.

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
passada no primeiro `step()`, junto de `packMaxFill`/`packShelf`) **e** dar ao
`better()` um critério de custo de execução, exposto como prioridade na UI:

| Prioridade | Ordem dos critérios |
|---|---|
| Máximo aproveitamento | peças fora → chapas → chapas cheias → sobras → cortes |
| **Equilibrado (padrão)** | peças fora → chapas → chapas cheias (com tolerância) → **giros/estágios** → cortes |
| Menos cortes e ajustes | peças fora → chapas → **giros → estágios → cortes** → chapas cheias |

A infraestrutura para isso já existe: `better()` compara por pesos
(`defaultWeights`), e os pesos foram removidos da UI mas continuam aceitos pelo
`optimize`/`createSearch`. Falta acrescentar os giros/estágios como critério
(`cutplan.js` mostra como medir) e escolher o perfil na tela.

O que ainda vale investigar:

- reduzir os casos em que o guloso gasta uma chapa a mais (reserva de peças
  grandes para a última chapa, ou um passo de rebalanceamento final);
- aproveitar o knapsack para **preencher as aparas** das chapas já fechadas
  pelo otimizador atual — atacaria o mesmo problema por outro lado;
- medir o custo de execução também em tempo de máquina (uma passada de serra
  longa custa mais que uma curta) — hoje contamos passadas, não metros.
