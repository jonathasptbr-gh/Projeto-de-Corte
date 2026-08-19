# Projeto de Corte — notas para Claude

PWA offline-first de plano de corte de chapas (MDF/madeira), com otimizador de aproveitamento, orçamento e exportação CSV. Roda no GitHub Pages; não tem build step — os arquivos são servidos diretamente.

## Versão

A cada deploy deve-se incrementar `N` em **`sw.js`** (`const CACHE = 'projeto-corte-vN'`) **e** em **`app.js`** (`const APP_VERSION = 'vN'`, exibido no cabeçalho). Os dois devem ficar iguais. Versão atual: **v133**.

O selo de versão no topo (`#app-version`) reflete o `app.js` que a tela carregou — serve para conferir, após um deploy, se o cache do Service Worker já atualizou (número novo) ou não (número antigo).

Não há `package.json`, transpiler, nem bundler.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Único HTML. Define todas as abas (Peças, Cortes, Orçamento) e modais. |
| `css/styles.css` | Todos os estilos; sem pré-processador. |
| `js/csv.js` | Parser CSV tolerante (BOM, vírgula decimal, `;` ou `,`, dois formatos de cabeçalho). Exporta `window.CSV`. |
| `js/optimizer.js` | Algoritmo de corte guilhotinado 2D (MaxRects/BSSF + busca por feixe). Exporta `window.Optimizer`. |
| `js/icons.js` | Ícones em **SVG inline** (paths do Material Symbols embutidos). Exporta `window.Icons` (`html`, `el`, `hydrate`). Substituiu a fonte de ícones do CDN do Google, que quebrava offline. |
| `js/render.js` | Geração SVG das chapas com réguas e rótulos. Exporta `window.Render`. |
| `js/budget.js` | Cálculo de orçamento (materiais, mão de obra, markup, Pix). Exporta `window.Budget`. |
| `js/app.js` | Controlador principal: estado, UI, tabs, projetos (localStorage), import/export CSV, plano de corte. |
| `sw.js` | Service Worker: cache offline do app shell + recepção de CSV via Web Share Target. **App shell é cache-first PURO e atômico por versão** (o `install`/`addAll` troca o cache inteiro; **não** se regrava arquivos avulsos em runtime — isso misturava versões, ex.: HTML novo + JS antigo, e quebrava o `init`). Não há mais cache de fontes/CDN: **todos os ícones são SVG local** (`js/icons.js`), então o app não faz nenhuma requisição externa. |
| `manifest.json` | PWA manifest (ícones, share target, display standalone). |
| `.github/workflows/deploy-pages.yml` | Deploy automático no GitHub Pages ao fazer push em `main`. Usa actions nativas (`configure-pages`, `upload-pages-artifact`, `deploy-pages`). **Não usar `enablement: true`** no passo `configure-pages` — causa falha imediata do workflow. |

## Arquitetura do app.js

- **Estado** vive em `state` (referência ao `data` do projeto ativo) e em `db` (todos os projetos, persistido em `localStorage` como `projeto-corte-db-v1`).
- **O cálculo só INICIA pelo botão** "Calcular plano" (`toggleLiveSearch` → `startLiveSearch`). Uma vez iniciado, roda continuamente (loop RAF) melhorando o resultado. Edições **não** recalculam: `markPlanStale()` apenas para uma busca em andamento (se houver), marca o plano como desatualizado e exibe um **aviso** na aba Cortes — banner `#plan-stale` + ponto `#plan-tab-dot` na aba. `updateStaleNotice()` controla a visibilidade (só aparece quando há plano calculado, ele está stale e nenhuma busca roda).
- **`startLiveSearch()`** inicia um loop RAF via `tickLive()` que chama `Optimizer.createSearch` e vai melhorando o resultado ao longo do tempo.
- **`showResult(result)`** monta a aba Cortes: `#plan-metrics` fica **vazio** (sem cards); `#plan-breakdown` recebe **uma tabela única** (`.plan-tbl`, layout fixo) com cabeçalho `Chapas/mín | Material | Peças | Aprov.` — primeiro as linhas de **resumo por material** (classe `tbl-geral`, fundo destacado) e depois o **detalhe por chapa** (1 linha por chapa). Os cartões SVG de cada chapa vêm em `#plan-sheets` (`Render.renderSheets`).
- **Importação NÃO calcula automaticamente** (`importAsProject`): após importar vai para a aba **Peças** (revisar); o plano só roda no botão.
- **Projetos** ficam em `localStorage`; o plano de corte (`state.plan`) **é persistido** junto com o projeto (v86). Se o localStorage estiver cheio, `saveDb` cai em fallback sem o plano para não perder os dados de peças/estoque. Ao recarregar, se o plano salvo for compatível, é exibido imediatamente sem recalcular. Undo/redo preserva o plano calculado mas o marca como stale, pois as peças podem ter mudado.
- **Foto de referência do orçamento** (v117): guardada no **IndexedDB** (`projeto-corte-media` / store `photos`, chave = id do projeto), **não** no `localStorage` — armazena o **Blob original sem recompressão** (qualidade máxima). `state.budgetPhoto` é só um **marcador** (`'1'` = tem foto). `renderBudgetPhoto` carrega o blob (`idbGetPhoto`) e exibe via `URL.createObjectURL` (revogado ao trocar, `setActivePhotoUrl`). A foto **não** entra no histórico (excluída de `snapData`; `applySnapshot` preserva o marcador atual) e é removida do IDB ao excluir o projeto. `migratePhotosToIdb()` (no `init`) converte fotos antigas em dataURL (localStorage) → IDB. CSS: `width:100%;height:auto` (preenche a largura, altura proporcional, **sem corte**).
- **Desfazer/Refazer:** `save()` registra um snapshot do projeto ativo (sem `plan`) em `history`; `doUndo`/`doRedo` navegam por `histIndex`. `applySnapshot()` restaura via `normalizeData` e re-renderiza (com a guarda `restoringHistory` para não gravar histórico durante a restauração). `resetHistory()` é chamado ao trocar/criar/importar/excluir projeto. Botões `#undo-btn`/`#redo-btn` no cabeçalho + atalhos Ctrl+Z / Ctrl+Shift+Z (ignorados quando o foco está num campo, para preservar o desfazer nativo do texto). Histórico é em memória (por sessão).
- **"Sem material" (vazio)**: peça sem material fica **fora do plano** (`buildPlanInputs` filtra `p.material` vazio). Serve para desligar peças sem excluí-las. O chip mostra o símbolo "—" (`paintMatChip` pinta vazio como "none"). Não há mais a opção "Nenhum" separada (v48); `normalizeData` migra material `'Nenhum'` salvo → vazio.
- **Chave do material = nome real + espessura** (v129): `normalizeMaterial()` monta a chave com `materialBaseName()` (nome sem "Maple" e sem a espessura embutida) + espessura — ex.: `"Dark grey 18mm"`, `"Oak 03 18mm"`, `"White 2 7mm"`. Até a v128 **todo** nome virava `"Branco"`/`"Cor"` + espessura, então materiais diferentes de **mesma espessura** caíam na MESMA chave e viravam **um só material**, com a cor/rótulo do primeiro (um CSV com "Dark grey - Maple" e "Oak 03 - Maple" 18mm mostrava só "Dark grey · 18mm", e o otimizador cortava tudo da mesma chapa). `canonMaterialKey()` reaproveita uma chave existente que difira só por **caixa** ("DARK GREY 18mm" → "Dark grey 18mm"). Projetos **salvos** antes da v129 continuam com as chaves antigas (peças já fundidas não têm como ser separadas retroativamente) — **reimportar o CSV** resolve.
- **"Maple" é formato, não material** (v128): quando o nome do material vem acompanhado de outro nome (ex.: "Maple Branco", "MAPLE AZUL 18MM"), a palavra **Maple** é ignorada — ela indica que a chapa é em **tábua**, não a cor/material. `stripMaple()` remove a palavra; `colorFromName()` (= `matchColorWord(stripMaple(n))`) passa a derivar a cor do nome real (antes "Maple Azul" virava marrom, pois `maple` está em `COLOR_WORDS`). Também é aplicado no nome nativo guardado na importação (`applyParsedPanels`), no material criado à mão e em `matLabel`. **Sozinho** ("Maple", "Maple 18mm" — o que sobra é só espessura/número) o nome é **mantido** e continua marrom. `normalizeData` migra projetos salvos: limpa `materialNames` e recalcula a cor **apenas** quando a guardada era a auto-atribuída pelo nome antigo (escolha manual do usuário é preservada).
- **Exportação de registro** (v130): botão **"Exportar registro"** dentro de **Opções** (`#export-report` → `openExportDialog`) abre um popup com 3 formatos: **`.md`** (`buildReportMd` — relatório legível: configurações, materiais com chave/rótulo/nomes do CSV/cor/grupo do otimizador, estoque, peças com fita por lado, e o plano **chapa a chapa** com X/Y/medidas/rotação de cada peça, sobras, o que não coube e um resumo do orçamento), **`.json`** (`buildReportJson` — estado bruto do projeto + `state.plan`) e **`.csv`** (o `exportCSV` de sempre, só as peças). `shareOrDownload()` centraliza a entrega do arquivo (Web Share no celular, download no resto) e é usada também pelo `exportCSV`. Serve para mandar dados reais de um plano calculado em vez de descrever o resultado.
- **Editor de material** (`openMaterialEditor`): tocar no chip/nome na legenda abre um popup temático para renomear (`materialNames[m]=[novo]`) e escolher a cor (**somente paleta padrão** — cor personalizada foi removida). O rótulo (`matLabel`) usa só o **primeiro** nome nativo + espessura.
- **Seleção de material na tabela** (`materialControl` → `openMaterialPicker`): o chip na linha de peça/estoque abre um **popup temático** (lista de materiais como chips + "Sem material"), em vez do `<select>` nativo. `paintMatChip()` é o helper de pintura do chip compartilhado.
- **Peças que não couberam** (`renderUnplaced`): no **topo** do plano (`#plan-unplaced`), com título "N peça(s) não couberam" e duas tabelas editáveis — **"Estoque"** (reusa `makeStockRow`) **antes** de **"Peças"** (reusa `makePanelRow`), pois mexer no estoque também resolve. Editar ali reflete direto nas listas originais (peças mapeadas por valor: `width/length/name/materialGroupKey`). A última coluna das peças (`Faltou`) mostra quantas unidades faltaram. O `render.js` **não** desenha mais o aviso no fim.
- **Nome da chapa no plano** (`render.js`): cada chapa é rotulada `Material — {stockName}` e recebe número (` 1`, ` 2`…) **só quando há mais de uma do mesmo tipo** (material+nome). `stockName` vem do otimizador, por chapa (nome do tamanho de estoque de origem; ver "Múltiplos tamanhos"). Estoque tem coluna **"Nome"** (texto livre, `s.name`, padrão "Chapa") para diferenciar chapas parecidas.
- **SVG do plano** (`render.js`): o **nome** da peça fica no quadrante superior-esquerdo (≈25%/25%), fora das linhas centrais onde ficam os números das bordas; as **medidas das sobras** vão nas bordas (largura no topo, comprimento à esquerda), como nas peças. Fontes têm piso menor para peças pequenas.
- **Réguas da guilhotina** (`render.js`, v125/v126): as marcas vêm de `axisTicks()` — projeta as peças no eixo, junta só as que se **sobrepõem** (encostar não impede o corte) e marca o **fim de cada bloco** (mais o início do primeiro, para a sobra da ponta). Garante que nenhuma peça é atravessada por uma marca, ou seja, toda linha da régua é um corte de ponta a ponta realmente executável. A **medida** de cada tira (`stripSize()`) é a **EXTENSÃO REAL das peças dentro dela** — da borda inicial da primeira até o fim real (`realW`/`realH`) da que vai mais longe. Não é a distância entre os cortes (embute o kerf do corte de ENTRADA e a folga do "slot", e levava a descontar o kerf de novo: uma tira de 40 aparecia como 40,8) **nem a maior peça da tira** — quando a tira leva peças em sequência (ex.: 36 + kerf + 5), o kerf ENTRE elas é material que tem de existir, então a tira é 41,8 e não 41; medir pela maior peça produzia um corte **fisicamente impossível** (bug v125, corrigido na v126). Tira sem peça nenhuma é sobra pura → distância bruta, o mesmo número impresso dentro do retângulo de sobra. Consequência esperada: os rótulos **não somam** a medida da chapa — a diferença é o material consumido pelos cortes de separação entre tiras. `reconstructCuts()` (DP memoizada) foi **removida**: só servia às réguas.

## Prioridade do plano (v133)

Área não é o único preço de um plano: cada **giro de 90°** é um reposicionamento
na máquina e cada **estágio** de guilhotina é uma nova rodada de cortes. Medindo
os planos (ver `lab/`), o de MAIOR aproveitamento era às vezes o mais caro de
executar — 7 estágios contra 5 no projeto "escola".

**`state.options.priority`** (seletor em Opções, `#opt-priority`, padrão
`balanced`) decide o desempate entre planos com o mesmo número de chapas:

| Valor | Rótulo | Critério |
|---|---|---|
| `area` | Máximo aproveitamento | comportamento histórico: chapas mais cheias, sobras, cortes |
| `balanced` | Equilibrado (padrão) | chapas cheias com **3% de folga** → giros → estágios → cortes → aproveitamento fino |
| `simple` | Menos cortes e ajustes | giros → estágios → cortes, com trava de **8%** para as chapas cheias não esvaziarem |

Nos dois perfis novos a comparação de ocupação **ignora a última chapa**
(`cmpFillsHead`): é onde a sobra deve se acumular e ela varia demais para servir
de critério.

Peças fora e nº de chapas continuam **antes de tudo** em qualquer prioridade —
nenhum ganho de operação justifica gastar chapa a mais.

### Peças novas no `optimizer.js`

- **`guillotineCost(W,H,placements,kerf)` / `operCost(res,kerf)`** — reconstroem
  a árvore de cortes na ordem de execução mais barata e devolvem `{cuts, turns,
  stages}`. O kerf entra na conta (cortar em X deixa o pedaço da direita em
  X+kerf), então o vão da serra não vira "sobra a refilar". `score()` só calcula
  isso quando a prioridade não é `area`.
- **`packStrips(list,W,H,o,cfg)`** — empacotador por TIRAS: corta uma tira de
  lado a lado e resolve, dentro dela, um **knapsack 1D exato** (DP com limite de
  quantidade por tipo) nos dois eixos; apara da tira, vão abaixo de cada peça e
  resto da chapa viram novas regiões. Trabalha em **décimos de cm inteiros**.
  Entra na busca como **36 variantes** (`STRIP_CFGS`) no primeiro `step()`.
  **É ele que dá aos perfis planos bons para escolher** — sem ele a prioridade
  quase não mudava o resultado (±2%).
- **`finishBest()`** — quando a prioridade não é `area`, finaliza o plano em três
  variantes (`FINISH_VARIANTS`: com/sem `consolidateByFreeArea`, com/sem
  `consolidateRemnants`) e fica com a melhor pelo critério. Sem isso o
  pós-processamento reorganizava o layout DEPOIS da escolha e diluía o critério.

### Efeito medido (busca completa, casos reais)

| Caso | v132 | v133 |
|---|---|---|
| escola (50 pç) | 89,6/87,8/68,7 · 88 cortes · 38 giros · 5 estágios | **95,3/91,7/59,1 · 81 · 32 · 3** |
| balcão dark grey | 92,7/40,8 · 50 · 24 · 5 | **93,4/40,1 · 47 · 17 · 3** |
| balcão oak | 80,5 · 18 · 9 · 5 | **80,5 · 17 · 6 · 3** |
| cristaleira | 79,4 · 16 · 9 · 4 | igual, mas já na fase determinística |

Nos casos reais os três perfis quase sempre **convergem para o mesmo plano** (só
o balcão oak diferencia: 17/6 no equilibrado contra 19/7 no de área). O ganho
veio do empacotador por tiras; o seletor é o desempate fino. Custo: o perfil
padrão é ~25% mais lento que `area` (74 s contra 58 s na escola).

87 planos (4 reais + 25 aleatórios × 3 perfis) passaram pelo validador do `lab/`
sem nenhuma falha de kerf, guilhotina, peça fora ou veio.

## Fase extra da busca (peças que sobraram)

`optimizer-worker.js` rodava a busca **só** até o fim das fases determinística
(360 combinações) e **beam** (20 passadas) — a fase de **reinícios aleatórios**
do `createSearch` (embaralha a ordem + combo aleatório) **nunca** era executada.
Em casos com solução óbvia para um humano, isso deixava peça de fora para sempre:
9 peças (Tb 40×140, 2× Lc 38×121,6, 5× Pc 34×86,4, Uc 86,4×121,6) numa única chapa
184×274 (`qty` 1, veio `v`) — nenhuma das 380 estratégias fixas encaixava a 5ª
`Pc`, e o reinício aleatório resolvia em ~60 passos (~40 ms).

Agora, **quando ainda sobram peças**, o worker continua a busca por até
`EXTRA_MS` (10 s), parando assim que tudo encaixa (ou quando `converged`):

- **Gatilho**: `search.unplacedFeasible() > 0` **e** `search.result().unplaced.length > 0`.
  `unplacedFeasible()` (em `optimizer.js`) conta só as peças que ainda **caberiam**
  numa chapa vazia do grupo respeitando o veio — peça maior que a chapa nunca vai
  entrar, então a fase extra é **pulada** (nada de gastar 10 s à toa).
- **Parada barata**: `unplacedRaw()` (contagem no melhor de cada grupo, sem
  pós-processamento) — o `result()` completo, que custa ~1,5 s num projeto grande,
  só é chamado quando o bruto MELHORA.
- **Progresso**: a fase extra reporta `extra:{ms,budget}` no `progress`; no
  `app.js` a faixa do beam passou a ser 42→66% e a fase extra ocupa 66→80%.

Efeito medido (app real, via Playwright): a cristaleira acima passou de
**8 peças / 1 fora / 73,6%** para **9 peças / 0 fora / 79,4%**, +0,3 s. O projeto
grande (43 peças, 3 materiais) não dispara a fase extra: mesmas 4 chapas, ~30 s
antes e depois.

## Bugs conhecidos no Android Chrome (S24 Ultra)

### 1. Double-tap no botão "Calcular plano"
**Causa:** No Android Chrome, um único toque dispara `touchend` e depois `click` separadamente (~100 ms de diferença). Sem guarda, `toggleLiveSearch()` era chamado duas vezes: a primeira vez iniciava a busca, a segunda a parava imediatamente (antes de qualquer resultado aparecer). O usuário via apenas o toast "Usando o melhor plano encontrado." sem resultado algum.

**Fix (v43):** Flag `recentTouch` no `touchend` com janela de 500 ms; o listener `click` retorna cedo se `recentTouch` estiver ativo.

```javascript
let recentTouch = false;
runBtn.addEventListener('touchend', function(e) {
  recentTouch = true;
  setTimeout(function() { recentTouch = false; }, 500);
  e.preventDefault();
  toggleLiveSearch();
}, { passive: false });
runBtn.addEventListener('click', function() {
  if (recentTouch) return;
  toggleLiveSearch();
});
```

### 2. Elemento `#plan-breakdown` nulo após mutação de innerHTML
**Causa:** O Android Chrome pode desvincular elementos irmãos do DOM quando `innerHTML` é setado num nó próximo na mesma subárvore. `showResult` chamava `$('#plan-breakdown')` após setar `$('#plan-metrics').innerHTML`, recebendo `null` e lançando `Cannot set properties of null`.

**Fix (v43):** Cachear todas as referências de elemento ANTES de qualquer mutação `innerHTML`; retornar cedo se algum estiver nulo.

```javascript
const metricsEl   = $('#plan-metrics');
const breakdownEl = $('#plan-breakdown');
const sheetsEl    = $('#plan-sheets');
if (!metricsEl || !breakdownEl || !sheetsEl) return;
// ... calcular rows ...
metricsEl.innerHTML   = ...;
breakdownEl.innerHTML = ...;
Render.renderSheets(sheetsEl, ...);
```

O mesmo padrão foi aplicado em `renderPlanEmpty()`.

## Eixos / convenções

- **Largura (W)** = dimensão no eixo X da chapa.
- **Comprimento (H)** = dimensão no eixo Y da chapa.
- Unidade: centímetros no otimizador; exibição em cm ou mm conforme o CSV importado.
- **Veio (`grain`):** `'v'` = vertical (ao longo do comprimento), `'h'` = horizontal, `''` = sem restrição.
- **Fita de borda (`bands`):** **por lado** — `p.bands[side]` = `{ w:22|45, color:'#hex' }` ou `false` (`side` ∈ top/left/bottom/right). `top`/`bottom` acompanham a largura; `left`/`right` o comprimento. `bandSpecOf(p,side)` normaliza formatos antigos (booleano; cor/largura global da v52) → `normalizeData` migra. `bandFallbackColor(p)` cai na cor do material, ou **branco** quando não há. **Botão na linha** (`refreshFitaButton`): mini-retângulo com fundo **cinza** (p/ enxergar fita branca); cada lado com fita vira uma linha na sua cor — fina p/ 22, grossa p/ 45. **Modal** (`openBandModal`): ilustração com **proporção limitada** (`maxRatio` 2.4, p/ não estourar a tela), lados sem fita em linha **sólida cinza**; um "pincel" (chip cor+largura) é aplicado por lado ao tocar (toque de novo retira) — **cada lado é independente**. `openBandMatPicker` lista **Branco sempre** + cores dos materiais × {22,45}. `buildPlanInputs` grava fitas concretas no plano.
- **Orçamento de fita** (`budget.js`): métricas separadas por largura×cor — `band22White/band45White/band22Color/band45Color` (auto nos itens). **Fita 45 é dividida por 2** (a fita larga é compartilhada por 2 peças coladas). Branco é detectado pela COR (`#ffffff`). **Metragem FINAL (v118)**: cada `band*` agora é a metragem **com margem de desperdício/retrabalho** = `arredondaCima5( metragemTotalFria × 1,05 + ladosFitados × 0,05m )` (arredondada de 5 em 5 m p/ cima) — é essa que **multiplica o preço unitário** (subtotal). A metragem total "fria" fica em `band*Raw` e é exibida **entre parênteses** ao lado, na coluna Qtd (`.bgt-raw`). `fitasTotal`/`totalN` continuam usando a metragem fria (não inflam a complexidade). Na fita **45**, tanto a metragem **quanto a contagem de lados** são divididas por 2 (tira compartilhada por 2 peças).

## Kerf entre peças (invariante do otimizador)

**Duas peças vizinhas na chapa NUNCA podem ficar a menos de `kerf` uma da
outra** — a serra come esse material, então um vão menor que o kerf é um corte
fisicamente impossível (ex.: uma peça de 36 e uma de 5 numa tira de exatos 41).
Três pontos garantem isso; ao mexer em qualquer um deles, revalidar:

1. **`splitRect`** — ao consumir `pw+kerf`/`ph+kerf`, os retalhos que ficam **ao
   lado** da peça herdam a medida da PEÇA (`pw`/`ph`), não a medida com kerf
   (`usedW`/`usedH`). Usar `usedW` ali deixava a peça seguinte alcançar a coluna
   vizinha com vão zero (bug até a v126).
2. **`usableFree()` / `freeGreedy()` / `freeExact()`** — `guillotineOffcuts*`
   decompõem a sobra pela GEOMETRIA pura (retângulos encostados nas peças), o
   que serve para **exibir** a sobra mas não para posicionar. Todo ponto que usa
   esses retalhos como espaço de posicionamento passa por `usableFree`, que
   desconta o kerf de cada borda **interna** (borda da chapa não desconta).
   Só `refineOffcuts` (exibição) e `maxOff` (métrica de área) usam os retalhos crus.
3. **`consolidateByFreeArea`** — as posições candidatas são `q.x+q.w+kerf` (não a
   borda crua) e o teste de colisão usa margem de kerf nos dois eixos.

Custo medido: ~0,8% de chapas a mais (118 → 119 em 60 planos aleatórios), sem
nenhuma peça deixando de caber.

## Sobras concentradas na última chapa (invariante)

A regra do plano é **encher cada chapa ao máximo antes de abrir a próxima**: a
sobra tem de se acumular na **última** chapa, não se espalhar por todas.

`consolidateRemnants` persegue outro objetivo — maximizar o MAIOR retalho
contíguo de um PAR de chapas — e, ao fazer isso, espalhava a sobra: num projeto
real de 50 peças o plano chegava nessa etapa como **89,6 / 87,8 / 68,7** e saía
dela como **89,1 / 78,7 / 78,3** (três chapas pela metade em vez de duas cheias
e a sobra inteira na última). As etapas anteriores (`consolidateSheets`,
`consolidateByFreeArea`, `repackMerge`) já entregavam a distribuição certa.

`consolidateRemnantsSafe()` (v132) roda a etapa sobre um **snapshot** e só fica
com o resultado quando o **perfil de ocupação** (`fillProfile()` — fração de área
usada por chapa, da mais cheia para a mais vazia; o mesmo critério 3 do
`better()`) **não piora** lexicograficamente, ou quando a etapa **elimina uma
chapa** (isso sempre vale mais). É esta função que `optimize()` e
`createSearch().result()` chamam.

**Não** basta proibir o movimento "da chapa cheia para a mais vazia" dentro do
`consolidateRemnants`: um movimento desses pode ser o passo intermediário que
libera vários outros — medido, essa versão piorava 3 em 40 projetos aleatórios.
A trava tem de ser na **aceitação do resultado**, não no movimento.

Verificado em 120 projetos aleatórios (`optimize`, mesmas sementes nos dois
lados): 0 pioras, 2 melhoras, 118 iguais — e nenhuma chapa a mais.

## Identidade de material no otimizador

Materiais são agrupados por **cor + espessura** (não pelo nome):
```javascript
function materialGroupKey(name) {
  return String(matColor(name)).toLowerCase() + '|' + (matThickness(name) || '');
}
```
Dois materiais com a mesma cor e espessura são tratados como intercambiáveis pelo otimizador.

## Limite de estoque (qty das chapas)

O campo **Qtd** de cada linha de estoque é um **teto real** de chapas para aquele
material. O otimizador recebe esse teto como `o.maxSheets` por grupo de material
(`stock.qty`); quando o limite é atingido, as peças excedentes vão para
**"não couberam"** (`result.unplaced`) em vez de abrir mais chapas. O teto é
respeitado por TODOS os empacotadores (`packOnce`, `packMaxFill`, `packShelf`,
`packBeam`, `packMaxFillBeam`) via o helper `sheetCap(o)`. `qty` ausente/0 → sem
limite (`Infinity`).

## Múltiplos tamanhos de chapa por material

Um material (cor+espessura) pode ter **várias linhas de estoque com larguras/
comprimentos diferentes**. `aggregateSizes()` agrupa as linhas por dimensão
(soma a `qty` de tamanhos iguais) e ordena do **MENOR para o maior** — chapas
menores são sobras de outros cortes e devem ser usadas antes de gastar uma chapa
nova. `runCascade()` roda os empacotadores em **cascata**: empacota no menor
tamanho (até a `qty` dele), o que **não couber cai no próximo tamanho** (maior), e
assim por diante. `optimize` e `createSearch` usam `sizesFor(material)` +
`runCascade` (empacotadores recebem um único `W,H` por passada; `it.__sg` por tamanho).
Cada tamanho carrega o **nome** do estoque (`aggregateSizes`); `runCascade` grava
`s.stockName` em cada chapa gerada, e a numeração no resultado é por
(material + `stockName`) — por isso o plano mostra "Chapa 1/2", "Pedaço 1/2" etc.

**Chapa com material vazio NÃO conta** (igual às peças vazias): `sizesFor` só
considera chapas com o material do grupo, sem fallback para material vazio. Um
material de peça sem nenhuma chapa correspondente → peças vão para "não couberam".

## Opções da UI

As opções ajustáveis são o **kerf** (`#opt-kerf` → `state.options.kerf`) e a
**prioridade do plano** (`#opt-priority` → `state.options.priority`, ver seção
"Prioridade do plano"). As
demais (nome nos painéis, considerar material, considerar grão e os 5 pesos do
otimizador) foram **removidas da UI** e são **fixas no padrão**: `considerMaterial`
e `considerGrain` sempre `true`, `showLabels` sempre `true`, `weights =
Optimizer.defaultWeights()` — fixados em `buildPlanInputs()` e `showResult()`.
O otimizador ainda **aceita** esses parâmetros (não remover do `optimize`/
`createSearch`); apenas não há mais controle de tela. `normalizeData` descarta
qualquer config antiga persistida, mantendo só o `kerf`.

## Ordenação de peças na importação (INTENCIONAL)

`nameSortKey(name)` ordena as peças importadas pelo **ÚLTIMO caractere** do nome
(depois pelo restante): `return n.slice(-1) + ' ' + n.slice(0, -1)`. Isso é
**proposital** — agrupa peças por sufixo (ex.: "Lateral D"/"Lateral E",
variações numeradas) para facilitar a conferência. **NÃO "corrigir" para ordem
alfabética normal** achando que é bug; é o comportamento desejado.

## Teto de quantidade (`MAX_QTY`)

A `qty` por linha (peças e estoque) é limitada a **999** (`MAX_QTY` em `app.js`,
via `clampQty`; o parser `csv.js` aplica o mesmo teto na importação). Evita que
um valor enorme exploda `expand()` e trave a busca. Ao alterar o teto, mude nos
dois lugares.

## Deploy

Push em `main` dispara o workflow automaticamente. O deploy leva ~15 s. Após o deploy, o Service Worker só atualiza o cache quando a versão em `sw.js` muda — sempre incrementar `N` antes de commitar.

## Fluxo de trabalho com o Claude (regra obrigatória)

Todo trabalho de código feito pelo Claude **deve seguir este fluxo**:

1. Desenvolver na branch designada (nunca diretamente no `main`).
2. **Incrementar a versão** em `sw.js` (`const CACHE = 'projeto-corte-vN'`) **e** em `app.js` (`const APP_VERSION = 'vN'`) — sempre juntos, sempre iguais, a cada deploy.
3. Commitar as alterações com mensagem descritiva.
4. Fazer `push` para o remote.
5. **Abrir um Pull Request** apontando para `main`.
6. **Mergear o Pull Request imediatamente** (squash merge) — não deixar o PR aberto aguardando aprovação.

O Claude não deve perguntar se deve criar o PR nem se deve mergear: **cria e mergeia sempre**.
