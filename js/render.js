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

  // Reconstrói os cortes guilhotinados a partir das peças posicionadas.
  // Retorna [{orient:'v'|'h', pos, a, b}] onde a..b é a extensão do corte.
  function reconstructCuts(W, H, placements) {
    const cuts = [];
    function rec(x, y, w, h, items) {
      if (items.length <= 1) return;
      // tenta corte vertical (linha em X sem peça atravessando)
      let chosen = null;
      const xs = Array.from(new Set(items.map(p => p.x + p.w))).filter(X => X > x + EPS && X < x + w - EPS).sort((a, b) => a - b);
      for (const X of xs) {
        if (items.every(p => p.x + p.w <= X + EPS || p.x >= X - EPS)) { chosen = { orient: 'v', pos: X }; break; }
      }
      if (!chosen) {
        const ys = Array.from(new Set(items.map(p => p.y + p.h))).filter(Y => Y > y + EPS && Y < y + h - EPS).sort((a, b) => a - b);
        for (const Y of ys) {
          if (items.every(p => p.y + p.h <= Y + EPS || p.y >= Y - EPS)) { chosen = { orient: 'h', pos: Y }; break; }
        }
      }
      if (!chosen) return;
      if (chosen.orient === 'v') {
        const X = chosen.pos;
        cuts.push({ orient: 'v', pos: X, a: y, b: y + h });
        rec(x, y, X - x, h, items.filter(p => p.x + p.w <= X + EPS));
        rec(X, y, x + w - X, h, items.filter(p => p.x >= X - EPS));
      } else {
        const Y = chosen.pos;
        cuts.push({ orient: 'h', pos: Y, a: x, b: x + w });
        rec(x, y, w, Y - y, items.filter(p => p.y + p.h <= Y + EPS));
        rec(x, Y, w, h - (Y - y), items.filter(p => p.y >= Y - EPS));
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
    parts.push(`<defs><pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0,0 L0,3" stroke="#000" stroke-width="0.15"/></pattern>` +
      `<pattern id="off" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="#2f9e44" stroke-width="1.1"/></pattern></defs>`);
    parts.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#fbfbf8" stroke="#888" stroke-width="0.7"/>`);

    // peças + medidas
    sheet.placements.forEach(p => {
      const x = ox + p.x, y = oy + p.y;
      const fill = colorMap[p.name] || '#e0e0e0';
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="${fill}" stroke="#3a3a3a" stroke-width="0.5"/>`);
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="url(#grain)" opacity="0.20"/>`);
      if (!showLabels) return;
      const small = Math.min(p.w, p.h);
      const cx = x + p.w / 2, cy = y + p.h / 2;
      // fonte proporcional à MENOR medida da peça, com piso (mín) consistente
      const fsDim = Math.max(2.2, Math.min(small * 0.22, 7));
      // largura na lateral superior; comprimento na lateral esquerda
      parts.push(`<text x="${cx}" y="${y + fsDim * 1.05}" font-size="${fsDim}" text-anchor="middle" fill="#555">${fmt(p.w)}</text>`);
      parts.push(`<text x="${x + fsDim * 1.05}" y="${cy}" font-size="${fsDim}" text-anchor="middle" dominant-baseline="central" fill="#555" transform="rotate(-90 ${x + fsDim * 1.05} ${cy})">${fmt(p.h)}</text>`);
      // nome no centro
      const fsName = Math.max(2.6, Math.min(small * 0.26, 8));
      parts.push(`<text x="${cx}" y="${cy}" font-size="${fsName}" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-weight="600">${esc(p.name)}</text>`);
    });

    // sobras reaproveitáveis (modelo de blocos) — hachura verde + medida
    (sheet.free || []).forEach(r => {
      if (Math.min(r.w, r.h) < 3) return;
      const x = ox + r.x, y = oy + r.y;
      parts.push(`<rect x="${x}" y="${y}" width="${r.w}" height="${r.h}" fill="url(#off)" opacity="0.55"/>`);
      parts.push(`<rect x="${x}" y="${y}" width="${r.w}" height="${r.h}" fill="none" stroke="#2f9e44" stroke-width="0.6" stroke-dasharray="3 2"/>`);
      const small = Math.min(r.w, r.h);
      if (small >= 8) {
        const fs = Math.max(2.4, Math.min(small * 0.16, 7));
        const cx = x + r.w / 2, cy = y + r.h / 2;
        const vert = r.h > r.w;
        const tr = vert ? `transform="rotate(-90 ${cx} ${cy})"` : '';
        parts.push(`<text x="${cx}" y="${cy}" ${tr} font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#1e6b2e" font-weight="700">sobra ${fmt(r.w)}×${fmt(r.h)}</text>`);
      }
    });

    // cortes guilhotinados
    const cuts = reconstructCuts(W, H, sheet.placements);
    cuts.forEach(c => {
      if (c.orient === 'v') parts.push(`<line x1="${ox + c.pos}" y1="${oy + c.a}" x2="${ox + c.pos}" y2="${oy + c.b}" stroke="#d11" stroke-width="0.6"/>`);
      else parts.push(`<line x1="${ox + c.a}" y1="${oy + c.pos}" x2="${ox + c.b}" y2="${oy + c.pos}" stroke="#d11" stroke-width="0.6"/>`);
    });

    // réguas externas: cortes que atravessam a chapa inteira (1º estágio)
    const rfs = Math.max(4, Math.min(W, H) * 0.024);
    const vFull = cuts.filter(c => c.orient === 'v' && c.a <= EPS && c.b >= H - EPS).map(c => c.pos);
    const hFull = cuts.filter(c => c.orient === 'h' && c.a <= EPS && c.b >= W - EPS).map(c => c.pos);
    const colsX = Array.from(new Set([0, ...vFull, W])).sort((a, b) => a - b);
    const rowsY = Array.from(new Set([0, ...hFull, H])).sort((a, b) => a - b);
    const ruler = '#444';
    // topo (medidas paralelas dos cortes verticais)
    const ty = oy - 5.5;
    parts.push(`<line x1="${ox}" y1="${ty}" x2="${ox + W}" y2="${ty}" stroke="${ruler}" stroke-width="0.4"/>`);
    colsX.forEach(X => parts.push(`<line x1="${ox + X}" y1="${ty}" x2="${ox + X}" y2="${oy}" stroke="${ruler}" stroke-width="0.4" stroke-dasharray="1 1"/>`));
    for (let i = 0; i < colsX.length - 1; i++) {
      const mid = ox + (colsX[i] + colsX[i + 1]) / 2;
      parts.push(`<text x="${mid}" y="${ty - 1.5}" font-size="${rfs}" text-anchor="middle" fill="${ruler}">${fmt(colsX[i + 1] - colsX[i])}</text>`);
    }
    // esquerda (medidas paralelas dos cortes horizontais)
    const tx = ox - 5.5;
    parts.push(`<line x1="${tx}" y1="${oy}" x2="${tx}" y2="${oy + H}" stroke="${ruler}" stroke-width="0.4"/>`);
    rowsY.forEach(Y => parts.push(`<line x1="${tx}" y1="${oy + Y}" x2="${ox}" y2="${oy + Y}" stroke="${ruler}" stroke-width="0.4" stroke-dasharray="1 1"/>`));
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
      const k = p.name + '|' + fmt(p.w) + 'x' + fmt(p.h);
      if (!groups[k]) groups[k] = { name: p.name, w: p.w, h: p.h, qty: 0 };
      groups[k].qty++;
    });
    const items = Object.values(groups).sort((a, b) => a.name.localeCompare(b.name, 'pt') || (b.w * b.h - a.w * a.h));
    let html = '<div class="sheet-legend">';
    items.forEach(g => {
      const col = colorMap[g.name] || '#e0e0e0';
      html += `<div class="li"><span class="sw" style="background:${col}"></span>` +
        `<span class="lt">${esc(g.name)} · ${fmt(g.w)}×${fmt(g.h)} · ${g.qty}×</span></div>`;
    });
    // sobras úteis
    (sheet.free || []).filter(r => Math.min(r.w, r.h) >= 5).sort((a, b) => b.w * b.h - a.w * a.h).forEach(r => {
      html += `<div class="li"><span class="sw" style="background:#cdeccd;border-color:#2f9e44"></span>` +
        `<span class="lt"><b>Sobra</b> ${fmt(r.w)}×${fmt(r.h)} (${(r.w * r.h / 1e4).toFixed(2)} m²)</span></div>`;
    });
    return html + '</div>';
  }

  function renderSheets(container, result, opts) {
    container.innerHTML = '';
    const colorMap = buildColorMap(result);
    result.sheets.forEach(sheet => {
      const used = sheet.placements.reduce((a, p) => a + p.w * p.h, 0);
      const eff = sheet.W * sheet.H ? (used / (sheet.W * sheet.H) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.innerHTML =
        `<h3>${esc(sheet.material)} — Chapa ${sheet.index}</h3>` +
        `<div class="sub">${fmt(sheet.W)} × ${fmt(sheet.H)} · ${sheet.placements.length} peças · aproveit. ${eff.toFixed(1)}%</div>` +
        sheetLegend(sheet, colorMap) +
        sheetSVG(sheet, colorMap, opts.showLabels);
      container.appendChild(card);
    });

    if (result.unplaced && result.unplaced.length) {
      const warn = document.createElement('div');
      warn.className = 'sheet-card';
      warn.style.borderColor = '#c0392b';
      warn.innerHTML = `<h3 style="color:#c0392b">⚠ ${result.unplaced.length} peça(s) não couberam</h3>` +
        `<div class="sub">Verifique o tamanho da chapa (stock) ou a direção do grão.</div>`;
      container.appendChild(warn);
    }
  }

  global.Render = { renderSheets };
})(window);
