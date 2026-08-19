/* ============================================================
 * lab/pareto.js — área × custo de execução.
 *
 * Responde à pergunta prática: "quanto de aproveitamento eu perco se
 * pedir um plano mais simples de cortar?" Roda três estratégias sobre
 * os mesmos projetos e mede as duas dimensões:
 *
 *   app          — o otimizador atual (busca rápida ou completa)
 *   tiras/área   — o experimental escolhendo o plano por aproveitamento
 *   tiras/oper   — o experimental escolhendo o plano por custo de
 *                  execução (menos giros de 90°, menos cortes, menos
 *                  estágios) entre os que empatam em chapas
 *
 *   node lab/pareto.js            → casos reais
 *   node lab/pareto.js --rand 30  → 30 aleatórios determinísticos
 *   node lab/pareto.js --full     → app com busca completa (mais lento)
 * ============================================================ */
'use strict';

const fs = require('fs');
const path = require('path');
const { REAIS, randomCases } = require('./cases');
const { validate, metrics } = require('./validate');
const { planCost } = require('./cutplan');
const strip = require('./strip-packer');

const Optimizer = new Function('window',
  fs.readFileSync(path.join(__dirname, '..', 'js', 'optimizer.js'), 'utf8') + '\n;return window.Optimizer;')({});

const optsFor = cs => ({
  kerf: cs.kerf, considerMaterial: true, considerGrain: true, allowRotate: true,
  weights: Optimizer.defaultWeights(),
});

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

function main() {
  const args = process.argv.slice(2);
  const full = args.includes('--full');
  const ri = args.indexOf('--rand');
  const cases = ri >= 0 ? randomCases(parseInt(args[ri + 1] || '20', 10)) : REAIS;

  const acc = {
    app: { cuts: 0, turns: 0, top: 0, last: 0, stages: [] },
    area: { cuts: 0, turns: 0, top: 0, last: 0, stages: [] },
    oper: { cuts: 0, turns: 0, top: 0, last: 0, stages: [] },
  };
  let sheetsIguais = 0, invalidos = 0;

  // Com o mesmo nº de chapas o aproveitamento GLOBAL é sempre igual (mesma área
  // em mesmas chapas) — o que varia é a distribuição. Medimos a chapa mais cheia
  // e o quanto de chapa livre sobra na mais vazia (sobra concentrada = boa).
  console.log('caso'.padEnd(26) + 'estratégia'.padEnd(14) + 'ch'.padEnd(4) +
    '1ª chapa'.padEnd(10) + 'sobra últ.'.padEnd(12) + 'cortes'.padEnd(8) + 'giros'.padEnd(7) + 'estágios');
  cases.forEach(cs => {
    const runs = {
      app: full ? runAppFull(cs) : Optimizer.optimize(cs.panels, cs.stock, optsFor(cs)),
      area: strip.packBest(cs, { objective: 'area' }),
      oper: strip.packBest(cs, { objective: 'oper' }),
    };
    const m = {}, c = {};
    Object.keys(runs).forEach(k => {
      if (k !== 'app' && !validate(cs, runs[k]).ok) invalidos++;
      m[k] = metrics(runs[k]);
      c[k] = planCost(runs[k], cs.kerf);
      console.log(cs.name.slice(0, 24).padEnd(26) + k.padEnd(14) +
        String(m[k].sheets).padEnd(4) + ((m[k].fills[0] || 0) * 100).toFixed(1).padEnd(10) +
        (m[k].lastFree * 100).toFixed(1).padEnd(12) +
        String(c[k].cuts).padEnd(8) + String(c[k].turns).padEnd(7) + c[k].stages);
    });
    // só acumula quando as três usaram o mesmo nº de chapas (comparação justa)
    if (m.app.sheets === m.area.sheets && m.app.sheets === m.oper.sheets &&
        m.app.unplaced === m.area.unplaced && m.app.unplaced === m.oper.unplaced) {
      sheetsIguais++;
      Object.keys(runs).forEach(k => {
        acc[k].cuts += c[k].cuts; acc[k].turns += c[k].turns;
        acc[k].top += (m[k].fills[0] || 0); acc[k].last += m[k].lastFree;
        acc[k].stages.push(c[k].stages);
      });
    }
  });

  const med = a => a.length ? (a.reduce((x, y) => x + y, 0) / a.length) : 0;
  const max = a => a.length ? Math.max.apply(null, a) : 0;
  console.log(`\n--- agregado sobre ${sheetsIguais} caso(s) com o mesmo nº de chapas ---`);
  ['app', 'area', 'oper'].forEach(k => {
    const a = acc[k];
    const n = sheetsIguais || 1;
    console.log(`  ${k.padEnd(5)} 1ª chapa ${(a.top / n * 100).toFixed(1)}%` +
      ` · sobra na última ${(a.last / n * 100).toFixed(1)}%` +
      ` · cortes ${a.cuts} · giros ${a.turns}` +
      ` · estágios médio ${med(a.stages).toFixed(1)} (máx ${max(a.stages)})`);
  });
  const rel = (x, base) => base ? ((x / base - 1) * 100).toFixed(1) + '%' : '—';
  console.log(`\n  tiras/oper vs app:        1ª chapa ${rel(acc.oper.top, acc.app.top)}` +
    ` · cortes ${rel(acc.oper.cuts, acc.app.cuts)} · giros ${rel(acc.oper.turns, acc.app.turns)}`);
  console.log(`  tiras/oper vs tiras/área: 1ª chapa ${rel(acc.oper.top, acc.area.top)}` +
    ` · cortes ${rel(acc.oper.cuts, acc.area.cuts)} · giros ${rel(acc.oper.turns, acc.area.turns)}`);
  console.log(`  tiras/área vs app:        1ª chapa ${rel(acc.area.top, acc.app.top)}` +
    ` · cortes ${rel(acc.area.cuts, acc.app.cuts)} · giros ${rel(acc.area.turns, acc.app.turns)}`);
  if (invalidos) console.log(`\n  planos experimentais inválidos: ${invalidos}`);
}

main();
