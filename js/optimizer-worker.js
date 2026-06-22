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
    // Posta progresso no máximo a cada 50 ms para não sobrecarregar postMessage.
    if (now - lastPost >= 50) {
      lastPost = now;
      self.postMessage({ type: 'progress', det: info.det, totalDet: info.totalDet, beam: info.beam, sinceImprove: info.sinceImprove || 0 });
    }
  } while (!info.converged);
  self.postMessage({ type: 'done', result: search.result() });
};
