// Executa o otimizador em background, liberando a thread principal para animações.
self.window = self; // optimizer.js usa (function(global){...})(window)
importScripts('./optimizer.js');

self.onmessage = function (e) {
  const { panels, stockList, options } = e.data;
  const search = self.Optimizer.createSearch(panels, stockList, options);
  let info, lastPost = 0;
  do {
    info = search.step();
    const now = Date.now();
    if (now - lastPost >= 50) {
      lastPost = now;
      self.postMessage({ type: 'progress', det: info.det, totalDet: info.totalDet, beam: info.beam });
    }
  } while (!(info.det >= info.totalDet && info.beam && info.beam.idx >= info.beam.total));

  // FASE EXTRA — só quando ainda sobraram peças sem chapa.
  // As fases determinística e beam podem terminar com peças de fora num caso que
  // TEM solução (ex.: 1 chapa com teto de estoque): quem costuma achar é a fase
  // de reinícios aleatórios do createSearch, que antes NUNCA rodava — o worker
  // parava assim que o beam acabava. Agora, se sobrou peça, insistimos por até
  // EXTRA_MS, parando assim que tudo encaixar (ou quando a busca convergir).
  const EXTRA_MS = 10000;
  if (search.unplacedFeasible() > 0 && search.result().unplaced.length > 0) {
    const t0 = Date.now();
    let bestRaw = search.unplacedRaw();
    let lastPostX = 0;
    while (Date.now() - t0 < EXTRA_MS) {
      info = search.step();
      const raw = search.unplacedRaw();
      // Só reavalia o resultado completo (caro) quando o bruto melhora.
      if (raw < bestRaw) {
        bestRaw = raw;
        if (search.result().unplaced.length === 0) break;
      }
      const now = Date.now();
      if (now - lastPostX >= 50) {
        lastPostX = now;
        self.postMessage({ type: 'progress', det: info.det, totalDet: info.totalDet, beam: info.beam,
          extra: { ms: now - t0, budget: EXTRA_MS } });
      }
      if (info.converged) break;
    }
  }

  // Fase de finalização (pós-processamento pesado: backfill, consolidações,
  // repackMerge, refino de sobras). Antes não emitia progresso → a barra travava.
  // Agora cada etapa reporta seu avanço (0..1) para a barra seguir fluindo.
  self.postMessage({ type: 'finalize_start' });
  const result = search.result(function (frac) {
    self.postMessage({ type: 'finalize', frac });
  });
  self.Optimizer.refineOffcuts(result.sheets);
  result.__refined = true;
  self.postMessage({ type: 'finalize', frac: 1 });

  // Protocolo de dois passos: sinal leve primeiro (sem dados — desserialização
  // instantânea), payload pesado só após o main thread confirmar que o overlay
  // já foi pintado. Evita freeze do RAF antes do overlay aparecer.
  self.postMessage({ type: 'done_signal' });
  self.onmessage = function (ack) {
    if (ack.data && ack.data.type === 'ready') {
      self.postMessage({ type: 'done', result });
    }
  };
};
