/* ============================================================
 * lab/validate.js — validador de planos de corte.
 *
 * Um número bonito só vale se o plano for executável. Este módulo
 * confere, para QUALQUER algoritmo (o do app ou um experimental):
 *
 *   1. cada peça cabe dentro da chapa;
 *   2. peças vizinhas nunca ficam a menos de `kerf` uma da outra
 *      (invariante do projeto: a serra come esse material);
 *   3. o layout inteiro é cortável por guilhotina (cortes de lado a
 *      lado, recursivamente);
 *   4. as peças posicionadas + as não posicionadas batem EXATAMENTE
 *      com o que foi pedido (nada some, nada duplica);
 *   5. peças com veio não aparecem giradas em chapa com veio.
 * ============================================================ */
'use strict';

const EPS = 1e-6;

const dimsOf = pl => ({ w: pl.realW != null ? pl.realW : pl.w, h: pl.realH != null ? pl.realH : pl.h });

// Layout admite corte guilhotinado puro? (mesma ideia do isGuillotineFeasible
// do optimizer.js: procura um corte de lado a lado e recursa nos dois lados)
function guillotinable(W, H, rects) {
  const memo = new Map();
  const key = list => list.map(r => r.x.toFixed(2) + ',' + r.y.toFixed(2)).sort().join('|');
  function ok(x, y, w, h, items) {
    if (items.length <= 1) return true;
    const k = [x, y, w, h].map(v => v.toFixed(2)).join('|') + '#' + key(items);
    if (memo.has(k)) return memo.get(k);
    let res = false;
    const xs = new Set(), ys = new Set();
    items.forEach(r => { xs.add(r.x); xs.add(r.x + r.w); ys.add(r.y); ys.add(r.y + r.h); });
    outer: {
      for (const X of xs) {
        if (X <= x + 1e-3 || X >= x + w - 1e-3) continue;
        if (items.every(r => r.x + r.w <= X + 1e-3 || r.x >= X - 1e-3)) {
          const L = items.filter(r => r.x + r.w <= X + 1e-3);
          const R = items.filter(r => r.x >= X - 1e-3);
          if (L.length && R.length && ok(x, y, X - x, h, L) && ok(X, y, x + w - X, h, R)) { res = true; break outer; }
        }
      }
      for (const Y of ys) {
        if (Y <= y + 1e-3 || Y >= y + h - 1e-3) continue;
        if (items.every(r => r.y + r.h <= Y + 1e-3 || r.y >= Y - 1e-3)) {
          const T = items.filter(r => r.y + r.h <= Y + 1e-3);
          const B = items.filter(r => r.y >= Y - 1e-3);
          if (T.length && B.length && ok(x, y, w, Y - y, T) && ok(x, Y, w, y + h - Y, B)) { res = true; break outer; }
        }
      }
    }
    memo.set(k, res);
    return res;
  }
  return ok(0, 0, W, H, rects.slice());
}

// Chave de uma peça por VALOR (medidas + nome), para conferir o multiset.
// Guarda as duas orientações porque a peça pode ter sido girada.
const sizeKey = (a, b, name) => {
  const lo = Math.min(a, b).toFixed(2), hi = Math.max(a, b).toFixed(2);
  return (name || '') + '|' + lo + 'x' + hi;
};

function validate(cs, result) {
  const errs = [];
  const kerf = cs.kerf || 0;

  // --- 1/2/3: geometria de cada chapa ---
  result.sheets.forEach((s, si) => {
    const rects = s.placements.map(pl => {
      const d = dimsOf(pl);
      return { x: pl.x, y: pl.y, w: d.w, h: d.h, name: pl.name };
    });
    rects.forEach(r => {
      if (r.x < -EPS || r.y < -EPS || r.x + r.w > s.W + 1e-3 || r.y + r.h > s.H + 1e-3) {
        errs.push(`chapa ${si + 1}: peça ${r.name} ${r.w}×${r.h} @(${r.x},${r.y}) sai da chapa ${s.W}×${s.H}`);
      }
    });
    for (let i = 0; i < rects.length; i++) {
      for (let j = i + 1; j < rects.length; j++) {
        const a = rects[i], b = rects[j];
        const xOverlap = a.x < b.x + b.w + kerf - 1e-3 && b.x < a.x + a.w + kerf - 1e-3;
        const yOverlap = a.y < b.y + b.h + kerf - 1e-3 && b.y < a.y + a.h + kerf - 1e-3;
        if (xOverlap && yOverlap) {
          errs.push(`chapa ${si + 1}: ${a.name}@(${a.x},${a.y}) e ${b.name}@(${b.x},${b.y}) a menos de kerf (${kerf})`);
        }
      }
    }
    if (rects.length > 1 && !guillotinable(s.W, s.H, rects)) {
      errs.push(`chapa ${si + 1}: layout não é cortável por guilhotina`);
    }
  });

  // --- 4: multiset de peças ---
  const want = new Map();
  cs.panels.forEach(pn => {
    const k = sizeKey(pn.width, pn.length, pn.name);
    want.set(k, (want.get(k) || 0) + pn.qty);
  });
  const got = new Map();
  const bump = k => got.set(k, (got.get(k) || 0) + 1);
  result.sheets.forEach(s => s.placements.forEach(pl => {
    const d = dimsOf(pl);
    bump(sizeKey(d.w, d.h, pl.name));
  }));
  (result.unplaced || []).forEach(u => bump(sizeKey(u.w, u.h, u.name)));
  want.forEach((n, k) => {
    const g = got.get(k) || 0;
    if (g !== n) errs.push(`peça ${k}: pedidas ${n}, no plano ${g}`);
  });
  got.forEach((n, k) => { if (!want.has(k)) errs.push(`peça ${k} não estava no projeto (${n}×)`); });

  // --- 5: veio ---
  const grainOf = new Map();
  cs.panels.forEach(pn => { if (pn.grain) grainOf.set(sizeKey(pn.width, pn.length, pn.name), { g: pn.grain, w: pn.width, l: pn.length }); });
  result.sheets.forEach((s, si) => {
    const sg = (cs.stock[0] && cs.stock[0].grain) || '';
    if (!sg) return;
    s.placements.forEach(pl => {
      const d = dimsOf(pl);
      const info = grainOf.get(sizeKey(d.w, d.h, pl.name));
      if (!info) return;
      const okOrient = sg === 'v'
        ? (info.g === 'v' ? Math.abs(d.w - info.w) < 1e-3 : Math.abs(d.w - info.l) < 1e-3)
        : (info.g === 'v' ? Math.abs(d.w - info.l) < 1e-3 : Math.abs(d.w - info.w) < 1e-3);
      if (!okOrient) errs.push(`chapa ${si + 1}: peça ${pl.name} girada contra o veio`);
    });
  });

  return { ok: !errs.length, errs };
}

// Métricas de um plano, na mesma linguagem do app.
function metrics(result) {
  const fills = result.sheets.map(s =>
    s.placements.reduce((a, pl) => a + (pl.realW != null ? pl.realW : pl.w) * (pl.realH != null ? pl.realH : pl.h), 0) / (s.W * s.H));
  const sorted = fills.slice().sort((a, b) => b - a);
  const areaAll = result.sheets.reduce((a, s) => a + s.W * s.H, 0);
  const usedAll = result.sheets.reduce((a, s, i) => a + fills[i] * s.W * s.H, 0);
  return {
    sheets: result.sheets.length,
    unplaced: (result.unplaced || []).length,
    fills: sorted,
    fillStr: sorted.map(f => (f * 100).toFixed(1)).join(' / '),
    overall: areaAll ? usedAll / areaAll : 0,
    // sobra concentrada: quanto da área livre total está na chapa mais vazia
    lastFree: sorted.length ? 1 - sorted[sorted.length - 1] : 0,
  };
}

module.exports = { validate, metrics, guillotinable };
