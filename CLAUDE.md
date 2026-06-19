# Projeto de Corte — notas para Claude

PWA offline-first de plano de corte de chapas (MDF/madeira), com otimizador de aproveitamento, orçamento e exportação CSV. Roda no GitHub Pages; não tem build step — os arquivos são servidos diretamente.

## Versão

A cada deploy deve-se incrementar `N` em **`sw.js`** (`const CACHE = 'projeto-corte-vN'`) **e** em **`app.js`** (`const APP_VERSION = 'vN'`, exibido no cabeçalho). Os dois devem ficar iguais. Versão atual: **v47**.

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
- **`showResult(result)`** renderiza métricas, tabela por material e SVG das chapas.
- **Projetos** ficam em `localStorage`; o plano de corte (`state.plan`) não é persistido — é recalculado ao abrir.

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
- **Fita de borda (`bands`):** objeto `{ top, bottom, left, right }` booleanos. `top`/`bottom` acompanham a largura; `left`/`right` acompanham o comprimento.

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
