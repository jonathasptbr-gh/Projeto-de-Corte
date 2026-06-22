/* ============================================================
 * render.js — Desenho SVG das chapas do plano de corte.
 *  - Peças iguais → mesma cor; vizinhas diferentes → cores distintas.
 *  - Cada peça mostra largura (lateral superior) e comprimento (esquerda),
 *    com fonte reduzida quando a peça é pequena (use zoom para ler).
 *  - Linhas de corte guilhotinado (seccionado), de lado a lado da seção.
 *  - Réguas externas (topo e esquerda) com a medida de cada corte paralelo.
 *  - Legenda multi-coluna no topo da chapa.
 * ============================================================ */
(function (global) {
  'use strict';

  const PALETTE = ['#e9d8a6', '#f1c6a8', '#cfe3d4', '#d8d2e8', '#f4d6d6', '#cde3ef', '#e7e0c9', '#dbe8c9', '#f0cdb4', '#c9dfe7'];
  const EPS = 0.05;

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function fmt(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }
  function hslColor(i) { return `hsl(${(i * 53) % 360}, 52%, 78%)`; }

  function touching(a, b) {
    const gap = 3;
    const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const overlapY = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    const vGap = Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h));
    const hGap = Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w));
    if (overlapX > 0.5 && vGap >= -0.5 && vGap <= gap) return true;
    if (overlapY > 0.5 && hGap >= -0.5 && hGap <= gap) return true;
    return false;
  }

  function buildColorMap(result) {
    const names = [], adj = {};
    const ensure = n => { if (!(n in adj)) { adj[n] = new Set(); names.push(n); } };
    result.sheets.forEach(sheet => {
      const ps = sheet.placements;
      ps.forEach(p => ensure(p.name));
      for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
        if (ps[i].name === ps[j].name) continue;
        if (touching(ps[i], ps[j])) { adj[ps[i].name].add(ps[j].name); adj[ps[j].name].add(ps[i].name); }
      }
    });
    const order = names.slice().sort((x, y) => adj[y].size - adj[x].size);
    const colorOf = {};
    order.forEach((n, idx) => {
      const used = new Set();
      adj[n].forEach(m => { if (colorOf[m]) used.add(colorOf[m]); });
      let c = null;
      for (const col of PALETTE) if (!used.has(col)) { c = col; break; }
      if (!c) { let k = idx; while (used.has(hslColor(k))) k++; c = hslColor(k); }
      colorOf[n] = c;
    });
    return colorOf;
  }

  // Reconstrói a sequência ÓTIMA de cortes guilhotinados a partir das peças
  // posicionadas. Testa V e H em cada nível, filtra cortes degenerados (lado
  // vazio) e usa memoização para garantir o mínimo de cortes. Desempate:
  // prefere H (faixas inteiras) sobre V — remove sobra do grupo antes de
  // separar peças individuais. Retorna [{orient:'v'|'h', pos, a, b}].
  function reconstructCuts(W, H, placements) {
    const cuts = [];
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
    function rec(x, y, w, h, items) {
      if (items.length <= 1) return;
      const target = minCuts(items);
      const cands = [];
      Array.from(new Set(items.map(p => p.x + p.w)))
        .filter(X => X > x + EPS && X < x + w - EPS).sort((a, b) => a - b)
        .forEach(X => {
          const L = items.filter(p => p.x + p.w <= X + EPS), R = items.filter(p => p.x >= X - EPS);
          if (L.length && R.length && items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS) &&
              1 + minCuts(L) + minCuts(R) === target)
            cands.push({ orient: 'v', pos: X, sA: L, sB: R });
        });
      Array.from(new Set(items.map(p => p.y + p.h)))
        .filter(Y => Y > y + EPS && Y < y + h - EPS).sort((a, b) => a - b)
        .forEach(Y => {
          const T = items.filter(p => p.y + p.h <= Y + EPS), B = items.filter(p => p.y >= Y - EPS);
          if (T.length && B.length && items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS) &&
              1 + minCuts(T) + minCuts(B) === target)
            cands.push({ orient: 'h', pos: Y, sA: T, sB: B });
        });
      if (!cands.length) return;
      // Desempate: H antes de V (faixas agrupam peças antes de separar individualmente)
      cands.sort((a, b) => (a.orient === 'h' ? 0 : 1) - (b.orient === 'h' ? 0 : 1));
      const c = cands[0];
      if (c.orient === 'v') {
        cuts.push({ orient: 'v', pos: c.pos, a: y, b: y + h });
        rec(x, y, c.pos - x, h, c.sA); rec(c.pos, y, x + w - c.pos, h, c.sB);
      } else {
        cuts.push({ orient: 'h', pos: c.pos, a: x, b: x + w });
        rec(x, y, w, c.pos - y, c.sA); rec(x, c.pos, w, y + h - c.pos, c.sB);
      }
    }
    rec(0, 0, W, H, placements.slice());
    return cuts;
  }

  function sheetSVG(sheet, colorMap, showLabels) {
    const W = sheet.W, H = sheet.H;
    const mT = 16, mL = 16, mR = 5, mB = 5;        // margens para as réguas
    const ox = mL, oy = mT;                          // origem da chapa
    const parts = [`<svg viewBox="0 0 ${W + mL + mR} ${H + mT + mB}" preserveAspectRatio="xMidYMid meet" role="img">`];
    parts.push(`<defs><pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0,0 L0,3" stroke="#000" stroke-width="0.15"/></pattern></defs>`);
    parts.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#fbfbf8" stroke="#888" stroke-width="0.7"/>`);

    // peças + medidas
    sheet.placements.forEach(p => {
      const x = ox + p.x, y = oy + p.y;
      const fill = colorMap[p.name] || '#e0e0e0';
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="${fill}" stroke="#3a3a3a" stroke-width="0.5"/>`);
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="url(#grain)" opacity="0.20"/>`);
      if (!showLabels) return;
      const dw = p.realW || p.w, dh = p.realH || p.h; // medida REAL no rótulo (slot pode ser maior)
      const small = Math.min(p.w, p.h);
      const cx = x + p.w / 2, cy = y + p.h / 2;
      // fonte proporcional à MENOR medida da peça; mínimo para peças pequenas
      const fsDim = Math.max(3.2, Math.min(small * 0.2, 7));
      parts.push(`<text x="${cx}" y="${y + fsDim * 1.05}" font-size="${fsDim}" text-anchor="middle" fill="#555" class="lbl-dim">${fmt(dw)}</text>`);
      parts.push(`<text x="${x + fsDim * 1.05}" y="${cy}" font-size="${fsDim}" text-anchor="middle" dominant-baseline="central" fill="#555" class="lbl-dim" transform="rotate(-90 ${x + fsDim * 1.05} ${cy})">${fmt(dh)}</text>`);
      const fsName = Math.max(3.2, Math.min(small * 0.2, 8));
      parts.push(`<text x="${cx}" y="${cy}" font-size="${fsName}" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-weight="600" class="lbl-name">${esc(p.name)}</text>`);
    });

    // sobras reaproveitáveis — sem preenchimento; medidas nas BORDAS (igual às peças)
    (sheet.free || []).forEach(r => {
      if (Math.min(r.w, r.h) < 3) return;
      const x = ox + r.x, y = oy + r.y;
      parts.push(`<rect x="${x}" y="${y}" width="${r.w}" height="${r.h}" fill="none" stroke="#9aa39d" stroke-width="0.6"/>`);
      const small = Math.min(r.w, r.h);
      if (small >= 8) {
        const fs = Math.max(1.6, Math.min(small * 0.18, 7));
        const cx = x + r.w / 2, cy = y + r.h / 2;
        // largura na borda superior; comprimento na borda esquerda
        parts.push(`<text x="${cx}" y="${y + fs * 1.05}" font-size="${fs}" text-anchor="middle" fill="#8a938d">${fmt(r.w)}</text>`);
        parts.push(`<text x="${x + fs * 1.05}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#8a938d" transform="rotate(-90 ${x + fs * 1.05} ${cy})">${fmt(r.h)}</text>`);
      }
    });

    // (As linhas de corte internas foram removidas a pedido — o desenho mostra
    // só as peças, as sobras e as réguas externas, sem riscar os retalhos.)
    const cuts = reconstructCuts(W, H, sheet.placements);

    // réguas externas: cortes que atravessam a chapa inteira (1º estágio)
    const rfs = Math.max(4, Math.min(W, H) * 0.024);
    const vFull = cuts.filter(c => c.orient === 'v' && c.a <= EPS && c.b >= H - EPS).map(c => c.pos);
    const hFull = cuts.filter(c => c.orient === 'h' && c.a <= EPS && c.b >= W - EPS).map(c => c.pos);
    const colsX = Array.from(new Set([0, ...vFull, W])).sort((a, b) => a - b);
    const rowsY = Array.from(new Set([0, ...hFull, H])).sort((a, b) => a - b);
    const ruler = '#cc2200'; // vermelho para diferenciar cortes guilhotinados dos contornos
    // topo (medidas paralelas dos cortes verticais)
    const ty = oy - 5.5;
    parts.push(`<line x1="${ox}" y1="${ty}" x2="${ox + W}" y2="${ty}" stroke="${ruler}" stroke-width="0.4"/>`);
    colsX.forEach(X => parts.push(`<line x1="${ox + X}" y1="${ty}" x2="${ox + X}" y2="${oy}" stroke="${ruler}" stroke-width="0.4"/>`));
    for (let i = 0; i < colsX.length - 1; i++) {
      const mid = ox + (colsX[i] + colsX[i + 1]) / 2;
      parts.push(`<text x="${mid}" y="${ty - 1.5}" font-size="${rfs}" text-anchor="middle" fill="${ruler}">${fmt(colsX[i + 1] - colsX[i])}</text>`);
    }
    // esquerda (medidas paralelas dos cortes horizontais)
    const tx = ox - 5.5;
    parts.push(`<line x1="${tx}" y1="${oy}" x2="${tx}" y2="${oy + H}" stroke="${ruler}" stroke-width="0.4"/>`);
    rowsY.forEach(Y => parts.push(`<line x1="${tx}" y1="${oy + Y}" x2="${ox}" y2="${oy + Y}" stroke="${ruler}" stroke-width="0.4"/>`));
    for (let i = 0; i < rowsY.length - 1; i++) {
      const mid = oy + (rowsY[i] + rowsY[i + 1]) / 2;
      parts.push(`<text x="${tx - 1.5}" y="${mid}" font-size="${rfs}" text-anchor="middle" dominant-baseline="central" fill="${ruler}" transform="rotate(-90 ${tx - 1.5} ${mid})">${fmt(rowsY[i + 1] - rowsY[i])}</text>`);
    }

    parts.push(`</svg>`);
    return parts.join('');
  }

  function sheetLegend(sheet, colorMap) {
    const groups = {};
    sheet.placements.forEach(p => {
      const dw = p.realW || p.w, dh = p.realH || p.h;
      const k = p.name + '|' + fmt(dw) + 'x' + fmt(dh);
      if (!groups[k]) groups[k] = { name: p.name, w: dw, h: dh, qty: 0 };
      groups[k].qty++;
    });
    const items = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name, 'pt') || (b.w * b.h - a.w * a.h));
    let html = '<div class="sheet-legend">';
    items.forEach(g => {
      const col = colorMap[g.name] || '#e0e0e0';
      html += `<div class="li"><span class="sw" style="background:${col}"></span>` +
        `<span class="lt">${esc(g.name)} · ${fmt(g.w)}×${fmt(g.h)} · ${g.qty}×</span></div>`;
    });
    return html + '</div>';
  }

  function renderSheets(container, result, opts) {
    container.innerHTML = '';
    const colorMap = buildColorMap(result);
    // conta chapas por tipo (material+nome) → nº só aparece se houver mais de uma
    const typeCount = {};
    result.sheets.forEach(s => { const k = s.material + '|' + (s.stockName || ''); typeCount[k] = (typeCount[k] || 0) + 1; });
    result.sheets.forEach((sheet, idx) => {
      const used = sheet.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0);
      const eff = sheet.W * sheet.H ? (used / (sheet.W * sheet.H) * 100) : 0;
      const nm = sheet.stockName || 'Chapa';
      const suffix = typeCount[sheet.material + '|' + (sheet.stockName || '')] > 1 ? ' ' + sheet.index : '';
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.id = 'sheet-card-' + idx;
      card.innerHTML =
        `<h3>${esc(sheet.material)} — ${esc(nm)}${suffix}</h3>` +
        `<div class="sub">${fmt(sheet.W)} × ${fmt(sheet.H)} · ${sheet.placements.length} peças · aproveit. ${eff.toFixed(1)}%</div>` +
        sheetLegend(sheet, colorMap) +
        sheetSVG(sheet, colorMap, opts.showLabels);
      container.appendChild(card);
    });
    // As peças que não couberam são listadas no TOPO do plano, em tabela
    // editável (montada no app.js — renderUnplaced), não mais aqui no fim.
  }

  global.Render = { renderSheets };
})(window);
