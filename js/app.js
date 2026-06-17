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
    options: { kerf: 0.8, labels: true, material: true, grain: true },
    budgetItems: Budget.defaultItems(),
    budgetCfg: { laborPct: 80, markupPct: 10, pixPct: 10, daysPerPiece: 0.105 },
    plan: null,
  };

  // seleção rápida
  let selectMode = false;
  const selected = new Set();

  // ---------- Persistência ----------
  function save() { try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) {} }
  function load() {
    try {
      const s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (!s) return;
      Object.assign(state.options, s.options || {});
      delete state.options.unit; delete state.options.rotate; // removidos
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
  function attr(s) { return String(s == null ? '' : s).replace(/"/g, '&quot;'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  function normalizeMaterial(raw, thMm) {
    const s = String(raw || '');
    const base = /white|branc/i.test(s) ? 'Branco' : 'Cor';
    let th = thMm > 0 ? Math.round(thMm) : 0;
    if (!th) { const m = s.match(/(\d+(?:[.,]\d+)?)\s*mm/i); if (m) th = Math.round(parseFloat(m[1].replace(',', '.'))); }
    return th ? `${base} ${th}mm` : base;
  }
  function nameSortKey(name) {
    const n = String(name || '').trim().toUpperCase();
    if (!n) return '￿';
    return n.slice(-1) + ' ' + n.slice(0, -1);
  }

  // ---------- Linhas em branco ----------
  function blankPanel() { return { length: 0, width: 0, qty: 1, material: '', name: '', grain: '', bands: {} }; }
  function blankStock() { return { width: 0, length: 0, qty: 1, material: '' }; }
  const isBlankPanel = p => !(p.length > 0) && !(p.width > 0) && !String(p.material || '').trim() && !String(p.name || '').trim();
  const isBlankStock = s => !(s.width > 0) && !(s.length > 0) && !String(s.material || '').trim();
  function ensureTrailingBlank(arr, isBlank, mk) { if (!arr.length || !isBlank(arr[arr.length - 1])) arr.push(mk()); }
  const validPanels = () => state.panels.filter(p => p.length > 0 && p.width > 0);
  const validStock = () => {
    const v = state.stock.filter(s => s.width > 0 && s.length > 0);
    return v.length ? v : [{ width: 184, length: 274, qty: 999, material: '' }];
  };

  // Lista de materiais (das peças + estoques) para os seletores.
  function materialsList() {
    const set = new Set();
    state.panels.forEach(p => { if (p.material) set.add(p.material); });
    state.stock.forEach(s => { if (s.material) set.add(s.material); });
    return [...set].sort((a, b) => a.localeCompare(b, 'pt'));
  }
  // Cria/garante um estoque para cada material das peças.
  function syncStockToMaterials() {
    const mats = [...new Set(state.panels.filter(p => p.material).map(p => p.material))];
    if (!mats.length) return;
    const existing = {}; state.stock.forEach(s => { if (s.material) existing[s.material] = s; });
    state.stock = mats.sort((a, b) => a.localeCompare(b, 'pt'))
      .map(m => existing[m] || { width: 184, length: 274, qty: 99, material: m });
  }

  // ---------- Construtores de células ----------
  function iconBtn(cls, icon, title, onClick) {
    const b = el('button', 'icon-btn ' + cls); b.type = 'button'; if (title) b.title = title;
    b.innerHTML = `<span class="material-symbols-outlined">${icon}</span>`;
    b.addEventListener('click', onClick); return b;
  }
  function numInput(val, ph, mode, onCh) {
    const i = document.createElement('input'); i.inputMode = mode || 'decimal'; i.placeholder = ph || '';
    i.value = val > 0 ? fmtNum(val) : ''; i.addEventListener('change', () => onCh(i.value)); return i;
  }
  function txtInput(val, ph, onCh) {
    const i = document.createElement('input'); i.placeholder = ph || ''; i.value = val || '';
    i.addEventListener('change', () => onCh(i.value)); return i;
  }
  // Seletor de material (lista dinâmica) ou input se ainda não há materiais.
  function materialControl(obj, onCh) {
    const list = materialsList();
    let c;
    if (list.length) {
      c = document.createElement('select');
      const cur = obj.material || '';
      const opts = list.includes(cur) || !cur ? list : list.concat([cur]);
      c.innerHTML = `<option value=""></option>` +
        opts.map(m => `<option value="${attr(m)}"${m === cur ? ' selected' : ''}>${esc(m)}</option>`).join('');
      c.value = cur;
    } else {
      c = document.createElement('input'); c.placeholder = 'material'; c.value = obj.material || '';
    }
    c.addEventListener('change', () => onCh(c.value));
    return c;
  }

  // ---------- Fita (popup) ----------
  function bandCount(p) { const b = p.bands || {}; return ['top', 'left', 'bottom', 'right'].filter(s => b[s]).length; }
  function makeFitaButton(p) {
    const b = el('button', 'fita-btn'); b.type = 'button';
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

  // ---------- Painéis ----------
  function makePanelRow(p) {
    const tr = el('tr');
    // seleção
    const tdSel = el('td', 'cell-sel');
    const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(p);
    cb.addEventListener('change', () => { cb.checked ? selected.add(p) : selected.delete(p); updateSelAll(); });
    tdSel.appendChild(cb); tr.appendChild(tdSel);
    // +
    const tdAdd = el('td', 'cell-act'); tdAdd.appendChild(iconBtn('add', 'add', 'Inserir acima', () => insertAbove('panels', p))); tr.appendChild(tdAdd);
    // largura, comprimento (largura primeiro!)
    const tdW = el('td', 'cell-num'); tdW.appendChild(numInput(p.width, 'L', 'decimal', v => onPanelField(p, 'width', v))); tr.appendChild(tdW);
    const tdL = el('td', 'cell-num'); tdL.appendChild(numInput(p.length, 'C', 'decimal', v => onPanelField(p, 'length', v))); tr.appendChild(tdL);
    // qtd
    const tdQ = el('td', 'cell-qty'); tdQ.appendChild(numInput(p.qty, '1', 'numeric', v => onPanelField(p, 'qty', v))); tr.appendChild(tdQ);
    // material
    const tdM = el('td', 'cell-mat'); tdM.appendChild(materialControl(p, v => onPanelField(p, 'material', v))); tr.appendChild(tdM);
    // nome
    const tdN = el('td', 'cell-name'); tdN.appendChild(txtInput(p.name, 'nome', v => onPanelField(p, 'name', v))); tr.appendChild(tdN);
    // fita
    const tdF = el('td', 'cell-fita'); tdF.appendChild(makeFitaButton(p)); tr.appendChild(tdF);
    // del
    const tdD = el('td', 'cell-act'); tdD.appendChild(iconBtn('del', 'delete', 'Excluir', () => deleteRow('panels', p))); tr.appendChild(tdD);
    return tr;
  }
  function applyPanelField(p, f, value) {
    if (f === 'length' || f === 'width') p[f] = parseNum(value);
    else if (f === 'qty') p[f] = Math.max(1, Math.round(parseNum(value) || 1));
    else p[f] = String(value).trim();
  }
  // Edita um campo; com seleção rápida ativa, replica para todas selecionadas.
  function onPanelField(p, f, value) {
    applyPanelField(p, f, value);
    if (selectMode && selected.has(p) && selected.size > 1) {
      selected.forEach(q => { if (q !== p) applyPanelField(q, f, value); });
      save(); renderPanels();
    } else { save(); afterRowEdit('panels'); }
  }
  function renderPanels() {
    ensureTrailingBlank(state.panels, isBlankPanel, blankPanel);
    const body = $('#panels-body'); body.innerHTML = '';
    $('#panels-table').classList.toggle('select-mode', selectMode);
    state.panels.forEach((p, i) => {
      const tr = makePanelRow(p);
      if (i === state.panels.length - 1) tr.classList.add('row-new');
      body.appendChild(tr);
    });
    updateSelAll();
  }

  // ---------- Stock ----------
  function makeStockRow(s) {
    const tr = el('tr');
    const tdAdd = el('td', 'cell-act'); tdAdd.appendChild(iconBtn('add', 'add', 'Inserir acima', () => insertAbove('stock', s))); tr.appendChild(tdAdd);
    const tdW = el('td', 'cell-num'); tdW.appendChild(numInput(s.width, 'Larg.', 'decimal', v => onStockField(s, 'width', v))); tr.appendChild(tdW);
    const tdL = el('td', 'cell-num'); tdL.appendChild(numInput(s.length, 'Compr.', 'decimal', v => onStockField(s, 'length', v))); tr.appendChild(tdL);
    const tdQ = el('td', 'cell-qty'); tdQ.appendChild(numInput(s.qty, '1', 'numeric', v => onStockField(s, 'qty', v))); tr.appendChild(tdQ);
    const tdM = el('td', 'cell-mat'); tdM.appendChild(materialControl(s, v => onStockField(s, 'material', v))); tr.appendChild(tdM);
    const tdD = el('td', 'cell-act'); tdD.appendChild(iconBtn('del', 'delete', 'Excluir', () => deleteRow('stock', s))); tr.appendChild(tdD);
    return tr;
  }
  function onStockField(s, f, value) {
    if (f === 'material') s[f] = String(value).trim();
    else if (f === 'qty') s[f] = Math.max(1, Math.round(parseNum(value) || 1));
    else s[f] = parseNum(value);
    save(); afterRowEdit('stock');
  }
  function renderStock() {
    ensureTrailingBlank(state.stock, isBlankStock, blankStock);
    const body = $('#stock-body'); body.innerHTML = '';
    state.stock.forEach((s, i) => {
      const tr = makeStockRow(s);
      if (i === state.stock.length - 1) tr.classList.add('row-new');
      body.appendChild(tr);
    });
  }

  // ---------- Comportamento comum das listas ----------
  function afterRowEdit(which) {
    const arr = which === 'panels' ? state.panels : state.stock;
    const isBlank = which === 'panels' ? isBlankPanel : isBlankStock;
    const mk = which === 'panels' ? blankPanel : blankStock;
    const body = which === 'panels' ? $('#panels-body') : $('#stock-body');
    if (!isBlank(arr[arr.length - 1])) {
      const blank = mk(); arr.push(blank);
      const ntr = (which === 'panels' ? makePanelRow : makeStockRow)(blank);
      const prev = body.querySelector('tr.row-new'); if (prev) prev.classList.remove('row-new');
      ntr.classList.add('row-new'); body.appendChild(ntr);
    }
  }
  function insertAbove(which, obj) {
    const arr = which === 'panels' ? state.panels : state.stock;
    const mk = which === 'panels' ? blankPanel : blankStock;
    const idx = Math.max(0, arr.indexOf(obj));
    arr.splice(idx, 0, mk());
    (which === 'panels' ? renderPanels : renderStock)(); save();
    const body = which === 'panels' ? $('#panels-body') : $('#stock-body');
    const row = body.children[idx + (which === 'panels' && selectMode ? 0 : 0)];
    if (row) { const inp = row.querySelector('input:not([type=checkbox])'); if (inp) inp.focus(); }
  }
  function deleteRow(which, obj) {
    const arr = which === 'panels' ? state.panels : state.stock;
    const idx = arr.indexOf(obj); if (idx < 0) return;
    selected.delete(obj);
    arr.splice(idx, 1);
    (which === 'panels' ? renderPanels : renderStock)(); save();
  }

  // ---------- Seleção rápida ----------
  function updateSelAll() {
    const all = state.panels.filter(p => !isBlankPanel(p));
    const selAll = $('#sel-all'); if (!selAll) return;
    const n = all.filter(p => selected.has(p)).length;
    selAll.checked = all.length > 0 && n === all.length;
    selAll.indeterminate = n > 0 && n < all.length;
  }
  function initSelect() {
    $('#toggle-select').addEventListener('click', () => {
      selectMode = !selectMode; selected.clear();
      $('#toggle-select').classList.toggle('active', selectMode);
      renderPanels();
      toast(selectMode ? 'Seleção rápida ligada' : 'Seleção rápida desligada');
    });
    $('#sel-all').addEventListener('change', () => {
      selected.clear();
      if ($('#sel-all').checked) state.panels.filter(p => !isBlankPanel(p)).forEach(p => selected.add(p));
      renderPanels();
    });
  }

  // ---------- Opções ----------
  function initOptions() {
    const o = state.options;
    $('#opt-kerf').value = o.kerf;
    $('#opt-labels').checked = o.labels;
    $('#opt-material').checked = o.material;
    $('#opt-grain').checked = o.grain;
    const bind = (id, key, isNum, isBool) => $(id).addEventListener('change', e => {
      o[key] = isBool ? e.target.checked : (isNum ? parseFloat(e.target.value) || 0 : e.target.value);
      save();
      if (state.plan) runPlan(true); // reflete a opção no resultado imediatamente
    });
    bind('#opt-kerf', 'kerf', true);
    bind('#opt-labels', 'labels', false, true);
    bind('#opt-material', 'material', false, true);
    bind('#opt-grain', 'grain', false, true);
  }

  // ---------- Importação ----------
  function importText(text) {
    const { panels, warnings } = CSV.parse(text);
    if (!panels.length) { toast(warnings[0] || 'CSV sem peças válidas.'); return; }
    panels.forEach(p => { p.material = normalizeMaterial(p.material, p.thickness); });
    panels.sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name), 'pt'));
    state.panels = panels;
    selected.clear();
    syncStockToMaterials();
    renderPanels(); renderStock(); save();
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
      state.panels = []; selected.clear(); renderPanels(); save(); $('#import-status').textContent = '';
    });
  }

  // ---------- Modal: editor de fita + grão ----------
  let editing = null;
  function openBandModal(p, btn) {
    editing = { p, btn, bands: Object.assign({ top: false, left: false, bottom: false, right: false }, p.bands), grain: p.grain || '' };
    $('#bm-title').textContent = p.name ? p.name : 'Peça';
    $('#bm-hint').textContent = `${fmtNum(p.width) || '?'} × ${fmtNum(p.length) || '?'} · toque num lado para aplicar/retirar a fita`;
    drawBandEditor(); syncGrainSeg();
    $('#band-modal').hidden = false;
  }
  function closeBandModal() { $('#band-modal').hidden = true; editing = null; }
  function drawBandEditor() {
    const p = editing.p;
    const L = p.width > 0 ? p.width : 60, C = p.length > 0 ? p.length : 40;
    const maxPx = 190, scale = maxPx / Math.max(L, C);
    const w = Math.max(48, Math.round(L * scale)), h = Math.max(48, Math.round(C * scale));
    const pad = 30, x0 = pad, y0 = pad, x1 = pad + w, y1 = pad + h;
    const ON = '#2f6f4f', OFF = '#c2ccc6', b = editing.bands;
    const edge = (s, ax, ay, bx, by) => `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${b[s] ? ON : OFF}" stroke-width="${b[s] ? 9 : 3}" stroke-dasharray="${b[s] ? '' : '5 5'}" stroke-linecap="round"/>`;
    const hit = (s, x, y, ww, hh) => `<rect class="edge-hit" data-side="${s}" x="${x}" y="${y}" width="${ww}" height="${hh}"/>`;
    const svg =
      `<svg viewBox="0 0 ${w + pad * 2} ${h + pad * 2}">` +
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#f3f1e7" stroke="#9aa39d"/>` +
      edge('top', x0, y0, x1, y0) + edge('bottom', x0, y1, x1, y1) + edge('left', x0, y0, x0, y1) + edge('right', x1, y0, x1, y1) +
      hit('top', x0, y0 - 14, w, 28) + hit('bottom', x0, y1 - 14, w, 28) + hit('left', x0 - 14, y0, 28, h) + hit('right', x1 - 14, y0, 28, h) +
      `<text x="${x0 + w / 2}" y="${y0 - 16}" text-anchor="middle" font-size="13" fill="#555">${fmtNum(L)}</text>` +
      `<text x="${x0 - 16}" y="${y0 + h / 2}" text-anchor="middle" font-size="13" fill="#555" transform="rotate(-90 ${x0 - 16} ${y0 + h / 2})">${fmtNum(C)}</text>` +
      `</svg>`;
    const c = $('#bm-canvas'); c.innerHTML = svg;
    c.querySelectorAll('[data-side]').forEach(el2 => el2.addEventListener('click', () => {
      const s = el2.dataset.side; editing.bands[s] = !editing.bands[s]; drawBandEditor();
    }));
  }
  function syncGrainSeg() { $$('#bm-grain button').forEach(btn => btn.classList.toggle('active', btn.dataset.g === editing.grain)); }
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
      const apply = q => { q.bands = Object.assign({}, editing.bands); q.grain = editing.grain; };
      apply(editing.p);
      if (selectMode && selected.has(editing.p) && selected.size > 1) {
        selected.forEach(q => { if (q !== editing.p) apply(q); });
        save(); closeBandModal(); renderPanels(); return;
      }
      refreshFitaButton(editing.btn, editing.p);
      save(); closeBandModal();
    });
  }

  // ---------- Plano de corte ----------
  function runPlan(silent) {
    const panels = validPanels();
    if (!panels.length) { if (!silent) toast('Importe um CSV ou adicione peças.'); return; }
    const result = Optimizer.optimize(panels, validStock(), {
      kerf: state.options.kerf,
      considerMaterial: state.options.material,
      considerGrain: state.options.grain,
      allowRotate: true, // rotação livre, limitada apenas pela direção do grão
    });
    state.plan = result;

    const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0);
    const cuts = result.sheets.reduce((a, s) => a + s.cuts, 0);
    const totalArea = result.sheets.reduce((a, s) => a + s.W * s.H, 0);
    const usedArea = result.sheets.reduce((a, s) => a + s.placements.reduce((b, p) => b + p.w * p.h, 0), 0);
    const eff = totalArea ? (usedArea / totalArea * 100) : 0;
    const m = Budget.metricsFromPlan(result, 'cm');

    $('#plan-empty').style.display = 'none';
    $('#plan-metrics').innerHTML =
      metric('Chapas', result.sheets.length) + metric('Peças', pieces) + metric('Cortes', cuts) +
      metric('Fita (m)', numFmt(m.bandMeters)) + metric('Aproveit.', eff.toFixed(1) + '%') +
      metric('Não couberam', result.unplaced.length);

    const bm = result.byMaterial; let rows = '';
    Object.keys(bm).forEach(mat => {
      const d = bm[mat];
      const minSheets = Math.max(1, Math.ceil(d.usedArea / (d.area / d.sheets)));
      const effMat = d.area ? (d.usedArea / d.area * 100) : 0;
      const optimal = d.sheets <= minSheets;
      rows += `<tr><td>${esc(mat)}</td><td>${d.sheets}</td><td>${minSheets}</td><td>${d.pieces}</td>` +
        `<td>${effMat.toFixed(1)}%</td><td>${optimal ? '<span class="ok">ótimo ✓</span>' : 'juntar'}</td></tr>`;
    });
    $('#plan-breakdown').innerHTML =
      `<table class="grid compact breakdown"><thead><tr><th>Material</th><th>Chapas</th><th>Mín</th>` +
      `<th>Peças</th><th>Aprov.</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>` +
      `<p class="muted small breakdown-note">Aproveit. = área das peças ÷ (chapas × área da chapa). ` +
      `Com o nº mínimo de chapas esse % é o teto.</p>`;

    Render.renderSheets($('#plan-sheets'), result, { showLabels: state.options.labels });
    Budget.applyMetrics(state.budgetItems, m);
    save();
    if (!silent) toast('Plano calculado!');
  }
  function metric(k, v) { return `<div class="metric"><div class="v">${v}</div><div class="k">${k}</div></div>`; }

  // ---------- Orçamento ----------
  function renderBudget() {
    if (state.plan) Budget.applyMetrics(state.budgetItems, Budget.metricsFromPlan(state.plan, 'cm'));
    const pieces = state.plan ? state.plan.sheets.reduce((a, s) => a + s.placements.length, 0) : 0;
    const cuts = state.plan ? state.plan.sheets.reduce((a, s) => a + s.cuts, 0) : 0;
    const m = state.plan ? Budget.metricsFromPlan(state.plan, 'cm') : { bandMeters: 0 };

    $('#budget-badges').innerHTML =
      `<div class="badge b1"><div class="v">${pieces}</div><div class="k">N- peças</div></div>` +
      `<div class="badge b2"><div class="v">${numFmt(m.bandMeters)}</div><div class="k">M - FITA</div></div>` +
      `<div class="badge b3"><div class="v">${cuts}</div><div class="k">C - CORTE</div></div>`;

    const body = $('#budget-body'); body.innerHTML = '';
    state.budgetItems.forEach((it, i) => {
      const tr = el('tr');
      const auto = it.type === 'auto';
      const qtyCell = auto
        ? `<td class="auto" style="text-align:right">${numFmt(it.qty)}</td>`
        : `<td><input inputmode="decimal" value="${it.qty}" data-q="${i}"></td>`;
      tr.innerHTML = `<td>${it.label}</td>` + qtyCell +
        `<td><input inputmode="decimal" value="${it.price}" data-p="${i}" style="text-align:right"></td>` +
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
    $$('#budget-body tr').forEach((tr, i) => { tr.querySelector('.subtotal').textContent = brl(Budget.subtotal(state.budgetItems[i])); });
    const t = Budget.totals(state.budgetItems, state.budgetCfg);
    const pieces = state.plan ? state.plan.sheets.reduce((a, s) => a + s.placements.length, 0) : 0;
    const days = pieces * state.budgetCfg.daysPerPiece;
    $('#conditions-table').innerHTML =
      row('Tempo de produção', (Math.round(days * 10) / 10).toLocaleString('pt-BR') + ' Dias') +
      row('Valor de Entrada', brl(t.entrada)) + row('Mão de obra', brl(t.labor)) +
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

  // ---------- Gráfico ----------
  function renderChart() {
    const canvas = $('#chart'); if (!canvas) return;
    const ctx = canvas.getContext('2d'); const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const data = state.budgetItems.map(it => ({ label: it.label, val: Budget.subtotal(it) }))
      .filter(d => d.val > 0).sort((a, b) => b.val - a.val);
    const total = data.reduce((a, d) => a + d.val, 0);
    const legend = $('#chart-legend'); legend.innerHTML = '';
    if (!total) { ctx.fillStyle = '#999'; ctx.font = '16px sans-serif'; ctx.fillText('Sem dados de custo ainda.', 20, 40); return; }
    const colors = ['#4a90d9', '#e74c3c', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#34495e', '#95a5a6', '#d35400', '#16a085', '#c0392b'];
    const cx = H / 2, cy = H / 2, r = H / 2 - 16; let start = -Math.PI / 2;
    data.forEach((d, i) => {
      const ang = (d.val / total) * Math.PI * 2;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.arc(cx, cy, r, start, start + ang); ctx.closePath();
      ctx.fillStyle = colors[i % colors.length]; ctx.fill(); start += ang;
      const item = el('div', 'item');
      item.innerHTML = `<span class="sw" style="background:${colors[i % colors.length]}"></span><span>${d.label} — ${(d.val / total * 100).toFixed(1)}% (${brl(d.val)})</span>`;
      legend.appendChild(item);
    });
  }

  // ---------- Navegação ----------
  function initTabs() {
    $('#tabs').addEventListener('click', e => {
      const btn = e.target.closest('.tab'); if (!btn) return;
      $$('.tab').forEach(b => b.classList.toggle('active', b === btn));
      const tab = btn.dataset.tab;
      $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
      if (tab === 'budget') renderBudget();
    });
  }

  // ---------- Recepção de CSV compartilhado / "abrir com" ----------
  // Lê o CSV guardado pelo service worker (Web Share Target) e processa.
  async function readSharedCSV() {
    try {
      const cache = await caches.open('projeto-corte-share');
      const res = await cache.match('shared-csv');
      if (!res) return false;
      const text = await res.text();
      await cache.delete('shared-csv');
      if (text && text.trim()) { importText(text); runPlan(true); return true; }
    } catch (e) {}
    return false;
  }
  function initShareHandlers() {
    // 1) Compartilhamento (Android/Chrome): SW redireciona com ?shared=1
    readSharedCSV().then(ok => {
      if (location.search) history.replaceState(null, '', location.pathname);
    });
    // 2) "Abrir com" (File Handling API, desktop): recebe o arquivo direto
    if ('launchQueue' in window && window.launchQueue && 'setConsumer' in window.launchQueue) {
      window.launchQueue.setConsumer(async params => {
        if (params && params.files && params.files.length) {
          try {
            const file = await params.files[0].getFile();
            const text = await file.text();
            if (text && text.trim()) { importText(text); runPlan(true); }
          } catch (e) {}
        }
      });
    }
  }

  // ---------- Init ----------
  function init() {
    load();
    initTabs(); initOptions(); initImport(); initSelect(); initBudgetCfg(); initBandModal();
    renderStock(); renderPanels();
    $('#run-plan').addEventListener('click', () => runPlan(false));
    initShareHandlers();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
