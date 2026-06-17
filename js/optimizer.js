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

  // Decomposição guilhotinada das SOBRAS (estilo "apara a ponta primeiro").
  // Em cada região, procura o corte de lado-a-lado (vão livre, sem peça
  // atravessando) que destaca a MAIOR área vazia — isto é, prefere arrancar
  // uma tira inteira da ponta/lateral da chapa antes de fatiar entre peças.
  // Resultado: quando as peças têm comprimentos parecidos, a ponta vira UM
  // retalho único de largura cheia, em vez de várias pontinhas por tira.
  function guillotineOffcuts(sheet) {
    const out = [];
    function decompose(x, y, w, h, items) {
      if (w <= EPS || h <= EPS) return;
      if (!items.length) { out.push({ x, y, w, h }); return; }
      const cands = [];
      // cortes verticais possíveis (nenhuma peça atravessa a linha X)
      const xs = Array.from(new Set([].concat(...items.map(p => [p.x, p.x + p.w])))).filter(X => X > x + EPS && X < x + w - EPS);
      xs.forEach(X => {
        if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS)) {
          const left = items.filter(p => p.x + p.w <= X + EPS);
          const right = items.filter(p => p.x >= X - EPS);
          cands.push({ a: { x, y, w: X - x, h, items: left }, b: { x: X, y, w: x + w - X, h, items: right } });
        }
      });
      // cortes horizontais possíveis (nenhuma peça atravessa a linha Y)
      const ys = Array.from(new Set([].concat(...items.map(p => [p.y, p.y + p.h])))).filter(Y => Y > y + EPS && Y < y + h - EPS);
      ys.forEach(Y => {
        if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS)) {
          const top = items.filter(p => p.y + p.h <= Y + EPS);
          const bot = items.filter(p => p.y >= Y - EPS);
          cands.push({ a: { x, y, w, h: Y - y, items: top }, b: { x, y: Y, w, h: y + h - Y, items: bot } });
        }
      });
      if (!cands.length) return; // peça preenche a região (sem retalho limpo)
      // prioriza o corte que destaca a maior ÁREA VAZIA (tira da ponta/lateral)
      const emptyArea = c => [c.a, c.b].reduce((s, r) => s + (r.items.length ? 0 : r.w * r.h), 0);
      const biggestEmpty = c => [c.a, c.b].reduce((m, r) => Math.max(m, r.items.length ? 0 : r.w * r.h), 0);
      cands.sort((c1, c2) => (emptyArea(c2) - emptyArea(c1)) || (biggestEmpty(c2) - biggestEmpty(c1)));
      const c = cands[0];
      decompose(c.a.x, c.a.y, c.a.w, c.a.h, c.a.items);
      decompose(c.b.x, c.b.y, c.b.w, c.b.h, c.b.items);
    }
    if (!sheet.placements.length) return [{ x: 0, y: 0, w: sheet.W, h: sheet.H }];
    decompose(0, 0, sheet.W, sheet.H, sheet.placements.slice());
    mergeFree(out); // funde retalhos colineares adjacentes em peças maiores
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

  function packOnce(list, W, H, o, splitPref, fitMode, placeMode, blockMode) {
    let sheetIndex = 0;
    const sheets = [];
    const unplaced = [];
    const done = new Array(list.length).fill(false);
    for (let idx = 0; idx < list.length; idx++) {
      if (done[idx]) continue;
      const it = list[idx];
      done[idx] = true;
      // Direção do veio fixa a orientação da peça:
      //  '' (sem veio) → rotação livre
      //  'v' (↕) → mantém como exportada (largura × comprimento)
      //  'h' (↔) → gira 90° (comprimento × largura)
      let pw = it.w, ph = it.h, allowRotate;
      if (o.considerGrain && it.grain) {
        allowRotate = false;
        if (it.grain === 'h') { pw = it.h; ph = it.w; }
      } else {
        allowRotate = o.allowRotate;
      }
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
      const fw = fit.rotated ? ph : pw, fh = fit.rotated ? pw : ph;
      const r = target.free[fit.rectIdx];
      if (blockMode) {
        // Bloco homogêneo: preenche o retângulo com o máximo de peças IGUAIS
        // (mesmo nome+medida+veio) numa grade cols×linhas — padrão limpo de
        // seccionadora, menos cortes/regulagens.
        const k = o.kerf;
        const cols = Math.max(1, Math.floor((r.w + k) / (fw + k)));
        const rows = Math.max(1, Math.floor((r.h + k) / (fh + k)));
        const cap = cols * rows;
        const group = [];
        const mySig = sig(it);
        for (let j = idx; j < list.length && group.length < cap; j++) {
          if (!done[j] && sig(list[j]) === mySig) group.push(j);
        }
        const n = group.length + 1; // +1 = a peça atual (idx, já marcada)
        const ids = [idx].concat(group.slice(0, n - 1));
        const total = Math.min(ids.length, cap);
        let placed = 0;
        for (let rr = 0; rr < rows && placed < total; rr++) {
          for (let cc = 0; cc < cols && placed < total; cc++) {
            target.placements.push({ x: r.x + cc * (fw + k), y: r.y + rr * (fh + k), w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
            if (placed > 0) done[ids[placed]] = true; // idx (placed 0) já marcado
            placed++;
          }
        }
        const usedCols = Math.min(cols, total);
        const usedRows = Math.ceil(total / cols);
        const blockW = usedCols * fw + (usedCols - 1) * k;
        const blockH = usedRows * fh + (usedRows - 1) * k;
        splitRect(target, fit.rectIdx, blockW, blockH, k, splitPref);
        target.cuts += (usedRows - 1) + usedRows * (usedCols - 1); // cortes internos do bloco
      } else {
        target.placements.push({ x: r.x, y: r.y, w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
        splitRect(target, fit.rectIdx, fw, fh, o.kerf, splitPref);
      }
      mergeFree(target.free); // consolida a lista livre (estilo GuillotineBinPack)
    }
    // sobras (apara a ponta primeiro) e nº real de cortes guilhotinados
    sheets.forEach(s => { s.free = guillotineOffcuts(s); s.cuts = countGuillotineCuts(s.W, s.H, s.placements); });
    return { sheets, unplaced };
  }

  // Preenche UMA única chapa o máximo possível: coloca o que couber e devolve
  // o resto para a próxima chapa (não abre chapa nova). Base do "encher antes
  // de abrir outra".
  function fillOneSheet(list, W, H, o, splitPref, fitMode, blockMode) {
    const sheet = newSheet(list.length ? list[0].__mat : '', W, H, 1);
    const done = new Array(list.length).fill(false);
    for (let idx = 0; idx < list.length; idx++) {
      if (done[idx]) continue;
      const it = list[idx];
      let pw = it.w, ph = it.h, allowRotate;
      if (o.considerGrain && it.grain) { allowRotate = false; if (it.grain === 'h') { pw = it.h; ph = it.w; } }
      else allowRotate = o.allowRotate;
      const fit = findFit(sheet, pw, ph, allowRotate, fitMode);
      if (!fit) continue; // não cabe nesta chapa → fica para a próxima
      done[idx] = true;
      const fw = fit.rotated ? ph : pw, fh = fit.rotated ? pw : ph;
      const r = sheet.free[fit.rectIdx];
      if (blockMode) {
        const k = o.kerf;
        const cols = Math.max(1, Math.floor((r.w + k) / (fw + k)));
        const rows = Math.max(1, Math.floor((r.h + k) / (fh + k)));
        const cap = cols * rows, mySig = sig(it), group = [];
        for (let j = idx; j < list.length && group.length < cap - 1; j++) if (!done[j] && sig(list[j]) === mySig) group.push(j);
        const ids = [idx].concat(group);
        const total = Math.min(ids.length, cap);
        let placed = 0;
        for (let rr = 0; rr < rows && placed < total; rr++) for (let cc = 0; cc < cols && placed < total; cc++) {
          sheet.placements.push({ x: r.x + cc * (fw + k), y: r.y + rr * (fh + k), w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
          if (placed > 0) done[ids[placed]] = true;
          placed++;
        }
        const usedCols = Math.min(cols, total), usedRows = Math.ceil(total / cols);
        splitRect(sheet, fit.rectIdx, usedCols * fw + (usedCols - 1) * k, usedRows * fh + (usedRows - 1) * k, k, splitPref);
      } else {
        sheet.placements.push({ x: r.x, y: r.y, w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
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
        for (const pref of ['maxrect', 'wide', 'tall']) for (const mode of ['bssf', 'tl', 'baf']) for (const block of [false, true]) {
          const r = fillOneSheet(sorted, W, H, o, pref, mode, block);
          const area = r.placed.reduce((a, p) => a + p.w * p.h, 0);
          if (!best || area > best.area + 1e-6) best = { area, sheet: r.sheet, rest: r.rest };
        }
      }
      if (!best || !best.placed && !best.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
      if (!best.sheet.placements.length) { unplaced.push.apply(unplaced, remaining); break; }
      best.sheet.index = sheets.length + 1;
      best.sheet.free = guillotineOffcuts(best.sheet);
      best.sheet.cuts = countGuillotineCuts(best.sheet.W, best.sheet.H, best.sheet.placements);
      sheets.push(best.sheet);
      remaining = best.rest;
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
      // fração ocupada por chapa, da mais cheia para a mais vazia
      fills: res.sheets.map(s => s.placements.reduce((a, p) => a + p.w * p.h, 0) / (s.W * s.H)).sort((a, b) => b - a),
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

  function packGroup(items, W, H, o, matName) {
    items.forEach(it => it.__mat = matName);
    let best = null, bestScore = null;
    const consider = res => { const sc = score(res); if (better(sc, bestScore)) { best = res; bestScore = sc; } };
    for (const key of Object.keys(ORDERS)) {
      const list = items.slice().sort(ORDERS[key]);
      for (const pref of ['maxrect', 'wide', 'tall']) {
        for (const mode of ['bssf', 'tl', 'baf']) {
          for (const place of ['first', 'best']) {
            for (const block of [false, true]) consider(packOnce(list, W, H, o, pref, mode, place, block));
          }
        }
      }
    }
    consider(packMaxFill(items, W, H, o)); // "encher ao máximo antes de abrir outra"
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

    const byMaterial = {};
    sheets.forEach(s => {
      const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
      m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
      s.placements.forEach(p => { m.pieces++; m.usedArea += p.w * p.h; });
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
      return { items: groupsMap[material], W: stock.width, H: stock.length, best: null, bestScore: null };
    });

    const orderKeys = Object.keys(ORDERS);
    const prefs = ['maxrect', 'wide', 'tall'], modes = ['bssf', 'tl', 'baf'], places = ['first', 'best'];
    const combos = [];
    for (const ok of orderKeys) for (const pref of prefs) for (const mode of modes) for (const place of places) for (const block of [false, true]) combos.push({ ok, pref, mode, place, block });
    const totalDet = combos.length;

    let rng = 2463534242;
    function rand() { rng ^= rng << 13; rng ^= rng >>> 17; rng ^= rng << 5; rng >>>= 0; return rng / 4294967296; }
    function shuffle(arr) { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
    const pick = a => a[Math.floor(rand() * a.length)];

    let detIdx = 0, stepCount = 0, sinceImprove = 0, maxFillDone = false;

    function tryOn(g, list, c) {
      const res = packOnce(list, g.W, g.H, o, c.pref, c.mode, c.place, c.block);
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
      } else {
        // reinícios aleatórios: embaralha a ordem + combo aleatório
        const c = { pref: pick(prefs), mode: pick(modes), place: pick(places), block: rand() < 0.5 };
        const ok = pick(orderKeys);
        for (const g of groups) {
          const base = g.items.slice().sort(ORDERS[ok]);
          const list = rand() < 0.75 ? shuffle(base) : base;
          if (tryOn(g, list, c)) improved = true;
        }
      }
      stepCount++;
      if (improved) sinceImprove = 0; else sinceImprove++;
      // convergiu: terminou a fase determinística e estagnou por muitos passos
      const converged = detIdx >= combos.length && sinceImprove >= 800;
      return { improved, converged, det: detIdx, totalDet, step: stepCount };
    }

    function result() {
      const sheets = [], unplaced = [];
      groups.forEach(g => { if (!g.best) return; g.best.sheets.forEach(s => sheets.push(s)); g.best.unplaced.forEach(u => unplaced.push(u)); });
      const perMat = {};
      sheets.forEach(s => { (perMat[s.material] = perMat[s.material] || []).push(s); });
      Object.keys(perMat).forEach(k => perMat[k].forEach((s, i) => { s.index = i + 1; }));
      const byMaterial = {};
      sheets.forEach(s => {
        const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
        m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
        s.placements.forEach(p => { m.pieces++; m.usedArea += p.w * p.h; });
      });
      return { sheets, unplaced, byMaterial };
    }

    return { step, result, totalDet };
  }

  global.Optimizer = { optimize, createSearch };
})(window);
