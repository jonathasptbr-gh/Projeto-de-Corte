# Projeto de Corte — guia para Claude

PWA de otimização de corte guilhotinado (2D bin-packing) sem servidor.
Stack: HTML + CSS + JavaScript puro, service worker para offline/instalação.

---

## Arquivos principais

| Arquivo | Responsabilidade |
|---|---|
| `index.html` | Estrutura HTML; contém o badge de versão no `<header>` |
| `css/styles.css` | Estilos; variáveis CSS (`--green`, `--line`, `--text`, `--muted`, `--card`) |
| `js/optimizer.js` | Motor de otimização (bin-packing guilhotinado) — núcleo do app |
| `js/render.js` | Renderização SVG das chapas e reconstrução visual dos cortes |
| `js/app.js` | Controlador principal: projetos, UI, importação/exportação, orçamento |
| `js/csv.js` | Parser de CSV de peças |
| `js/budget.js` | Cálculo de orçamento e condições |
| `sw.js` | Service worker: cache offline, recepção de CSV compartilhado |
| `manifest.json` | Manifesto PWA |

---

## Regra de versão (OBRIGATÓRIO a cada atualização)

A cada deploy **dois valores devem ser incrementados juntos**:

1. `sw.js` linha 2 — `const CACHE = 'projeto-corte-vN';` → incrementar N
2. `index.html` — `<span class="app-version">vN</span>` → mesmo N

O número N é a fonte única de verdade. O badge no topo do app mostra ao
usuário que a versão foi atualizada. Nunca atualizar um sem o outro.

Versão atual: **v44**

---

## Deploy

O workflow `.github/workflows/deploy-pages.yml` faz push para a branch
`gh-pages` via `peaceiris/actions-gh-pages@v4` sempre que há push na `main`.
A branch `main` é a de produção. Commits vão para `main` e o deploy
é automático.

URL de produção: `https://jonathasptbr-gh.github.io/Projeto-de-Corte`

---

## Regras de comportamento do app (decisões tomadas com o usuário)

### Plano de corte — 100% manual
Nenhuma edição dispara recálculo automático. Apenas o botão
**"Calcular plano"** inicia ou para a busca. Ao alterar dados (peças,
stock, opções, material), a busca em andamento é parada e um aviso
amarelo aparece na aba Cortes.

Não reverter esse comportamento sem aprovação explícita do usuário.

### Critérios de otimização (em ordem de prioridade)
1. Menos peças não posicionadas
2. Menos chapas usadas
3. Chapas mais cheias — comparação pelo **pior aproveitamento** primeiro
   (sort ascendente em `score.fills`), para evitar 3ª chapa com 55%
4. Maior retalho único aproveitável
5. Menos cortes (só decide quando os demais estão empatados)

### Sliders de prioridade
Foram removidos (v44). O usuário considerou que não serviram.
Não reintroduzir sliders de peso para os critérios.

---

## Arquitetura do otimizador (`js/optimizer.js`)

### Fluxo principal
```
optimize() / createSearch()
  └─ packGroup()          ← testa todas as estratégias para 1 material
       ├─ packOnce()      ← heurística BSSF/TL/BAF + várias ordens
       ├─ packMaxFill()   ← enche ao máximo antes de abrir outra chapa
       ├─ packShelf()     ← guilhotina em 2 estágios (faixas/colunas)
       ├─ packBeam()      ← beam search global entre chapas
       └─ packMaxFillBeam() ← beam search por chapa (enche 1 de cada vez)
```

### Busca contínua (`createSearch`)
Executa em `requestAnimationFrame`; o app chama `step()` em lotes e
renderiza quando melhora. Fases em ordem:
1. `packMaxFill` + `packMaxFillBeam(280)` + `packShelf` (passo inicial rápido)
2. Combinações determinísticas de ordem × corte × encaixe × bloco × grão
3. Beam schedule crescente: widths `[48, 128, 320, 700, 1200, 2000]`
4. Reinícios aleatórios (rng determinístico, semente fixa)

### `packGroup` (cálculo único)
Desde v44, também executa beam search por padrão (width 160) sem precisar
de flag explícita — antes só rodava nas fases de busca contínua.

### Restrições de veio (`grainOrient`)
- Chapa sem veio (`''`) → peça gira livremente
- Chapa `'v'` + peça `'v'` → sem rotação
- Chapa `'v'` + peça `'h'` → swap largura↔comprimento, sem rotação

### Retalhos (`guillotineOffcuts`)
Decomposição recursiva com memoização que maximiza o **maior retalho único**
(não a área total). Usada na exibição final; durante a busca usa a versão
gulosa (`guillotineOffcutsGreedy`) por performance.
