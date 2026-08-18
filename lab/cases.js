/* ============================================================
 * lab/cases.js — casos de teste do laboratório do otimizador.
 *
 * Casos REAIS vieram de registros exportados pelo app ("Exportar
 * registro" → .md), então as medidas são as mesmas que geraram os
 * planos discutidos. Os aleatórios usam um gerador determinístico
 * (mesma semente → mesmos projetos), para comparar algoritmos sobre
 * exatamente a mesma entrada.
 *
 * Formato de um caso:
 *   { name, panels:[{width,length,qty,material,name,grain}], stock:[...], kerf }
 * — o mesmo que o app passa para Optimizer.optimize/createSearch.
 * ============================================================ */
'use strict';

const MAT = '#ffffff|18'; // material único nos casos (cor|espessura, como no app)

const p = (width, length, qty, name, grain) =>
  ({ width, length, qty, material: MAT, name: name || 'p', grain: grain || '', bands: {} });
const sheet = (width, length, qty, grain) =>
  ({ width, length, qty: qty || 99, material: MAT, name: 'Chapa', grain: grain || '' });

// ---------- Casos reais ----------

// Cristaleira: 9 peças que cabem numa única chapa (registro de 18/08).
// O plano feito à mão usa colunas de altura cheia: 3×Pc | 2×Lc | Uc+Tb+2×Pc.
const cristaleira = {
  name: 'cristaleira (9 pç, 1 chapa, veio v)',
  panels: [
    p(40, 140, 1, 'Tb', 'v'),
    p(38, 121.6, 2, 'Lc', 'v'),
    p(34, 86.4, 5, 'Pc', 'v'),
    p(86.4, 121.6, 1, 'Uc', 'v'),
  ],
  stock: [sheet(184, 274, 1, 'v')],
  kerf: 0.8,
};

// Escola: 50 peças / 23 linhas, 12,41 m² — o caso em que a sobra se espalhava.
const escola = {
  name: 'escola (50 pç, 3 chapas)',
  panels: [
    p(37.2, 45.5, 1), p(45.5, 77.4, 1), p(8, 88.7, 3), p(37.8, 78.2, 3),
    p(52.5, 250.5, 2), p(5, 250.5, 1), p(52.5, 55.6, 4), p(52.5, 179.2, 1),
    p(50, 55.6, 1), p(29.8, 52.5, 1), p(31.6, 58, 1), p(54.3, 181, 1),
    p(29.8, 54.5, 1), p(5, 34.6, 1), p(8, 29.8, 3), p(9.5, 55.6, 1),
    p(58.6, 140.6, 1), p(32.1, 58.6, 4), p(29.2, 120, 1), p(28, 40.8, 8),
    p(28, 49.4, 8), p(3, 181, 1), p(3, 54.6, 1),
  ],
  stock: [sheet(184, 274)],
  kerf: 0.8,
};

// Balcão (material Dark grey do CSV de 18/08): 30 peças em 2 chapas.
const balcao = {
  name: 'balcão dark grey (30 pç, 2 chapas)',
  panels: [
    p(35.5, 226.4, 1, 'bb'), p(35.5, 76.6, 2, 'db'), p(8, 36.2, 1, 'e2tb'),
    p(8, 34.4, 1, 'e2tb'), p(8, 140, 2, 'etb'), p(8, 24, 3, 'etb'),
    p(46.4, 78.1, 3, 'f1b'), p(44.7, 121.6, 2, 'f1c'), p(44.7, 78.1, 2, 'f4b'),
    p(38, 85.9, 2, 'lb'), p(35.5, 43.8, 1, 'p1b'), p(35.5, 91.7, 1, 'p2b'),
    p(35.5, 87.3, 1, 'p3b'), p(7.5, 23.7, 4, 'r2b'), p(7.5, 226.4, 2, 'rb'),
    p(6, 226.4, 1, 's1b'), p(8, 226.4, 1, 's2b'),
  ],
  stock: [sheet(184, 274)],
  kerf: 0.8,
};

// Balcão, material Oak 03: 12 peças numa chapa.
const balcaoOak = {
  name: 'balcão oak (12 pç, 1 chapa)',
  panels: [
    p(38, 121.6, 2, 'lc'), p(36.2, 86.4, 3, 'pc'), p(40, 140, 1, 'tb'),
    p(38, 86.4, 2, 'tbc'), p(28.1, 86.4, 3, 'u1c'), p(29.2, 86.4, 1, 'u4c'),
  ],
  stock: [sheet(184, 274)],
  kerf: 0.8,
};

const REAIS = [cristaleira, escola, balcao, balcaoOak];

// ---------- Aleatórios determinísticos ----------

function makeRng(seed) {
  let s = seed >>> 0 || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

// Projeto aleatório "de marcenaria": poucas linhas, quantidades pequenas,
// medidas com uma casa decimal, dentro do que cabe numa chapa 184×274.
function randomCase(seed) {
  const rnd = makeRng(seed);
  const lines = 4 + Math.floor(rnd() * 12);
  const panels = [];
  for (let i = 0; i < lines; i++) {
    const w = Math.round((12 + rnd() * 75) * 10) / 10;
    const l = Math.round((20 + rnd() * 200) * 10) / 10;
    panels.push(p(w, l, 1 + Math.floor(rnd() * 6), 'p' + (i + 1)));
  }
  return { name: 'aleatório #' + seed, panels, stock: [sheet(184, 274)], kerf: 0.8 };
}

function randomCases(n, seed0) {
  const out = [];
  for (let i = 0; i < n; i++) out.push(randomCase((seed0 || 1000) + i * 7919));
  return out;
}

module.exports = { MAT, REAIS, cristaleira, escola, balcao, balcaoOak, randomCase, randomCases };
