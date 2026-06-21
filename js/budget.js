/* ============================================================
 * budget.js — Orçamento alimentado pelo plano de corte.
 * Fórmulas:
 *   Entrada      = Σ subtotais de materiais
 *   Mão de obra  = Entrada × (labor%)
 *   Complexidade = K × (peças + fitas_ponderadas + cortes)
 *   Pix (base)   = Entrada + Mão de obra + Complexidade
 *   Crédito      = Pix × (1 + taxa%)
 *   Dias         = nº de peças × diasPorPeca
 * ============================================================ */
(function (global) {
  'use strict';

  // Itens padrão do orçamento (definição global; preços e ordem valem para todos os projetos).
  // type: 'auto' → qty vem do plano; 'manual' → qty × preço; 'value' → qty já é R$
  function defaultItems() {
    return [
      { key: 'chapasBrancas', label: 'Chapas Brancas',    type: 'auto',   price: 229.00, src: 'sheetsWhite' },
      { key: 'fitaBranca',    label: 'Fita Branca 22',     type: 'auto',   price: 0.60,   src: 'band22White' },
      { key: 'fitaBranca45',  label: 'Fita Branca 45',     type: 'auto',   price: 1.50,   src: 'band45White' },
      { key: 'chapasCor',     label: 'Chapas de Cor',      type: 'auto',   price: 419.00, src: 'sheetsColor' },
      { key: 'fitaCor',       label: 'Fita de Cor 22',     type: 'auto',   price: 1.99,   src: 'band22Color' },
      { key: 'fitaCor45',     label: 'Fita de Cor 45',     type: 'auto',   price: 3.80,   src: 'band45Color' },
      { key: 'fundo6mm',      label: 'Fundo 6mm',          type: 'manual', price: 139.00  },
      { key: 'pes',           label: 'Pés',                type: 'manual', price: 15.00   },
      { key: 'dobradicas',    label: 'Dobradiças',         type: 'manual', price: 9.00    },
      { key: 'sistemaCorrer', label: 'Sistema de Correr',  type: 'manual', price: 45.00   },
      { key: 'corredicas',    label: 'Corrediças',         type: 'manual', price: 19.00   },
      { key: 'puxador',       label: 'Puxador',            type: 'manual', price: 39.00   },
      { key: 'cabideiro',     label: 'Cabideiro',          type: 'manual', price: 30.00   },
      { key: 'eletrica',      label: 'Elétrica',           type: 'value',  price: 1.00    },
      { key: 'fixacao',       label: 'Fixação',            type: 'auto-value', src: 'fixacaoAuto', price: 1.00 },
      { key: 'frete',         label: 'Frete (KM)',         type: 'manual', price: 6.00    },
      { key: 'extras',        label: 'Extras',             type: 'value',  price: 1.00    },
    ];
  }

  // Configuração padrão por projeto.
  function defaultCfg() {
    return {
      laborPct:     80,
      complexidade: 0,
      daysPerUnit:  0.105,
      fixacaoRate:  0,
      entradaPct:   50,
      credit6xFee:  10,
      credit12xFee: 15,
    };
  }

  function isWhite(material) { return /branc|white/i.test(material || ''); }
  function isWhiteBand(color) {
    return String(color || '').toLowerCase().replace('#', '').slice(0, 6) === 'ffffff';
  }
  function bandSpec(v) {
    if (!v) return null;
    if (typeof v === 'object') return { w: v.w === 45 ? 45 : 22, color: v.color || '#ffffff' };
    return { w: 22, color: '#ffffff' };
  }

  // Extrai métricas do plano de corte.
  // Fita 45: compartilhada entre 2 peças → metros reais ÷ 2.
  // fitasTotal: 22mm a 1× e 45mm a 2× (mais material/trabalho).
  function metricsFromPlan(result, unit) {
    const div = unit === 'mm' ? 1000 : 100;
    let sheetsWhite = 0, sheetsColor = 0, pieces = 0, cuts = 0;
    let b22w = 0, b45w = 0, b22c = 0, b45c = 0;

    result.sheets.forEach(s => {
      const white = s.materialWhite !== undefined ? s.materialWhite : isWhite(s.material);
      if (white) sheetsWhite++; else sheetsColor++;
      cuts += s.cuts;
      s.placements.forEach(p => {
        pieces++;
        const b = p.bands || {};
        const pw = p.realW || p.w, ph = p.realH || p.h;
        const add = (v, len) => {
          const sp = bandSpec(v); if (!sp) return;
          const w = isWhiteBand(sp.color);
          if (sp.w === 45) { if (w) b45w += len; else b45c += len; }
          else             { if (w) b22w += len; else b22c += len; }
        };
        add(b.top, pw); add(b.bottom, pw); add(b.left, ph); add(b.right, ph);
      });
    });

    const m = x => Math.round((x / div) * 10) / 10;
    const band22White = m(b22w), band45White = m(b45w / 2);
    const band22Color = m(b22c), band45Color = m(b45c / 2);
    const bandMeters  = Math.round((band22White + band45White + band22Color + band45Color) * 10) / 10;
    const fitasTotal  = Math.round((band22White + band22Color + (band45White + band45Color) * 2) * 10) / 10;
    const totalN      = Math.round((pieces + fitasTotal + cuts) * 10) / 10;
    return { sheetsWhite, sheetsColor, pieces, cuts, band22White, band45White, band22Color, band45Color, bandMeters, fitasTotal, totalN };
  }

  // Subtotal de um item dado sua quantidade.
  function subtotalItem(it, qty) {
    if (it.type === 'value' || it.type === 'auto-value') return qty || 0;
    return (qty || 0) * it.price;
  }

  // Totais do orçamento.
  // items: definição global; qtys: {key:qty} por projeto; metrics: do plano; cfg: por projeto.
  function totals(items, qtys, metrics, cfg) {
    const getQty = it => (it.type === 'auto' || it.type === 'auto-value')
      ? (metrics && metrics[it.src] != null ? metrics[it.src] : 0)
      : (qtys[it.key] || 0);
    const entrada    = items.reduce((a, it) => a + subtotalItem(it, getQty(it)), 0);
    const labor      = entrada * ((cfg.laborPct || 0) / 100);
    const totalN     = (metrics && metrics.totalN) || 0;
    const pieces     = (metrics && metrics.pieces) || 0;
    const fitas      = (metrics && metrics.fitasTotal) || 0;
    const cuts       = (metrics && metrics.cuts) || 0;
    const complexTotal = (cfg.complexidade || 0) * totalN;
    const pix        = entrada + labor + complexTotal;
    const credit6x   = pix * (1 + (cfg.credit6xFee  || 0) / 100);
    const credit12x  = pix * (1 + (cfg.credit12xFee || 0) / 100);
    const entradaVal = credit6x * ((cfg.entradaPct || 0) / 100);
    const entregaVal = credit6x - entradaVal;
    const days       = totalN * (cfg.daysPerUnit || 0);
    return { entrada, labor, complexTotal, pix, credit6x, credit12x, entradaVal, entregaVal, days, totalN, pieces, fitas, cuts };
  }

  global.Budget = { defaultItems, defaultCfg, metricsFromPlan, subtotalItem, totals, isWhite };
})(window);
