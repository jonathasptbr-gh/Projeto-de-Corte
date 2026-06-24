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

  const result = search.result();
  self.Optimizer.refineOffcuts(result.sheets);
  result.__refined = true;

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
