# Projeto de Corte — notas para Claude

PWA offline-first de plano de corte de chapas (MDF/madeira), com otimizador de aproveitamento, orçamento e exportação CSV. Roda no GitHub Pages; não tem build step — os arquivos são servidos diretamente.

## Versão

A cada deploy deve-se incrementar `N` em **`sw.js`** (`const CACHE = 'projeto-corte-vN'`) **e** em **`app.js`** (`const APP_VERSION = 'vN'`, exibido no cabeçalho). Os dois devem ficar iguais. Versão atual: **v118**.

O selo de versão no topo (`#app-version`) reflete o `app.js` que a tela carregou — serve para conferir, após um deploy, se o cache do Service Worker já atualizou (número novo) ou não (número antigo).

Não há `package.json`, transpiler, nem bundler.

## Estrutura de arquivos

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Único HTML. Define todas as abas (Peças, Cortes, Orçamento) e modais. |
| `css/styles.css` | Todos os estilos; sem pré-processador. |
| `js/csv.js` | Parser CSV tolerante (BOM, vírgula decimal, `;` ou `,`, dois formatos de cabeçalho). Exporta `window.CSV`. |
| `js/optimizer.js` | Algoritmo de corte guilhotinado 2D (MaxRects/BSSF + busca por feixe). Exporta `window.Optimizer`. |
| `js/render.js` | Geração SVG das chapas com réguas, rótulos, linhas de corte. Exporta `window.Render`. |
| `js/budget.js` | Cálculo de orçamento (materiais, mão de obra, markup, Pix). Exporta `window.Budget`. |
| `js/app.js` | Controlador principal: estado, UI, tabs, projetos (localStorage), import/export CSV, plano de corte. |
| `sw.js` | Service Worker: cache offline do app shell + recepção de CSV via Web Share Target. **App shell é cache-first PURO e atômico por versão** (o `install`/`addAll` troca o cache inteiro; **não** se regrava arquivos avulsos em runtime — isso misturava versões, ex.: HTML novo + JS antigo, e quebrava o `init`). Os ícones (Material Symbols, CDN do Google) ficam num cache próprio `FONT_CACHE` que **não** é apagado no `activate` — assim permanecem offline mesmo após um bump de versão. |
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
- **Editor de material** (`openMaterialEditor`): tocar no chip/nome na legenda abre um popup temático para renomear (`materialNames[m]=[novo]`) e escolher a cor (**somente paleta padrão** — cor personalizada foi removida). O rótulo (`matLabel`) usa só o **primeiro** nome nativo + espessura.
- **Seleção de material na tabela** (`materialControl` → `openMaterialPicker`): o chip na linha de peça/estoque abre um **popup temático** (lista de materiais como chips + "Sem material"), em vez do `<select>` nativo. `paintMatChip()` é o helper de pintura do chip compartilhado.
- **Peças que não couberam** (`renderUnplaced`): no **topo** do plano (`#plan-unplaced`), com título "N peça(s) não couberam" e duas tabelas editáveis — **"Estoque"** (reusa `makeStockRow`) **antes** de **"Peças"** (reusa `makePanelRow`), pois mexer no estoque também resolve. Editar ali reflete direto nas listas originais (peças mapeadas por valor: `width/length/name/materialGroupKey`). A última coluna das peças (`Faltou`) mostra quantas unidades faltaram. O `render.js` **não** desenha mais o aviso no fim.
- **Nome da chapa no plano** (`render.js`): cada chapa é rotulada `Material — {stockName}` e recebe número (` 1`, ` 2`…) **só quando há mais de uma do mesmo tipo** (material+nome). `stockName` vem do otimizador, por chapa (nome do tamanho de estoque de origem; ver "Múltiplos tamanhos"). Estoque tem coluna **"Nome"** (texto livre, `s.name`, padrão "Chapa") para diferenciar chapas parecidas.
- **SVG do plano** (`render.js`): o **nome** da peça fica no quadrante superior-esquerdo (≈25%/25%), fora das linhas centrais onde ficam os números das bordas; as **medidas das sobras** vão nas bordas (largura no topo, comprimento à esquerda), como nas peças. Fontes têm piso menor para peças pequenas.

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
- **Orçamento de fita** (`budget.js`): métricas separadas por largura×cor — `band22White/band45White/band22Color/band45Color` (auto nos itens). **Fita 45 é dividida por 2** (a fita larga é compartilhada por 2 peças coladas). Branco é detectado pela COR (`#ffffff`). **Metragem FINAL (v118)**: cada `band*` agora é a metragem **com margem de desperdício/retrabalho** = `arredondaCima5( metragemTotalFria × 1,05 + ladosFitados × 0,05m )` (arredondada de 5 em 5 m p/ cima) — é essa que **multiplica o preço unitário** (subtotal). A metragem total "fria" fica em `band*Raw` e é exibida **entre parênteses** ao lado, na coluna Qtd (`.bgt-raw`). `fitasTotal`/`totalN` continuam usando a metragem fria (não inflam a complexidade). A contagem de lados (`n22w/n45w/…`) é **crua** (45 só divide a metragem, não a contagem).

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

A **única opção ajustável** é o **kerf** (`#opt-kerf` → `state.options.kerf`). As
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
2. Commitar as alterações com mensagem descritiva.
3. Fazer `push` para o remote.
4. **Sempre abrir um Pull Request** apontando para `main` ao final — mesmo para mudanças pequenas. Isso garante que o deploy automático rode e que o histórico fique rastreável.

O Claude não deve perguntar se deve criar o PR: **cria sempre**.
