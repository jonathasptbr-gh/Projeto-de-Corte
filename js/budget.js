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
      { key: 'fitaBranca',    label: 'Fita Branca 22',  type: 'auto', price: 0.60,  qty: 0, src: 'band22White' },
      { key: 'fitaBranca45',  label: 'Fita Branca 45',  type: 'auto', price: 1.50, qty: 0, src: 'band45White' },
      { key: 'chapasCor',     label: 'Chapas de Cor',   type: 'auto', price: 419.00, qty: 0, src: 'sheetsColor' },
      { key: 'fitaCor',       label: 'Fita de Cor 22',  type: 'auto', price: 1.99, qty: 0, src: 'band22Color' },
      { key: 'fitaCor45',     label: 'Fita de Cor 45',  type: 'auto', price: 3.80, qty: 0, src: 'band45Color' },
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
  // Fita branca pela COR (hex ~ #ffffff). Aceita objeto {w,color}, ou true (legado → branco 22).
  function isWhiteBand(color) {
    return String(color || '').toLowerCase().replace('#', '').slice(0, 6) === 'ffffff';
  }
  function bandSpec(v) {
    if (!v) return null;
    if (typeof v === 'object') return { w: v.w === 45 ? 45 : 22, color: v.color || '#ffffff' };
    return { w: 22, color: '#ffffff' }; // legado boolean → branco 22
  }

  // Extrai métricas do resultado do plano de corte.
  // Fita 45 é COMPARTILHADA entre 2 peças coladas → soma das 45 dividida por 2.
  function metricsFromPlan(result, unit) {
    const div = unit === 'mm' ? 1000 : 100; // → metros
    let sheetsWhite = 0, sheetsColor = 0, pieces = 0, cuts = 0;
    let b22w = 0, b45w = 0, b22c = 0, b45c = 0; // comprimento por largura/cor

    result.sheets.forEach(s => {
      // materialWhite é gravado por relabelResult (cor hex do grupo) antes de
      // substituir a chave pelo rótulo; evita depender do nome editável pelo usuário.
      const white = s.materialWhite !== undefined ? s.materialWhite : isWhite(s.material);
      if (white) sheetsWhite++; else sheetsColor++;
      cuts += s.cuts;
      s.placements.forEach(p => {
        pieces++;
        const b = p.bands || {};
        const pw = p.realW || p.w, ph = p.realH || p.h; // medida real da peça
        const add = (v, len) => {
          const sp = bandSpec(v); if (!sp) return;
          const white = isWhiteBand(sp.color);
          if (sp.w === 45) { if (white) b45w += len; else b45c += len; }
          else { if (white) b22w += len; else b22c += len; }
        };
        // top/bottom acompanham a largura (w); left/right o comprimento (h)
        add(b.top, pw); add(b.bottom, pw); add(b.left, ph); add(b.right, ph);
      });
    });

    const m = x => Math.round((x / div) * 10) / 10;
    const band22White = m(b22w), band45White = m(b45w / 2);  // 45 ÷ 2 (fita partilhada)
    const band22Color = m(b22c), band45Color = m(b45c / 2);
    return {
      sheetsWhite, sheetsColor, pieces, cuts,
      band22White, band45White, band22Color, band45Color,
      bandMeters: Math.round((band22White + band45White + band22Color + band45Color) * 10) / 10,
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
