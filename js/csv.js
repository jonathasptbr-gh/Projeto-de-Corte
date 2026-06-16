/* ============================================================
 * csv.js — Leitura de CSV no formato CutList.
 * Cabeçalho esperado:
 *   C, L, Q, Material, NOME, Enabled, Grain direction,
 *   Top band, Left band, Bottom band, Right band, Ordem
 * Linhas vazias e linhas sem medidas são ignoradas.
 * ============================================================ */
(function (global) {
  'use strict';

  // Divide uma linha de CSV respeitando aspas e separadores , ou ;
  function splitLine(line, sep) {
    const out = [];
    let cur = '', inq = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inq && line[i + 1] === '"') { cur += '"'; i++; }
        else inq = !inq;
      } else if (c === sep && !inq) {
        out.push(cur); cur = '';
      } else {
        cur += c;
      }
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function detectSep(text) {
    const head = text.split(/\r?\n/, 5).join('\n');
    const commas = (head.match(/,/g) || []).length;
    const semis = (head.match(/;/g) || []).length;
    return semis > commas ? ';' : ',';
  }

  // Converte número aceitando vírgula ou ponto como decimal.
  function num(v) {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    if (s === '') return NaN;
    return parseFloat(s);
  }

  function truthy(v) {
    const s = String(v || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'sim' || s === 'yes' || s === 'verdadeiro';
  }

  // Recebe texto CSV e devolve { panels: [...], warnings: [...] }
  function parse(text) {
    const sep = detectSep(text);
    const rows = text.split(/\r?\n/).map(l => splitLine(l, sep));
    const panels = [];
    const warnings = [];

    rows.forEach((cols) => {
      if (!cols || cols.length < 3) return;
      const c = num(cols[0]);   // Comprimento
      const l = num(cols[1]);   // Largura
      // ignora cabeçalho e linhas vazias
      if (!isFinite(c) || !isFinite(l) || c <= 0 || l <= 0) return;

      const q = Math.max(1, Math.round(num(cols[2]) || 1));
      const material = (cols[3] || '').trim() || 'Padrão';
      const name = (cols[4] || '').trim() || 'Peça';
      // Enabled: se a coluna existir e for falsa, ignora a peça
      if (cols.length > 5 && cols[5] !== '' && !truthy(cols[5])) return;

      const grain = (cols[6] || '').trim().toLowerCase(); // h / v / vazio
      const bands = {
        top:    (cols[7]  || '').trim() !== '',
        left:   (cols[8]  || '').trim() !== '',
        bottom: (cols[9]  || '').trim() !== '',
        right:  (cols[10] || '').trim() !== '',
      };

      panels.push({
        length: c, width: l, qty: q,
        material, name,
        grain: grain === 'h' || grain === 'v' ? grain : '',
        bands,
      });
    });

    if (!panels.length) warnings.push('Nenhuma peça válida encontrada no CSV.');
    return { panels, warnings };
  }

  global.CSV = { parse };
})(window);
