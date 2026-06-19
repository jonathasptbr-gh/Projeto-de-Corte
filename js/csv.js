/* ============================================================
 * csv.js — Leitor de CSV tolerante a formatos.
 * Identifica as colunas pelos NOMES do cabeçalho (não pela
 * ordem), suportando os dois modelos conhecidos:
 *
 *  A) Grupo, Peça, Quantidade, Comprimento(cm), Largura(cm),
 *     Espessura(cm), Material
 *  B) C, L, Q, Material, NOME, Enabled, Grain direction,
 *     Top band, Left band, Bottom band, Right band, Ordem
 *
 * Trata BOM, aspas, vírgula decimal e separador , ou ;.
 * Devolve { panels:[{length,width,qty,material,name,grain,
 *           bands,thickness}], warnings:[] }  (thickness em mm)
 * ============================================================ */
(function (global) {
  'use strict';

  function splitLine(line, sep) {
    const out = [];
    let cur = '', inq = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        if (inq && line[i + 1] === '"') { cur += '"'; i++; }
        else inq = !inq;
      } else if (c === sep && !inq) { out.push(cur); cur = ''; }
      else cur += c;
    }
    out.push(cur);
    return out.map(s => s.trim());
  }

  function detectSep(text) {
    const head = text.split(/\r?\n/, 5).join('\n');
    return (head.split(';').length - 1) > (head.split(',').length - 1) ? ';' : ',';
  }

  function num(v) {
    if (v == null) return NaN;
    const s = String(v).trim().replace(/\s/g, '').replace(',', '.');
    return s === '' ? NaN : parseFloat(s);
  }

  function truthy(v) {
    const s = String(v || '').trim().toLowerCase();
    return s === 'true' || s === '1' || s === 'sim' || s === 'yes' || s === 'verdadeiro';
  }

  // Conserta texto com encoding duplo (UTF-8 lido como Latin-1), comum em
  // exports do Windows: "PeÃ§a" → "Peça", "ï»¿" → BOM. Só age se detectar sinais.
  function repairEncoding(s) {
    if (!/Ã.|Â.|ï»¿|Ã§|Ã©|Ã£/.test(s)) return s;
    try {
      const fixed = decodeURIComponent(escape(s));
      return fixed;
    } catch (e) { return s; }
  }

  // Normaliza um cabeçalho: minúsculas, sem acentos, só letras/números.
  function normHead(h) {
    return String(h || '')
      .replace(/^﻿/, '')
      .normalize('NFD').replace(/[̀-ͯ]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Acha o índice da coluna: tenta correspondência exata, depois "contém".
  function colIndex(H, contains, exact) {
    if (exact) { for (let i = 0; i < H.length; i++) if (exact.includes(H[i])) return i; }
    for (let i = 0; i < H.length; i++) if (contains.some(k => H[i].includes(k))) return i;
    return -1;
  }

  function buildMap(H) {
    return {
      length: colIndex(H, ['comprimento', 'length'], ['c']),
      width: colIndex(H, ['largura', 'width'], ['l']),
      qty: colIndex(H, ['quantidade', 'qtd', 'quant'], ['q']),
      name: colIndex(H, ['nome', 'peca', 'label'], []),
      material: colIndex(H, ['material'], []),
      thickness: colIndex(H, ['espessura', 'thickness', 'espesura'], []),
      grain: colIndex(H, ['grain', 'grao', 'veio'], []),
      enabled: colIndex(H, ['enabled', 'ativo'], []),
      top: colIndex(H, ['topband', 'top', 'topo'], []),
      left: colIndex(H, ['leftband', 'left', 'esq'], []),
      bottom: colIndex(H, ['bottomband', 'bottom', 'base', 'inferior'], []),
      right: colIndex(H, ['rightband', 'right', 'dir'], []),
    };
  }

  function parse(text) {
    text = repairEncoding(String(text || '')).replace(/﻿/g, '');
    const sep = detectSep(text);
    const lines = text.split(/\r?\n/);
    const warnings = [];

    // 1ª linha não-vazia = cabeçalho
    let hi = lines.findIndex(l => l.trim() !== '');
    if (hi < 0) return { panels: [], warnings: ['CSV vazio.'] };

    const rawHead = splitLine(lines[hi], sep);
    const H = rawHead.map(normHead);
    const map = buildMap(H);

    if (map.length < 0 || map.width < 0) {
      return { panels: [], warnings: ['Não encontrei as colunas de comprimento/largura no cabeçalho.'] };
    }

    // unidade da espessura: (mm) no cabeçalho → mm; senão assume cm.
    const thUnit = map.thickness >= 0 && /mm/.test(H[map.thickness] || '') ? 'mm' : 'cm';
    const get = (cols, i) => (i >= 0 && i < cols.length) ? cols[i] : '';

    const panels = [];
    for (let r = hi + 1; r < lines.length; r++) {
      if (lines[r].trim() === '') continue;
      const cols = splitLine(lines[r], sep);

      const c = num(get(cols, map.length));   // comprimento
      const l = num(get(cols, map.width));     // largura
      if (!isFinite(c) || !isFinite(l) || c <= 0 || l <= 0) continue;

      if (map.enabled >= 0) {
        const e = get(cols, map.enabled);
        if (e !== '' && !truthy(e)) continue;
      }

      const qty = Math.min(999, Math.max(1, Math.round(num(get(cols, map.qty)) || 1))); // teto 999 (ver MAX_QTY no app.js)
      const material = (get(cols, map.material) || '').trim() || 'Padrão';
      const name = (get(cols, map.name) || '').trim() || 'Peça';

      let thickness = 0;
      if (map.thickness >= 0) {
        const tv = num(get(cols, map.thickness));
        if (isFinite(tv) && tv > 0) thickness = thUnit === 'mm' ? Math.round(tv) : Math.round(tv * 10);
      }

      const grain = (get(cols, map.grain) || '').trim().toLowerCase();
      const bands = {
        top: (get(cols, map.top) || '').trim() !== '',
        left: (get(cols, map.left) || '').trim() !== '',
        bottom: (get(cols, map.bottom) || '').trim() !== '',
        right: (get(cols, map.right) || '').trim() !== '',
      };

      panels.push({
        length: c, width: l, qty, material, name, thickness,
        grain: grain === 'h' || grain === 'v' ? grain : '',
        bands,
      });
    }

    if (!panels.length) warnings.push('Nenhuma peça válida encontrada no CSV.');
    return { panels, warnings };
  }

  // ---- Geração de CSV (round-trip: re-importável pelo parser acima) ----
  // Usa ';' como separador e vírgula decimal (padrão pt-BR/Excel).
  function csvCell(v, sep) {
    const s = String(v == null ? '' : v);
    return new RegExp('["\\n\\r' + sep + ']').test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }
  function stringify(rows, headers, sep) {
    sep = sep || ';';
    const head = headers.map(h => csvCell(h.label, sep)).join(sep);
    const body = rows.map(r => headers.map(h => csvCell(r[h.key], sep)).join(sep)).join('\r\n');
    return head + '\r\n' + body + '\r\n';
  }

  global.CSV = { parse, stringify };
})(window);
