/* ============================================================
 * render.js — Desenho SVG das chapas do plano de corte.
 *  - Peças iguais recebem a mesma cor; peças vizinhas diferentes
 *    nunca recebem a mesma cor (coloração por adjacência).
 *  - Cada peça mostra a largura na lateral superior e o
 *    comprimento na lateral esquerda.
 *  - Cada chapa tem uma legenda (nome · medida · qtd) no topo.
 * ============================================================ */
(function (global) {
  'use strict';

  const PALETTE = ['#e9d8a6', '#f1c6a8', '#cfe3d4', '#d8d2e8', '#f4d6d6', '#cde3ef', '#e7e0c9', '#dbe8c9', '#f0cdb4', '#c9dfe7'];

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function fmt(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }
  function hslColor(i) { return `hsl(${(i * 53) % 360}, 52%, 78%)`; }

  // Duas peças são vizinhas se encostam (com folga de kerf) em um dos eixos.
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

  // Constrói o mapa nome→cor com coloração gulosa por adjacência (global).
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

  // SVG de uma chapa.
  function sheetSVG(sheet, colorMap, showLabels) {
    const W = sheet.W, H = sheet.H, pad = 4;
    const parts = [`<svg viewBox="0 0 ${W + pad * 2} ${H + pad * 2}" preserveAspectRatio="xMidYMid meet" role="img">`];
    parts.push(`<defs><pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0,0 L0,3" stroke="#000" stroke-width="0.15"/></pattern></defs>`);
    parts.push(`<rect x="${pad}" y="${pad}" width="${W}" height="${H}" fill="#fbfbf8" stroke="#888" stroke-width="0.7"/>`);

    sheet.placements.forEach(p => {
      const x = pad + p.x, y = pad + p.y;
      const fill = colorMap[p.name] || '#e0e0e0';
      parts.push(`<g>`);
      // peça + linha de corte (borda)
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="${fill}" stroke="#3a3a3a" stroke-width="0.6"/>`);
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="url(#grain)" opacity="0.22"/>`);

      const small = Math.min(p.w, p.h);
      const fsName = Math.max(4, Math.min(p.w, p.h) * 0.20);
      const fsDim = Math.max(3.2, small * 0.14);
      const cx = x + p.w / 2, cy = y + p.h / 2;
      if (showLabels && small > 9) {
        // nome no centro
        parts.push(`<text x="${cx}" y="${cy}" font-size="${fsName}" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-weight="600">${esc(p.name)}</text>`);
        // largura (p.w) na lateral SUPERIOR; comprimento (p.h) na lateral ESQUERDA
        parts.push(`<text x="${cx}" y="${y + fsDim + 0.5}" font-size="${fsDim}" text-anchor="middle" fill="#555">${fmt(p.w)}</text>`);
        parts.push(`<text x="${x + fsDim + 0.5}" y="${cy}" font-size="${fsDim}" text-anchor="middle" dominant-baseline="central" fill="#555" transform="rotate(-90 ${x + fsDim + 0.5} ${cy})">${fmt(p.h)}</text>`);
      } else if (showLabels && small > 4) {
        parts.push(`<text x="${cx}" y="${cy}" font-size="${fsName}" text-anchor="middle" dominant-baseline="central" fill="#333">${esc(p.name)}</text>`);
      }
      parts.push(`</g>`);
    });

    parts.push(`</svg>`);
    return parts.join('');
  }

  // Legenda multi-coluna no topo da chapa.
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
