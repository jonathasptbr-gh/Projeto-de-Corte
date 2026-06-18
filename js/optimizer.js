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
  // deixa o MAIOR pedaço inteiro (desempate: maior área reaproveitável total).
  // Assim ela "apara as tiras com peça" primeiro (esquerda, topo) e mantém o
  // miolo vazio como um único retalho grande. Memoiza por região+peças.
  function guillotineOffcuts(sheet) {
    if (!sheet.placements.length) return [{ x: 0, y: 0, w: sheet.W, h: sheet.H }];
    const placements = sheet.placements;
    // Muitas peças numa região → busca completa fica cara: cai no guloso.
    if (placements.length > 14) return guillotineOffcutsGreedy(sheet);
    const memo = new Map();
    function best(x, y, w, h, items) {
      if (w <= EPS || h <= EPS) return { rects: [], maxA: 0, total: 0 };
      if (!items.length) { const a = w * h; return { rects: [{ x, y, w, h }], maxA: a, total: a }; }
      const key = x.toFixed(1) + '|' + y.toFixed(1) + '|' + w.toFixed(1) + '|' + h.toFixed(1) + '|' + items.map(p => p.x.toFixed(0) + ',' + p.y.toFixed(0)).sort().join(';');
      const hit = memo.get(key); if (hit) return hit;
      let res = null;
      const consider = (ca, cb) => {
        const ra = best(ca.x, ca.y, ca.w, ca.h, ca.items);
        const rb = best(cb.x, cb.y, cb.w, cb.h, cb.items);
        const maxA = Math.max(ra.maxA, rb.maxA), total = ra.total + rb.total;
        if (!res || maxA > res.maxA + 1e-6 || (Math.abs(maxA - res.maxA) <= 1e-6 && total > res.total + 1e-6)) {
          res = { rects: ra.rects.concat(rb.rects), maxA, total };
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
      if (!res) res = { rects: [], maxA: 0, total: 0 }; // peça preenche a região
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
      cands.sort((c1, c2) => (emptyArea(c2) - emptyArea(c1)) || (biggestEmpty(c2) - biggestEmpty(c1)));
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
  function annotateGroups(items, tol) {
    const clusterMax = vals => {
      const sorted = Array.from(new Set(vals)).sort((a, b) => a - b);
      const map = {}; let i = 0;
      while (i < sorted.length) {
        let j = i; while (j + 1 < sorted.length && sorted[j + 1] - sorted[i] <= tol) j++;
        const mx = sorted[j]; for (let k = i; k <= j; k++) map[sorted[k]] = mx; i = j + 1;
      }
      return map;
    };
    const wm = clusterMax(items.map(it => it.w));
    const hm = clusterMax(items.map(it => it.h));
    items.forEach(it => { it.gw = wm[it.w]; it.gh = hm[it.h]; it.gKey = (it.grain || '') + '|' + it.gw + '|' + it.gh; });
  }

  function packOnce(list, W, H, o, splitPref, fitMode, placeMode, blockMode, gr) {
    let sheetIndex = 0;
    const sheets = [];
    const unplaced = [];
    const done = new Array(list.length).fill(false);
    // dims: footprint do "slot" (arredondado se gr) + medida real p/ rótulo
    const dimsOf = it => {
      let sw = gr ? (it.gw || it.w) : it.w, sh = gr ? (it.gh || it.h) : it.h, aw = it.w, ah = it.h, allowRotate;
      if (o.considerGrain && it.grain) { allowRotate = false; if (it.grain === 'h') { const t = sw; sw = sh; sh = t; const u = aw; aw = ah; ah = u; } }
      else allowRotate = o.allowRotate;
      return { sw, sh, aw, ah, allowRotate };
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
      let sw = gr ? (it.gw || it.w) : it.w, sh = gr ? (it.gh || it.h) : it.h, aw = it.w, ah = it.h, allowRotate;
      if (o.considerGrain && it.grain) { allowRotate = false; if (it.grain === 'h') { const t = sw; sw = sh; sh = t; const u = aw; aw = ah; ah = u; } }
      else allowRotate = o.allowRotate;
      return { sw, sh, aw, ah, allowRotate };
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
    let guard = 0;
    while (remaining.length && guard++ < 300) {
      let best = null;
      for (const ok of Object.keys(ORDERS)) {
        const sorted = remaining.slice().sort(ORDERS[ok]);
        for (const pref of ['maxrect', 'wide', 'tall']) for (const mode of ['bssf', 'tl', 'baf']) for (const block of [false, true]) for (const gr of [false, true]) {
          const r = fillOneSheet(sorted, W, H, o, pref, mode, block, gr);
          const area = r.placed.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0);
          if (!best || area > best.area + 1e-6) best = { area, sheet: r.sheet, rest: r.rest };
        }
      }
      if (!best || !best.placed && !best.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
      if (!best.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
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
    const k = o.kerf;

    const dimsOf = it => {
      let pw = it.w, ph = it.h, allowRotate;
      if (o.considerGrain && it.grain) { allowRotate = false; if (it.grain === 'h') { pw = it.h; ph = it.w; } }
      else allowRotate = o.allowRotate;
      return { pw, ph, allowRotate };
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
      if (fitsNew) {
        const ns = cloneState(st);
        const sheet = newSheet(it.__mat, W, H, ns.sheets.length + 1);
        const rot = !(pw <= W + 1e-6 && ph <= H + 1e-6);
        const fw = rot ? ph : pw, fh = rot ? pw : ph;
        sheet.placements.push({ x: 0, y: 0, w: fw, h: fh, realW: fw, realH: fh, name: it.name, rotated: rot, bands: it.bands });
        splitRect(sheet, 0, fw, fh, k, splitPrefs[0]);
        mergeFree(sheet.free);
        ns.sheets.push(sheet);
        children.push(ns);
      } else if (children.length === 0) {
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
      if (better(sc, bestScore)) { best = res; bestScore = sc; }
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
      let pw = it.w, ph = it.h, allowRotate;
      if (o.considerGrain && it.grain) { allowRotate = false; if (it.grain === 'h') { pw = it.h; ph = it.w; } }
      else allowRotate = o.allowRotate;
      return { pw, ph, allowRotate };
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
    let guard = 0;
    while (remaining.length && guard++ < 300) {
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

  // Conta os cortes guilhotinados REAIS do layout (nº de linhas de corte de
  // lado a lado, recursivamente). Espalhar uma tira na borda oposta gera mais
  // cortes do que consolidá-la junto às demais — é isto que medimos aqui.
  function countGuillotineCuts(W, H, placements) {
    let n = 0;
    function rec(x, y, w, h, items) {
      if (items.length <= 1) return;
      let chosen = null;
      const xs = Array.from(new Set(items.map(p => p.x + p.w))).filter(X => X > x + EPS && X < x + w - EPS).sort((a, b) => a - b);
      for (const X of xs) { if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS)) { chosen = { o: 'v', pos: X }; break; } }
      if (!chosen) {
        const ys = Array.from(new Set(items.map(p => p.y + p.h))).filter(Y => Y > y + EPS && Y < y + h - EPS).sort((a, b) => a - b);
        for (const Y of ys) { if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS)) { chosen = { o: 'h', pos: Y }; break; } }
      }
      if (!chosen) return;
      n++;
      if (chosen.o === 'v') {
        const X = chosen.pos;
        rec(x, y, X - x, h, items.filter(p => p.x + p.w <= X + EPS));
        rec(X, y, x + w - X, h, items.filter(p => p.x >= X - EPS));
      } else {
        const Y = chosen.pos;
        rec(x, y, w, Y - y, items.filter(p => p.y + p.h <= Y + EPS));
        rec(x, Y, w, h - (Y - y), items.filter(p => p.y >= Y - EPS));
      }
    }
    rec(0, 0, W, H, placements.slice());
    return n;
  }

  // Áreas das sobras reaproveitáveis (ignora fiapos), em ordem decrescente.
  function offAreas(sheets) {
    const a = [];
    sheets.forEach(s => s.free.forEach(r => { if (Math.min(r.w, r.h) >= 5) a.push(r.w * r.h); }));
    a.sort((x, y) => y - x);
    return a;
  }
  function cmpLex(a, b) {
    const n = Math.max(a.length, b.length);
    for (let i = 0; i < n; i++) {
      const x = a[i] || 0, y = b[i] || 0;
      if (Math.abs(x - y) > 1e-3) return x - y;
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
  // Prioriza: menos não-encaixadas → menos chapas → MAIOR retalho (com
  // tolerância) → MENOS cortes → demais sobras (lex) → menos retalhos.
  // A tolerância evita sacrificar o maior retalho por cortes, mas quando o
  // maior retalho é praticamente o mesmo, escolhe o plano com menos cortes
  // (ex.: consolidar tiras de um lado em vez de espalhar uma na borda oposta).
  function better(a, b) {
    if (!b) return true;
    if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
    if (a.sheets !== b.sheets) return a.sheets < b.sheets;
    // ENCHER AO MÁXIMO: chapas mais cheias primeiro (concentra a sobra numa só,
    // em vez de deixar duas chapas meio-cheias). Tolerância de 0,1%.
    const fl = cmpLex(a.fills, b.fills);
    if (Math.abs(fl) > 1e-3) return fl > 0;
    const a0 = a.off[0] || 0, b0 = b.off[0] || 0;
    const tol = Math.max(a0, b0) * 0.03; // 3% no maior retalho
    if (Math.abs(a0 - b0) > tol) return a0 > b0;
    if (a.cuts !== b.cuts) return a.cuts < b.cuts;
    if (a.off.length !== b.off.length) return a.off.length < b.off.length; // menos retalhos = menos fragmentação
    const lex = cmpLex(a.off, b.off);
    return lex > 0;
  }

  // Recalcula as sobras do resultado final com a decomposição ÓTIMA (maior
  // retalho único). Roda só nas poucas chapas finais → barato.
  function refineOffcuts(sheets) {
    sheets.forEach(s => { s.free = guillotineOffcuts(s); });
  }

  function packGroup(items, W, H, o, matName) {
    items.forEach(it => it.__mat = matName);
    annotateGroups(items, GROUP_TOL); // peças similares (<=5cm) usam a maior medida
    let best = null, bestScore = null;
    const consider = res => { const sc = score(res); if (better(sc, bestScore)) { best = res; bestScore = sc; } };
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
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true }, options);
    const items = expand(panels);
    const groups = {};
    items.forEach(it => { const key = o.considerMaterial ? it.material : '__all__'; (groups[key] = groups[key] || []).push(it); });

    function stockFor(material) {
      let s = stockList.find(s => o.considerMaterial && s.material && s.material === material);
      if (!s) s = stockList.find(s => !s.material) || stockList[0];
      return s || { width: 184, length: 274, qty: 999 };
    }

    const sheets = [], unplaced = [];
    Object.keys(groups).forEach(material => {
      const stock = stockFor(material);
      const matName = o.considerMaterial ? material : 'Geral';
      const res = packGroup(groups[material], stock.width, stock.length, o, matName);
      res.sheets.forEach((s, i) => { s.index = i + 1; sheets.push(s); });
      res.unplaced.forEach(u => unplaced.push(u));
    });
    refineOffcuts(sheets); // decomposição ótima das sobras (só no resultado final)

    const byMaterial = {};
    sheets.forEach(s => {
      const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
      m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
      s.placements.forEach(p => { m.pieces++; m.usedArea += (p.realW || p.w) * (p.realH || p.h); });
    });

    return { sheets, unplaced, byMaterial };
  }

  // ---- Busca CONTÍNUA: testa estratégias em passos, guardando o melhor de
  // cada material. O app chama step() em lotes e renderiza quando melhora;
  // pode pausar a qualquer momento e usar o melhor plano até então. ----
  function createSearch(panels, stockList, options) {
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true }, options);
    const items = expand(panels);
    const groupsMap = {};
    items.forEach(it => { const key = o.considerMaterial ? it.material : '__all__'; (groupsMap[key] = groupsMap[key] || []).push(it); });
    function stockFor(material) {
      let s = stockList.find(s => o.considerMaterial && s.material && s.material === material);
      if (!s) s = stockList.find(s => !s.material) || stockList[0];
      return s || { width: 184, length: 274, qty: 999 };
    }
    const groups = Object.keys(groupsMap).map(material => {
      const stock = stockFor(material);
      const matName = o.considerMaterial ? material : 'Geral';
      groupsMap[material].forEach(it => it.__mat = matName);
      annotateGroups(groupsMap[material], GROUP_TOL);
      return { items: groupsMap[material], W: stock.width, H: stock.length, best: null, bestScore: null };
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

    function tryOn(g, list, c) {
      const res = packOnce(list, g.W, g.H, o, c.pref, c.mode, c.place, c.block, c.gr);
      const sc = score(res);
      if (better(sc, g.bestScore)) { g.best = res; g.bestScore = sc; return true; }
      return false;
    }

    function step() {
      let improved = false;
      if (!maxFillDone) {
        // 1º passo: "encher ao máximo antes de abrir outra chapa"
        maxFillDone = true;
        for (const g of groups) {
          const res = packMaxFill(g.items, g.W, g.H, o);
          const sc = score(res);
          if (better(sc, g.bestScore)) { g.best = res; g.bestScore = sc; improved = true; }
        }
        stepCount++;
        if (improved) sinceImprove = 0; else sinceImprove++;
        return { improved, converged: false, det: detIdx, totalDet, step: stepCount };
      }
      if (detIdx < combos.length) {
        const c = combos[detIdx++];
        for (const g of groups) {
          const list = g.items.slice().sort(ORDERS[c.ok]);
          if (tryOn(g, list, c)) improved = true;
        }
      } else if (beamIdx < beamSchedule.length) {
        // fase BEAM: busca em árvore (uma passada por step)
        const job = beamSchedule[beamIdx++];
        for (const g of groups) {
          const list = g.items.slice().sort(ORDERS[job.ok]);
          let r = packBeam(g.items, g.W, g.H, o, { order: list, beamWidth: job.wgt });
          let sc = score(r);
          if (better(sc, g.bestScore)) { g.best = r; g.bestScore = sc; improved = true; }
          r = packMaxFillBeam(list, g.W, g.H, o, { beamWidth: job.wgt });
          sc = score(r);
          if (better(sc, g.bestScore)) { g.best = r; g.bestScore = sc; improved = true; }
        }
      } else {
        // reinícios aleatórios: embaralha a ordem + combo aleatório
        const c = { pref: pick(prefs), mode: pick(modes), place: pick(places), block: rand() < 0.5, gr: rand() < 0.5 };
        const ok = pick(orderKeys);
        for (const g of groups) {
          const base = g.items.slice().sort(ORDERS[ok]);
          const list = rand() < 0.75 ? shuffle(base) : base;
          if (tryOn(g, list, c)) improved = true;
        }
      }
      stepCount++;
      if (improved) sinceImprove = 0; else sinceImprove++;
      // convergiu: terminou as fases determinística + beam e estagnou por MUITOS
      // passos (busca longa; o usuário pode pausar a qualquer momento).
      const converged = detIdx >= combos.length && beamIdx >= beamSchedule.length && sinceImprove >= 3000;
      return { improved, converged, det: detIdx, totalDet, step: stepCount, beam: { idx: beamIdx, total: beamSchedule.length } };
    }

    function result() {
      const sheets = [], unplaced = [];
      groups.forEach(g => { if (!g.best) return; g.best.sheets.forEach(s => sheets.push(s)); g.best.unplaced.forEach(u => unplaced.push(u)); });
      const perMat = {};
      sheets.forEach(s => { (perMat[s.material] = perMat[s.material] || []).push(s); });
      Object.keys(perMat).forEach(k => perMat[k].forEach((s, i) => { s.index = i + 1; }));
      refineOffcuts(sheets); // decomposição ótima das sobras (só no resultado mostrado)
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

  global.Optimizer = { optimize, createSearch };
})(window);
