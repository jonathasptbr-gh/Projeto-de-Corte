/* ============================================================
 * lab/strip-packer.js — empacotador experimental por TIRAS ótimas.
 *
 * Ideia: em vez de encaixar peça a peça (MaxRects/BSSF, como o
 * otimizador do app), este algoritmo raciocina como quem opera a
 * seccionadora — corta uma TIRA de lado a lado e resolve, dentro
 * dela, "quais peças enfileirar para gastar o mínimo de material".
 *
 * Cada tira é um KNAPSACK 1D exato (programação dinâmica com limite
 * de quantidade por tipo), resolvido nos dois eixos; fica a tira de
 * maior densidade. O que sobra — a apara no fim da tira, o espaço
 * abaixo de cada peça mais baixa que a tira, e o resto da chapa —
 * vira uma nova região, tratada do mesmo jeito. Isso dá cortes
 * guilhotinados de vários estágios sem nunca sair da guilhotina.
 *
 * Tudo interno roda em DÉCIMOS DE CENTÍMETRO (inteiros) para não
 * acumular erro de ponto flutuante nas somas de kerf.
 * ============================================================ */
'use strict';

const MM = v => Math.round(v * 10);      // cm → décimos de cm (inteiro)
const CM = v => Math.round(v) / 10;      // volta para cm

// Orientações permitidas de uma peça numa chapa (veio manda; sem veio, gira).
function orientations(piece, sheetGrain) {
  const w = MM(piece.width), h = MM(piece.length);
  if (sheetGrain && piece.grain) {
    // veio efetivo: chapa 'v' → o veio da peça vale como está; chapa 'h' inverte
    const eff = sheetGrain === 'v' ? piece.grain : (piece.grain === 'v' ? 'h' : 'v');
    return eff === 'h' ? [{ w: h, h: w }] : [{ w, h }];
  }
  return w === h ? [{ w, h }] : [{ w, h }, { w: h, h: w }];
}

/* ---------- Knapsack 1D limitado ----------
 * cap: comprimento disponível (décimos de cm)
 * items: [{ len, area, qty }] — len já é a extensão ao longo da tira
 * kerf: largura do corte entre duas peças vizinhas
 * Devolve { value, take:[qtd por item] } maximizando a área ocupada.
 *
 * Truque do kerf: cada peça consome (len + kerf) e a capacidade vira
 * (cap + kerf) — assim N peças em fila gastam N-1 kerfs, que é o número
 * real de cortes ENTRE elas.
 */
function knapsack(cap, items, kerf) {
  const C = cap + kerf;
  if (C <= 0 || !items.length) return { value: 0, take: items.map(() => 0) };
  const n = items.length;
  let dp = new Float64Array(C + 1);
  const choice = [];
  for (let t = 0; t < n; t++) {
    const cost = items[t].len + kerf, val = items[t].area, q = items[t].qty;
    const next = new Float64Array(C + 1);
    const cnt = new Uint8Array(C + 1);
    for (let j = 0; j <= C; j++) {
      let best = dp[j], bestK = 0;
      for (let k = 1; k <= q; k++) {
        const need = k * cost;
        if (need > j) break;
        const cand = dp[j - need] + k * val;
        if (cand > best + 1e-9) { best = cand; bestK = k; }
      }
      next[j] = best; cnt[j] = bestK;
    }
    choice.push(cnt);
    dp = next;
  }
  // reconstrução
  const take = new Array(n).fill(0);
  let j = C;
  for (let t = n - 1; t >= 0; t--) {
    const k = choice[t][j];
    take[t] = k;
    j -= k * (items[t].len + kerf);
  }
  return { value: dp[C], take };
}

/* ---------- Melhor tira para uma região ----------
 * Testa cada altura candidata (as alturas das peças disponíveis) e devolve
 * a tira de maior densidade (área ocupada ÷ área da faixa consumida).
 * axis 'h': tira deitada — corre em X, espessura em Y.
 * axis 'v': tira em pé   — corre em Y, espessura em X.
 */
function bestStrip(region, pool, kerf, axis, sheetGrain, mode) {
  const along = axis === 'h' ? region.w : region.h;   // comprimento da tira
  const cross = axis === 'h' ? region.h : region.w;   // espessura disponível
  // candidatos de espessura: as medidas transversais das peças que cabem
  const thicknesses = new Set();
  const cand = [];
  pool.forEach((entry, idx) => {
    if (entry.qty <= 0) return;
    orientations(entry.piece, sheetGrain).forEach(or => {
      const len = axis === 'h' ? or.w : or.h;
      const thick = axis === 'h' ? or.h : or.w;
      if (len <= along && thick <= cross) { cand.push({ idx, len, thick, area: or.w * or.h }); thicknesses.add(thick); }
    });
  });
  if (!cand.length) return null;

  let best = null;
  for (const t of thicknesses) {
    // por tipo, dentro de uma tira de espessura t, usa a orientação que gasta
    // MENOS comprimento entre as que cabem (deixa mais espaço para as outras)
    const byIdx = new Map();
    cand.forEach(c => {
      if (c.thick > t) return;
      const cur = byIdx.get(c.idx);
      if (!cur || c.len < cur.len) byIdx.set(c.idx, c);
    });
    if (!byIdx.size) continue;
    const idxs = Array.from(byIdx.keys());
    const items = idxs.map(i => {
      const c = byIdx.get(i);
      return { len: c.len, area: c.area, qty: pool[i].qty };
    });
    const res = knapsack(along, items, kerf);
    if (res.value <= 0) continue;
    // espessura efetiva = maior peça realmente escolhida
    let effT = 0;
    idxs.forEach((i, k) => { if (res.take[k] > 0) effT = Math.max(effT, byIdx.get(i).thick); });
    if (!effT) continue;
    const density = res.value / (along * effT);
    // 'density' = tira mais bem aproveitada; 'area' = tira que consome mais
    // material de uma vez; 'thick' = tira mais espessa (puxa as peças grandes
    // para o começo da chapa, o que evita sobrar peça grande na última).
    const score = mode === 'area' ? res.value
      : mode === 'thick' ? effT * 1e6 + density
      : density;
    if (!best || score > best.score + 1e-9 ||
        (Math.abs(score - best.score) <= 1e-9 && res.value > best.value)) {
      best = {
        score, density, value: res.value, thickness: effT,
        picks: idxs.map((i, k) => ({ idx: i, n: res.take[k], len: byIdx.get(i).len, thick: byIdx.get(i).thick, or: byIdx.get(i) })).filter(p => p.n > 0),
      };
    }
  }
  return best;
}

/* ---------- Empacota UMA chapa ----------
 * Fila de regiões processadas da maior para a menor: a região grande escolhe
 * primeiro, então as peças grandes não ficam presas numa apara.
 */
function packSheet(W, H, pool, kerf, sheetGrain, cfg) {
  const mode = cfg.mode, order = cfg.order, axisPref = cfg.axisPref;
  const placements = [];
  const regions = [{ x: 0, y: 0, w: W, h: H }];
  let guard = 0;

  // "semente": planta a MAIOR peça restante no canto antes de começar. Sem
  // isso o guloso às vezes enche as primeiras chapas com peças médias e deixa
  // uma peça grande sem par no fim — o que custa uma chapa inteira a mais.
  if (cfg.seedBig) {
    let pick = null;
    pool.forEach((entry, idx) => {
      if (entry.qty <= 0) return;
      orientations(entry.piece, sheetGrain).forEach(or => {
        if (or.w > W || or.h > H) return;
        const area = or.w * or.h;
        if (!pick || area > pick.area) pick = { idx, or, area };
      });
    });
    if (pick) {
      const or = pick.or;
      pool[pick.idx].qty -= 1;
      placements.push({ x: 0, y: 0, w: or.w, h: or.h,
        name: pool[pick.idx].piece.name, rotated: MM(pool[pick.idx].piece.width) !== or.w });
      regions.length = 0;
      if (W - or.w > kerf) regions.push({ x: or.w + kerf, y: 0, w: W - or.w - kerf, h: or.h });
      if (H - or.h > kerf) regions.push({ x: 0, y: or.h + kerf, w: W, h: H - or.h - kerf });
    }
  }
  while (regions.length && guard++ < 4000) {
    regions.sort((a, b) => order === 'small' ? (a.w * a.h - b.w * b.h) : (b.w * b.h - a.w * a.h));
    const region = regions.shift();
    if (region.w <= 0 || region.h <= 0) continue;
    if (!pool.some(e => e.qty > 0)) break;

    const h = axisPref === 'v' ? null : bestStrip(region, pool, kerf, 'h', sheetGrain, mode);
    const v = axisPref === 'h' ? null : bestStrip(region, pool, kerf, 'v', sheetGrain, mode);
    let axis = 'h', strip = h;
    if (v && (!h || v.score > h.score + 1e-9)) { axis = 'v'; strip = v; }
    if (!strip) continue;

    // enfileira as peças da tira (mais espessas primeiro: o degrau fica no fim)
    const seq = [];
    strip.picks.sort((a, b) => b.thick - a.thick).forEach(p => {
      for (let i = 0; i < p.n; i++) seq.push(p);
      pool[p.idx].qty -= p.n;
    });

    let cursor = 0;
    seq.forEach(p => {
      const or = p.or;
      const pw = axis === 'h' ? or.len : or.thick;
      const ph = axis === 'h' ? or.thick : or.len;
      const x = axis === 'h' ? region.x + cursor : region.x;
      const y = axis === 'h' ? region.y : region.y + cursor;
      const entry = pool[p.idx];
      placements.push({
        x, y, w: pw, h: ph,
        name: entry.piece.name,
        rotated: MM(entry.piece.width) !== pw,
      });
      // espaço abaixo (ou ao lado) da peça, dentro da tira: 3º estágio
      const slack = strip.thickness - (axis === 'h' ? ph : pw);
      if (slack > kerf) {
        regions.push(axis === 'h'
          ? { x, y: y + ph + kerf, w: pw, h: slack - kerf }
          : { x: x + pw + kerf, y, w: slack - kerf, h: ph });
      }
      cursor += p.len + kerf;
    });

    // apara no fim da tira
    const rest = (axis === 'h' ? region.w : region.h) - (cursor - kerf);
    if (rest > kerf) {
      regions.push(axis === 'h'
        ? { x: region.x + cursor, y: region.y, w: rest - kerf, h: strip.thickness }
        : { x: region.x, y: region.y + cursor, w: strip.thickness, h: rest - kerf });
    }
    // resto da região, depois da tira
    const left = (axis === 'h' ? region.h : region.w) - strip.thickness;
    if (left > kerf) {
      regions.push(axis === 'h'
        ? { x: region.x, y: region.y + strip.thickness + kerf, w: region.w, h: left - kerf }
        : { x: region.x + strip.thickness + kerf, y: region.y, w: left - kerf, h: region.h });
    }
  }
  return placements;
}

/* ---------- Plano completo ----------
 * Abre uma chapa por vez e a enche ao máximo antes de abrir a próxima —
 * é o que concentra a sobra na última chapa.
 * Roda cada chapa com algumas estratégias e fica com a melhor.
 */
function pack(cs, cfg) {
  cfg = Object.assign({ mode: 'density', order: 'big', axisPref: 'auto', seedBig: false }, cfg || {});
  const kerf = MM(cs.kerf || 0);
  const st = cs.stock[0];
  const W = MM(st.width), H = MM(st.length);
  const cap = st.qty > 0 ? st.qty : Infinity;
  const sheetGrain = st.grain || '';

  const pool = cs.panels.map(piece => ({ piece, qty: piece.qty }));
  const sheets = [];

  while (pool.some(e => e.qty > 0) && sheets.length < cap) {
    const trial = pool.map(e => ({ piece: e.piece, qty: e.qty }));
    const pl = packSheet(W, H, trial, kerf, sheetGrain, cfg);
    const bestRun = { pl, trial };
    if (!bestRun.pl.length) break; // nada mais cabe
    for (let i = 0; i < pool.length; i++) pool[i].qty = bestRun.trial[i].qty;
    sheets.push({
      material: cs.panels[0].material, W: CM(W), H: CM(H), index: sheets.length + 1, stockName: st.name || 'Chapa',
      placements: bestRun.pl.map(p => ({
        x: CM(p.x), y: CM(p.y), w: CM(p.w), h: CM(p.h),
        realW: CM(p.w), realH: CM(p.h), name: p.name, rotated: p.rotated, bands: {},
      })),
      free: [], cuts: 0,
    });
  }

  const unplaced = [];
  pool.forEach(e => {
    for (let i = 0; i < e.qty; i++) {
      unplaced.push({ w: e.piece.width, h: e.piece.length, name: e.piece.name, material: e.piece.material });
    }
  });
  return { sheets, unplaced };
}

// ---------- Multi-start ----------
// Um guloso só erra feio de vez em quando: enche as primeiras chapas e deixa
// peça grande sem par no fim, gastando uma chapa a mais. Rodar o plano inteiro
// com várias estratégias (é barato) e escolher pelo MESMO critério do app —
// menos peças fora, menos chapas, chapas mais cheias — corrige isso.
const VARIANTS = [];
for (const mode of ['density', 'area', 'thick'])
  for (const order of ['big', 'small'])
    for (const axisPref of ['auto', 'h', 'v'])
      for (const seedBig of [false, true])
        VARIANTS.push({ mode, order, axisPref, seedBig });

function planScore(res) {
  const fills = res.sheets
    .map(s => s.placements.reduce((a, p) => a + p.w * p.h, 0) / (s.W * s.H))
    .sort((a, b) => b - a);
  return { unplaced: res.unplaced.length, sheets: res.sheets.length, fills };
}
function betterPlan(a, b) { // a é melhor que b?
  if (!b) return true;
  if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
  if (a.sheets !== b.sheets) return a.sheets < b.sheets;
  for (let i = 0; i < Math.max(a.fills.length, b.fills.length); i++) {
    const x = a.fills[i] || 0, y = b.fills[i] || 0;
    if (Math.abs(x - y) > 1e-6) return x > y;
  }
  return false;
}

function packBest(cs) {
  let best = null, bestSc = null, bestCfg = null;
  for (const cfg of VARIANTS) {
    const res = pack(cs, cfg);
    const sc = planScore(res);
    if (betterPlan(sc, bestSc)) { best = res; bestSc = sc; bestCfg = cfg; }
  }
  if (best) best.__cfg = bestCfg;
  return best;
}

module.exports = { pack, packBest, knapsack, packSheet, VARIANTS };
