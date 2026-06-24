/* ============================================================
 * optimizer.js — Plano de corte por aproveitamento (seccionadora).
 *
 * Corte guilhotinado bidimensional com heurística estilo MaxRects/
 * GuillotineBinPack + critério BSSF (Best Short Side Fit) e fusão de
 * retângulos livres. As sobras usam um MODELO DE BLOCOS: a região
 * ocupada é tratada como uma "chapa menor" (bloco no canto) e o que
 * sobra fora dela vira 1–2 retalhos inteiros grandes.
 *
 * Escolha da melhor estratégia:
 *   1) menos peças sem encaixe
 *   2) menos chapas
 *   3) sobras MAIORES (lexicográfico: maior retalho, depois 2º maior...)
 *   4) menos retalhos
 *   5) menos cortes
 *
 * Eixos da chapa: x = Largura (W), y = Comprimento (H).
 * ============================================================ */
(function (global) {
  'use strict';

  const EPS = 0.05;

  // Teto de chapas por grupo de material (= qty do estoque). Sem limite → Infinity.
  const sheetCap = o => (o && o.maxSheets != null && o.maxSheets > 0) ? o.maxSheets : Infinity;

  // Agrega linhas de estoque por DIMENSÃO (largura×comprimento), somando as
  // quantidades. Devolve os tamanhos do MENOR para o maior — chapas menores são
  // sobras de outros cortes e devem ser usadas antes de gastar uma chapa nova.
  function aggregateSizes(rows) {
    const by = {};
    (rows || []).forEach(s => {
      const W = s.width, H = s.length;
      if (!(W > 0 && H > 0)) return;
      const k = W + 'x' + H;
      if (!by[k]) by[k] = { W, H, qty: 0, grain: s.grain, name: (s.name || '').trim() };
      by[k].qty += (s.qty > 0 ? s.qty : 0);
      if (by[k].grain == null) by[k].grain = s.grain;
      if (!by[k].name && (s.name || '').trim()) by[k].name = (s.name || '').trim();
    });
    const arr = Object.values(by).filter(z => z.qty > 0);
    arr.sort((a, b) => (a.W * a.H) - (b.W * b.H)); // menores primeiro
    return arr;
  }
  // Roda um empacotador de 1 tamanho em CASCATA pelos tamanhos do grupo (maior
  // primeiro); o que não couber cai no próximo tamanho. runOnSize(items,W,H)
  // devolve { sheets, unplaced } respeitando o.maxSheets (definido aqui por tamanho).
  function runCascade(items, sizes, o, runOnSize) {
    let remaining = items;
    const sheets = [];
    for (const sz of sizes) {
      if (!remaining.length) break;
      o.maxSheets = (sz.qty > 0 && sz.qty !== Infinity) ? sz.qty : Infinity;
      remaining.forEach(it => { it.__sg = sz.grain; }); // veio da chapa deste tamanho
      const res = runOnSize(remaining, sz.W, sz.H);
      for (const s of res.sheets) { s.stockName = sz.name || ''; sheets.push(s); } // nome do estoque de origem
      remaining = res.unplaced;
    }
    return { sheets, unplaced: remaining };
  }

  function expand(panels) {
    const items = [];
    panels.forEach((p, idx) => {
      for (let i = 0; i < p.qty; i++) {
        items.push({ w: p.width, h: p.length, material: p.material, name: p.name, grain: p.grain, bands: p.bands || {}, srcIndex: idx });
      }
    });
    return items;
  }

  function newSheet(material, W, H, index) {
    return { material, index, W, H, placements: [], free: [{ x: 0, y: 0, w: W, h: H }], cuts: 0 };
  }

  // Acha o retângulo livre para a peça.
  //  mode 'bssf' = Best Short Side Fit (menor sobra do lado curto) — heurística principal
  //  mode 'tl'   = Top-Left (empurra a peça para o canto, formando um bloco compacto)
  function findFit(sheet, pw, ph, allowRotate, mode) {
    let best = null;
    const consider = (i, rotated, fw, fh) => {
      const r = sheet.free[i];
      let key1, key2;
      if (mode === 'tl') { key1 = r.y; key2 = r.x; }
      else if (mode === 'baf') { key1 = r.w * r.h - fw * fh; key2 = Math.min(r.w - fw, r.h - fh); }
      else { // BSSF: menor lado-curto restante; desempate pelo lado-longo
        key1 = Math.min(r.w - fw, r.h - fh);
        key2 = Math.max(r.w - fw, r.h - fh);
      }
      if (!best || key1 < best.key1 - 1e-6 || (Math.abs(key1 - best.key1) <= 1e-6 && key2 < best.key2)) {
        best = { rectIdx: i, rotated, key1, key2 };
      }
    };
    for (let i = 0; i < sheet.free.length; i++) {
      const r = sheet.free[i];
      if (pw <= r.w + 1e-6 && ph <= r.h + 1e-6) consider(i, false, pw, ph);
      if (allowRotate && ph <= r.w + 1e-6 && pw <= r.h + 1e-6) consider(i, true, ph, pw);
    }
    return best;
  }

  function splitRect(sheet, rectIdx, pw, ph, kerf, splitPref) {
    const r = sheet.free[rectIdx];
    sheet.free.splice(rectIdx, 1);
    const usedW = pw + kerf, usedH = ph + kerf;
    const remRight = r.w - usedW, remBottom = r.h - usedH;
    const rects = [];
    if (remRight > EPS && remBottom > EPS) {
      const horizBig = Math.max(r.w * remBottom, remRight * usedH);
      const vertBig = Math.max(remRight * r.h, usedW * remBottom);
      let cutVertical;
      if (splitPref === 'tall') cutVertical = true;        // sempre corte vertical (tira de altura cheia)
      else if (splitPref === 'wide') cutVertical = false;  // sempre corte horizontal (tira de largura cheia)
      else if (splitPref === 'maxrect') cutVertical = vertBig >= horizBig;
      else cutVertical = remRight >= remBottom;
      if (cutVertical) {
        rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: r.h });
        rects.push({ x: r.x, y: r.y + usedH, w: usedW, h: remBottom });
      } else {
        rects.push({ x: r.x, y: r.y + usedH, w: r.w, h: remBottom });
        rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: usedH });
      }
      sheet.cuts += 2;
    } else if (remRight > EPS) {
      rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: r.h }); sheet.cuts += 1;
    } else if (remBottom > EPS) {
      rects.push({ x: r.x, y: r.y + usedH, w: r.w, h: remBottom }); sheet.cuts += 1;
    }
    rects.forEach(rc => { if (rc.w > EPS && rc.h > EPS) sheet.free.push(rc); });
  }

  // Funde retângulos livres adjacentes que compartilham uma aresta inteira,
  // para que a sobra contígua seja medida como um único retalho grande.
  function mergeFree(free) {
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < free.length && !merged; i++) {
        for (let j = i + 1; j < free.length; j++) {
          const a = free[i], b = free[j];
          // mesma coluna (x,w) e empilhados em y
          if (Math.abs(a.x - b.x) < EPS && Math.abs(a.w - b.w) < EPS &&
              (Math.abs(a.y + a.h - b.y) < EPS || Math.abs(b.y + b.h - a.y) < EPS)) {
            const y = Math.min(a.y, b.y);
            free.splice(j, 1); free.splice(i, 1); free.push({ x: a.x, y, w: a.w, h: a.h + b.h }); merged = true; break;
          }
          // mesma linha (y,h) e lado a lado em x
          if (Math.abs(a.y - b.y) < EPS && Math.abs(a.h - b.h) < EPS &&
              (Math.abs(a.x + a.w - b.x) < EPS || Math.abs(b.x + b.w - a.x) < EPS)) {
            const x = Math.min(a.x, b.x);
            free.splice(j, 1); free.splice(i, 1); free.push({ x, y: a.y, w: a.w + b.w, h: a.h }); merged = true; break;
          }
        }
      }
    }
  }

  // Decomposição guilhotinada das SOBRAS que MAXIMIZA O MAIOR retalho único.
  // Em vez de descascar a maior área vazia (guloso, fragmenta), faz uma busca
  // recursiva por todos os cortes de lado-a-lado e escolhe a sequência que
  // deixa o MAIOR pedaço inteiro. Desempate em ordem de prioridade:
  //   1. Maior retalho único (maxA) — prioridade principal
  //   2. Menor número de fragmentos (count) — sobras mais inteiras
  //   3. Maior área total reaproveitável (total)
  // Memoiza por região+peças.
  function guillotineOffcuts(sheet) {
    if (!sheet.placements.length) return [{ x: 0, y: 0, w: sheet.W, h: sheet.H }];
    const placements = sheet.placements;
    // Muitas peças numa região → busca completa fica cara: cai no guloso.
    if (placements.length > 20) return guillotineOffcutsGreedy(sheet);
    const memo = new Map();
    function best(x, y, w, h, items) {
      if (w <= EPS || h <= EPS) return { rects: [], count: 0, maxA: 0, total: 0 };
      if (!items.length) { const a = w * h; return { rects: [{ x, y, w, h }], count: 1, maxA: a, total: a }; }
      const key = x.toFixed(1) + '|' + y.toFixed(1) + '|' + w.toFixed(1) + '|' + h.toFixed(1) + '|' + items.map(p => p.x.toFixed(0) + ',' + p.y.toFixed(0)).sort().join(';');
      const hit = memo.get(key); if (hit) return hit;
      let res = null;
      const consider = (ca, cb) => {
        const ra = best(ca.x, ca.y, ca.w, ca.h, ca.items);
        const rb = best(cb.x, cb.y, cb.w, cb.h, cb.items);
        const count = ra.rects.length + rb.rects.length;
        const maxA = Math.max(ra.maxA, rb.maxA), total = ra.total + rb.total;
        if (!res ||
            maxA > res.maxA + 1e-6 ||
            (Math.abs(maxA - res.maxA) <= 1e-6 && count < res.count) ||
            (Math.abs(maxA - res.maxA) <= 1e-6 && count === res.count && total > res.total + 1e-6)) {
          res = { rects: ra.rects.concat(rb.rects), count, maxA, total };
        }
      };
      const xs = Array.from(new Set([].concat(...items.map(p => [p.x, p.x + p.w])))).filter(X => X > x + EPS && X < x + w - EPS);
      xs.forEach(X => {
        if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS))
          consider({ x, y, w: X - x, h, items: items.filter(p => p.x + p.w <= X + EPS) },
                   { x: X, y, w: x + w - X, h, items: items.filter(p => p.x >= X - EPS) });
      });
      const ys = Array.from(new Set([].concat(...items.map(p => [p.y, p.y + p.h])))).filter(Y => Y > y + EPS && Y < y + h - EPS);
      ys.forEach(Y => {
        if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS))
          consider({ x, y, w, h: Y - y, items: items.filter(p => p.y + p.h <= Y + EPS) },
                   { x, y: Y, w, h: y + h - Y, items: items.filter(p => p.y >= Y - EPS) });
      });
      if (!res) res = { rects: [], count: 0, maxA: 0, total: 0 }; // peça preenche a região
      memo.set(key, res);
      return res;
    }
    const r = best(0, 0, sheet.W, sheet.H, placements.slice());
    const out = r.rects.filter(rc => rc.w > EPS && rc.h > EPS);
    mergeFree(out);
    return out;
  }

  // Versão gulosa (rápida) — usada como fallback quando há muitas peças.
  function guillotineOffcutsGreedy(sheet) {
    const out = [];
    function decompose(x, y, w, h, items) {
      if (w <= EPS || h <= EPS) return;
      if (!items.length) { out.push({ x, y, w, h }); return; }
      const cands = [];
      const xs = Array.from(new Set([].concat(...items.map(p => [p.x, p.x + p.w])))).filter(X => X > x + EPS && X < x + w - EPS);
      xs.forEach(X => {
        if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS)) {
          const left = items.filter(p => p.x + p.w <= X + EPS);
          const right = items.filter(p => p.x >= X - EPS);
          cands.push({ a: { x, y, w: X - x, h, items: left }, b: { x: X, y, w: x + w - X, h, items: right } });
        }
      });
      const ys = Array.from(new Set([].concat(...items.map(p => [p.y, p.y + p.h])))).filter(Y => Y > y + EPS && Y < y + h - EPS);
      ys.forEach(Y => {
        if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS)) {
          const top = items.filter(p => p.y + p.h <= Y + EPS);
          const bot = items.filter(p => p.y >= Y - EPS);
          cands.push({ a: { x, y, w, h: Y - y, items: top }, b: { x, y: Y, w, h: y + h - Y, items: bot } });
        }
      });
      if (!cands.length) return;
      const emptyArea = c => [c.a, c.b].reduce((s, r) => s + (r.items.length ? 0 : r.w * r.h), 0);
      const biggestEmpty = c => [c.a, c.b].reduce((m, r) => Math.max(m, r.items.length ? 0 : r.w * r.h), 0);
      // Tiebreaker extra: quando nenhum corte produz sub-região vazia, preferir o
      // que deixa MENOS peças no lado menor — tende a gerar menos fragmentos no
      // total ao isolar sub-problemas menores mais rapidamente.
      const minSideCount = c => Math.min(c.a.items.length, c.b.items.length);
      cands.sort((c1, c2) => (emptyArea(c2) - emptyArea(c1)) || (biggestEmpty(c2) - biggestEmpty(c1)) || (minSideCount(c1) - minSideCount(c2)));
      const c = cands[0];
      decompose(c.a.x, c.a.y, c.a.w, c.a.h, c.a.items);
      decompose(c.b.x, c.b.y, c.b.w, c.b.h, c.b.items);
    }
    if (!sheet.placements.length) return [{ x: 0, y: 0, w: sheet.W, h: sheet.H }];
    decompose(0, 0, sheet.W, sheet.H, sheet.placements.slice());
    mergeFree(out);
    return out.filter(r => r.w > EPS && r.h > EPS);
  }

  // Ordenações de peças usadas pelas estratégias de empacotamento.
  const ORDERS = {
    area: (a, b) => (b.w * b.h) - (a.w * a.h),
    maxside: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
    height: (a, b) => b.h - a.h || b.w - a.w,
    width: (a, b) => b.w - a.w || b.h - a.h,
    perim: (a, b) => (b.w + b.h) - (a.w + a.h),
  };
  const sig = it => it.name + '|' + it.w + '|' + it.h + '|' + (it.grain || '');

  // Agrupamento por tamanho aproximado (tolerância em cm). Peças cujo
  // comprimento E largura diferem por <= tol (mesmo veio) entram no mesmo
  // grupo e passam a usar a MAIOR medida do grupo (o excedente vira trim).
  // Isso nivela faixas/blocos → sobras inteiras maiores.
  const GROUP_TOL = 5;
  // Arredonda CADA dimensão independentemente para o topo do seu "cluster"
  // (valores a <= tol viram o maior). Assim peças de comprimento parecido
  // nivelam (mesma altura de faixa) mesmo tendo larguras diferentes.
  // Mapa valor → topo do seu cluster: valores cuja diferença ao primeiro do
  // cluster é <= tol viram o MAIOR do cluster (nivela medidas próximas).
  function clusterMaxMap(vals, tol) {
    const sorted = Array.from(new Set(vals)).sort((a, b) => a - b);
    const map = {}; let i = 0;
    while (i < sorted.length) {
      let j = i; while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] <= tol) j++;
      const mx = sorted[j]; for (let k = i; k <= j; k++) map[sorted[k]] = mx; i = j + 1;
    }
    return map;
  }
  function annotateGroups(items, tol) {
    const wm = clusterMaxMap(items.map(it => it.w), tol);
    const hm = clusterMaxMap(items.map(it => it.h), tol);
    items.forEach(it => { it.gw = wm[it.w]; it.gh = hm[it.h]; it.gKey = (it.grain || '') + '|' + it.gw + '|' + it.gh; });
  }

  // Veio EFETIVO = combina o veio da PEÇA (it.grain) com o veio da CHAPA (it.__sg):
  //  chapa '' (sem veio)  → gira livre (ignora o veio da peça)
  //  chapa 'v' (padrão, ao longo do comprimento) → veio da peça como está
  //  chapa 'h' (ao longo da largura)             → inverte o veio da peça
  // Retorna { swap, allowRotate }: swap troca largura↔comprimento; allowRotate libera giro.
  function grainOrient(it, o) {
    const sg = it.__sg == null ? 'v' : it.__sg;
    if (sg === '' || !o.considerGrain || !it.grain) return { swap: false, allowRotate: o.allowRotate };
    const eff = sg === 'v' ? it.grain : (it.grain === 'v' ? 'h' : 'v');
    return { swap: eff === 'h', allowRotate: false };
  }

  function packOnce(list, W, H, o, splitPref, fitMode, placeMode, blockMode, gr) {
    let sheetIndex = 0;
    const cap = sheetCap(o);
    const sheets = [];
    const unplaced = [];
    const done = new Array(list.length).fill(false);
    // dims: footprint do "slot" (arredondado se gr) + medida real p/ rótulo
    const dimsOf = it => {
      let sw = gr ? (it.gw || it.w) : it.w, sh = gr ? (it.gh || it.h) : it.h, aw = it.w, ah = it.h;
      const g = grainOrient(it, o);
      if (g.swap) { const t = sw; sw = sh; sh = t; const u = aw; aw = ah; ah = u; }
      return { sw, sh, aw, ah, allowRotate: g.allowRotate };
    };
    for (let idx = 0; idx < list.length; idx++) {
      if (done[idx]) continue;
      const it = list[idx];
      done[idx] = true;
      const d = dimsOf(it);
      const pw = d.sw, ph = d.sh, allowRotate = d.allowRotate;
      let target = null, fit = null;
      if (placeMode === 'best') {
        // best-fit global: melhor encaixe entre TODAS as chapas abertas
        for (const sheet of sheets) {
          const f = findFit(sheet, pw, ph, allowRotate, fitMode);
          if (!f) continue;
          if (!fit || f.key1 < fit.key1 - 1e-6 || (Math.abs(f.key1 - fit.key1) <= 1e-6 && f.key2 < fit.key2)) { target = sheet; fit = f; }
        }
      } else {
        // first-fit: primeira chapa que couber
        for (const sheet of sheets) {
          const f = findFit(sheet, pw, ph, allowRotate, fitMode);
          if (f) { target = sheet; fit = f; break; }
        }
      }
      if (!target) {
        const cabe = (pw <= W + 1e-6 && ph <= H + 1e-6) || (allowRotate && ph <= W + 1e-6 && pw <= H + 1e-6);
        if (!cabe) { unplaced.push(it); continue; }
        if (sheets.length >= cap) { unplaced.push(it); continue; } // estoque esgotado
        target = newSheet(it.__mat, W, H, ++sheetIndex);
        fit = findFit(target, pw, ph, allowRotate, fitMode);
        sheets.push(target);
      }
      const fw = fit.rotated ? ph : pw, fh = fit.rotated ? pw : ph; // slot (footprint)
      const realW = fit.rotated ? d.ah : d.aw, realH = fit.rotated ? d.aw : d.ah;
      const r = target.free[fit.rectIdx];
      if (blockMode) {
        // Bloco: preenche o retângulo com a grade de peças do mesmo grupo
        // (idênticas, ou similares quando gr) usando a célula = maior medida.
        const k = o.kerf;
        const cols = Math.max(1, Math.floor((r.w + k) / (fw + k)));
        const rows = Math.max(1, Math.floor((r.h + k) / (fh + k)));
        const cap = cols * rows;
        const myKey = gr ? it.gKey : sig(it);
        const ids = [idx];
        for (let j = idx + 1; j < list.length && ids.length < cap; j++) {
          if (!done[j] && (gr ? list[j].gKey === myKey : sig(list[j]) === myKey)) ids.push(j);
        }
        const total = Math.min(ids.length, cap);
        let placed = 0;
        for (let rr = 0; rr < rows && placed < total; rr++) {
          for (let cc = 0; cc < cols && placed < total; cc++) {
            const jt = list[ids[placed]];
            const dj = dimsOf(jt);
            const rW = fit.rotated ? dj.ah : dj.aw, rH = fit.rotated ? dj.aw : dj.ah;
            target.placements.push({ x: r.x + cc * (fw + k), y: r.y + rr * (fh + k), w: fw, h: fh, realW: rW, realH: rH, name: jt.name, rotated: fit.rotated, bands: jt.bands });
            if (placed > 0) done[ids[placed]] = true;
            placed++;
          }
        }
        const usedCols = Math.min(cols, total), usedRows = Math.ceil(total / cols);
        splitRect(target, fit.rectIdx, usedCols * fw + (usedCols - 1) * k, usedRows * fh + (usedRows - 1) * k, k, splitPref);
        target.cuts += (usedRows - 1) + usedRows * (usedCols - 1);
        // Devolve ao pool o espaço vazio no final da última fileira incompleta.
        // Só ocorre quando há mais de uma fileira e ela não está cheia;
        // com uma fileira só, o splitRect já libera o espaço à direita.
        const lastRowCount = total % cols;
        if (usedRows > 1 && lastRowCount > 0) {
          const uw = (cols - lastRowCount) * (fw + k) - k;
          if (uw > EPS && fh > EPS) target.free.push({ x: r.x + lastRowCount * (fw + k), y: r.y + (usedRows - 1) * (fh + k), w: uw, h: fh });
        }
      } else {
        target.placements.push({ x: r.x, y: r.y, w: fw, h: fh, realW, realH, name: it.name, rotated: fit.rotated, bands: it.bands });
        splitRect(target, fit.rectIdx, fw, fh, o.kerf, splitPref);
      }
      mergeFree(target.free); // consolida a lista livre (estilo GuillotineBinPack)
    }
    // Durante a BUSCA usa a decomposição rápida (gulosa); o resultado final
    // recebe a decomposição ótima (maior retalho) em refineOffcuts().
    sheets.forEach(s => { s.free = guillotineOffcutsGreedy(s); s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
    return { sheets, unplaced };
  }

  // Preenche UMA única chapa o máximo possível: coloca o que couber e devolve
  // o resto para a próxima chapa (não abre chapa nova). Base do "encher antes
  // de abrir outra".
  function fillOneSheet(list, W, H, o, splitPref, fitMode, blockMode, gr) {
    const sheet = newSheet(list.length ? list[0].__mat : '', W, H, 1);
    const done = new Array(list.length).fill(false);
    const dimsOf = it => {
      let sw = gr ? (it.gw || it.w) : it.w, sh = gr ? (it.gh || it.h) : it.h, aw = it.w, ah = it.h;
      const g = grainOrient(it, o);
      if (g.swap) { const t = sw; sw = sh; sh = t; const u = aw; aw = ah; ah = u; }
      return { sw, sh, aw, ah, allowRotate: g.allowRotate };
    };
    for (let idx = 0; idx < list.length; idx++) {
      if (done[idx]) continue;
      const it = list[idx];
      const d = dimsOf(it);
      const fit = findFit(sheet, d.sw, d.sh, d.allowRotate, fitMode);
      if (!fit) continue; // não cabe nesta chapa → fica para a próxima
      done[idx] = true;
      const fw = fit.rotated ? d.sh : d.sw, fh = fit.rotated ? d.sw : d.sh;
      const realW = fit.rotated ? d.ah : d.aw, realH = fit.rotated ? d.aw : d.ah;
      const r = sheet.free[fit.rectIdx];
      if (blockMode) {
        const k = o.kerf;
        const cols = Math.max(1, Math.floor((r.w + k) / (fw + k)));
        const rows = Math.max(1, Math.floor((r.h + k) / (fh + k)));
        const cap = cols * rows, myKey = gr ? it.gKey : sig(it), ids = [idx];
        for (let j = idx + 1; j < list.length && ids.length < cap; j++) if (!done[j] && (gr ? list[j].gKey === myKey : sig(list[j]) === myKey)) ids.push(j);
        const total = Math.min(ids.length, cap);
        let placed = 0;
        for (let rr = 0; rr < rows && placed < total; rr++) for (let cc = 0; cc < cols && placed < total; cc++) {
          const dj = dimsOf(list[ids[placed]]);
          const rW = fit.rotated ? dj.ah : dj.aw, rH = fit.rotated ? dj.aw : dj.ah;
          sheet.placements.push({ x: r.x + cc * (fw + k), y: r.y + rr * (fh + k), w: fw, h: fh, realW: rW, realH: rH, name: list[ids[placed]].name, rotated: fit.rotated, bands: list[ids[placed]].bands });
          if (placed > 0) done[ids[placed]] = true;
          placed++;
        }
        const usedCols = Math.min(cols, total), usedRows = Math.ceil(total / cols);
        splitRect(sheet, fit.rectIdx, usedCols * fw + (usedCols - 1) * k, usedRows * fh + (usedRows - 1) * k, k, splitPref);
        const lastRowCount = total % cols;
        if (usedRows > 1 && lastRowCount > 0) {
          const uw = (cols - lastRowCount) * (fw + k) - k;
          if (uw > EPS && fh > EPS) sheet.free.push({ x: r.x + lastRowCount * (fw + k), y: r.y + (usedRows - 1) * (fh + k), w: uw, h: fh });
        }
      } else {
        sheet.placements.push({ x: r.x, y: r.y, w: fw, h: fh, realW, realH, name: it.name, rotated: fit.rotated, bands: it.bands });
        splitRect(sheet, fit.rectIdx, fw, fh, o.kerf, splitPref);
      }
      mergeFree(sheet.free);
    }
    const placed = [], rest = [];
    list.forEach((it, i) => (done[i] ? placed : rest).push(it));
    return { sheet, placed, rest };
  }

  // Estratégia "encher ao máximo": para cada chapa, escolhe (entre várias
  // ordens/cortes/encaixes) o preenchimento que ocupa MAIOR área; só então
  // abre a próxima. Tende a concentrar a sobra numa única chapa (menos chapas).
  function packMaxFill(items, W, H, o) {
    let remaining = items.slice();
    const sheets = [], unplaced = [];
    const cap = sheetCap(o);
    let guard = 0;
    while (remaining.length && guard++ < 300) {
      if (sheets.length >= cap) { unplaced.push.apply(unplaced, remaining); break; } // estoque esgotado
      let best = null;
      for (const ok of Object.keys(ORDERS)) {
        const sorted = remaining.slice().sort(ORDERS[ok]);
        for (const pref of ['maxrect', 'wide', 'tall']) for (const mode of ['bssf', 'tl', 'baf']) for (const block of [false, true]) for (const gr of [false, true]) {
          const r = fillOneSheet(sorted, W, H, o, pref, mode, block, gr);
          const area = r.placed.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0);
          if (!best || area > best.area + 1e-6) best = { area, sheet: r.sheet, rest: r.rest };
        }
      }
      if (!best || !best.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
      best.sheet.index = sheets.length + 1;
      best.sheet.free = guillotineOffcutsGreedy(best.sheet);
      best.sheet.cuts = countGuillotineCuts(best.sheet.W, best.sheet.H, best.sheet.placements);
      sheets.push(best.sheet);
      remaining = best.rest;
    }
    return { sheets, unplaced };
  }

  // ---- BUSCA EM ÁRVORE (beam search) estilo PackingSolver ----------------
  // Em vez de colocar cada peça de forma gulosa (1 escolha), explora MUITAS
  // sequências de colocação em paralelo: a cada peça, ramifica sobre
  // (retângulo livre × rotação × orientação do corte) e mantém as melhores
  // `beamWidth` soluções parciais. Isso encontra os "empilhamentos" alinhados
  // que a heurística gulosa não enxerga. É anytime: quanto maior beamWidth /
  // mais ordens testadas, melhor — sem teto de tempo.
  function packBeam(items, W, H, o, opts) {
    opts = opts || {};
    const beamWidth = opts.beamWidth || 200;
    const maxCandRects = opts.maxCandRects || 6;
    const splitPrefs = opts.splitPrefs || ['maxrect', 'wide', 'tall'];
    const order = opts.order || items;
    const cap = sheetCap(o);
    const k = o.kerf;

    const dimsOf = it => {
      let pw = it.w, ph = it.h;
      const g = grainOrient(it, o);
      if (g.swap) { const t = pw; pw = ph; ph = t; }
      return { pw, ph, allowRotate: g.allowRotate };
    };
    // clone barato: placements são imutáveis (compartilha), só free muda
    const cloneSheet = s => ({ material: s.material, index: s.index, W: s.W, H: s.H, placements: s.placements.slice(), free: s.free.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })), cuts: s.cuts });
    const cloneState = st => ({ sheets: st.sheets.map(cloneSheet), unplaced: st.unplaced.slice() });

    // guia parcial: na mesma profundidade a área colocada é igual; discrimina
    // por menos chapas → maior retalho livre → menos fragmentação.
    const freeStats = st => {
      let maxR = 0, sumSq = 0, frag = 0;
      st.sheets.forEach(s => s.free.forEach(r => { const a = r.w * r.h; if (a > maxR) maxR = a; sumSq += a * a; if (Math.min(r.w, r.h) >= 5) frag++; }));
      return { maxR, sumSq, frag };
    };
    const cmp = (a, b) => {
      if (a.unplaced.length !== b.unplaced.length) return a.unplaced.length - b.unplaced.length;
      if (a.sheets.length !== b.sheets.length) return a.sheets.length - b.sheets.length;
      if (Math.abs(a._fs.maxR - b._fs.maxR) > 1e-6) return b._fs.maxR - a._fs.maxR;
      if (Math.abs(a._fs.sumSq - b._fs.sumSq) > 1) return b._fs.sumSq - a._fs.sumSq;
      return a._fs.frag - b._fs.frag;
    };

    function expand(st, d) {
      const it = order[d];
      const { pw, ph, allowRotate } = dimsOf(it);
      const children = [];
      st.sheets.forEach((s, si) => {
        const cands = [];
        s.free.forEach((r, ri) => {
          if (pw <= r.w + 1e-6 && ph <= r.h + 1e-6) cands.push({ ri, fw: pw, fh: ph, rot: false, waste: Math.min(r.w - pw, r.h - ph) });
          if (allowRotate && ph <= r.w + 1e-6 && pw <= r.h + 1e-6) cands.push({ ri, fw: ph, fh: pw, rot: true, waste: Math.min(r.w - ph, r.h - pw) });
        });
        cands.sort((a, b) => a.waste - b.waste);
        for (let ci = 0; ci < cands.length && ci < maxCandRects; ci++) {
          const c = cands[ci];
          for (const pref of splitPrefs) {
            const ns = cloneState(st);
            const sheet = ns.sheets[si];
            const r = sheet.free[c.ri];
            sheet.placements.push({ x: r.x, y: r.y, w: c.fw, h: c.fh, realW: c.fw, realH: c.fh, name: it.name, rotated: c.rot, bands: it.bands });
            splitRect(sheet, c.ri, c.fw, c.fh, k, pref);
            mergeFree(sheet.free);
            children.push(ns);
          }
        }
      });
      // abrir uma chapa nova (o guia penaliza +1 chapa, então só "vence" quando preciso)
      const fitsNew = (pw <= W + 1e-6 && ph <= H + 1e-6) || (allowRotate && ph <= W + 1e-6 && pw <= H + 1e-6);
      if (fitsNew && st.sheets.length < cap) { // só abre chapa se houver estoque
        const ns = cloneState(st);
        const sheet = newSheet(it.__mat, W, H, ns.sheets.length + 1);
        const rot = !(pw <= W + 1e-6 && ph <= H + 1e-6);
        const fw = rot ? ph : pw, fh = rot ? pw : ph;
        sheet.placements.push({ x: 0, y: 0, w: fw, h: fh, realW: fw, realH: fh, name: it.name, rotated: rot, bands: it.bands });
        splitRect(sheet, 0, fw, fh, k, splitPrefs[0]);
        mergeFree(sheet.free);
        ns.sheets.push(sheet);
        children.push(ns);
      }
      if (children.length === 0) { // não coube em nenhuma chapa aberta nem há estoque
        const ns = cloneState(st); ns.unplaced.push(it); children.push(ns);
      }
      return children;
    }

    let beam = [{ sheets: [], unplaced: [] }];
    beam[0]._fs = freeStats(beam[0]);
    for (let d = 0; d < order.length; d++) {
      let next = [];
      for (const st of beam) { const ch = expand(st, d); for (const c of ch) next.push(c); }
      if (!next.length) break;
      next.forEach(s => { s._fs = freeStats(s); });
      next.sort(cmp);
      beam = next.slice(0, beamWidth);
    }
    // seleção final pela métrica REAL (score/better), finalizando as sobras
    let best = null, bestScore = null;
    for (const st of beam) {
      st.sheets.forEach(s => { s.free = guillotineOffcutsGreedy(s); s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
      const res = { sheets: st.sheets, unplaced: st.unplaced };
      const sc = score(res);
      if (better(sc, bestScore, o.weights)) { best = res; bestScore = sc; }
    }
    return best || { sheets: [], unplaced: items.slice() };
  }

  // Beam search que ENCHE UMA chapa ao máximo (maior área colocada). Para cada
  // peça (em ordem fixa) ramifica em {pular} ou {colocar em retângulo r × corte},
  // mantendo as melhores `beamWidth` soluções por área ocupada. Crama a chapa
  // bem mais que a gulosa → menos transbordo → menos chapas no total.
  function fillOneSheetBeam(list, W, H, o, opts) {
    opts = opts || {};
    const beamWidth = opts.beamWidth || 300;
    const maxCandRects = opts.maxCandRects || 6;
    const splitPrefs = opts.splitPrefs || ['maxrect', 'wide', 'tall'];
    const k = o.kerf;
    const dimsOf = it => {
      let pw = it.w, ph = it.h;
      const g = grainOrient(it, o);
      if (g.swap) { const t = pw; pw = ph; ph = t; }
      return { pw, ph, allowRotate: g.allowRotate };
    };
    const cloneSheet = s => ({ material: s.material, index: s.index, W: s.W, H: s.H, placements: s.placements.slice(), free: s.free.map(r => ({ x: r.x, y: r.y, w: r.w, h: r.h })), cuts: s.cuts });
    const stats = sh => { let maxR = 0, sumSq = 0; sh.free.forEach(r => { const a = r.w * r.h; if (a > maxR) maxR = a; sumSq += a * a; }); return { maxR, sumSq }; };
    const cmp = (a, b) => {
      if (Math.abs(a.area - b.area) > 1e-6) return b.area - a.area;            // mais área colocada
      if (Math.abs(a._s.maxR - b._s.maxR) > 1e-6) return b._s.maxR - a._s.maxR; // sobra mais inteira
      return b._s.sumSq - a._s.sumSq;
    };
    const base = newSheet(list.length ? list[0].__mat : '', W, H, 1);
    let beam = [{ sheet: base, area: 0, ids: [] }];
    beam[0]._s = stats(base);
    for (let d = 0; d < list.length; d++) {
      const it = list[d];
      const { pw, ph, allowRotate } = dimsOf(it);
      const next = [];
      for (const st of beam) {
        // PULAR (deixa a peça para a próxima chapa) — compartilha a chapa (não muta)
        next.push({ sheet: st.sheet, area: st.area, ids: st.ids, _s: st._s });
        // COLOCAR
        const cands = [];
        st.sheet.free.forEach((r, ri) => {
          if (pw <= r.w + 1e-6 && ph <= r.h + 1e-6) cands.push({ ri, fw: pw, fh: ph, rot: false, waste: Math.min(r.w - pw, r.h - ph) });
          if (allowRotate && ph <= r.w + 1e-6 && pw <= r.h + 1e-6) cands.push({ ri, fw: ph, fh: pw, rot: true, waste: Math.min(r.w - ph, r.h - pw) });
        });
        cands.sort((a, b) => a.waste - b.waste);
        for (let ci = 0; ci < cands.length && ci < maxCandRects; ci++) {
          const c = cands[ci];
          for (const pref of splitPrefs) {
            const sh = cloneSheet(st.sheet);
            const r = sh.free[c.ri];
            sh.placements.push({ x: r.x, y: r.y, w: c.fw, h: c.fh, realW: c.fw, realH: c.fh, name: it.name, rotated: c.rot, bands: it.bands });
            splitRect(sh, c.ri, c.fw, c.fh, k, pref);
            mergeFree(sh.free);
            const ch = { sheet: sh, area: st.area + c.fw * c.fh, ids: st.ids.concat(d) };
            ch._s = stats(sh);
            next.push(ch);
          }
        }
      }
      next.sort(cmp);
      beam = next.slice(0, beamWidth);
    }
    const win = beam[0];
    const placedSet = new Set(win.ids);
    const placed = [], rest = [];
    list.forEach((it, i) => (placedSet.has(i) ? placed : rest).push(it));
    return { sheet: win.sheet, placed, rest };
  }

  // "Encher ao máximo" via beam: enche cada chapa com fillOneSheetBeam e segue.
  function packMaxFillBeam(items, W, H, o, opts) {
    let remaining = items.slice();
    const sheets = [], unplaced = [];
    const cap = sheetCap(o);
    let guard = 0;
    while (remaining.length && guard++ < 300) {
      if (sheets.length >= cap) { unplaced.push.apply(unplaced, remaining); break; } // estoque esgotado
      const r = fillOneSheetBeam(remaining, W, H, o, opts);
      if (!r.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
      r.sheet.index = sheets.length + 1;
      r.sheet.free = guillotineOffcutsGreedy(r.sheet);
      r.sheet.cuts = countGuillotineCuts(r.sheet.W, r.sheet.H, r.sheet.placements);
      sheets.push(r.sheet);
      remaining = r.rest;
    }
    return { sheets, unplaced };
  }

  // ---- GUILHOTINA EM 2 ESTÁGIOS (faixas / shelf) ------------------------
  // Padrão de seccionadora clássico: 1º estágio corta a chapa em FAIXAS de
  // lado a lado (todas com a altura da peça mais alta da faixa); 2º estágio
  // corta as peças dentro da faixa. A "ponta" de cada faixa e o fundo da chapa
  // ficam CONSOLIDADOS (uma sobra grande), em vez de pontinhas espalhadas.
  //  axis 'v' = faixas verticais (colunas de altura cheia H, espessura=largura)
  //  axis 'h' = faixas horizontais (tiras de largura cheia W, espessura=altura)
  //  groupTol = agrupa alturas de faixa próximas (<= tol) → menos trim no topo
  function packShelf(items, W, H, o, opts) {
    opts = opts || {};
    const axis = opts.axis || 'v';
    const tol = opts.groupTol || 0;
    const k = o.kerf;
    const dimsOf = it => { let pw = it.w, ph = it.h; const g = grainOrient(it, o); if (g.swap) { const t = pw; pw = ph; ph = t; } return { pw, ph, allow: g.allowRotate }; };
    // cross = espessura da faixa; along = comprimento ao longo da faixa
    const crossRaw = it => { const d = dimsOf(it); return axis === 'h' ? d.ph : d.pw; };
    const alongOf = it => { const d = dimsOf(it); return axis === 'h' ? d.pw : d.ph; };
    const ALONG = axis === 'h' ? W : H, CROSS = axis === 'h' ? H : W;
    const base = (opts.order || items).slice();
    // tol>0: agrupa espessuras de faixa próximas (<=tol) → faixas niveladas na
    // MAIOR medida do cluster, concentrando o trim em poucas sobras grandes.
    const crossMap = tol ? clusterMaxMap(base.map(crossRaw), tol) : null;
    const crossOf = it => crossMap ? crossMap[crossRaw(it)] : crossRaw(it);
    // ordena por espessura desc (peça mais alta primeiro define a faixa), depois comprimento desc
    let remaining = base.sort((a, b) => crossOf(b) - crossOf(a) || alongOf(b) - alongOf(a));
    const sheets = [], unplaced = [];
    const cap = sheetCap(o);
    let sheet = null, crossCursor = 0, guard = 0;
    const openSheet = () => { sheet = newSheet(remaining[0].__mat, W, H, sheets.length + 1); sheets.push(sheet); crossCursor = 0; };
    while (remaining.length && guard++ < 5000) {
      if (!sheet) {
        if (sheets.length >= cap) { unplaced.push.apply(unplaced, remaining); break; } // estoque esgotado
        openSheet();
      }
      const head = remaining[0];
      const bandCross = crossOf(head); // altura da faixa = (cluster da) peça mais alta restante
      if (crossCursor + bandCross > CROSS + 1e-6) {
        if (crossCursor < 1e-6) { unplaced.push(head); remaining.shift(); sheet = null; continue; } // peça maior que a chapa
        sheet = null; continue; // chapa cheia → abre outra
      }
      // preenche a faixa: pega peças (na ordem) com cross<=bandCross que couberem no comprimento
      let alongCursor = 0; const used = [];
      for (let i = 0; i < remaining.length; i++) {
        const it = remaining[i];
        if (crossOf(it) > bandCross + 1e-6) continue;
        const a = alongOf(it);
        if (alongCursor + a > ALONG + 1e-6) continue;
        const d = dimsOf(it);
        const x = axis === 'h' ? alongCursor : crossCursor;
        const y = axis === 'h' ? crossCursor : alongCursor;
        sheet.placements.push({ x, y, w: d.pw, h: d.ph, realW: d.pw, realH: d.ph, name: it.name, rotated: false, bands: it.bands });
        alongCursor += a + k;
        used.push(i);
      }
      for (let j = used.length - 1; j >= 0; j--) remaining.splice(used[j], 1);
      crossCursor += bandCross + k;
      if (!used.length) { unplaced.push(head); remaining.shift(); } // trava de segurança
    }
    sheets.forEach(s => { s.free = guillotineOffcutsGreedy(s); s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
    return { sheets, unplaced };
  }


  // Conta os cortes guilhotinados REAIS do layout (nº de linhas de corte de
  // lado a lado, recursivamente). Espalhar uma tira na borda oposta gera mais
  // cortes do que consolidá-la junto às demais — é isto que medimos aqui.
  function countGuillotineCuts(W, H, placements) {
    // Mínimo de cortes guilhotinados via busca com memoização: testa V e H em
    // cada nível, filtra cortes degenerados (lado vazio = não separa peças) e
    // escolhe o que minimiza o total — garante a contagem ótima.
    const memo = new Map();
    const key = items => items.map(p => p.x + ',' + p.y).sort().join('|');
    function minCuts(items) {
      if (items.length <= 1) return 0;
      const k = key(items);
      if (memo.has(k)) return memo.get(k);
      let best = Infinity;
      Array.from(new Set(items.map(p => p.x + p.w))).forEach(X => {
        const L = items.filter(p => p.x + p.w <= X + EPS), R = items.filter(p => p.x >= X - EPS);
        if (L.length && R.length && items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS))
          best = Math.min(best, 1 + minCuts(L) + minCuts(R));
      });
      Array.from(new Set(items.map(p => p.y + p.h))).forEach(Y => {
        const T = items.filter(p => p.y + p.h <= Y + EPS), B = items.filter(p => p.y >= Y - EPS);
        if (T.length && B.length && items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS))
          best = Math.min(best, 1 + minCuts(T) + minCuts(B));
      });
      memo.set(k, isFinite(best) ? best : 0);
      return memo.get(k);
    }
    return minCuts(placements.slice());
  }

  // Áreas das sobras reaproveitáveis (ignora fiapos), em ordem decrescente.
  function offAreas(sheets) {
    const a = [];
    sheets.forEach(s => s.free.forEach(r => { if (Math.min(r.w, r.h) >= 5) a.push(r.w * r.h); }));
    a.sort((x, y) => y - x);
    return a;
  }
  function defaultWeights() {
    return { unplaced: 10, sheets: 10, fill: 5, offcut: 5, cuts: 5 };
  }
  // tol opcional: substitui o padrão 1e-4 quando o chamador passa um peso customizado
  function cmpFills(a, b, tol) {
    tol = (tol != null) ? tol : 1e-4;
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (Math.abs(x - y) > tol) return x - y;
    }
    return 0;
  }
  function score(res) {
    return {
      sheets: res.sheets.length,
      unplaced: res.unplaced.length,
      // fração ocupada por chapa (área REAL das peças, não o slot), da mais cheia para a mais vazia
      fills: res.sheets.map(s => s.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0) / (s.W * s.H)).sort((a, b) => b - a),
      off: offAreas(res.sheets),
      cuts: res.sheets.reduce((a, s) => a + s.cuts, 0),
    };
  }
  // Compara dois resultados pelas 5 premissas, em ordem de prioridade.
  // w.X = peso 1–10: peso maior → tolerância menor → critério mais exigente.
  function better(a, b, w) {
    if (!b) return true;
    if (!w) w = defaultWeights();
    // 1. Menos peças não-posicionadas (peso≥9→tol 0, ≥5→tol 1, <5→tol 2)
    const unplTol = w.unplaced >= 9 ? 0 : w.unplaced >= 5 ? 1 : 2;
    if (Math.abs(a.unplaced - b.unplaced) > unplTol) return a.unplaced < b.unplaced;
    // 2. Menos chapas usadas
    const shTol = w.sheets >= 9 ? 0 : w.sheets >= 5 ? 1 : 2;
    if (Math.abs(a.sheets - b.sheets) > shTol) return a.sheets < b.sheets;
    // 3. Chapas mais cheias (peso 10→tol 0,1%; peso 1→tol 5%)
    const fillTol = 0.001 + (10 - w.fill) * (0.049 / 9);
    const fl = cmpFills(a.fills, b.fills, fillTol);
    if (fl !== 0) return fl > 0;
    // 4. Maior retalho único aproveitável (peso 10→tol 1%; peso 1→tol 30%)
    const a0 = a.off[0] || 0, b0 = b.off[0] || 0;
    const offFactor = 0.01 + (10 - w.offcut) * (0.29 / 9);
    if (Math.abs(a0 - b0) > Math.max(a0, b0) * offFactor) return a0 > b0;
    // 5. Menos cortes — só decide quando os demais estão empatados
    // (peso 10→qualquer diff conta; peso 1→ignora diferenças ≤20 cortes)
    const cutsTol = Math.round((10 - w.cuts) * (20 / 9));
    if (Math.abs(a.cuts - b.cuts) > cutsTol) return a.cuts < b.cuts;
    return false;
  }

  // Recalcula as sobras do resultado final com a decomposição ÓTIMA (maior
  // retalho único, menos fragmentos). Filtra retalhos menores que 1 cm em
  // qualquer dimensão (sobras de kerf — inutilizáveis). Roda só nas poucas
  // chapas finais → barato. Também exportada para uso externo (app.js).
  function refineOffcuts(sheets) {
    sheets.forEach(s => {
      s.free = guillotineOffcuts(s).filter(r => Math.min(r.w, r.h) > 1.0);
    });
  }

  // Tenta encaixar peças não-posicionadas nas sobras guilhotinadas das chapas
  // existentes, usando guillotineOffcutsGreedy para revelar espaços contíguos
  // que o splitRect runtime tinha fragmentado. Opera sobre cópias das chapas
  // (não corrompe g.best). Devolve as peças que ainda não couberam.
  function backfillUnplaced(sheets, unplaced, o) {
    if (!unplaced.length || !sheets.length) return unplaced;
    const remaining = unplaced.slice();
    let madeProgress = true;
    while (madeProgress && remaining.length) {
      madeProgress = false;
      for (let i = remaining.length - 1; i >= 0; i--) {
        const it = remaining[i];
        const gr = grainOrient(it, o);
        const pw = gr.swap ? it.h : it.w, ph = gr.swap ? it.w : it.h;
        for (const sheet of sheets) {
          if (it.__mat && sheet.material !== it.__mat) continue;
          const free = guillotineOffcutsGreedy(sheet);
          const f = findFit({ free }, pw, ph, gr.allowRotate, 'bssf');
          if (f) {
            const fw = f.rotated ? ph : pw, fh = f.rotated ? pw : ph;
            const realW = f.rotated ? it.h : it.w, realH = f.rotated ? it.w : it.h;
            const r = free[f.rectIdx];
            sheet.placements.push({ x: r.x, y: r.y, w: fw, h: fh, realW, realH, name: it.name, rotated: f.rotated, bands: it.bands });
            remaining.splice(i, 1);
            madeProgress = true;
            break;
          }
        }
      }
    }
    sheets.forEach(s => { s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
    return remaining;
  }

  // Pós-processamento: tenta mover peças das chapas MENOS cheias para as
  // MAIS cheias, usando guillotineOffcutsGreedy para revelar espaços
  // contíguos que o splitRect runtime havia fragmentado. Remove chapas que
  // ficarem vazias após a consolidação. Muta o array `sheets` em lugar.
  function consolidateSheets(sheets, o) {
    if (sheets.length < 2) return sheets;
    const fillRate = s => s.placements.length
      ? s.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0) / (s.W * s.H)
      : 0;
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      // Acha a chapa menos cheia
      let minFill = Infinity, srcIdx = -1;
      for (let i = 0; i < sheets.length; i++) {
        const f = fillRate(sheets[i]);
        if (f < minFill) { minFill = f; srcIdx = i; }
      }
      if (srcIdx < 0 || sheets.length < 2) break;
      const src = sheets[srcIdx];
      if (!src.placements.length) { sheets.splice(srcIdx, 1); madeProgress = true; continue; }
      // Destinos: demais chapas do mesmo material, da mais cheia para a menos
      const targets = sheets.filter((_, i) => i !== srcIdx && sheets[i].material === src.material)
                            .sort((a, b) => fillRate(b) - fillRate(a));
      if (!targets.length) break;
      for (let i = src.placements.length - 1; i >= 0; i--) {
        const p = src.placements[i];
        for (const tgt of targets) {
          // usa a decomposição ÓTIMA (guillotineOffcuts) — a mesma que o SVG
          // exibe como sobras — para encontrar a maior região contígua possível
          const free = guillotineOffcuts(tgt);
          const f = findFit({ free }, p.w, p.h, false, 'bssf');
          if (f) {
            const r = free[f.rectIdx];
            tgt.placements.push({ ...p, x: r.x, y: r.y });
            src.placements.splice(i, 1);
            madeProgress = true;
            break;
          }
        }
      }
    }
    // Remove chapas vazias
    for (let i = sheets.length - 1; i >= 0; i--) {
      if (!sheets[i].placements.length) sheets.splice(i, 1);
    }
    sheets.forEach(s => { s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
    return sheets;
  }

  // Verifica se um conjunto de placements em W×H é compatível com corte
  // guilhotinado puro: existe alguma sequência de cortes de lado a lado que
  // os separa recursivamente. Diferente de guillotineOffcuts (que decompõe a
  // SOBRA), esta função decide se o layout COMPLETO é guilhotinável.
  function isGuillotineFeasible(W, H, placements) {
    if (placements.length <= 1) return true;
    const memo = new Map();
    const key = ps => ps.map(p => p.x.toFixed(1) + ',' + p.y.toFixed(1)).sort().join('|');
    function ok(x, y, w, h, items) {
      if (items.length <= 1) return true;
      const k = x.toFixed(1) + '|' + y.toFixed(1) + '|' + w.toFixed(1) + '|' + h.toFixed(1) + '|' + key(items);
      if (memo.has(k)) return memo.get(k);
      let res = false;
      const xs = new Set(), ys = new Set();
      items.forEach(p => { xs.add(p.x); xs.add(p.x + p.w); ys.add(p.y); ys.add(p.y + p.h); });
      outer: {
        for (const X of xs) {
          if (X <= x + EPS || X >= x + w - EPS) continue;
          if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS)) {
            const L = items.filter(p => p.x + p.w <= X + EPS);
            const R = items.filter(p => p.x >= X - EPS);
            if (L.length && R.length && ok(x, y, X - x, h, L) && ok(X, y, x + w - X, h, R)) {
              res = true; break outer;
            }
          }
        }
        for (const Y of ys) {
          if (Y <= y + EPS || Y >= y + h - EPS) continue;
          if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS)) {
            const T = items.filter(p => p.y + p.h <= Y + EPS);
            const B = items.filter(p => p.y >= Y - EPS);
            if (T.length && B.length && ok(x, y, w, Y - y, T) && ok(x, Y, w, y + h - Y, B)) {
              res = true; break outer;
            }
          }
        }
      }
      memo.set(k, res);
      return res;
    }
    return ok(0, 0, W, H, placements.slice());
  }

  // Tenta mover peças da chapa menos cheia para chapas mais cheias testando
  // QUALQUER posição na área livre (não apenas slots da decomposição guilhotinada).
  // Para cada posição candidata: (1) verifica não-sobreposição com peças existentes;
  // (2) verifica se o layout completo resultante ainda admite corte guilhotinado puro.
  // Captura o caso em que a sobra é irregular (L, T, dentes, etc.) e nenhum
  // retângulo isolado é grande o suficiente, mas a UNIÃO da sobra tem espaço.
  function consolidateByFreeArea(sheets, o) {
    if (sheets.length < 2) return;
    const fillRate = s => s.placements.length
      ? s.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0) / (s.W * s.H)
      : 0;
    let madeProgress = true;
    while (madeProgress) {
      madeProgress = false;
      let srcIdx = -1, minFill = Infinity;
      for (let i = 0; i < sheets.length; i++) {
        const f = fillRate(sheets[i]);
        if (f < minFill) { minFill = f; srcIdx = i; }
      }
      if (srcIdx < 0 || sheets.length < 2) break;
      const src = sheets[srcIdx];
      if (!src.placements.length) { sheets.splice(srcIdx, 1); madeProgress = true; continue; }
      const targets = sheets
        .filter((_, i) => i !== srcIdx && sheets[i].material === src.material)
        .sort((a, b) => fillRate(b) - fillRate(a));
      if (!targets.length) break;
      for (let pi = src.placements.length - 1; pi >= 0; pi--) {
        const p = src.placements[pi];
        for (const tgt of targets) {
          // Posições candidatas: coordenadas de bordas das peças existentes
          const xs = new Set([0]), ys = new Set([0]);
          tgt.placements.forEach(q => { xs.add(q.x); xs.add(q.x + q.w); ys.add(q.y); ys.add(q.y + q.h); });
          const xArr = Array.from(xs).sort((a, b) => a - b);
          const yArr = Array.from(ys).sort((a, b) => a - b);
          let placed = false;
          xloop: for (const x of xArr) {
            if (x + p.w > tgt.W + EPS) continue;
            for (const y of yArr) {
              if (y + p.h > tgt.H + EPS) continue;
              // 1. Sem sobreposição com peças existentes
              if (tgt.placements.some(q =>
                x < q.x + q.w - EPS && x + p.w > q.x + EPS &&
                y < q.y + q.h - EPS && y + p.h > q.y + EPS)) continue;
              // 2. Layout completo (peças antigas + nova) ainda é guilhotinável
              if (!isGuillotineFeasible(tgt.W, tgt.H, tgt.placements.concat([{ x, y, w: p.w, h: p.h }]))) continue;
              tgt.placements.push({ ...p, x, y });
              src.placements.splice(pi, 1);
              madeProgress = true;
              placed = true;
              break xloop;
            }
          }
          if (placed) break;
        }
      }
    }
    for (let i = sheets.length - 1; i >= 0; i--) {
      if (!sheets[i].placements.length) sheets.splice(i, 1);
    }
    sheets.forEach(s => { s.free = guillotineOffcuts(s); s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
  }


  // Redistribui peças entre chapas do mesmo material para MAXIMIZAR o maior
  // retalho contíguo. Ao contrário de consolidateSheets (que reduz o número de
  // chapas), aqui o objetivo é melhorar a QUALIDADE das sobras: concentra o
  // espaço ocupado numa chapa e "expande" a sobra livre da outra — mesmo que o
  // número de chapas não mude. Move uma peça de src→tgt somente quando o maior
  // retalho inteiro do par (max(off_src, off_tgt)) estritamente aumenta.
  function consolidateRemnants(sheets, o) {
    if (sheets.length < 2) return;

    // Área do maior retalho contíguo de uma chapa (via decomposição ótima)
    const maxOff = s => {
      if (!s.placements.length) return s.W * s.H;
      const free = guillotineOffcuts(s);
      return free.reduce((m, r) => Math.max(m, r.w * r.h), 0);
    };

    let madeProgress = true;
    let guard = 0;
    while (madeProgress && guard++ < 100) {
      madeProgress = false;

      outer: for (let si = 0; si < sheets.length; si++) {
        const src = sheets[si];
        if (!src.placements.length) continue;

        for (let ti = 0; ti < sheets.length; ti++) {
          if (si === ti) continue;
          const tgt = sheets[ti];
          if (src.material !== tgt.material) continue;

          const srcOff = maxOff(src);
          const tgtOff = maxOff(tgt);
          const currentMax = Math.max(srcOff, tgtOff);

          // Sobras disponíveis no destino (decomposição ótima)
          const tgtFree = guillotineOffcuts(tgt);

          for (let pi = 0; pi < src.placements.length; pi++) {
            const p = src.placements[pi];

            // Encaixa a peça nas sobras do destino (sem rotação — orientação já fixada)
            const f = findFit({ free: tgtFree }, p.w, p.h, false, 'bssf');
            if (!f) continue;

            const r = tgtFree[f.rectIdx];
            const newTgtPlacements = tgt.placements.concat([{ ...p, x: r.x, y: r.y }]);

            // Verifica que o novo layout do destino é guilhotinável
            if (!isGuillotineFeasible(tgt.W, tgt.H, newTgtPlacements)) continue;

            // Simula o retalho máximo do par após a troca
            const simTgt = { W: tgt.W, H: tgt.H, placements: newTgtPlacements };
            const newTgtOff = maxOff(simTgt);

            const newSrcPlacements = src.placements.filter((_, i) => i !== pi);
            const simSrc = { W: src.W, H: src.H, placements: newSrcPlacements };
            const newSrcOff = maxOff(simSrc);

            // Só move se o maior retalho do par melhorar estritamente
            if (Math.max(newSrcOff, newTgtOff) > currentMax + EPS) {
              tgt.placements.push({ ...p, x: r.x, y: r.y });
              src.placements.splice(pi, 1);
              madeProgress = true;
              break outer;
            }
          }
        }
      }
    }

    // Remove chapas que ficaram vazias após os movimentos
    for (let i = sheets.length - 1; i >= 0; i--) {
      if (!sheets[i].placements.length) sheets.splice(i, 1);
    }

    sheets.forEach(s => {
      s.free = guillotineOffcutsGreedy(s);
      s.cuts = countGuillotineCuts(s.W, s.H, s.placements);
    });
  }

  // todas as suas peças numa única. Quando consolidateSheets falha porque não
  // existe espaço contíguo suficiente no layout atual, um re-empacotamento
  // completo deste subconjunto de peças pode descobrir um arranjo que cabe numa
  // só chapa. As peças são reconstruídas a partir dos placements (realW×realH)
  // com grain='v'/sg='v' para fixar a orientação efetiva sem rotação extra.
  function repackMerge(sheets, o) {
    if (sheets.length < 2) return;
    const fillRate = s => s.placements.length
      ? s.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0) / (s.W * s.H)
      : 0;
    // Pares compatíveis (mesmo material + dimensão), do menor fill combinado ao maior.
    const cands = [];
    for (let i = 0; i < sheets.length; i++) {
      for (let j = i + 1; j < sheets.length; j++) {
        const a = sheets[i], b = sheets[j];
        if (a.material !== b.material) continue;
        if (Math.abs(a.W - b.W) > EPS || Math.abs(a.H - b.H) > EPS) continue;
        cands.push({ i, j, combined: fillRate(a) + fillRate(b) });
      }
    }
    cands.sort((a, b) => a.combined - b.combined);
    for (const { i, j } of cands) {
      const sA = sheets[i], sB = sheets[j];
      const items = [];
      [sA, sB].forEach(s => s.placements.forEach(p => items.push({
        w: p.realW || p.w, h: p.realH || p.h,
        material: s.material, name: p.name,
        grain: 'v', bands: p.bands || {},
        __mat: s.material, __sg: 'v',
      })));
      const ro = Object.assign({}, o);
      const res = packGroup(items, sA.W, sA.H, ro, sA.material, 1);
      if (res && !res.unplaced.length && res.sheets.length === 1) {
        const ns = res.sheets[0];
        ns.material = sA.material;
        ns.stockName = (fillRate(sB) >= fillRate(sA) ? sB : sA).stockName || '';
        ns.free = guillotineOffcutsGreedy(ns);
        ns.cuts = countGuillotineCuts(ns.W, ns.H, ns.placements);
        sheets.splice(j, 1);
        sheets.splice(i, 1);
        sheets.push(ns);
        return;
      }
    }
  }

  function packGroup(items, W, H, o, matName, maxSheets) {
    items.forEach(it => it.__mat = matName);
    o.maxSheets = (maxSheets != null && maxSheets > 0) ? maxSheets : Infinity; // teto de chapas (estoque)
    annotateGroups(items, GROUP_TOL); // peças similares (<=5cm) usam a maior medida
    let best = null, bestScore = null;
    const consider = res => { const sc = score(res); if (better(sc, bestScore, o.weights)) { best = res; bestScore = sc; } };
    for (const key of Object.keys(ORDERS)) {
      const list = items.slice().sort(ORDERS[key]);
      for (const pref of ['maxrect', 'wide', 'tall']) {
        for (const mode of ['bssf', 'tl', 'baf']) {
          for (const place of ['first', 'best']) {
            for (const block of [false, true]) for (const gr of [false, true]) consider(packOnce(list, W, H, o, pref, mode, place, block, gr));
          }
        }
      }
    }
    consider(packMaxFill(items, W, H, o)); // "encher ao máximo antes de abrir outra"
    // guilhotina em 2 estágios (faixas) — consolida pontas/fundo numa sobra grande
    for (const axis of ['v', 'h']) for (const gt of [0, GROUP_TOL]) {
      for (const key of Object.keys(ORDERS)) consider(packShelf(items, W, H, o, { axis, groupTol: gt, order: items.slice().sort(ORDERS[key]) }));
    }
    // busca em árvore (beam) — só quando pedida (o.beamWidth); o one-shot
    // padrão fica instantâneo. Acha combinações que a gulosa não vê.
    if (o.beamWidth) {
      for (const key of Object.keys(ORDERS)) {
        const list = items.slice().sort(ORDERS[key]);
        consider(packBeam(items, W, H, o, { order: list, beamWidth: o.beamWidth }));
        consider(packMaxFillBeam(list, W, H, o, { beamWidth: o.beamWidth }));
      }
    }
    return best;
  }

  function optimize(panels, stockList, options) {
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true, weights: defaultWeights() }, options);
    const items = expand(panels);
    const groups = {};
    items.forEach(it => { const key = o.considerMaterial ? it.material : '__all__'; (groups[key] = groups[key] || []).push(it); });

    function sizesFor(material) {
      // só chapas com ESTE material; material vazio não conta (fora do cálculo)
      const rows = stockList.filter(s => o.considerMaterial && s.material && s.material === material);
      return aggregateSizes(rows);
    }

    const sheets = [], unplaced = [];
    Object.keys(groups).forEach(material => {
      const sizes = sizesFor(material);
      const matName = o.considerMaterial ? material : 'Geral';
      // cascata: chapas menores primeiro; o que sobra cai no próximo tamanho
      const res = runCascade(groups[material], sizes, o, (items, W, H) => packGroup(items, W, H, o, matName, o.maxSheets));
      res.sheets.forEach(s => sheets.push(s));
      res.unplaced.forEach(u => unplaced.push(u));
    });
    const finalUnplaced = backfillUnplaced(sheets, unplaced, o);
    consolidateSheets(sheets, o);
    consolidateByFreeArea(sheets, o);
    let _rLen;
    do { _rLen = sheets.length; repackMerge(sheets, o); } while (sheets.length < _rLen);
    consolidateRemnants(sheets, o); // melhora qualidade das sobras sem reduzir chapas
    // numera por (material + nome do estoque) após consolidação
    const perKey = {};
    sheets.forEach(s => { const k = s.material + '|' + (s.stockName || ''); (perKey[k] = perKey[k] || []).push(s); });
    Object.keys(perKey).forEach(k => perKey[k].forEach((s, i) => { s.index = i + 1; }));
    refineOffcuts(sheets); // decomposição ótima das sobras (só no resultado final)

    const byMaterial = {};
    sheets.forEach(s => {
      const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
      m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
      s.placements.forEach(p => { m.pieces++; m.usedArea += (p.realW || p.w) * (p.realH || p.h); });
    });

    return { sheets, unplaced: finalUnplaced, byMaterial };
  }

  // ---- Busca CONTÍNUA: testa estratégias em passos, guardando o melhor de
  // cada material. O app chama step() em lotes e renderiza quando melhora;
  // pode pausar a qualquer momento e usar o melhor plano até então. ----
  function createSearch(panels, stockList, options) {
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true, weights: defaultWeights() }, options);
    const items = expand(panels);
    const groupsMap = {};
    items.forEach(it => { const key = o.considerMaterial ? it.material : '__all__'; (groupsMap[key] = groupsMap[key] || []).push(it); });
    function sizesFor(material) {
      // só chapas com ESTE material; material vazio não conta (fora do cálculo)
      const rows = stockList.filter(s => o.considerMaterial && s.material && s.material === material);
      return aggregateSizes(rows);
    }
    const groups = Object.keys(groupsMap).map(material => {
      const sizes = sizesFor(material); // 1+ tamanhos de chapa (maior primeiro)
      const matName = o.considerMaterial ? material : 'Geral';
      groupsMap[material].forEach(it => { it.__mat = matName; it.__sg = (sizes[0] && sizes[0].grain) || 'v'; });
      annotateGroups(groupsMap[material], GROUP_TOL);
      return { items: groupsMap[material], sizes, best: null, bestScore: null };
    });

    const orderKeys = Object.keys(ORDERS);
    const prefs = ['maxrect', 'wide', 'tall'], modes = ['bssf', 'tl', 'baf'], places = ['first', 'best'];
    const combos = [];
    for (const ok of orderKeys) for (const pref of prefs) for (const mode of modes) for (const place of places) for (const block of [false, true]) for (const gr of [false, true]) combos.push({ ok, pref, mode, place, block, gr });
    const totalDet = combos.length;
    // fase BEAM (busca profunda anytime, estilo PackingSolver): largura cresce
    // a cada passada. Roda DEPOIS das combinações rápidas → o plano bom aparece
    // já; o beam só refina. Cada passada é um step() (a tela atualiza entre elas).
    const beamSchedule = [];
    for (const wgt of [48, 128, 320, 700]) for (const ok of orderKeys) beamSchedule.push({ wgt, ok });
    let beamIdx = 0;

    let rng = 2463534242;
    function rand() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 4294967296; }
    function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    const pick = a => a[Math.floor(rand() * a.length)];

    let detIdx = 0, stepCount = 0, sinceImprove = 0, maxFillDone = false;

    // Aplica um combo em CASCATA pelos tamanhos do grupo (packOnce por tamanho).
    function tryOn(g, c) {
      const res = runCascade(g.items, g.sizes, o, (it, W, H) => packOnce(it.slice().sort(ORDERS[c.ok]), W, H, o, c.pref, c.mode, c.place, c.block, c.gr));
      const sc = score(res);
      if (better(sc, g.bestScore, o.weights)) { g.best = res; g.bestScore = sc; return true; }
      return false;
    }

    function step() {
      let improved = false;
      if (!maxFillDone) {
        // 1º passo: "encher ao máximo" + guilhotina em faixas (2 estágios)
        maxFillDone = true;
        for (const g of groups) {
          const tryRes = res => { const sc = score(res); if (better(sc, g.bestScore, o.weights)) { g.best = res; g.bestScore = sc; improved = true; } };
          tryRes(runCascade(g.items, g.sizes, o, (it, W, H) => packMaxFill(it, W, H, o)));
          for (const axis of ['v', 'h']) for (const gt of [0, GROUP_TOL]) for (const ok of Object.keys(ORDERS))
            tryRes(runCascade(g.items, g.sizes, o, (it, W, H) => packShelf(it, W, H, o, { axis, groupTol: gt, order: it.slice().sort(ORDERS[ok]) })));
        }
        stepCount++;
        if (improved) sinceImprove = 0; else sinceImprove++;
        return { improved, converged: false, det: detIdx, totalDet, step: stepCount, sinceImprove };
      }
      if (detIdx < combos.length) {
        const c = combos[detIdx++];
        for (const g of groups) { if (tryOn(g, c)) improved = true; }
      } else if (beamIdx < beamSchedule.length) {
        // fase BEAM: busca em árvore (uma passada por step)
        const job = beamSchedule[beamIdx++];
        for (const g of groups) {
          let r = runCascade(g.items, g.sizes, o, (it, W, H) => packBeam(it, W, H, o, { order: it.slice().sort(ORDERS[job.ok]), beamWidth: job.wgt }));
          let sc = score(r);
          if (better(sc, g.bestScore, o.weights)) { g.best = r; g.bestScore = sc; improved = true; }
          r = runCascade(g.items, g.sizes, o, (it, W, H) => packMaxFillBeam(it.slice().sort(ORDERS[job.ok]), W, H, o, { beamWidth: job.wgt }));
          sc = score(r);
          if (better(sc, g.bestScore, o.weights)) { g.best = r; g.bestScore = sc; improved = true; }
        }
      } else {
        // reinícios aleatórios: embaralha a ordem + combo aleatório
        const c = { pref: pick(prefs), mode: pick(modes), place: pick(places), block: rand() < 0.5, gr: rand() < 0.5 };
        const ok = pick(orderKeys), useShuffle = rand() < 0.75;
        for (const g of groups) {
          const res = runCascade(g.items, g.sizes, o, (it, W, H) => {
            const base = it.slice().sort(ORDERS[ok]);
            return packOnce(useShuffle ? shuffle(base) : base, W, H, o, c.pref, c.mode, c.place, c.block, c.gr);
          });
          const sc = score(res);
          if (better(sc, g.bestScore, o.weights)) { g.best = res; g.bestScore = sc; improved = true; }
        }
      }
      stepCount++;
      if (improved) sinceImprove = 0; else sinceImprove++;
      // convergiu: terminou as fases determinística + beam e estagnou por MUITOS
      // passos (busca longa; o usuário pode pausar a qualquer momento).
      const converged = detIdx >= combos.length && beamIdx >= beamSchedule.length && sinceImprove >= 3000;
      return { improved, converged, det: detIdx, totalDet, step: stepCount, sinceImprove, beam: { idx: beamIdx, total: beamSchedule.length } };
    }

    // onStage(frac) — callback opcional de progresso (0..1) da finalização. Cada
    // etapa do pós-processamento reporta seu avanço para que a barra de progresso
    // continue fluindo durante esta fase pesada (antes ela ficava sem sinal).
    function result(onStage) {
      const report = typeof onStage === 'function' ? onStage : function () {};
      const sheets = [], rawUnplaced = [];
      // Copia os sheets para não corromper g.best ao fazer backfill/consolidação
      groups.forEach(g => {
        if (!g.best) return;
        g.best.sheets.forEach(s => sheets.push({ ...s, placements: s.placements.slice() }));
        g.best.unplaced.forEach(u => rawUnplaced.push(u));
      });
      report(0.08);
      const unplaced = backfillUnplaced(sheets, rawUnplaced, o);
      report(0.22);
      consolidateSheets(sheets, o);
      report(0.34);
      consolidateByFreeArea(sheets, o);
      report(0.46);
      // Tenta fundir chapas pouco cheias num único re-empacotamento
      let _prevLen;
      do { _prevLen = sheets.length; repackMerge(sheets, o); } while (sheets.length < _prevLen);
      report(0.66);
      consolidateRemnants(sheets, o); // melhora qualidade das sobras sem reduzir chapas
      report(0.78);
      // Numera após consolidação (chapas podem ter sido removidas/reordenadas)
      const perMat = {};
      sheets.forEach(s => { const k = s.material + '|' + (s.stockName || ''); (perMat[k] = perMat[k] || []).push(s); });
      Object.keys(perMat).forEach(k => perMat[k].forEach((s, i) => { s.index = i + 1; }));
      report(0.82);
      refineOffcuts(sheets); // decomposição ótima das sobras (só no resultado mostrado)
      report(0.92);
      const byMaterial = {};
      sheets.forEach(s => {
        const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
        m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
        s.placements.forEach(p => { m.pieces++; m.usedArea += (p.realW || p.w) * (p.realH || p.h); });
      });
      return { sheets, unplaced, byMaterial };
    }

    return { step, result, totalDet };
  }

  global.Optimizer = { optimize, createSearch, defaultWeights, refineOffcuts };
})(window);
