/* ============================================================
 * app.js — Controlador principal do PWA Projeto de Corte.
 * ============================================================ */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const STORE_KEY = 'projeto-corte-v1';

  // ---------- Estado ----------
  const state = {
    panels: [],
    stock: [{ width: 184, length: 274, qty: 5, material: '' }],
    options: { kerf: 0.8, labels: true, material: true, grain: true, rotate: true, unit: 'cm' },
    budgetItems: Budget.defaultItems(),
    budgetCfg: { laborPct: 80, markupPct: 10, pixPct: 10, daysPerPiece: 0.105 },
    plan: null,
  };

  // CSV de exemplo (lucas.csv) embutido para uso offline.
  const SAMPLE_CSV = `C,L,Q,Material,NOME,Enabled,Grain direction,Top band,Left band,Bottom band,Right band,Ordem
64.7,45.8,1,White 2 - Maple,F1,TRUE,,,,,,1f
44,13.3,4,White 1 - Maple,F1,TRUE,,,,,,1f
64.7,44,2,White 1 - Maple,F1,TRUE,,,,,,1f
64.7,44,1,White 2 - Maple,F1,TRUE,,,,,,1f
60.2,30.5,2,White 1 - Maple,F1,TRUE,,,,,,1f
74.5,8,4,White 1 - Maple,E1A,TRUE,,,,,,ae1
74.5,70,1,White 1 - Maple,L1A,TRUE,,,,,,al1
74.5,55,1,White 1 - Maple,L2A,TRUE,,,,,,al2
74.5,60,2,White 1 - Maple,L3A,TRUE,,,,,,al3
182.4,5,1,White 1 - Maple,BB,TRUE,,,,,,bb
177.4,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
106.4,47.5,1,White 1 - Maple,BB,TRUE,,,,,,bb
212.4,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
112.6,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
104.6,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
61.5,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
37.7,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
45.1,43.7,1,White 1 - Maple,BB,TRUE,,,,,,bb
106.4,5,1,White 1 - Maple,BB,TRUE,,,,,,bb
223.1,8,1,White 1 - Maple,BB,TRUE,,,,,,bb
86.8,45.5,1,White 1 - Maple,BB,TRUE,,,,,,bb
89.1,45.5,1,White 1 - Maple,BB,TRUE,,,,,,bb
226.7,47.5,1,White 1 - Maple,BB,TRUE,,,,,,bb
86,47.5,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
86,5,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
72.4,10.7,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
72.4,43.1,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
85.5,10,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
72.4,35,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
72.4,45.5,3,White 1 - Maple,L1B,TRUE,,,,,,bl1
85.5,50,1,White 1 - Maple,L1B,TRUE,,,,,,bl1
72.4,12.5,1,White 1 - Maple,L1B,TRUE,,,,,,bl1`;

  // ---------- Persistência ----------
  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {}
  }
  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      Object.assign(state.options, s.options || {});
      Object.assign(state.budgetCfg, s.budgetCfg || {});
      if (Array.isArray(s.panels)) state.panels = s.panels;
      if (Array.isArray(s.stock) && s.stock.length) state.stock = s.stock;
      if (Array.isArray(s.budgetItems)) {
        // mescla preserva chaves novas
        const def = Budget.defaultItems();
        state.budgetItems = def.map(d => {
          const found = s.budgetItems.find(i => i.key === d.key);
          return found ? Object.assign(d, { price: found.price, qty: found.qty }) : d;
        });
      }
    } catch (e) {}
  }

  // ---------- Utilidades ----------
  const brl = n => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numFmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('pt-BR');

  let toastTimer;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Navegação de abas ----------
  function initTabs() {
    $('#tabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab');
      if (!btn) return;
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
      if (tab === 'budget') renderBudget();
    });
  }

  // ---------- Painéis ----------
  function renderPanels() {
    const body = $('#panels-body');
    body.innerHTML = '';
    state.panels.forEach((p, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><input type="number" step="0.1" value="${p.length}" data-f="length"></td>` +
        `<td><input type="number" step="0.1" value="${p.width}" data-f="width"></td>` +
        `<td><input type="number" step="1" value="${p.qty}" data-f="qty"></td>` +
        `<td><input value="${attr(p.material)}" data-f="material"></td>` +
        `<td><input value="${attr(p.name)}" data-f="name"></td>` +
        `<td><select data-f="grain">
            <option value="" ${p.grain===''?'selected':''}>—</option>
            <option value="h" ${p.grain==='h'?'selected':''}>↔</option>
            <option value="v" ${p.grain==='v'?'selected':''}>↕</option>
          </select></td>` +
        `<td class="band-cell">${bandBox(p,'top')}${bandBox(p,'left')}${bandBox(p,'bottom')}${bandBox(p,'right')}</td>` +
        `<td class="col-del" data-del="${i}">✕</td>`;
      tr.querySelectorAll('[data-f]').forEach(inp => {
        inp.addEventListener('change', () => {
          const f = inp.dataset.f;
          if (f === 'length' || f === 'width' || f === 'qty') p[f] = parseFloat(inp.value) || 0;
          else p[f] = inp.value;
          save();
        });
      });
      tr.querySelectorAll('[data-band]').forEach(cb => {
        cb.addEventListener('change', () => { p.bands[cb.dataset.band] = cb.checked; save(); });
      });
      tr.querySelector('[data-del]').addEventListener('click', () => {
        state.panels.splice(i, 1); renderPanels(); save();
      });
      body.appendChild(tr);
    });
    $('#panels-empty').style.display = state.panels.length ? 'none' : 'block';
  }
  function bandBox(p, side) {
    const s = { top: 'T', left: 'E', bottom: 'B', right: 'D' }[side];
    return `<label title="${side}"><input type="checkbox" data-band="${side}" ${p.bands && p.bands[side] ? 'checked' : ''}>${s}</label>`;
  }
  function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }

  // ---------- Stock ----------
  function renderStock() {
    const body = $('#stock-body');
    body.innerHTML = '';
    state.stock.forEach((s, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML =
        `<td><input type="number" step="0.1" value="${s.width}" data-f="width"></td>` +
        `<td><input type="number" step="0.1" value="${s.length}" data-f="length"></td>` +
        `<td><input type="number" step="1" value="${s.qty}" data-f="qty"></td>` +
        `<td><input value="${attr(s.material)}" data-f="material" placeholder="(qualquer)"></td>` +
        `<td class="col-del" data-del="${i}">✕</td>`;
      tr.querySelectorAll('[data-f]').forEach(inp => inp.addEventListener('change', () => {
        const f = inp.dataset.f;
        s[f] = (f === 'material') ? inp.value : (parseFloat(inp.value) || 0);
        save();
      }));
      tr.querySelector('[data-del]').addEventListener('click', () => {
        if (state.stock.length > 1) { state.stock.splice(i, 1); renderStock(); save(); }
      });
      body.appendChild(tr);
    });
  }

  // ---------- Opções ----------
  function initOptions() {
    const o = state.options;
    $('#opt-kerf').value = o.kerf;
    $('#opt-labels').checked = o.labels;
    $('#opt-material').checked = o.material;
    $('#opt-grain').checked = o.grain;
    $('#opt-rotate').checked = o.rotate;
    $('#opt-unit').value = o.unit;
    const bind = (id, key, isNum, isBool) => $(id).addEventListener('change', e => {
      o[key] = isBool ? e.target.checked : (isNum ? parseFloat(e.target.value) || 0 : e.target.value);
      save();
    });
    bind('#opt-kerf', 'kerf', true);
    bind('#opt-labels', 'labels', false, true);
    bind('#opt-material', 'material', false, true);
    bind('#opt-grain', 'grain', false, true);
    bind('#opt-rotate', 'rotate', false, true);
    bind('#opt-unit', 'unit');
  }

  // ---------- Importação ----------
  function importText(text, label) {
    const { panels, warnings } = CSV.parse(text);
    if (warnings.length && !panels.length) { toast(warnings[0]); return; }
    state.panels = panels;
    renderPanels();
    save();
    const total = panels.reduce((a, p) => a + p.qty, 0);
    $('#import-status').textContent = `${panels.length} linhas · ${total} peças importadas`;
    toast(`Importado: ${label || 'CSV'}`);
  }

  function initImport() {
    $('#csv-input').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importText(reader.result, file.name);
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#load-sample').addEventListener('click', () => importText(SAMPLE_CSV, 'lucas.csv (exemplo)'));
    $('#clear-panels').addEventListener('click', () => {
      state.panels = []; renderPanels(); save(); $('#import-status').textContent = '';
    });
    $('#add-panel').addEventListener('click', () => {
      state.panels.push({ length: 60, width: 40, qty: 1, material: state.stock[0].material || 'Padrão', name: 'Peça', grain: '', bands: {} });
      renderPanels(); save();
    });
    $('#add-stock').addEventListener('click', () => {
      state.stock.push({ width: 184, length: 274, qty: 5, material: '' });
      renderStock(); save();
    });
  }

  // ---------- Plano de corte ----------
  function runPlan() {
    if (!state.panels.length) { toast('Importe ou adicione painéis primeiro.'); return; }
    const result = Optimizer.optimize(state.panels, state.stock, {
      kerf: state.options.kerf,
      considerMaterial: state.options.material,
      considerGrain: state.options.grain,
      allowRotate: state.options.rotate,
    });
    state.plan = result;

    // métricas globais
    const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0);
    const cuts = result.sheets.reduce((a, s) => a + s.cuts, 0);
    const totalArea = result.sheets.reduce((a, s) => a + s.W * s.H, 0);
    const usedArea = result.sheets.reduce((a, s) => a + s.placements.reduce((b, p) => b + p.w * p.h, 0), 0);
    const eff = totalArea ? (usedArea / totalArea * 100) : 0;
    const m = Budget.metricsFromPlan(result, state.options.unit);

    $('#plan-empty').style.display = 'none';
    $('#plan-metrics').innerHTML =
      metric('Chapas', result.sheets.length) +
      metric('Peças', pieces) +
      metric('Cortes', cuts) +
      metric('Fita (m)', numFmt(m.bandMeters)) +
      metric('Aproveit.', eff.toFixed(1) + '%') +
      metric('Não couberam', result.unplaced.length);

    Render.renderSheets($('#plan-sheets'), result, { showLabels: state.options.labels });

    // atualiza orçamento com dados do plano
    Budget.applyMetrics(state.budgetItems, m);
    save();
    toast('Plano calculado!');
  }
  function metric(k, v) { return `<div class="metric"><div class="v">${v}</div><div class="k">${k}</div></div>`; }

  // ---------- Orçamento ----------
  function renderBudget() {
    // garante métricas atualizadas se houver plano
    if (state.plan) Budget.applyMetrics(state.budgetItems, Budget.metricsFromPlan(state.plan, state.options.unit));

    const pieces = state.plan ? state.plan.sheets.reduce((a, s) => a + s.placements.length, 0) : 0;
    const cuts = state.plan ? state.plan.sheets.reduce((a, s) => a + s.cuts, 0) : 0;
    const m = state.plan ? Budget.metricsFromPlan(state.plan, state.options.unit) : { bandMeters: 0 };

    $('#budget-badges').innerHTML =
      `<div class="badge b1"><div class="v">${pieces}</div><div class="k">N⁠- peças</div></div>` +
      `<div class="badge b2"><div class="v">${numFmt(m.bandMeters)}</div><div class="k">M - FITA</div></div>` +
      `<div class="badge b3"><div class="v">${cuts}</div><div class="k">C - CORTE</div></div>`;

    // tabela
    const body = $('#budget-body');
    body.innerHTML = '';
    state.budgetItems.forEach((it, i) => {
      const tr = document.createElement('tr');
      const auto = it.type === 'auto';
      const qtyCell = auto
        ? `<td class="auto" style="text-align:right">${numFmt(it.qty)}</td>`
        : `<td><input type="number" step="${it.type === 'value' ? '0.01' : '1'}" value="${it.qty}" data-q="${i}"></td>`;
      tr.innerHTML =
        `<td>${it.label}</td>` +
        qtyCell +
        `<td><input type="number" step="0.01" value="${it.price}" data-p="${i}" style="text-align:right"></td>` +
        `<td class="subtotal">${brl(Budget.subtotal(it))}</td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-q]').forEach(inp => inp.addEventListener('input', () => {
      state.budgetItems[+inp.dataset.q].qty = parseFloat(inp.value) || 0;
      updateBudgetTotals(); save();
    }));
    body.querySelectorAll('[data-p]').forEach(inp => inp.addEventListener('input', () => {
      state.budgetItems[+inp.dataset.p].price = parseFloat(inp.value) || 0;
      updateBudgetTotals(); save();
    }));

    // config condições
    const c = state.budgetCfg;
    $('#cfg-labor').value = c.laborPct;
    $('#cfg-markup').value = c.markupPct;
    $('#cfg-pix').value = c.pixPct;
    $('#cfg-days').value = c.daysPerPiece;

    updateBudgetTotals();
  }

  function updateBudgetTotals() {
    // recalcula subtotais visíveis
    $$('#budget-body tr').forEach((tr, i) => {
      tr.querySelector('.subtotal').textContent = brl(Budget.subtotal(state.budgetItems[i]));
    });

    const t = Budget.totals(state.budgetItems, state.budgetCfg);
    const pieces = state.plan ? state.plan.sheets.reduce((a, s) => a + s.placements.length, 0) : 0;
    const days = pieces * state.budgetCfg.daysPerPiece;

    $('#conditions-table').innerHTML =
      row('Tempo de produção', (Math.round(days * 10) / 10).toLocaleString('pt-BR') + ' Dias') +
      row('Valor de Entrada', brl(t.entrada)) +
      row('Mão de obra', brl(t.labor)) +
      `<tr class="total">${cell('Valor total')}${cell(brl(t.total))}</tr>` +
      `<tr class="total">${cell('Valor Pix')}${cell(brl(t.pix))}</tr>`;

    renderChart();
  }
  function row(k, v) { return `<tr>${cell(k)}${cell(v)}</tr>`; }
  function cell(v) { return `<td>${v}</td>`; }

  function initBudgetCfg() {
    const bind = (id, key) => $(id).addEventListener('input', e => {
      state.budgetCfg[key] = parseFloat(e.target.value) || 0;
      updateBudgetTotals(); save();
    });
    bind('#cfg-labor', 'laborPct');
    bind('#cfg-markup', 'markupPct');
    bind('#cfg-pix', 'pixPct');
    bind('#cfg-days', 'daysPerPiece');
  }

  // ---------- Gráfico de pizza (custo por material) ----------
  function renderChart() {
    const canvas = $('#chart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    const data = state.budgetItems
      .map(it => ({ label: it.label, val: Budget.subtotal(it) }))
      .filter(d => d.val > 0)
      .sort((a, b) => b.val - a.val);
    const total = data.reduce((a, d) => a + d.val, 0);
    const legend = $('#chart-legend');
    legend.innerHTML = '';
    if (!total) { ctx.fillStyle = '#999'; ctx.font = '16px sans-serif'; ctx.fillText('Sem dados de custo ainda.', 20, 40); return; }

    const colors = ['#4a90d9', '#e74c3c', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#34495e', '#95a5a6', '#d35400', '#16a085', '#c0392b'];
    const cx = H / 2, cy = H / 2, r = H / 2 - 16;
    let start = -Math.PI / 2;
    data.forEach((d, i) => {
      const ang = (d.val / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, start, start + ang);
      ctx.closePath();
      ctx.fillStyle = colors[i % colors.length];
      ctx.fill();
      start += ang;

      const pct = (d.val / total * 100).toFixed(1);
      const item = document.createElement('div');
      item.className = 'item';
      item.innerHTML = `<span class="sw" style="background:${colors[i % colors.length]}"></span>` +
        `<span>${d.label} — ${pct}% (${brl(d.val)})</span>`;
      legend.appendChild(item);
    });
  }

  // ---------- Init ----------
  function init() {
    load();
    initTabs();
    initOptions();
    initImport();
    initBudgetCfg();
    renderPanels();
    renderStock();
    $('#run-plan').addEventListener('click', runPlan);
    if (!state.panels.length) {
      // primeira execução: deixa o exemplo pronto para o usuário
      $('#import-status').textContent = 'Dica: use “Carregar exemplo” para testar.';
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
