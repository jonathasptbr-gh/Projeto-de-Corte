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

  // ---------- Persistência ----------
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!s) return;
      Object.assign(state.options, s.options || {});
      Object.assign(state.budgetCfg, s.budgetCfg || {});
      if (Array.isArray(s.panels)) state.panels = s.panels;
      if (Array.isArray(s.stock) && s.stock.length) state.stock = s.stock;
      if (Array.isArray(s.budgetItems)) {
        const def = Budget.defaultItems();
        state.budgetItems = def.map(d => {
          const f = s.budgetItems.find(i => i.key === d.key);
          return f ? Object.assign(d, { price: f.price, qty: f.qty }) : d;
        });
      }
    } catch (e) {}
  }

  // ---------- Utilidades ----------
  const brl = n => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numFmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('pt-BR');
  const fmtNum = v => (v || v === 0) ? String(v).replace('.', ',') : '';
  const parseNum = s => { const n = parseFloat(String(s).replace(',', '.')); return isFinite(n) ? n : 0; };
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // Material simplificado: Branco/Cor + espessura (ex.: "Branco 18mm").
  // A espessura vem da coluna do CSV (em mm); se faltar, tenta extrair do texto.
  function normalizeMaterial(raw, thMm) {
    const s = String(raw || '');
    const base = /white|branc/i.test(s) ? 'Branco' : 'Cor';
    let th = thMm > 0 ? Math.round(thMm) : 0;
    if (!th) { const m = s.match(/(\d+(?:[.,]\d+)?)\s*mm/i); if (m) th = Math.round(parseFloat(m[1].replace(',', '.'))); }
    return th ? `${base} ${th}mm` : base;
  }

  // Chave de ordenação: última letra (conjunto) primeiro, depois o resto.
  function nameSortKey(name) {
    const n = String(name || '').trim().toUpperCase();
    if (!n) return '￿';
    return n.slice(-1) + ' ' + n.slice(0, -1);
  }

  // ---------- Linhas vazias / em branco ----------
  function blankPanel() { return { length: 0, width: 0, qty: 1, material: '', name: '', grain: '', bands: {} }; }
  function blankStock() { return { width: 0, length: 0, qty: 1, material: '' }; }
  const isBlankPanel = p => !(p.length > 0) && !(p.width > 0) && !String(p.material || '').trim() && !String(p.name || '').trim();
  const isBlankStock = s => !(s.width > 0) && !(s.length > 0) && !String(s.material || '').trim();
  function ensureTrailingBlank(arr, isBlank, mk) {
    if (!arr.length || !isBlank(arr[arr.length - 1])) arr.push(mk());
  }
  const validPanels = () => state.panels.filter(p => p.length > 0 && p.width > 0);
  const validStock = () => {
    const v = state.stock.filter(s => s.width > 0 && s.length > 0);
    return v.length ? v : [{ width: 184, length: 274, qty: 999, material: '' }];
  };

  // ---------- Navegação de abas ----------
  function initTabs() {
    $('#tabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab'); if (!btn) return;
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
      if (tab === 'budget') renderBudget();
    });
  }

  // ---------- Painéis ----------
  function bandCount(p) { const b = p.bands || {}; return ['top', 'left', 'bottom', 'right'].filter(s => b[s]).length; }

  function makeFitaButton(p) {
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'fita-btn';
    refreshFitaButton(b, p);
    b.addEventListener('click', () => openBandModal(p, b));
    return b;
  }
  function refreshFitaButton(b, p) {
    const n = bandCount(p);
    b.classList.toggle('has', n > 0);
    b.innerHTML = `<span class="material-symbols-outlined">border_style</span>${n}`;
    b.title = n ? `${n} lado(s) com fita` : 'Sem fita';
  }

  function makePanelRow(p) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="cell-act"><button class="icon-btn add" title="Inserir linha acima"><span class="material-symbols-outlined">add</span></button></td>` +
      `<td class="cell-num"><input inputmode="decimal" data-f="length" placeholder="C"></td>` +
      `<td class="cell-num"><input inputmode="decimal" data-f="width" placeholder="L"></td>` +
      `<td class="cell-qty"><input inputmode="numeric" data-f="qty" placeholder="1"></td>` +
      `<td class="cell-mat"><input data-f="material" placeholder="material"></td>` +
      `<td class="cell-name"><input data-f="name" placeholder="nome"></td>` +
      `<td class="cell-fita"></td>` +
      `<td class="cell-act"><button class="icon-btn del" title="Excluir"><span class="material-symbols-outlined">delete</span></button></td>`;
    const q = s => tr.querySelector(s);
    q('[data-f="length"]').value = p.length > 0 ? fmtNum(p.length) : '';
    q('[data-f="width"]').value = p.width > 0 ? fmtNum(p.width) : '';
    q('[data-f="qty"]').value = p.qty > 0 ? p.qty : '';
    q('[data-f="material"]').value = p.material || '';
    q('[data-f="name"]').value = p.name || '';
    q('.cell-fita').appendChild(makeFitaButton(p));

    tr.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('change', () => {
      const f = inp.dataset.f;
      if (f === 'length' || f === 'width') p[f] = parseNum(inp.value);
      else if (f === 'qty') p[f] = Math.max(1, Math.round(parseNum(inp.value) || 1));
      else p[f] = inp.value.trim();
      afterRowEdit('panels');
    }));
    q('.icon-btn.add').addEventListener('click', () => insertAbove('panels', p));
    q('.icon-btn.del').addEventListener('click', () => deleteRow('panels', p));
    return tr;
  }

  function renderPanels() {
    ensureTrailingBlank(state.panels, isBlankPanel, blankPanel);
    const body = $('#panels-body');
    body.innerHTML = '';
    state.panels.forEach((p, i) => {
      const tr = makePanelRow(p);
      if (i === state.panels.length - 1) tr.classList.add('row-new');
      body.appendChild(tr);
    });
  }

  // ---------- Stock ----------
  function makeStockRow(s) {
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="cell-act"><button class="icon-btn add" title="Inserir linha acima"><span class="material-symbols-outlined">add</span></button></td>` +
      `<td class="cell-num"><input inputmode="decimal" data-f="width" placeholder="Larg."></td>` +
      `<td class="cell-num"><input inputmode="decimal" data-f="length" placeholder="Compr."></td>` +
      `<td class="cell-qty"><input inputmode="numeric" data-f="qty" placeholder="1"></td>` +
      `<td class="cell-mat"><input data-f="material" placeholder="(qualquer)"></td>` +
      `<td class="cell-act"><button class="icon-btn del" title="Excluir"><span class="material-symbols-outlined">delete</span></button></td>`;
    const q = sel => tr.querySelector(sel);
    q('[data-f="width"]').value = s.width > 0 ? fmtNum(s.width) : '';
    q('[data-f="length"]').value = s.length > 0 ? fmtNum(s.length) : '';
    q('[data-f="qty"]').value = s.qty > 0 ? s.qty : '';
    q('[data-f="material"]').value = s.material || '';
    tr.querySelectorAll('input[data-f]').forEach(inp => inp.addEventListener('change', () => {
      const f = inp.dataset.f;
      if (f === 'material') s[f] = inp.value.trim();
      else if (f === 'qty') s[f] = Math.max(1, Math.round(parseNum(inp.value) || 1));
      else s[f] = parseNum(inp.value);
      afterRowEdit('stock');
    }));
    q('.icon-btn.add').addEventListener('click', () => insertAbove('stock', s));
    q('.icon-btn.del').addEventListener('click', () => deleteRow('stock', s));
    return tr;
  }

  function renderStock() {
    ensureTrailingBlank(state.stock, isBlankStock, blankStock);
    const body = $('#stock-body');
    body.innerHTML = '';
    state.stock.forEach((s, i) => {
      const tr = makeStockRow(s);
      if (i === state.stock.length - 1) tr.classList.add('row-new');
      body.appendChild(tr);
    });
  }

  // ---------- Comportamento das listas ----------
  // Após editar uma linha: se a última deixou de ser vazia, acrescenta uma
  // nova linha vazia na base (sem re-renderizar, para preservar o foco).
  function afterRowEdit(which) {
    save();
    const arr = which === 'panels' ? state.panels : state.stock;
    const isBlank = which === 'panels' ? isBlankPanel : isBlankStock;
    const mk = which === 'panels' ? blankPanel : blankStock;
    const body = which === 'panels' ? $('#panels-body') : $('#stock-body');
    if (!isBlank(arr[arr.length - 1])) {
      const blank = mk(); arr.push(blank);
      const ntr = (which === 'panels' ? makePanelRow : makeStockRow)(blank);
      const prev = body.querySelector('tr.row-new'); if (prev) prev.classList.remove('row-new');
      ntr.classList.add('row-new');
      body.appendChild(ntr);
    }
  }
  function insertAbove(which, obj) {
    const arr = which === 'panels' ? state.panels : state.stock;
    const mk = which === 'panels' ? blankPanel : blankStock;
    const idx = arr.indexOf(obj);
    arr.splice(Math.max(0, idx), 0, mk());
    (which === 'panels' ? renderPanels : renderStock)();
    save();
    // foca o primeiro campo da nova linha
    const body = which === 'panels' ? $('#panels-body') : $('#stock-body');
    const row = body.children[Math.max(0, idx)];
    if (row) { const inp = row.querySelector('input'); if (inp) inp.focus(); }
  }
  function deleteRow(which, obj) {
    const arr = which === 'panels' ? state.panels : state.stock;
    const idx = arr.indexOf(obj); if (idx < 0) return;
    arr.splice(idx, 1);
    (which === 'panels' ? renderPanels : renderStock)();
    save();
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
  function importText(text) {
    const { panels, warnings } = CSV.parse(text);
    if (!panels.length) { toast(warnings[0] || 'CSV sem peças válidas.'); return; }
    panels.forEach(p => { p.material = normalizeMaterial(p.material, p.thickness); });
    panels.sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name), 'pt'));
    state.panels = panels;
    renderPanels(); save();
    $('#import-status').textContent = `${panels.length} peças · ${panels.reduce((a, p) => a + p.qty, 0)} un.`;
    toast('CSV importado');
  }
  function initImport() {
    $('#csv-input').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importText(reader.result);
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#clear-panels').addEventListener('click', () => {
      state.panels = []; renderPanels(); save(); $('#import-status').textContent = '';
    });
  }

  // ---------- Modal: editor de fita + grão ----------
  let editing = null;
  function openBandModal(p, btn) {
    editing = { p, btn, bands: Object.assign({ top: false, left: false, bottom: false, right: false }, p.bands), grain: p.grain || '' };
    $('#bm-title').textContent = p.name ? p.name : 'Peça';
    $('#bm-hint').textContent = `${fmtNum(p.length) || '?'} × ${fmtNum(p.width) || '?'} · toque num lado para aplicar/retirar a fita`;
    drawBandEditor();
    syncGrainSeg();
    $('#band-modal').hidden = false;
  }
  function closeBandModal() { $('#band-modal').hidden = true; editing = null; }

  function drawBandEditor() {
    const p = editing.p;
    const L = p.width > 0 ? p.width : 60;
    const C = p.length > 0 ? p.length : 40;
    const maxPx = 190, scale = maxPx / Math.max(L, C);
    const w = Math.max(48, Math.round(L * scale)), h = Math.max(48, Math.round(C * scale));
    const pad = 30, x0 = pad, y0 = pad, x1 = pad + w, y1 = pad + h;
    const ON = '#2f6f4f', OFF = '#c2ccc6';
    const b = editing.bands;
    const edge = (side, x1_, y1_, x2_, y2_) => {
      const has = b[side];
      return `<line class="edge" x1="${x1_}" y1="${y1_}" x2="${x2_}" y2="${y2_}" stroke="${has ? ON : OFF}" stroke-width="${has ? 9 : 3}" stroke-dasharray="${has ? '' : '5 5'}"/>`;
    };
    const hit = (side, x, y, ww, hh) => `<rect class="edge-hit" data-side="${side}" x="${x}" y="${y}" width="${ww}" height="${hh}"/>`;
    const svg =
      `<svg viewBox="0 0 ${w + pad * 2} ${h + pad * 2}">` +
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#f3f1e7" stroke="#9aa39d" stroke-width="1"/>` +
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="url(#g)" opacity="0.18"/>` +
      edge('top', x0, y0, x1, y0) + edge('bottom', x0, y1, x1, y1) +
      edge('left', x0, y0, x0, y1) + edge('right', x1, y0, x1, y1) +
      hit('top', x0, y0 - 14, w, 28) + hit('bottom', x0, y1 - 14, w, 28) +
      hit('left', x0 - 14, y0, 28, h) + hit('right', x1 - 14, y0, 28, h) +
      `<text x="${x0 + w / 2}" y="${y0 - 16}" text-anchor="middle" font-size="13" fill="#555">${fmtNum(L)}</text>` +
      `<text x="${x0 - 16}" y="${y0 + h / 2}" text-anchor="middle" font-size="13" fill="#555" transform="rotate(-90 ${x0 - 16} ${y0 + h / 2})">${fmtNum(C)}</text>` +
      `<defs><pattern id="g" width="4" height="4" patternUnits="userSpaceOnUse"><path d="M0 0 L0 4" stroke="#000" stroke-width="0.4"/></pattern></defs>` +
      `</svg>`;
    const c = $('#bm-canvas');
    c.innerHTML = svg;
    c.querySelectorAll('[data-side]').forEach(el => el.addEventListener('click', () => {
      const s = el.dataset.side; editing.bands[s] = !editing.bands[s]; drawBandEditor();
    }));
  }
  function syncGrainSeg() {
    $$('#bm-grain button').forEach(btn => btn.classList.toggle('active', btn.dataset.g === editing.grain));
  }
  function initBandModal() {
    $('#bm-close').addEventListener('click', closeBandModal);
    $('#bm-cancel').addEventListener('click', closeBandModal);
    $('#band-modal').addEventListener('click', e => { if (e.target.id === 'band-modal') closeBandModal(); });
    $('#bm-grain').addEventListener('click', e => {
      const btn = e.target.closest('button'); if (!btn || !editing) return;
      editing.grain = btn.dataset.g; syncGrainSeg();
    });
    $('#bm-ok').addEventListener('click', () => {
      if (!editing) return;
      editing.p.bands = Object.assign({}, editing.bands);
      editing.p.grain = editing.grain;
      refreshFitaButton(editing.btn, editing.p);
      save(); closeBandModal();
    });
  }

  // ---------- Plano de corte ----------
  function runPlan() {
    const panels = validPanels();
    if (!panels.length) { toast('Importe um CSV ou adicione peças.'); return; }
    const result = Optimizer.optimize(panels, validStock(), {
      kerf: state.options.kerf,
      considerMaterial: state.options.material,
      considerGrain: state.options.grain,
      allowRotate: state.options.rotate,
    });
    state.plan = result;

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

    const bm = result.byMaterial;
    let rows = '';
    Object.keys(bm).forEach(mat => {
      const d = bm[mat];
      const sheetArea = d.area / d.sheets;
      const minSheets = Math.max(1, Math.ceil(d.usedArea / sheetArea));
      const effMat = d.area ? (d.usedArea / d.area * 100) : 0;
      const optimal = d.sheets <= minSheets;
      rows += `<tr><td>${esc(mat)}</td><td>${d.sheets}</td><td>${minSheets}</td>` +
        `<td>${d.pieces}</td><td>${effMat.toFixed(1)}%</td>` +
        `<td>${optimal ? '<span class="ok">ótimo ✓</span>' : 'juntar'}</td></tr>`;
    });
    $('#plan-breakdown').innerHTML =
      `<table class="grid compact breakdown"><thead><tr>` +
      `<th>Material</th><th>Chapas</th><th>Mín</th><th>Peças</th><th>Aprov.</th><th>Status</th>` +
      `</tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="muted small breakdown-note">Aproveit. = área das peças ÷ (chapas × área da chapa). ` +
      `Com o nº mínimo de chapas esse % é o teto — para subir, reduza chapas (ex.: desligue ` +
      `<b>“Considerar material”</b> se forem a mesma chapa).</p>`;

    Render.renderSheets($('#plan-sheets'), result, { showLabels: state.options.labels });
    Budget.applyMetrics(state.budgetItems, m);
    save();
    toast('Plano calculado!');
  }
  function metric(k, v) { return `<div class="metric"><div class="v">${v}</div><div class="k">${k}</div></div>`; }

  // ---------- Orçamento ----------
  function renderBudget() {
    if (state.plan) Budget.applyMetrics(state.budgetItems, Budget.metricsFromPlan(state.plan, state.options.unit));
    const pieces = state.plan ? state.plan.sheets.reduce((a, s) => a + s.placements.length, 0) : 0;
    const cuts = state.plan ? state.plan.sheets.reduce((a, s) => a + s.cuts, 0) : 0;
    const m = state.plan ? Budget.metricsFromPlan(state.plan, state.options.unit) : { bandMeters: 0 };

    $('#budget-badges').innerHTML =
      `<div class="badge b1"><div class="v">${pieces}</div><div class="k">N- peças</div></div>` +
      `<div class="badge b2"><div class="v">${numFmt(m.bandMeters)}</div><div class="k">M - FITA</div></div>` +
      `<div class="badge b3"><div class="v">${cuts}</div><div class="k">C - CORTE</div></div>`;

    const body = $('#budget-body');
    body.innerHTML = '';
    state.budgetItems.forEach((it, i) => {
      const tr = document.createElement('tr');
      const auto = it.type === 'auto';
      const qtyCell = auto
        ? `<td class="auto" style="text-align:right">${numFmt(it.qty)}</td>`
        : `<td><input inputmode="decimal" step="${it.type === 'value' ? '0.01' : '1'}" value="${it.qty}" data-q="${i}"></td>`;
      tr.innerHTML = `<td>${it.label}</td>` + qtyCell +
        `<td><input inputmode="decimal" step="0.01" value="${it.price}" data-p="${i}" style="text-align:right"></td>` +
        `<td class="subtotal">${brl(Budget.subtotal(it))}</td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-q]').forEach(inp => inp.addEventListener('input', () => {
      state.budgetItems[+inp.dataset.q].qty = parseNum(inp.value); updateBudgetTotals(); save();
    }));
    body.querySelectorAll('[data-p]').forEach(inp => inp.addEventListener('input', () => {
      state.budgetItems[+inp.dataset.p].price = parseNum(inp.value); updateBudgetTotals(); save();
    }));

    const c = state.budgetCfg;
    $('#cfg-labor').value = c.laborPct; $('#cfg-markup').value = c.markupPct;
    $('#cfg-pix').value = c.pixPct; $('#cfg-days').value = c.daysPerPiece;
    updateBudgetTotals();
  }

  function updateBudgetTotals() {
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
      state.budgetCfg[key] = parseFloat(e.target.value) || 0; updateBudgetTotals(); save();
    });
    bind('#cfg-labor', 'laborPct'); bind('#cfg-markup', 'markupPct');
    bind('#cfg-pix', 'pixPct'); bind('#cfg-days', 'daysPerPiece');
  }

  // ---------- Gráfico de pizza ----------
  function renderChart() {
    const canvas = $('#chart'); if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const data = state.budgetItems.map(it => ({ label: it.label, val: Budget.subtotal(it) }))
      .filter(d => d.val > 0).sort((a, b) => b.val - a.val);
    const total = data.reduce((a, d) => a + d.val, 0);
    const legend = $('#chart-legend'); legend.innerHTML = '';
    if (!total) { ctx.fillStyle = '#999'; ctx.font = '16px sans-serif'; ctx.fillText('Sem dados de custo ainda.', 20, 40); return; }
    const colors = ['#4a90d9', '#e74c3c', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#34495e', '#95a5a6', '#d35400', '#16a085', '#c0392b'];
    const cx = H / 2, cy = H / 2, r = H / 2 - 16;
    let start = -Math.PI / 2;
    data.forEach((d, i) => {
      const ang = (d.val / total) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + ang); ctx.closePath();
      ctx.fillStyle = colors[i % colors.length]; ctx.fill(); start += ang;
      const item = document.createElement('div'); item.className = 'item';
      item.innerHTML = `<span class="sw" style="background:${colors[i % colors.length]}"></span>` +
        `<span>${d.label} — ${(d.val / total * 100).toFixed(1)}% (${brl(d.val)})</span>`;
      legend.appendChild(item);
    });
  }

  // ---------- Init ----------
  function init() {
    load();
    initTabs(); initOptions(); initImport(); initBudgetCfg(); initBandModal();
    renderPanels(); renderStock();
    $('#run-plan').addEventListener('click', runPlan);
  }
  document.addEventListener('DOMContentLoaded', init);
})();
