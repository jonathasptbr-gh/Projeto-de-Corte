/* ============================================================
 * lab/bench.js — compara o otimizador do app com o experimental.
 *
 *   node lab/bench.js              → casos reais, busca rápida (optimize)
 *   node lab/bench.js --full       → casos reais, busca completa (como o app)
 *   node lab/bench.js --rand 30    → 30 projetos aleatórios determinísticos
 *
 * Todo plano passa pelo validador antes de entrar na conta: plano
 * inválido (peça fora, kerf violado, corte não guilhotinável, peça
 * sumida) é reportado como FALHA, não como resultado melhor.
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { REAIS, randomCases } = require('./cases');
const { validate, metrics } = require('./validate');
const { planCost } = require('./cutplan');
const strip = require('./strip-packer');

// carrega o optimizer.js do app (IIFE que exporta em window.Optimizer)
function loadAppOptimizer() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'optimizer.js'), 'utf8');
  const sandbox = {};
  return new Function('window', src + '\n;return window.Optimizer;')(sandbox);
}
const Optimizer = loadAppOptimizer();

const optsFor = cs => ({
  kerf: cs.kerf, considerMaterial: true, considerGrain: true, allowRotate: true,
  weights: Optimizer.defaultWeights(),
});

// Busca rápida: uma passada determinística (Optimizer.optimize).
function runAppFast(cs) {
  return Optimizer.optimize(cs.panels, cs.stock, optsFor(cs));
}

// Busca completa: o mesmo loop do optimizer-worker.js (fases determinística,
// beam e a fase extra quando sobram peças) — é o que o app entrega na tela.
function runAppFull(cs) {
  const search = Optimizer.createSearch(cs.panels, cs.stock, optsFor(cs));
  let info;
  do { info = search.step(); } while (!(info.det >= info.totalDet && info.beam && info.beam.idx >= info.beam.total));
  if (search.unplacedFeasible() > 0 && search.result().unplaced.length > 0) {
    const t0 = Date.now();
    let bestRaw = search.unplacedRaw();
    while (Date.now() - t0 < 10000) {
      info = search.step();
      const raw = search.unplacedRaw();
      if (raw < bestRaw) { bestRaw = raw; if (search.result().unplaced.length === 0) break; }
      if (info.converged) break;
    }
  }
  return search.result();
}

function timed(fn) {
  const t0 = Date.now();
  const res = fn();
  return { res, ms: Date.now() - t0 };
}

function report(cs, runs) {
  console.log(`\n=== ${cs.name} ===`);
  const linhas = [];
  runs.forEach(({ tag, res, ms }) => {
    const v = validate(cs, res);
    const m = metrics(res);
    const c = planCost(res, cs.kerf);
    linhas.push({ tag, m, ms, v, c });
    console.log(
      `  ${tag.padEnd(12)} chapas=${m.sheets} fora=${m.unplaced} · ${m.fillStr}` +
      ` · geral ${(m.overall * 100).toFixed(1)}% · ${(ms / 1000).toFixed(1)}s`);
    console.log(
      `  ${''.padEnd(12)} cortes=${c.cuts} · giros=${c.turns} · estágios=${c.stages}` +
      ` · ${c.cutsPerPiece.toFixed(2)} cortes/peça` + (c.falhas ? ` · ${c.falhas} chapa(s) sem árvore` : '') +
      (v.ok ? '' : `  ← PLANO INVÁLIDO (${v.errs.length})`));
    if (!v.ok) v.errs.slice(0, 4).forEach(e => console.log(`       ! ${e}`));
  });
  return linhas;
}

// Critério de escolha entre dois planos — o mesmo do app (better/score):
// menos peças fora, menos chapas, chapas mais cheias (lexicográfico).
function planBetter(a, b) {
  if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
  if (a.sheets !== b.sheets) return a.sheets < b.sheets;
  for (let i = 0; i < Math.max(a.fills.length, b.fills.length); i++) {
    const x = a.fills[i] || 0, y = b.fills[i] || 0;
    if (Math.abs(x - y) > 1e-6) return x > y;
  }
  return false;
}

function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const randIdx = args.indexOf('--rand');
  const cases = randIdx >= 0 ? randomCases(parseInt(args[randIdx + 1] || '20', 10)) : REAIS;

  const zero = () => ({ melhorChapas: 0, piorChapas: 0, melhorDist: 0, piorDist: 0, igual: 0 });
  const resumo = zero(), resumoHib = zero();
  let invalidos = 0;
  // custo operacional acumulado (app x experimental)
  const oper = { appCuts: 0, expCuts: 0, appTurns: 0, expTurns: 0,
    cutsMenos: 0, cutsMais: 0, cutsIgual: 0, turnsMenos: 0, turnsMais: 0, turnsIgual: 0,
    stagesApp: {}, stagesExp: {} };
  const compara = (alvo, base, acc) => {
    if (alvo.unplaced !== base.unplaced) { (alvo.unplaced < base.unplaced ? acc.melhorChapas++ : acc.piorChapas++); return; }
    if (alvo.sheets !== base.sheets) { (alvo.sheets < base.sheets ? acc.melhorChapas++ : acc.piorChapas++); return; }
    for (let i = 0; i < Math.max(alvo.fills.length, base.fills.length); i++) {
      const x = alvo.fills[i] || 0, y = base.fills[i] || 0;
      if (Math.abs(x - y) > 1e-6) { (x > y ? acc.melhorDist++ : acc.piorDist++); return; }
    }
    acc.igual++;
  };
  cases.forEach(cs => {
    const app = timed(() => (full ? runAppFull(cs) : runAppFast(cs)));
    const exp = timed(() => strip.packBest(cs));
    // híbrido: o que o app entregaria se o plano por tiras entrasse como mais
    // um candidato da busca — fica com o melhor dos dois pelo critério do app
    const expOk = validate(cs, exp.res).ok;
    const hyb = (expOk && planBetter(metrics(exp.res), metrics(app.res))) ? exp : app;
    const [a, b] = report(cs, [
      { tag: full ? 'app (busca)' : 'app (rápido)', res: app.res, ms: app.ms },
      { tag: 'experimental', res: exp.res, ms: exp.ms },
      { tag: 'híbrido', res: hyb.res, ms: app.ms + exp.ms },
    ]);
    if (!b.v.ok) { invalidos++; return; }
    compara(b.m, a.m, resumo);
    compara(metrics(hyb.res), a.m, resumoHib);
    // custo operacional só é comparável quando os planos têm o mesmo nº de chapas
    oper.appCuts += a.c.cuts; oper.expCuts += b.c.cuts;
    oper.appTurns += a.c.turns; oper.expTurns += b.c.turns;
    oper.stagesApp[a.c.stages] = (oper.stagesApp[a.c.stages] || 0) + 1;
    oper.stagesExp[b.c.stages] = (oper.stagesExp[b.c.stages] || 0) + 1;
    if (a.m.sheets === b.m.sheets && a.m.unplaced === b.m.unplaced) {
      if (b.c.cuts < a.c.cuts) oper.cutsMenos++; else if (b.c.cuts > a.c.cuts) oper.cutsMais++; else oper.cutsIgual++;
      if (b.c.turns < a.c.turns) oper.turnsMenos++; else if (b.c.turns > a.c.turns) oper.turnsMais++; else oper.turnsIgual++;
    }
  });

  const linha = (tag, acc) => console.log(
    `  ${tag}: menos chapas/fora=${acc.melhorChapas} · mais chapas/fora=${acc.piorChapas}` +
    ` · distribuição melhor=${acc.melhorDist} · pior=${acc.piorDist} · empate=${acc.igual}`);
  console.log(`\n--- resumo (${cases.length} casos), comparado ao app ---`);
  linha('experimental', resumo);
  linha('híbrido     ', resumoHib);
  if (invalidos) console.log(`  planos experimentais INVÁLIDOS: ${invalidos}`);
  console.log(`\n--- custo operacional ---`);
  console.log(`  cortes no total: app=${oper.appCuts} · experimental=${oper.expCuts}` +
    ` (${oper.appCuts ? ((oper.expCuts / oper.appCuts - 1) * 100).toFixed(1) : '0'}%)`);
  console.log(`  giros no total:  app=${oper.appTurns} · experimental=${oper.expTurns}` +
    ` (${oper.appTurns ? ((oper.expTurns / oper.appTurns - 1) * 100).toFixed(1) : '0'}%)`);
  console.log(`  por caso (mesmo nº de chapas) — cortes: exp menos=${oper.cutsMenos} mais=${oper.cutsMais} igual=${oper.cutsIgual}`);
  console.log(`  por caso (mesmo nº de chapas) — giros:  exp menos=${oper.turnsMenos} mais=${oper.turnsMais} igual=${oper.turnsIgual}`);
  const st = o => Object.keys(o).sort().map(k => `${k}:${o[k]}`).join(' ');
  console.log(`  estágios (nº de casos por profundidade): app [${st(oper.stagesApp)}] · experimental [${st(oper.stagesExp)}]`);
}

main();
