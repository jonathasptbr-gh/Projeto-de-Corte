/* ============================================================
 * render.js — Desenho SVG das chapas do plano de corte.
 *  - Peças iguais → mesma cor; vizinhas diferentes → cores distintas.
 *  - Cada peça mostra largura (lateral superior) e comprimento (esquerda),
 *    com fonte reduzida quando a peça é pequena (use zoom para ler).
 *  - Réguas externas (topo e esquerda) marcando onde a guilhotina passa; a
 *    medida de cada tira é a da MAIOR peça que sai dela (medida real, sem kerf).
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

  function sheetSVG(sheet, colorMap, showLabels, idx) {
    const rawW = sheet.W, rawH = sheet.H;
    const stockGrain = sheet.stockGrain || '';

    // Portrait: rotaciona 90° CW quando a chapa é mais larga que alta.
    // 90° CW em SVG (y-down): (x,y) → (rawH-y, x) no espaço de display.
    const rot = rawW > rawH;
    const W = rot ? rawH : rawW;  // largura de display
    const H = rot ? rawW : rawH;  // altura de display

    const mT = 16, mL = 16, mR = 5, mB = 5;
    const ox = mL, oy = mT;

    // Transforma rect do espaço original para SVG display (com offset de margem).
    // Para rot: rect(x,y,w,h) → (ox+rawH-y-h, oy+x, h, w)
    function mapRect(x, y, w, h) {
      if (!rot) return { x: ox + x, y: oy + y, w, h };
      return { x: ox + rawH - y - h, y: oy + x, w: h, h: w };
    }

    // Após 90° CW, veio 'v' (vertical na chapa) aparece horizontal no display.
    const displayGrain = !rot ? stockGrain
      : stockGrain === 'v' ? 'h' : stockGrain === 'h' ? 'v' : '';

    const gId = 'gp' + (idx || 0);
    const parts = [`<svg viewBox="0 0 ${W + mL + mR} ${H + mT + mB}" preserveAspectRatio="xMidYMid meet" role="img">`];

    // Padrão de veio no fundo da chapa — apenas se o estoque tiver direção configurada.
    if (displayGrain) {
      const pathD = displayGrain === 'v' ? 'M0,0 L0,3' : 'M0,0 L3,0';
      parts.push(`<defs><pattern id="${gId}" width="3" height="3" patternUnits="userSpaceOnUse"><path d="${pathD}" stroke="#000" stroke-width="0.15"/></pattern></defs>`);
    }

    // Fundo da chapa
    parts.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="#fbfbf8" stroke="#888" stroke-width="0.7"/>`);
    if (displayGrain) {
      parts.push(`<rect x="${ox}" y="${oy}" width="${W}" height="${H}" fill="url(#${gId})" opacity="0.20"/>`);
    }

    // Peças + medidas
    sheet.placements.forEach(p => {
      const pr = mapRect(p.x, p.y, p.w, p.h);
      const fill = colorMap[p.name] || '#e0e0e0';
      parts.push(`<rect x="${pr.x}" y="${pr.y}" width="${pr.w}" height="${pr.h}" fill="${fill}" stroke="#3a3a3a" stroke-width="0.5"/>`);
      if (!showLabels) return;
      const dw = p.realW || p.w, dh = p.realH || p.h; // medida REAL no rótulo
      const small = Math.min(p.w, p.h);
      const cx = pr.x + pr.w / 2, cy = pr.y + pr.h / 2;
      const fsDim = Math.max(3.2, Math.min(small * 0.2, 7));
      // Após rotação 90° CW: largura original (dw) vira extensão vertical no display.
      // Rótulo topo = extensão horizontal no display; rótulo esquerda = vertical.
      const topVal  = rot ? dh : dw;
      const leftVal = rot ? dw : dh;
      parts.push(`<text x="${cx}" y="${pr.y + fsDim * 1.05}" font-size="${fsDim}" text-anchor="middle" fill="#555" class="lbl-dim">${fmt(topVal)}</text>`);
      parts.push(`<text x="${pr.x + fsDim * 1.05}" y="${cy}" font-size="${fsDim}" text-anchor="middle" dominant-baseline="central" fill="#555" class="lbl-dim" transform="rotate(-90 ${pr.x + fsDim * 1.05} ${cy})">${fmt(leftVal)}</text>`);
      const fsName = Math.max(3.2, Math.min(small * 0.2, 8));
      parts.push(`<text x="${cx}" y="${cy}" font-size="${fsName}" text-anchor="middle" dominant-baseline="central" fill="#2a2a2a" font-weight="600" class="lbl-name">${esc(p.name)}</text>`);
    });

    // Sobras reaproveitáveis
    (sheet.free || []).forEach(r => {
      if (Math.min(r.w, r.h) < 3) return;
      const rr = mapRect(r.x, r.y, r.w, r.h);
      parts.push(`<rect x="${rr.x}" y="${rr.y}" width="${rr.w}" height="${rr.h}" fill="none" stroke="#9aa39d" stroke-width="0.6"/>`);
      const small = Math.min(r.w, r.h);
      if (small >= 8) {
        const fs = Math.max(1.6, Math.min(small * 0.18, 7));
        const cx = rr.x + rr.w / 2, cy = rr.y + rr.h / 2;
        const topVal  = rot ? r.h : r.w;
        const leftVal = rot ? r.w : r.h;
        parts.push(`<text x="${cx}" y="${rr.y + fs * 1.05}" font-size="${fs}" text-anchor="middle" fill="#8a938d">${fmt(topVal)}</text>`);
        parts.push(`<text x="${rr.x + fs * 1.05}" y="${cy}" font-size="${fs}" text-anchor="middle" dominant-baseline="central" fill="#8a938d" transform="rotate(-90 ${rr.x + fs * 1.05} ${cy})">${fmt(leftVal)}</text>`);
      }
    });

    // --- Réguas externas (guilhotina) ------------------------------------
    const rfs = Math.max(4, Math.min(W, H) * 0.024);
    const ruler = '#cc2200';

    // Peças no espaço de DISPLAY (já com a rotação portrait aplicada), com o
    // espaço OCUPADO (w/h, o "slot") e a medida REAL da peça (rw/rh).
    const dispPieces = sheet.placements.map(p => {
      const pr = mapRect(p.x, p.y, p.w, p.h);
      const realW = p.realW || p.w, realH = p.realH || p.h;
      return {
        x: pr.x - ox, y: pr.y - oy, w: pr.w, h: pr.h,
        rw: rot ? realH : realW,   // extensão real no eixo X do display
        rh: rot ? realW : realH    // extensão real no eixo Y do display
      };
    });

    // Onde a guilhotina pode passar de ponta a ponta: projeta as peças no eixo e
    // junta só as que se SOBREPÕEM (encostar não impede o corte). O fim de cada
    // bloco é uma linha de corte válida — nenhuma peça a atravessa. O início do
    // primeiro bloco entra também, para a sobra da ponta ganhar sua medida em
    // vez de ser somada à tira vizinha.
    function axisTicks(axis, limit) {
      const ticks = [0, limit];
      const push = v => {
        if (v > EPS && v < limit - EPS && !ticks.some(t => Math.abs(t - v) < EPS)) ticks.push(v);
      };
      const iv = dispPieces
        .map(d => (axis === 'x' ? [d.x, d.x + d.w] : [d.y, d.y + d.h]))
        .sort((a, b) => a[0] - b[0]);
      let s = null, e = null;
      iv.forEach(([a, b], i) => {
        if (s === null) { s = a; e = b; push(a); return; } // início do 1º bloco
        if (a < e - EPS) { e = Math.max(e, b); return; }   // sobrepõe → mesmo bloco
        push(e); s = a; e = b;
      });
      if (s !== null) push(e);
      return ticks.sort((x, y) => x - y);
    }
    const colsX = axisTicks('x', W);
    const rowsY = axisTicks('y', H);

    // Medida da tira [a,b]: a MAIOR peça inteiramente contida nela, na medida
    // REAL. A distância entre dois cortes não serve como medida — ela embute o
    // kerf (serra + folga) do corte de entrada e, quando o otimizador arredonda
    // o "slot", também essa folga; esse número levava a descontar o kerf DE NOVO
    // na hora de cortar. Tira sem peça nenhuma é sobra pura → mostra a distância
    // bruta, o mesmo número impresso dentro do retângulo de sobra.
    function stripSize(a, b, axis) {
      let max = -Infinity;
      for (const d of dispPieces) {
        const s = axis === 'x' ? d.x : d.y;
        const occ = axis === 'x' ? d.w : d.h;
        const real = axis === 'x' ? d.rw : d.rh;
        if (s < a - EPS || s + occ > b + EPS) continue; // fora desta tira
        if (real > max) max = real;
      }
      return max === -Infinity ? b - a : Math.min(max, b - a);
    }

    const ty = oy - 5.5;
    parts.push(`<line x1="${ox}" y1="${ty}" x2="${ox + W}" y2="${ty}" stroke="${ruler}" stroke-width="0.4"/>`);
    colsX.forEach(X => parts.push(`<line x1="${ox + X}" y1="${ty}" x2="${ox + X}" y2="${oy}" stroke="${ruler}" stroke-width="0.4"/>`));
    for (let i = 0; i < colsX.length - 1; i++) {
      const mid = ox + (colsX[i] + colsX[i + 1]) / 2;
      parts.push(`<text x="${mid}" y="${ty - 1.5}" font-size="${rfs}" text-anchor="middle" fill="${ruler}">${fmt(stripSize(colsX[i], colsX[i + 1], 'x'))}</text>`);
    }

    const tx = ox - 5.5;
    parts.push(`<line x1="${tx}" y1="${oy}" x2="${tx}" y2="${oy + H}" stroke="${ruler}" stroke-width="0.4"/>`);
    rowsY.forEach(Y => parts.push(`<line x1="${tx}" y1="${oy + Y}" x2="${ox}" y2="${oy + Y}" stroke="${ruler}" stroke-width="0.4"/>`));
    for (let i = 0; i < rowsY.length - 1; i++) {
      const mid = oy + (rowsY[i] + rowsY[i + 1]) / 2;
      parts.push(`<text x="${tx - 1.5}" y="${mid}" font-size="${rfs}" text-anchor="middle" dominant-baseline="central" fill="${ruler}" transform="rotate(-90 ${tx - 1.5} ${mid})">${fmt(stripSize(rowsY[i], rowsY[i + 1], 'y'))}</text>`);
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
        sheetSVG(sheet, colorMap, opts.showLabels, idx);
      container.appendChild(card);
    });
    // As peças que não couberam são listadas no TOPO do plano, em tabela
    // editável (montada no app.js — renderUnplaced), não mais aqui no fim.
  }

  global.Render = { renderSheets };
})(window);
