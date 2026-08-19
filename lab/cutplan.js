/* ============================================================
 * lab/cutplan.js — custo OPERACIONAL de um plano de corte.
 *
 * Aproveitamento de área não é o único preço do plano: cada corte é
 * uma passada na seccionadora, e cada vez que o pedaço precisa entrar
 * girado 90° é um reposicionamento (esquadro, encosto, conferência).
 * Ganhar 3% de área gastando o dobro de manobras costuma ser um mau
 * negócio.
 *
 * Este módulo reconstrói a ÁRVORE de cortes guilhotinados do layout e
 * mede:
 *
 *   cuts   — total de passadas de serra, incluindo os refilos que
 *            liberam uma peça da sua sobra;
 *   turns  — quantas dessas passadas mudam de direção em relação ao
 *            corte que gerou aquele pedaço: cada uma é um giro de 90°
 *            de material na máquina;
 *   stages — profundidade em estágios (alternâncias de direção no
 *            caminho mais fundo): 2 é o padrão "tiras + peças" da
 *            seccionadora, 3 já pede um passo extra, 4+ é layout
 *            trabalhoso de executar.
 *
 * A árvore é escolhida por MENOR CUSTO (giros, depois cortes) — mede o
 * plano no seu melhor cenário de execução, não numa ordem arbitrária.
 * O kerf entra na conta: cortar em X deixa o pedaço da direita
 * começando em X + kerf, então o vão da serra não vira "sobra a
 * refilar".
 * ============================================================ */
'use strict';

const EPS = 1e-3;

const keyOf = (x, y, w, h, items, dir) =>
  [x, y, w, h].map(v => v.toFixed(1)).join(',') + '#' + dir + '#' +
  items.map(r => r.x.toFixed(1) + ':' + r.y.toFixed(1)).sort().join('|');

// custo lexicográfico: primeiro giros, depois cortes
const cheaper = (a, b) => !b || a.turns < b.turns || (a.turns === b.turns && a.cuts < b.cuts);

function analyze(W, H, rects, opts) {
  const kerf = (opts && opts.kerf) || 0;
  const limit = (opts && opts.nodeLimit) || 120000;
  let nodes = 0;
  const memo = new Map();
  const ZERO = { cuts: 0, turns: 0, depth: 0 };
  const FAIL = { cuts: 999, turns: 999, depth: 9 };

  // Junta o custo de um corte com o dos dois pedaços que ele gera.
  // depth = alternâncias no caminho mais fundo (o giro deste corte conta 1).
  const join = (turned, a, b) => ({
    cuts: 1 + a.cuts + b.cuts,
    turns: (turned ? 1 : 0) + a.turns + b.turns,
    depth: (turned ? 1 : 0) + Math.max(a.depth, b.depth),
  });

  // Refilos que liberam UMA peça da sobra da região em que ela está.
  function trim(x, y, w, h, r, dir) {
    const vCuts = (r.x - x > EPS ? 1 : 0) + ((x + w) - (r.x + r.w) > EPS ? 1 : 0);
    const hCuts = (r.y - y > EPS ? 1 : 0) + ((y + h) - (r.y + r.h) > EPS ? 1 : 0);
    if (!vCuts && !hCuts) return ZERO;
    const both = vCuts > 0 && hCuts > 0;
    // começa pelo eixo que já está na máquina (não gira à toa)
    const firstV = vCuts > 0 && (dir === 'V' || dir === '' || !hCuts);
    const firstAxis = firstV ? 'V' : 'H';
    const turnFirst = dir !== '' && dir !== firstAxis ? 1 : 0;
    const turnSecond = both ? 1 : 0;
    return {
      cuts: vCuts + hCuts,
      turns: turnFirst + turnSecond,
      depth: turnFirst + turnSecond,
    };
  }

  function best(x, y, w, h, items, dir) {
    if (!items.length) return ZERO;
    if (items.length === 1) return trim(x, y, w, h, items[0], dir);
    const k = keyOf(x, y, w, h, items, dir);
    if (memo.has(k)) return memo.get(k);
    if (++nodes > limit) return FAIL;

    let out = null;
    const xs = new Set(), ys = new Set();
    items.forEach(r => { xs.add(r.x + r.w); ys.add(r.y + r.h); });

    for (const X of xs) {
      if (X <= x + EPS || X >= x + w - EPS) continue;
      // corte válido: ninguém atravessa a linha nem invade o vão da serra
      if (!items.every(r => r.x + r.w <= X + EPS || r.x >= X + kerf - EPS)) continue;
      const L = items.filter(r => r.x + r.w <= X + EPS);
      const R = items.filter(r => r.x >= X + kerf - EPS);
      if (!L.length || !R.length || L.length + R.length !== items.length) continue;
      const turned = dir !== '' && dir !== 'V';
      const cand = join(turned,
        best(x, y, X - x, h, L, 'V'),
        best(X + kerf, y, x + w - X - kerf, h, R, 'V'));
      if (cheaper(cand, out)) out = cand;
    }
    for (const Y of ys) {
      if (Y <= y + EPS || Y >= y + h - EPS) continue;
      if (!items.every(r => r.y + r.h <= Y + EPS || r.y >= Y + kerf - EPS)) continue;
      const T = items.filter(r => r.y + r.h <= Y + EPS);
      const B = items.filter(r => r.y >= Y + kerf - EPS);
      if (!T.length || !B.length || T.length + B.length !== items.length) continue;
      const turned = dir !== '' && dir !== 'H';
      const cand = join(turned,
        best(x, y, w, Y - y, T, 'H'),
        best(x, Y + kerf, w, y + h - Y - kerf, B, 'H'));
      if (cheaper(cand, out)) out = cand;
    }
    if (!out) out = FAIL;
    memo.set(k, out);
    return out;
  }

  const r = best(0, 0, W, H, rects.slice(), '');
  return { cuts: r.cuts, turns: r.turns, stages: r.depth + 1, ok: r.cuts < 999 };
}

// Custo operacional do plano inteiro (todas as chapas).
function planCost(result, kerf) {
  let cuts = 0, turns = 0, stages = 0, falhas = 0;
  result.sheets.forEach(s => {
    const rects = s.placements.map(p => ({
      x: p.x, y: p.y,
      w: p.realW != null ? p.realW : p.w,
      h: p.realH != null ? p.realH : p.h,
    }));
    const a = analyze(s.W, s.H, rects, { kerf });
    if (!a.ok) { falhas++; return; }
    cuts += a.cuts; turns += a.turns; stages = Math.max(stages, a.stages);
  });
  const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0);
  return {
    cuts, turns, stages, pieces, falhas,
    cutsPerPiece: pieces ? cuts / pieces : 0,
    turnsPerPiece: pieces ? turns / pieces : 0,
  };
}

module.exports = { analyze, planCost };
