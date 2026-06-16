/* ============================================================
 * render.js — Desenho SVG das chapas do plano de corte.
 * ============================================================ */
(function (global) {
  'use strict';

  const PALETTE = ['#e9d8a6', '#f1c6a8', '#cfe3d4', '#d8d2e8', '#f4d6d6', '#cde3ef', '#e7e0c9', '#dbe8c9'];

  function colorFor(name, cache) {
    if (!(name in cache)) cache[name] = PALETTE[Object.keys(cache).length % PALETTE.length];
    return cache[name];
  }

  function esc(s) { return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  // Desenha uma chapa e devolve string SVG.
  function sheetSVG(sheet, opts) {
    const showLabels = opts && opts.showLabels;
    const cache = opts && opts.colorCache || {};
    const W = sheet.W, H = sheet.H;
    const pad = 4;
    // Mantém proporção; o SVG é responsivo pela largura.
    const vw = W + pad * 2, vh = H + pad * 2;

    let parts = [`<svg viewBox="0 0 ${vw} ${vh}" preserveAspectRatio="xMidYMid meet" role="img">`];
    parts.push(`<rect x="${pad}" y="${pad}" width="${W}" height="${H}" fill="#fbfbf8" stroke="#999" stroke-width="0.6"/>`);

    sheet.placements.forEach(p => {
      const x = pad + p.x, y = pad + p.y;
      const fill = colorFor(p.name, cache);
      parts.push(`<g>`);
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="${fill}" stroke="#5a5a5a" stroke-width="0.5"/>`);
      // direção do grão (linhas verticais leves)
      parts.push(`<rect x="${x}" y="${y}" width="${p.w}" height="${p.h}" fill="url(#grain)" opacity="0.25"/>`);
      if (showLabels) {
        const cx = x + p.w / 2, cy = y + p.h / 2;
        const vertical = p.h > p.w * 1.4;
        const fs = Math.max(5, Math.min(p.w, p.h) * 0.22);
        const dims = `${fmt(p.h)}×${fmt(p.w)}`;
        const transform = vertical ? `transform="rotate(-90 ${cx} ${cy})"` : '';
        parts.push(`<text x="${cx}" y="${cy - fs*0.2}" ${transform} font-size="${fs}" text-anchor="middle" fill="#333">${esc(p.name)}</text>`);
        parts.push(`<text x="${cx}" y="${cy + fs}" ${transform} font-size="${fs*0.8}" text-anchor="middle" fill="#666">${dims}</text>`);
      }
      parts.push(`</g>`);
    });

    // padrão de grão
    parts.push(`<defs><pattern id="grain" width="3" height="3" patternUnits="userSpaceOnUse"><path d="M0,0 L0,3" stroke="#000" stroke-width="0.15"/></pattern></defs>`);
    parts.push(`</svg>`);
    return parts.join('');
  }

  function fmt(n) { return (Math.round(n * 10) / 10).toString().replace('.', ','); }

  // Renderiza todas as chapas no container.
  function renderSheets(container, result, opts) {
    container.innerHTML = '';
    const colorCache = {};
    result.sheets.forEach(sheet => {
      const used = sheet.placements.reduce((a, p) => a + p.w * p.h, 0);
      const eff = sheet.W * sheet.H ? (used / (sheet.W * sheet.H) * 100) : 0;
      const card = document.createElement('div');
      card.className = 'sheet-card';
      card.innerHTML =
        `<h3>${esc(sheet.material)} — Chapa ${sheet.index}</h3>` +
        `<div class="sub">${fmt(sheet.W)} × ${fmt(sheet.H)} · ${sheet.placements.length} peças · aproveit. ${eff.toFixed(1)}%</div>` +
        sheetSVG(sheet, { showLabels: opts.showLabels, colorCache });
      container.appendChild(card);
    });

    if (result.unplaced && result.unplaced.length) {
      const warn = document.createElement('div');
      warn.className = 'sheet-card';
      warn.style.borderColor = '#c0392b';
      warn.innerHTML = `<h3 style="color:#c0392b">⚠ ${result.unplaced.length} peça(s) não couberam</h3>` +
        `<div class="sub">Verifique o tamanho da chapa (stock) ou a rotação.</div>`;
      container.appendChild(warn);
    }
  }

  global.Render = { renderSheets };
})(window);
