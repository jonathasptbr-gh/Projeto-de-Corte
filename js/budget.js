/* ============================================================
 * budget.js — Orçamento alimentado pelo plano de corte.
 * Fórmulas (derivadas da planilha de referência):
 *   Entrada      = Σ subtotais de materiais
 *   Mão de obra  = Entrada × (labor%)
 *   Total        = (Entrada + Mão de obra) × (1 + markup%)
 *   Pix          = Total × (1 − descontoPix%)
 *   Dias         = nº de peças × diasPorPeca
 * ============================================================ */
(function (global) {
  'use strict';

  // Itens padrão do orçamento. type:
  //   auto   → quantidade vem do plano de corte (não editável)
  //   manual → quantidade editável (multiplica pelo preço)
  //   value  → o campo "quant." é um valor em R$ (preço = 1)
  function defaultItems() {
    return [
      { key: 'chapasBrancas', label: 'Chapas Brancas', type: 'auto', price: 229.00, qty: 0, src: 'sheetsWhite' },
      { key: 'fitaBranca',    label: 'Fita Branca',     type: 'auto', price: 0.60,  qty: 0, src: 'bandMeters' },
      { key: 'fitaBranca45',  label: 'Fita Branca 45',  type: 'manual', price: 1.50, qty: 0 },
      { key: 'chapasCor',     label: 'Chapas de Cor',   type: 'auto', price: 419.00, qty: 0, src: 'sheetsColor' },
      { key: 'fitaCor',       label: 'Fita de Cor',     type: 'manual', price: 1.99, qty: 0 },
      { key: 'fitaCor45',     label: 'Fita de Cor 45',  type: 'manual', price: 3.80, qty: 0 },
      { key: 'fundo6mm',      label: 'Fundo 6mm',       type: 'manual', price: 139.00, qty: 0 },
      { key: 'pes',           label: 'Pés',             type: 'manual', price: 15.00, qty: 0 },
      { key: 'dobradicas',    label: 'Dobradiças',      type: 'manual', price: 9.00,  qty: 0 },
      { key: 'sistemaCorrer', label: 'Sistema de Correr', type: 'manual', price: 45.00, qty: 0 },
      { key: 'corredicas',    label: 'Corrediças',      type: 'manual', price: 19.00, qty: 0 },
      { key: 'puxador',       label: 'Puxador',         type: 'manual', price: 39.00, qty: 0 },
      { key: 'cabideiro',     label: 'Cabideiro',       type: 'manual', price: 30.00, qty: 0 },
      { key: 'eletrica',      label: 'Elétrica',        type: 'value',  price: 1.00, qty: 0 },
      { key: 'fixacao',       label: 'Fixação',         type: 'value',  price: 1.00, qty: 0 },
      { key: 'frete',         label: 'Frete (KM)',      type: 'manual', price: 6.00, qty: 0 },
      { key: 'extras',        label: 'Extras',          type: 'value',  price: 1.00, qty: 0 },
    ];
  }

  function isWhite(material) {
    return /branc|white/i.test(material || '');
  }

  // Extrai métricas do resultado do plano de corte.
  function metricsFromPlan(result, unit) {
    const div = unit === 'mm' ? 1000 : 100; // → metros
    let sheetsWhite = 0, sheetsColor = 0, pieces = 0, cuts = 0, bandLen = 0;

    result.sheets.forEach(s => {
      if (isWhite(s.material)) sheetsWhite++; else sheetsColor++;
      cuts += s.cuts;
      s.placements.forEach(p => {
        pieces++;
        const b = p.bands || {};
        // top/bottom acompanham a largura (w); left/right o comprimento (h)
        if (b.top) bandLen += p.w;
        if (b.bottom) bandLen += p.w;
        if (b.left) bandLen += p.h;
        if (b.right) bandLen += p.h;
      });
    });

    return {
      sheetsWhite, sheetsColor,
      pieces, cuts,
      bandMeters: Math.round((bandLen / div) * 10) / 10,
    };
  }

  // Aplica as métricas do plano nos itens "auto".
  function applyMetrics(items, metrics) {
    items.forEach(it => {
      if (it.type === 'auto' && it.src && metrics[it.src] != null) {
        it.qty = metrics[it.src];
      }
    });
  }

  function subtotal(it) {
    if (it.type === 'value') return it.qty;          // campo já é o valor
    return it.qty * it.price;
  }

  function totals(items, cfg) {
    const entrada = items.reduce((a, it) => a + subtotal(it), 0);
    const labor = entrada * (cfg.laborPct / 100);
    const total = (entrada + labor) * (1 + cfg.markupPct / 100);
    const pix = total * (1 - cfg.pixPct / 100);
    return { entrada, labor, total, pix };
  }

  global.Budget = { defaultItems, metricsFromPlan, applyMetrics, subtotal, totals, isWhite };
})(window);
