/* ============================================================
 * app.js — Controlador principal do PWA Projeto de Corte.
 * ============================================================ */
(function () {
  'use strict';

  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));

  // ---------- Estado / Projetos ----------
  function emptyData() {
    return {
      panels: [],
      stock: [{ width: 184, length: 274, qty: 5, material: '' }],
      options: { kerf: 0.8 }, // única opção ajustável (material/grão/labels/pesos fixos no padrão)
      materialColors: {},
      materialNames: {},
      materials: [],
      budgetItems: Budget.defaultItems(),
      budgetCfg: { laborPct: 80, markupPct: 10, pixPct: 10, daysPerPiece: 0.105 },
      plan: null,
    };
  }
  let state = emptyData();                 // dados do projeto ativo (referência viva)
  let db = { projects: [], activeId: null };
  const DB_KEY = 'projeto-corte-db-v1';
  const OLD_KEY = 'projeto-corte-v1';
  const MAX_QTY = 999; // teto de quantidade por linha (peças/estoque) — evita travar a busca
  // "Sem material" (material vazio) = peça FORA do plano de corte (símbolo —).
  // Serve para desligar peças sem excluí-las.
  // Versão exibida no cabeçalho. Reflete o app.js carregado na tela (útil para
  // saber se o cache do Service Worker já atualizou). Manter igual ao N de sw.js.
  const APP_VERSION = 'v53';

  const clampQty = v => Math.min(MAX_QTY, Math.max(1, Math.round(parseNum(v) || 1)));

  // seleção rápida
  let selectMode = false;
  const selected = new Set();

  function genId() { return 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function activeProject() { return db.projects.find(p => p.id === db.activeId) || null; }

  // Aceita formato antigo (string) e novo (array) de nomes nativos.
  function coerceNames(obj) {
    const out = {};
    if (obj && typeof obj === 'object') Object.keys(obj).forEach(k => {
      const v = obj[k]; out[k] = Array.isArray(v) ? v.slice() : (v ? [v] : []);
    });
    return out;
  }
  // Garante todos os campos de um "data" de projeto.
  function normalizeData(d) {
    const e = emptyData(); d = d || {};
    // Migração: material "Nenhum" (v48) virou "Sem material" (vazio).
    if (Array.isArray(d.panels)) d.panels.forEach(p => {
      if (!p) return;
      if (p.material === 'Nenhum') p.material = '';
      // Fita: booleano (antigo) ou cor/largura global (v52) → objeto por lado {w,color}.
      const b = p.bands;
      if (b && typeof b === 'object') ['top', 'left', 'bottom', 'right'].forEach(s => {
        const v = b[s];
        if (!v) { b[s] = false; return; }
        if (typeof v === 'object') { b[s] = { w: v.w === 45 ? 45 : 22, color: v.color || p.bandColor || '' }; }
        else b[s] = { w: p.bandWidth === 45 ? 45 : 22, color: p.bandColor || '' };
      });
      delete p.bandColor; delete p.bandWidth;
    });
    if (Array.isArray(d.stock)) d.stock.forEach(s => { if (s && s.material === 'Nenhum') s.material = ''; });
    const out = {
      panels: Array.isArray(d.panels) ? d.panels : e.panels,
      stock: Array.isArray(d.stock) && d.stock.length ? d.stock : e.stock,
      // só o kerf persiste; demais configs foram removidas (ignora valores antigos)
      options: { kerf: (d.options && isFinite(parseFloat(d.options.kerf))) ? parseFloat(d.options.kerf) : e.options.kerf },
      materialColors: (d.materialColors && typeof d.materialColors === 'object') ? d.materialColors : {},
      materialNames: coerceNames(d.materialNames),
      materials: Array.isArray(d.materials) ? d.materials.slice() : [],
      budgetCfg: Object.assign(e.budgetCfg, d.budgetCfg || {}),
      budgetItems: e.budgetItems,
      plan: null,
    };
    if (Array.isArray(d.budgetItems)) {
      out.budgetItems = Budget.defaultItems().map(def => {
        const f = d.budgetItems.find(i => i.key === def.key);
        return f ? Object.assign(def, { price: f.price, qty: f.qty }) : def;
      });
    }
    return out;
  }
  function makeProject(name, data) {
    return { id: genId(), name: name || 'Projeto', createdAt: Date.now(), updatedAt: Date.now(), data: normalizeData(data) };
  }

  function load() {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) {}
    if (parsed && Array.isArray(parsed.projects) && parsed.projects.length) {
      db = parsed;
      db.projects.forEach(p => { p.data = normalizeData(p.data); });
    } else {
      let old = null;
      try { old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); } catch (e) {}
      const proj = makeProject('Projeto 1', old);
      db = { projects: [proj], activeId: proj.id };
    }
    if (!db.projects.find(p => p.id === db.activeId)) db.activeId = db.projects[0].id;
    state = activeProject().data;
  }

  function saveDb() {
    try {
      const slim = {
        activeId: db.activeId,
        projects: db.projects.map(p => ({
          id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
          data: Object.assign({}, p.data, { plan: null }) // plano não é persistido (recalculado ao abrir)
        })),
      };
      localStorage.setItem(DB_KEY, JSON.stringify(slim));
    } catch (e) {}
  }
  function save() { const p = activeProject(); if (p) p.updatedAt = Date.now(); saveDb(); recordHistory(); }

  // ---------- Histórico (desfazer / refazer) ----------
  // Snapshots do projeto ativo (sem o plano, que não é persistido). Cada save()
  // registra um ponto; desfazer/refazer navegam por eles. Em memória, por sessão.
  let history = [], histIndex = -1, restoringHistory = false;
  const HISTORY_MAX = 120;
  function snapData() { return JSON.stringify(Object.assign({}, state, { plan: null })); }
  function resetHistory() { history = [snapData()]; histIndex = 0; updateUndoButtons(); }
  function recordHistory() {
    if (restoringHistory) return;
    const snap = snapData();
    if (history[histIndex] === snap) return;       // sem mudança real → ignora
    history = history.slice(0, histIndex + 1);      // descarta o "refazer" pendente
    history.push(snap);
    if (history.length > HISTORY_MAX) history.shift();
    histIndex = history.length - 1;
    updateUndoButtons();
  }
  function applySnapshot(snap) {
    restoringHistory = true;
    try {
      const proj = activeProject();
      if (proj) { proj.data = normalizeData(JSON.parse(snap)); state = proj.data; saveDb(); }
      selected.clear();
      renderActive();
    } catch (e) {}
    restoringHistory = false;
    updateUndoButtons();
  }
  function doUndo() { if (histIndex > 0) { histIndex--; applySnapshot(history[histIndex]); toast('Desfeito'); } }
  function doRedo() { if (histIndex < history.length - 1) { histIndex++; applySnapshot(history[histIndex]); toast('Refeito'); } }
  function updateUndoButtons() {
    const u = $('#undo-btn'), r = $('#redo-btn');
    if (u) u.disabled = histIndex <= 0;
    if (r) r.disabled = histIndex >= history.length - 1;
  }

  // ---------- Utilidades ----------
  const brl = n => 'R$ ' + (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const numFmt = n => (Math.round((n || 0) * 100) / 100).toLocaleString('pt-BR');
  const fmtNum = v => (v || v === 0) ? String(v).replace('.', ',') : '';
  const parseNum = s => { const n = parseFloat(String(s).replace(',', '.')); return isFinite(n) ? n : 0; };
  const capFirst = s => { s = String(s == null ? '' : s); return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; };
  // Seleciona todo o conteúdo ao focar (útil para editar campos numéricos).
  function selectAllOnFocus(inp) { inp.addEventListener('focus', () => { try { inp.select(); } catch (e) {} }); }
  function attr(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])); }
  function el(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }

  let toastTimer;
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('show');
    clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), 2200);
  }

  // ---------- Diálogos temáticos reutilizáveis (alert/confirm/prompt) ----------
  function dialog(opts) {
    opts = opts || {};
    return new Promise(resolve => {
      const ov = el('div', 'modal-overlay dialog-overlay');
      const card = el('div', 'modal dialog' + (opts.danger ? ' danger' : ''));
      const head = el('div', 'dialog-head'); head.textContent = opts.title || 'Confirmar';
      const body = el('div', 'dialog-body');
      if (opts.message) { const m = el('p', 'dialog-msg'); m.textContent = opts.message; body.appendChild(m); }
      if (Array.isArray(opts.list) && opts.list.length) {
        const ul = el('ul', 'dialog-list');
        opts.list.forEach(t => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
        body.appendChild(ul);
      }
      let inputEl = null;
      if (opts.input) {
        inputEl = document.createElement('input'); inputEl.className = 'dialog-input';
        inputEl.value = opts.value || ''; body.appendChild(inputEl);
      }
      const actions = el('div', 'modal-actions');
      let cancelBtn = null;
      if (!opts.alert) { cancelBtn = el('button', 'btn'); cancelBtn.textContent = opts.cancelText || 'Cancelar'; actions.appendChild(cancelBtn); }
      const okBtn = el('button', 'btn ' + (opts.danger ? 'danger' : 'primary')); okBtn.textContent = opts.okText || 'OK';
      actions.appendChild(okBtn);
      card.appendChild(head); card.appendChild(body); card.appendChild(actions); ov.appendChild(card);
      document.body.appendChild(ov);

      const close = val => { ov.remove(); document.removeEventListener('keydown', onKey); resolve(val); };
      const onOk = () => close(opts.input ? (inputEl ? inputEl.value : '') : true);
      const onCancel = () => close(opts.input ? null : false);
      okBtn.addEventListener('click', onOk);
      if (cancelBtn) cancelBtn.addEventListener('click', onCancel);
      ov.addEventListener('click', e => { if (e.target === ov) onCancel(); });
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
        else if (e.key === 'Enter') { e.preventDefault(); onOk(); }
      }
      document.addEventListener('keydown', onKey);
      setTimeout(() => { (inputEl || okBtn).focus(); if (inputEl) inputEl.select(); }, 30);
    });
  }
  const ui = {
    confirm: (message, o) => dialog(Object.assign({ title: 'Confirmar', message }, o)),
    prompt: (title, message, value, o) => dialog(Object.assign({ title, message, input: true, value }, o)),
    alert: (message, o) => dialog(Object.assign({ title: 'Aviso', message, alert: true }, o)),
  };

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

  // Lista de materiais em ordem de aparição (peças primeiro, depois estoques).
  // O índice define o NÚMERO do material exibido no chip.
  function materialsOrdered() {
    const seen = [];
    const add = m => { if (m && !seen.includes(m)) seen.push(m); }; // vazio = "sem material"
    state.panels.forEach(p => add(p.material));
    state.stock.forEach(s => add(s.material));
    (state.materials || []).forEach(add); // materiais criados manualmente
    return seen;
  }
  // Número exibido no chip = espessura do material (ex.: 18, 15, 6), sem "mm".
  function matThickness(m) { const x = String(m || '').match(/(\d+(?:[.,]\d+)?)\s*mm/i); return x ? x[1].replace(',', '.') : ''; }
  // Rótulo da legenda: nome NATIVO importado + espessura.
  function matNatives(m) { const v = state.materialNames && state.materialNames[m]; return Array.isArray(v) ? v : (v ? [v] : []); }
  function matLabel(m) {
    const arr = matNatives(m);
    const th = matThickness(m);
    // Apenas o PRIMEIRO nome nativo importado (+ espessura).
    if (arr.length) return arr[0] + (th ? ` · ${th}mm` : '');
    return m;
  }

  // --- Cores por material (tons amplos a partir do nome) ---
  const COLOR_WORDS = [
    [/branc|white/, '#ffffff'],
    [/pret|black|negr/, '#1f1f1f'],
    [/cinz|gray|grey|grafite|chumbo|concret|ciment/, '#9e9e9e'],
    [/marrom|brown|nogueir|walnut|madeir|wood|maple|carvalh|oak|imbuia|freij|tabaco|amend/, '#8a5a2b'],
    [/beg|cream|creme|areia|sand|fendi|aveia/, '#d8c39a'],
    [/dourad|gold|ouro/, '#d4af37'],
    [/amarel|yellow/, '#f2c200'],
    [/prat|silver|alum|inox/, '#c2c7cc'],
    [/azul|blue/, '#3b6fb0'],
    [/verde|green/, '#3f8f4f'],
    [/vermelh|red|rubi/, '#c0392b'],
    [/ros[ae]|pink/, '#e58aa6'],
    [/rox|lil[aá]|purpl|violet|uva/, '#7e57c2'],
    [/laranj|orange/, '#e07b2a'],
    [/vinh|bord[oô]|wine/, '#7a2230'],
  ];
  const FALLBACK_COLORS = ['#5b8def', '#e8743b', '#19a979', '#945ecf', '#13a4b4', '#e0566f', '#6c8893', '#ef7e32', '#7b9f35', '#c879b0'];
  function colorFromName(s) {
    const t = String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    for (const [re, hex] of COLOR_WORDS) if (re.test(t)) return hex;
    return null;
  }
  function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
  function fallbackColor(name) { return FALLBACK_COLORS[hashStr(String(name)) % FALLBACK_COLORS.length]; }
  function assignColor(name) { return colorFromName(name) || fallbackColor(name); }
  // Cor atual do material (cria/memoriza se faltar).
  function matColor(m) {
    if (!m) return 'transparent';
    if (!state.materialColors[m]) state.materialColors[m] = assignColor(m);
    return state.materialColors[m];
  }
  function isLight(hex) {
    const c = String(hex || '').replace('#', '');
    if (c.length < 6) return true;
    const r = parseInt(c.slice(0, 2), 16), g = parseInt(c.slice(2, 4), 16), b = parseInt(c.slice(4, 6), 16);
    return (0.299 * r + 0.587 * g + 0.114 * b) > 175;
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
    i.value = val > 0 ? fmtNum(val) : ''; i.addEventListener('change', () => onCh(i.value));
    selectAllOnFocus(i); return i;
  }
  function txtInput(val, ph, onCh) {
    const i = document.createElement('input'); i.placeholder = ph || ''; i.value = val || '';
    i.addEventListener('change', () => onCh(i.value)); return i;
  }
  // Pinta um chip de material conforme o valor atual (compartilhado pela tabela
  // e pelo popup de seleção).
  function paintMatChip(chip, cur) {
    chip.classList.remove('empty', 'light', 'none');
    if (cur) {
      const col = matColor(cur);
      chip.style.background = col;
      chip.textContent = matThickness(cur) || '';
      chip.classList.toggle('light', isLight(col));
    } else {
      // "Sem material" = fora do plano (símbolo —)
      chip.textContent = '—'; chip.style.background = '#e6e6e6'; chip.classList.add('none');
    }
  }
  // Controle de material na tabela: chip colorido que abre o popup temático de
  // seleção (mesmo padrão de popup da seção de materiais).
  function materialControl(obj, onCh) {
    const list = materialsOrdered();
    if (!list.length) { // ainda sem materiais → input livre p/ digitar o primeiro
      const c = document.createElement('input'); c.placeholder = 'material'; c.value = obj.material || '';
      c.addEventListener('change', () => onCh(c.value));
      return c;
    }
    const cur = obj.material || '';
    const btn = el('button', 'mat-cell-btn'); btn.type = 'button'; btn.title = 'Escolher material';
    const chip = el('span', 'mat-chip');
    paintMatChip(chip, cur);
    btn.appendChild(chip);
    btn.addEventListener('click', () => openMaterialPicker(cur, onCh));
    return btn;
  }

  // Popup temático para escolher o material de uma peça/chapa.
  function openMaterialPicker(cur, onPick) {
    const list = materialsOrdered();
    const ov = el('div', 'modal-overlay dialog-overlay');
    const card = el('div', 'modal dialog');
    const head = el('div', 'dialog-head'); head.textContent = 'Escolher material';
    const body = el('div', 'dialog-body');
    const pick = el('div', 'mat-pick');
    const addOpt = (value, labelText) => {
      const it = el('button', 'mat-pick-item' + (value === cur ? ' sel' : '')); it.type = 'button';
      const chip = el('span', 'mat-chip');
      paintMatChip(chip, value);
      const name = el('span', 'mat-pick-name'); name.textContent = labelText;
      it.appendChild(chip); it.appendChild(name);
      it.addEventListener('click', () => { ov.remove(); document.removeEventListener('keydown', onKey); onPick(value); });
      pick.appendChild(it);
    };
    list.forEach(m => addOpt(m, matLabel(m)));
    addOpt('', 'Sem material');
    body.appendChild(pick);
    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'btn'); cancelBtn.textContent = 'Cancelar';
    actions.appendChild(cancelBtn);
    card.appendChild(head); card.appendChild(body); card.appendChild(actions); ov.appendChild(card);
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    cancelBtn.addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey);
  }

  // Legenda de materiais (acima do Stock): chip + nome. Tocar no chip ou no nome
  // abre o editor (nome + cor) usando o popup temático do app.
  function renderMatLegend() {
    const box = $('#mat-legend'); if (!box) return;
    const list = materialsOrdered();
    box.innerHTML = '';
    list.forEach(m => {
      const col = matColor(m);
      const item = el('div', 'mat-legend-item');
      const sw = el('button', 'swatch'); sw.type = 'button';
      sw.style.background = col; sw.classList.toggle('light', isLight(col));
      sw.title = 'Editar material';
      const num = el('span', 'sw-num'); num.textContent = matThickness(m) || '';
      sw.appendChild(num);
      sw.addEventListener('click', () => openMaterialEditor(m));
      const name = el('span', 'mat-name'); name.textContent = matLabel(m);
      name.title = 'Editar material'; name.addEventListener('click', () => openMaterialEditor(m));
      const del = iconBtn('del', 'delete', 'Excluir material e suas peças', () => deleteMaterial(m));
      item.appendChild(sw); item.appendChild(name); item.appendChild(del);
      box.appendChild(item);
    });
  }

  // Editor de material (popup temático): renomeia e escolhe a cor.
  function openMaterialEditor(m) {
    const curName = matNatives(m)[0] || m;
    const th = matThickness(m);
    let chosen = matColor(m);
    const presets = [];
    COLOR_WORDS.forEach(([, hex]) => { if (!presets.includes(hex)) presets.push(hex); });
    FALLBACK_COLORS.forEach(hex => { if (!presets.includes(hex)) presets.push(hex); });

    const ov = el('div', 'modal-overlay dialog-overlay');
    const card = el('div', 'modal dialog');
    const head = el('div', 'dialog-head'); head.textContent = 'Editar material';
    const body = el('div', 'dialog-body');
    const lblName = el('div', 'mat-edit-label'); lblName.textContent = 'Nome' + (th ? ` (espessura ${th}mm)` : '');
    const nameInp = document.createElement('input'); nameInp.className = 'dialog-input'; nameInp.value = curName;
    body.appendChild(lblName); body.appendChild(nameInp);
    const lblColor = el('div', 'mat-edit-label'); lblColor.textContent = 'Cor';
    body.appendChild(lblColor);
    const swatches = [];
    const mark = () => swatches.forEach(s => s.classList.toggle('sel', s.dataset.col.toLowerCase() === String(chosen).toLowerCase()));
    const grid = el('div', 'color-grid');
    presets.forEach(hex => {
      const b = el('button', 'color-sw'); b.type = 'button'; b.style.background = hex; b.dataset.col = hex;
      if (isLight(hex)) b.classList.add('light');
      b.addEventListener('click', () => { chosen = hex; mark(); });
      grid.appendChild(b); swatches.push(b);
    });
    body.appendChild(grid);

    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'btn'); cancelBtn.textContent = 'Cancelar';
    const okBtn = el('button', 'btn primary'); okBtn.textContent = 'Salvar';
    actions.appendChild(cancelBtn); actions.appendChild(okBtn);
    card.appendChild(head); card.appendChild(body); card.appendChild(actions); ov.appendChild(card);
    document.body.appendChild(ov);
    mark();

    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    const onOk = () => {
      const newName = nameInp.value.trim();
      if (newName) state.materialNames[m] = [newName];
      state.materialColors[m] = String(chosen).toLowerCase();
      save();
      renderMatLegend(); renderPanels(); renderStock();
      if (validPanels().length) markPlanStale(); // cores iguais → mesmo material no cálculo
      close(); toast('Material atualizado');
    };
    cancelBtn.addEventListener('click', close);
    okBtn.addEventListener('click', onOk);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'Enter') { e.preventDefault(); onOk(); } }
    document.addEventListener('keydown', onKey);
    setTimeout(() => { nameInp.focus(); nameInp.select(); }, 30);
  }

  // Cria um material manualmente (aparece na legenda e nos seletores das
  // peças/estoque, mesmo sem nenhuma peça ainda usá-lo).
  async function addMaterialManual() {
    const name = await ui.prompt('Novo material', 'Nome (inclua a espessura, ex.: "Carvalho 18mm"):', '', { okText: 'Criar' });
    if (name == null) return;
    const key = String(name).trim();
    if (!key) return;
    if (materialsOrdered().includes(key)) { toast('Esse material já existe.'); return; }
    if (!Array.isArray(state.materials)) state.materials = [];
    state.materials.push(key);
    state.materialColors[key] = colorFromName(key) || fallbackColor(key);
    const native = key.replace(/\s*\d+(?:[.,]\d+)?\s*mm$/i, '').trim();
    if (native && native !== key) state.materialNames[key] = [native];
    save();
    renderMatLegend(); renderPanels(); renderStock();
    toast('Material criado');
  }

  // Exclui um material e TODAS as peças (e estoques) que o utilizam.
  async function deleteMaterial(m) {
    const affected = state.panels.filter(p => p.material === m && (p.length > 0 || p.width > 0));
    const units = affected.reduce((a, p) => a + (p.qty || 1), 0);
    const groups = {};
    affected.forEach(p => {
      const k = (p.name || 'Peça') + '|' + p.width + 'x' + p.length;
      if (!groups[k]) groups[k] = { name: p.name || 'Peça', w: p.width, l: p.length, qty: 0 };
      groups[k].qty += (p.qty || 1);
    });
    const list = Object.values(groups).map(g => `${g.name} · ${fmtNum(g.w)}×${fmtNum(g.l)} · ${g.qty}×`);
    const ok = await ui.confirm(
      `Excluir este material e as ${units} peça(s) abaixo? Esta ação não pode ser desfeita.`,
      { title: 'Excluir material', danger: true, okText: 'Excluir', list });
    if (!ok) return;
    state.panels = state.panels.filter(p => p.material !== m);
    state.stock = state.stock.filter(s => s.material !== m);
    state.materials = (state.materials || []).filter(x => x !== m);
    delete state.materialColors[m]; delete state.materialNames[m];
    selected.clear();
    save();
    renderPanels(); renderStock();
    if (validPanels().length) markPlanStale(); else renderPlanEmpty();
    toast('Material excluído');
  }

  // ---------- Fita (botão visual + popup) ----------
  const BAND_WIDTHS = [22, 45]; // larguras de fita padrão (mm)
  const BAND_SIDES = ['top', 'left', 'bottom', 'right'];
  // Cor padrão da fita: cor do material da peça, ou branco quando não há.
  function bandFallbackColor(p) {
    const c = p && p.material ? matColor(p.material) : '';
    return (c && c !== 'transparent') ? c : '#ffffff';
  }
  // Fita de um lado: { w:22|45, color:'#hex' } ou null. Tolera formato antigo
  // (booleano + p.bandColor/p.bandWidth da v52).
  function bandSpecOf(p, side) {
    const v = (p.bands || {})[side];
    if (!v) return null;
    if (typeof v === 'object') return { w: v.w === 45 ? 45 : 22, color: v.color || bandFallbackColor(p) };
    return { w: p.bandWidth === 45 ? 45 : 22, color: p.bandColor || bandFallbackColor(p) };
  }
  function makeFitaButton(p) {
    const b = el('button', 'fita-btn'); b.type = 'button';
    refreshFitaButton(b, p);
    b.addEventListener('click', () => openBandModal(p, b));
    return b;
  }
  // Botão = retângulo (fundo cinza p/ ver fita branca); cada lado com fita ganha
  // uma linha na sua cor — fina p/ 22, grossa p/ 45.
  function refreshFitaButton(b, p) {
    let any = false;
    const W = 17, H = 28, m = 3;
    const ln = (sp, x1, y1, x2, y2) => {
      if (!sp) return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#aeb5b0" stroke-width="1" stroke-linecap="round"/>`;
      any = true;
      const sw = sp.w === 45 ? 5 : 2.4;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${sp.color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    };
    const body =
      `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="#cfd5d1" stroke="#aeb5b0" stroke-width="0.8"/>` +
      ln(bandSpecOf(p, 'top'), m, m, W - m, m) + ln(bandSpecOf(p, 'bottom'), m, H - m, W - m, H - m) +
      ln(bandSpecOf(p, 'left'), m, m, m, H - m) + ln(bandSpecOf(p, 'right'), W - m, m, W - m, H - m);
    b.innerHTML = `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" aria-hidden="true">${body}</svg>`;
    b.classList.toggle('has', any);
    b.title = any ? 'Fita aplicada — toque para editar' : 'Sem fita — toque para aplicar';
  }
  function paintBandChip(chip, color, width) {
    chip.style.background = color;
    chip.textContent = String(width);
    chip.classList.toggle('light', isLight(color));
  }

  // Botão de direção do grão (veio): retângulo listrado 2:1 que cicla
  // sem direção → vertical (↕) → horizontal (↔).
  function veioButton(p, opts) {
    opts = opts || {};
    const titles = opts.stock
      ? { v: 'Veio ao longo do comprimento', h: 'Veio ao longo da largura', '': 'Chapa sem veio (gira livre)' }
      : { v: 'Veio vertical', h: 'Veio horizontal', '': 'Sem direção do veio' };
    const b = el('button', 'veio-btn'); b.type = 'button';
    const paint = () => {
      const g = p.grain || '';
      b.className = 'veio-btn ' + (g === 'v' ? 'v' : g === 'h' ? 'h' : 'none');
      b.title = titles[g];
    };
    paint();
    b.addEventListener('click', () => {
      const cur = p.grain || '';
      const next = cur === '' ? 'v' : cur === 'v' ? 'h' : '';
      p.grain = next;
      if (opts.onCycle) { opts.onCycle(next); paint(); }
      else if (selectMode && selected.has(p) && selected.size > 1) {
        selected.forEach(q => { if (q !== p) q.grain = next; }); save(); renderPanels();
      } else { paint(); save(); }
      if (validPanels().length) markPlanStale();
    });
    return b;
  }

  // ---------- Painéis ----------
  function makePanelRow(p) {
    const tr = el('tr');
    // 1ª coluna: "+" para inserir acima OU checkbox de seleção (mesmo espaço)
    const tdAct = el('td', 'cell-act');
    if (selectMode) {
      const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = selected.has(p);
      cb.addEventListener('change', () => { cb.checked ? selected.add(p) : selected.delete(p); updateSelAll(); });
      tdAct.appendChild(cb);
    } else {
      tdAct.appendChild(iconBtn('add', 'add', 'Inserir acima', () => insertAbove('panels', p)));
    }
    tr.appendChild(tdAct);
    // largura, comprimento (largura primeiro!)
    const tdW = el('td', 'cell-num'); tdW.appendChild(numInput(p.width, 'L', 'decimal', v => onPanelField(p, 'width', v))); tr.appendChild(tdW);
    const tdL = el('td', 'cell-num'); tdL.appendChild(numInput(p.length, 'C', 'decimal', v => onPanelField(p, 'length', v))); tr.appendChild(tdL);
    // qtd
    const tdQ = el('td', 'cell-qty'); tdQ.appendChild(numInput(p.qty, '1', 'numeric', v => onPanelField(p, 'qty', v))); tr.appendChild(tdQ);
    // material (chip)
    const tdM = el('td', 'cell-mat'); tdM.appendChild(materialControl(p, v => onPanelField(p, 'material', v))); tr.appendChild(tdM);
    // nome da peça
    const tdN = el('td', 'cell-name');
    const nameInp = document.createElement('input'); nameInp.placeholder = 'nome'; nameInp.value = p.name || '';
    nameInp.addEventListener('change', () => { const cap = capFirst(nameInp.value.trim()); nameInp.value = cap; onPanelField(p, 'name', cap); });
    tdN.appendChild(nameInp); tr.appendChild(tdN);
    // veio (direção do grão) — toque cicla — / ↕ / ↔
    const tdV = el('td', 'cell-veio'); tdV.appendChild(veioButton(p)); tr.appendChild(tdV);
    // fita
    const tdF = el('td', 'cell-fita'); tdF.appendChild(makeFitaButton(p)); tr.appendChild(tdF);
    // del
    const tdD = el('td', 'cell-act'); tdD.appendChild(iconBtn('del', 'delete', 'Excluir', () => deleteRow('panels', p))); tr.appendChild(tdD);
    return tr;
  }
  function applyPanelField(p, f, value) {
    if (f === 'length' || f === 'width') p[f] = parseNum(value);
    else if (f === 'qty') p[f] = clampQty(value);
    else p[f] = String(value).trim();
  }
  // Edita um campo; com seleção rápida ativa, replica para todas selecionadas.
  function onPanelField(p, f, value) {
    applyPanelField(p, f, value);
    if (selectMode && selected.has(p) && selected.size > 1) {
      selected.forEach(q => { if (q !== p) applyPanelField(q, f, value); });
      save(); renderPanels();
    } else if (f === 'material') {
      // material novo/alterado → repinta chips, legenda e seletores na hora
      save(); renderPanels(); renderStock();
    } else { save(); afterRowEdit('panels'); }
    if (validPanels().length) markPlanStale();
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
    renderMatLegend();
  }

  // ---------- Stock ----------
  function makeStockRow(s) {
    const tr = el('tr');
    const tdAdd = el('td', 'cell-act'); tdAdd.appendChild(iconBtn('add', 'add', 'Inserir acima', () => insertAbove('stock', s))); tr.appendChild(tdAdd);
    const tdW = el('td', 'cell-num'); tdW.appendChild(numInput(s.width, 'Larg.', 'decimal', v => onStockField(s, 'width', v))); tr.appendChild(tdW);
    const tdL = el('td', 'cell-num'); tdL.appendChild(numInput(s.length, 'Compr.', 'decimal', v => onStockField(s, 'length', v))); tr.appendChild(tdL);
    const tdQ = el('td', 'cell-qty'); tdQ.appendChild(numInput(s.qty, '1', 'numeric', v => onStockField(s, 'qty', v))); tr.appendChild(tdQ);
    const tdM = el('td', 'cell-mat'); tdM.appendChild(materialControl(s, v => onStockField(s, 'material', v))); tr.appendChild(tdM);
    // nome da chapa (material) — abre o mesmo seletor ao tocar
    const tdMN = el('td', 'cell-matname');
    const mn = el('span', 'matname-text'); mn.textContent = s.material ? matLabel(s.material) : '—';
    mn.title = 'Escolher material'; mn.addEventListener('click', () => openMaterialPicker(s.material || '', v => onStockField(s, 'material', v)));
    tdMN.appendChild(mn); tr.appendChild(tdMN);
    if (s.grain == null) s.grain = 'v'; // padrão: veio ao longo do comprimento
    const tdV = el('td', 'cell-veio'); tdV.appendChild(veioButton(s, { stock: true, onCycle: () => { save(); markPlanStale(); } })); tr.appendChild(tdV);
    const tdD = el('td', 'cell-act'); tdD.appendChild(iconBtn('del', 'delete', 'Excluir', () => deleteRow('stock', s))); tr.appendChild(tdD);
    return tr;
  }
  function onStockField(s, f, value) {
    if (f === 'material') s[f] = String(value).trim();
    else if (f === 'qty') s[f] = clampQty(value);
    else s[f] = parseNum(value);
    if (f === 'material') { save(); renderStock(); renderPanels(); }
    else { save(); afterRowEdit('stock'); }
    if (validPanels().length) markPlanStale();
  }
  function renderStock() {
    ensureTrailingBlank(state.stock, isBlankStock, blankStock);
    const body = $('#stock-body'); body.innerHTML = '';
    state.stock.forEach((s, i) => {
      const tr = makeStockRow(s);
      if (i === state.stock.length - 1) tr.classList.add('row-new');
      body.appendChild(tr);
    });
    renderMatLegend();
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
  // Única opção restante: kerf. (Material/grão/labels/pesos são fixos no padrão.)
  function refreshOptionsUI() {
    const k = $('#opt-kerf'); if (k) k.value = state.options.kerf;
  }
  function initOptions() {
    refreshOptionsUI();
    const k = $('#opt-kerf'); if (!k) return;
    k.addEventListener('change', e => {
      state.options.kerf = parseFloat(e.target.value) || 0;
      save();
      if (validPanels().length) markPlanStale();
    });
  }

  // ---------- Importação (cada CSV vira um projeto no histórico) ----------
  function projectNameFromFile(fileName) {
    let base = String(fileName || 'Projeto').replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '').trim() || 'Projeto';
    let name = base, i = 2;
    while (db.projects.some(p => p.name === name)) name = `${base} (${i++})`;
    return name;
  }
  function importAsProject(text, fileName) {
    const { panels, warnings } = CSV.parse(text);
    if (!panels.length) { toast(warnings[0] || 'CSV sem peças válidas.'); return; }
    // novo projeto herdando opções/preços do projeto atual
    const base = activeProject() ? activeProject().data : emptyData();
    const proj = makeProject(projectNameFromFile(fileName),
      { options: base.options, budgetItems: base.budgetItems, budgetCfg: base.budgetCfg });
    db.projects.unshift(proj); db.activeId = proj.id; state = proj.data;
    selected.clear();

    panels.forEach(p => {
      p.name = capFirst((p.name || '').trim()); // primeira letra maiúscula
      const raw = p.material;
      p.material = normalizeMaterial(raw, p.thickness);
      if (!state.materialColors[p.material]) state.materialColors[p.material] = colorFromName(raw) || fallbackColor(p.material);
      const arr = state.materialNames[p.material] || (state.materialNames[p.material] = []);
      if (raw && arr.indexOf(raw) < 0) arr.push(raw); // guarda todos os nomes nativos do grupo
    });
    panels.sort((a, b) => nameSortKey(a.name).localeCompare(nameSortKey(b.name), 'pt'));
    state.panels = panels;
    syncStockToMaterials();
    save();
    refreshOptionsUI(); updateProjectName(); renderStock(); renderPanels();
    $('#import-status').textContent = `${panels.length} peças · ${panels.reduce((a, p) => a + p.qty, 0)} un.`;
    gotoTab('plan');
    toast('Projeto: ' + proj.name);
    resetHistory();
    startLiveSearch();
  }
  // Exporta as peças atuais (com edições de medida/veio/material/fita) num CSV
  // re-importável. No celular abre o compartilhamento; no resto, baixa o arquivo.
  function numOut(n) { return (Math.round((+n || 0) * 1000) / 1000).toString().replace('.', ','); }
  function exportCSV() {
    const ps = validPanels();
    if (!ps.length) { toast('Nenhuma peça para exportar.'); return; }
    const headers = [
      { key: 'width', label: 'Largura' },
      { key: 'length', label: 'Comprimento' },
      { key: 'qty', label: 'Quantidade' },
      { key: 'thickness', label: 'Espessura (mm)' },
      { key: 'material', label: 'Material' },
      { key: 'name', label: 'Nome' },
      { key: 'grain', label: 'Veio' },
      { key: 'top', label: 'Top band' },
      { key: 'left', label: 'Left band' },
      { key: 'bottom', label: 'Bottom band' },
      { key: 'right', label: 'Right band' },
    ];
    const rows = ps.map(p => {
      const b = p.bands || {};
      return {
        width: numOut(p.width), length: numOut(p.length), qty: p.qty || 1,
        thickness: matThickness(p.material) || (p.thickness || ''),
        material: matNatives(p.material)[0] || p.material || '',
        name: p.name || '', grain: p.grain || '',
        top: b.top ? '1' : '', left: b.left ? '1' : '', bottom: b.bottom ? '1' : '', right: b.right ? '1' : '',
      };
    });
    try {
      const text = '﻿' + CSV.stringify(rows, headers); // BOM p/ acentos no Excel
      const pname = (($('#project-name') && $('#project-name').textContent) || 'pecas').trim().replace(/[^\w.-]+/g, '_') || 'pecas';
      const fname = `${pname}_${new Date().toISOString().slice(0, 10)}.csv`;
      const file = new File([text], fname, { type: 'text/csv' });
      if (navigator.canShare && navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: fname }).catch(err => {
          if (err && err.name === 'AbortError') return; // usuário cancelou
          downloadBlob(file, fname); // compartilhamento falhou → baixa
        });
        return;
      }
      downloadBlob(file, fname);
    } catch (e) {
      toast('Não consegui exportar: ' + ((e && e.message) || e));
    }
  }
  function downloadBlob(file, fname) {
    const url = URL.createObjectURL(file);
    const a = document.createElement('a');
    a.href = url; a.download = fname; a.rel = 'noopener';
    document.body.appendChild(a); a.click();
    setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 1500);
    toast('CSV exportado (verifique seus Downloads).');
  }

  function initImport() {
    $('#csv-input').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = () => importAsProject(reader.result, file.name);
      reader.readAsText(file);
      e.target.value = '';
    });
    $('#export-csv').addEventListener('click', exportCSV);
    const addMatBtn = $('#add-material'); if (addMatBtn) addMatBtn.addEventListener('click', addMaterialManual);
    $('#clear-panels').addEventListener('click', async () => {
      if (validPanels().length) {
        const ok = await ui.confirm('Limpar todas as peças deste projeto?', { title: 'Limpar peças', danger: true, okText: 'Limpar' });
        if (!ok) return;
      }
      state.panels = []; selected.clear(); renderPanels(); renderPlanEmpty(); save(); $('#import-status').textContent = '';
    });
  }

  // ---------- Projetos (menu / histórico) ----------
  function gotoTab(tab) {
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    $$('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + tab));
    if (tab === 'budget') renderBudget();
  }
  function updateProjectName() { const p = activeProject(); $('#project-name').textContent = p ? p.name : 'Projeto'; }
  function renderPlanEmpty() {
    stopLiveSearch();
    state.plan = null;
    const metricsEl   = $('#plan-metrics');
    const breakdownEl = $('#plan-breakdown');
    const sheetsEl    = $('#plan-sheets');
    const emptyEl     = $('#plan-empty');
    const unplacedEl  = $('#plan-unplaced');
    if (metricsEl)   metricsEl.innerHTML   = '';
    if (breakdownEl) breakdownEl.innerHTML = '';
    if (sheetsEl)    sheetsEl.innerHTML    = '';
    if (unplacedEl)  { unplacedEl.innerHTML = ''; unplacedEl.hidden = true; }
    if (emptyEl)     emptyEl.style.display = 'block';
    planStale = false; updateStaleNotice();
  }
  function renderActive() {
    refreshOptionsUI(); updateProjectName();
    renderStock(); renderPanels();
    const total = state.panels.reduce((a, p) => a + (p.length > 0 && p.width > 0 ? (p.qty || 1) : 0), 0);
    $('#import-status').textContent = total ? `${total} un. em peças` : '';
    showSavedPlan(); // mostra o plano salvo sem recalcular (cálculo é manual)
    if ($('#view-budget').classList.contains('active')) renderBudget();
  }
  function setActive(id) {
    if (!db.projects.find(p => p.id === id)) return;
    db.activeId = id; state = activeProject().data; saveDb(); selected.clear();
    renderActive();
    resetHistory();
  }
  function fmtDate(ts) {
    try { return new Date(ts).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return ''; }
  }
  function renderProjectsList() {
    const box = $('#proj-list'); box.innerHTML = '';
    db.projects.slice().sort((a, b) => b.updatedAt - a.updatedAt).forEach(p => {
      const pieces = (p.data.panels || []).reduce((a, x) => a + (x.length > 0 && x.width > 0 ? (x.qty || 1) : 0), 0);
      const item = el('div', 'proj-item' + (p.id === db.activeId ? ' active' : ''));
      const info = el('div', 'proj-info');
      info.innerHTML = `<div class="proj-title">${esc(p.name)}</div><div class="proj-sub">${pieces} peças · ${fmtDate(p.updatedAt)}</div>`;
      info.addEventListener('click', () => { setActive(p.id); closeProjects(); gotoTab('panels'); });
      const ren = iconBtn('', 'edit', 'Renomear', () => renameProject(p));
      const del = iconBtn('del', 'delete', 'Excluir', () => deleteProject(p));
      item.appendChild(info); item.appendChild(ren); item.appendChild(del);
      box.appendChild(item);
    });
  }
  async function renameProject(p) {
    const name = await ui.prompt('Renomear projeto', 'Novo nome:', p.name, { okText: 'Salvar' });
    if (name && name.trim()) { p.name = name.trim(); save(); updateProjectName(); renderProjectsList(); }
  }
  async function deleteProject(p) {
    const ok = await ui.confirm(`Excluir o projeto “${p.name}”? Esta ação não pode ser desfeita.`,
      { title: 'Excluir projeto', danger: true, okText: 'Excluir' });
    if (!ok) return;
    const i = db.projects.findIndex(x => x.id === p.id);
    if (i >= 0) db.projects.splice(i, 1);
    if (!db.projects.length) { const np = makeProject('Projeto 1', null); db.projects.push(np); db.activeId = np.id; }
    if (p.id === db.activeId) db.activeId = db.projects[0].id;
    state = activeProject().data; saveDb();
    renderActive(); renderProjectsList(); resetHistory();
  }
  function newProject() {
    const base = activeProject() ? activeProject().data : emptyData();
    const proj = makeProject(projectNameFromFile('Projeto'),
      { options: base.options, budgetItems: base.budgetItems, budgetCfg: base.budgetCfg });
    db.projects.unshift(proj); db.activeId = proj.id; state = proj.data; saveDb();
    selected.clear(); closeProjects(); renderActive(); gotoTab('panels'); resetHistory();
  }
  function openProjects() { renderProjectsList(); $('#proj-modal').hidden = false; }
  function closeProjects() { $('#proj-modal').hidden = true; }
  function initProjects() {
    $('#open-projects').addEventListener('click', openProjects);
    $('#project-name').addEventListener('click', openProjects);
    $('#proj-close').addEventListener('click', closeProjects);
    $('#proj-modal').addEventListener('click', e => { if (e.target.id === 'proj-modal') closeProjects(); });
    $('#proj-new').addEventListener('click', newProject);
  }

  // ---------- Modal: editor de fita de borda ----------
  // Estado: bands por lado ({w,color}|false) + "pincel" (cor+largura a aplicar).
  let editing = null;
  function openBandModal(p, btn) {
    const bands = {};
    BAND_SIDES.forEach(s => { const sp = bandSpecOf(p, s); bands[s] = sp ? { w: sp.w, color: sp.color } : false; });
    editing = { p, btn, bands, brush: { w: 22, color: bandFallbackColor(p) } };
    $('#bm-title').textContent = p.name ? p.name : 'Peça';
    $('#bm-hint').textContent = `${fmtNum(p.width) || '?'} × ${fmtNum(p.length) || '?'} · escolha a fita no quadro e toque nos lados (toque de novo para retirar)`;
    drawBandEditor(); paintBandChipEl();
    $('#band-modal').hidden = false;
  }
  function closeBandModal() { $('#band-modal').hidden = true; editing = null; }
  function paintBandChipEl() { const chip = $('#bm-band-chip'); if (chip && editing) paintBandChip(chip, editing.brush.color, editing.brush.w); }
  function drawBandEditor() {
    const p = editing.p;
    const L = p.width > 0 ? p.width : 60, C = p.length > 0 ? p.length : 40;
    // PROPORÇÃO da peça, mas LIMITADA (senão peças compridas estouram a tela)
    const maxRatio = 2.4;
    let rw = L, rh = C;
    if (rw / rh > maxRatio) rh = rw / maxRatio; else if (rh / rw > maxRatio) rw = rh / maxRatio;
    const maxPx = 168, scale = maxPx / Math.max(rw, rh);
    const w = Math.round(rw * scale), h = Math.round(rh * scale);
    const pad = 30, x0 = pad, y0 = pad, x1 = pad + w, y1 = pad + h;
    const b = editing.bands;
    const edge = (s, ax, ay, bx, by) => {
      const sp = b[s];
      if (!sp) return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#9aa39d" stroke-width="3" stroke-linecap="round"/>`;
      return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${sp.color}" stroke-width="${sp.w === 45 ? 12 : 8}" stroke-linecap="round"/>`;
    };
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
      const s = el2.dataset.side;
      editing.bands[s] = editing.bands[s] ? false : { w: editing.brush.w, color: editing.brush.color };
      drawBandEditor();
    }));
  }
  // Popup: escolhe o "material da fita" (cor) em 22 ou 45 mm. Branco está
  // sempre disponível, mesmo sem um material branco no projeto.
  function openBandMatPicker(curColor, curWidth, onPick) {
    const mats = [{ label: 'Branco (fita)', color: '#ffffff' }];
    materialsOrdered().forEach(m => { const c = matColor(m); if (String(c).toLowerCase() !== '#ffffff') mats.push({ label: matLabel(m), color: c }); });
    const ov = el('div', 'modal-overlay dialog-overlay');
    const card = el('div', 'modal dialog');
    const head = el('div', 'dialog-head'); head.textContent = 'Material da fita';
    const body = el('div', 'dialog-body');
    const pick = el('div', 'mat-pick');
    mats.forEach(mt => {
      const row = el('div', 'band-pick-row');
      const name = el('span', 'mat-pick-name'); name.textContent = mt.label;
      const widths = el('span', 'band-pick-widths');
      BAND_WIDTHS.forEach(wd => {
        const sel = (String(mt.color).toLowerCase() === String(curColor).toLowerCase() && wd === curWidth);
        const c = el('button', 'mat-chip band-w' + (sel ? ' sel' : '')); c.type = 'button';
        paintBandChip(c, mt.color, wd);
        c.addEventListener('click', () => { ov.remove(); document.removeEventListener('keydown', onKey); onPick(mt.color, wd); });
        widths.appendChild(c);
      });
      row.appendChild(name); row.appendChild(widths); pick.appendChild(row);
    });
    body.appendChild(pick);
    const actions = el('div', 'modal-actions');
    const cancelBtn = el('button', 'btn'); cancelBtn.textContent = 'Cancelar';
    actions.appendChild(cancelBtn);
    card.appendChild(head); card.appendChild(body); card.appendChild(actions); ov.appendChild(card);
    document.body.appendChild(ov);
    const close = () => { ov.remove(); document.removeEventListener('keydown', onKey); };
    cancelBtn.addEventListener('click', close);
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }
    document.addEventListener('keydown', onKey);
  }
  function initBandModal() {
    $('#bm-close').addEventListener('click', closeBandModal);
    $('#bm-cancel').addEventListener('click', closeBandModal);
    $('#band-modal').addEventListener('click', e => { if (e.target.id === 'band-modal') closeBandModal(); });
    $('#bm-band-chip').addEventListener('click', () => {
      if (!editing) return;
      openBandMatPicker(editing.brush.color, editing.brush.w, (color, width) => {
        editing.brush = { w: width, color: color };
        paintBandChipEl();
      });
    });
    $('#bm-ok').addEventListener('click', () => {
      if (!editing) return;
      const snap = editing.bands;
      const apply = q => { const nb = {}; BAND_SIDES.forEach(s => { nb[s] = snap[s] ? { w: snap[s].w, color: snap[s].color } : false; }); q.bands = nb; delete q.bandColor; delete q.bandWidth; };
      apply(editing.p);
      if (selectMode && selected.has(editing.p) && selected.size > 1) {
        selected.forEach(q => { if (q !== editing.p) apply(q); });
        save(); closeBandModal(); renderPanels();
        if (validPanels().length) markPlanStale();
        return;
      }
      refreshFitaButton(editing.btn, editing.p);
      save(); closeBandModal();
      if (validPanels().length) markPlanStale();
    });
  }

  // ---------- Plano de corte ----------
  // Identidade do material no corte = COR + espessura (o nome é ignorado):
  // materiais de cor e espessura iguais são tratados como o mesmo material.
  function materialGroupKey(name) {
    if (!name) return '';
    return String(matColor(name)).toLowerCase() + '|' + (matThickness(name) || '');
  }

  // Monta os parâmetros do otimizador a partir das peças/estoque atuais.
  // Retorna null se não houver peças válidas.
  function buildPlanInputs() {
    const raw = validPanels().filter(p => p.material); // "sem material" (vazio) fica fora do plano
    if (!raw.length) return null;
    const groupLabel = {};
    raw.forEach(p => { const k = materialGroupKey(p.material); if (!(k in groupLabel)) groupLabel[k] = matLabel(p.material); });
    const gpanels = raw.map(p => {
      const bands = {}; // fitas concretas por lado ({w,color}) p/ o orçamento
      BAND_SIDES.forEach(s => { const sp = bandSpecOf(p, s); if (sp) bands[s] = { w: sp.w, color: sp.color }; });
      return Object.assign({}, p, { material: materialGroupKey(p.material), bands });
    });
    const gstock = validStock().map(s => Object.assign({}, s, { material: materialGroupKey(s.material) }));
    const opts = {
      kerf: state.options.kerf,
      considerMaterial: true, // fixos (opções removidas da UI)
      considerGrain: true,
      allowRotate: true,
      weights: Optimizer.defaultWeights(),
    };
    return { gpanels, gstock, groupLabel, opts };
  }

  // Re-rotula (chave de grupo → nome legível) para exibição.
  function relabelResult(result, groupLabel) {
    result.sheets.forEach(s => { s.material = groupLabel[s.material] || s.material; });
    const bm2 = {};
    Object.keys(result.byMaterial).forEach(k => { bm2[groupLabel[k] || k] = result.byMaterial[k]; });
    result.byMaterial = bm2;
    return result;
  }

  // O cálculo NÃO é automático: a busca só INICIA pelo botão "Calcular plano"
  // (uma vez iniciada, roda continuamente melhorando o resultado). Edições não
  // recalculam — apenas marcam o plano como desatualizado e exibem um aviso na
  // aba Cortes (banner + ponto na aba), para o usuário recalcular quando quiser.
  let planStale = false;
  function markPlanStale() {
    if (live) stopLiveSearch(); // busca rodava com dados velhos → para (sem reiniciar)
    planStale = true;
    updateStaleNotice();
  }
  // Mostra/oculta o aviso de "alterações pendentes". Só aparece quando há um
  // plano já calculado, ele ficou desatualizado e não há busca em andamento.
  function updateStaleNotice() {
    const hasPlan = !!(state.plan && state.plan.sheets && state.plan.sheets.length);
    const show = planStale && hasPlan && !live;
    const banner = $('#plan-stale'); if (banner) banner.hidden = !show;
    const dot = $('#plan-tab-dot'); if (dot) dot.hidden = !show;
  }
  // Mostra o plano já salvo (sem recalcular) ou o aviso vazio.
  function showSavedPlan() {
    if (state.plan && state.plan.sheets && state.plan.sheets.length) { showResult(state.plan); planStale = false; }
    else renderPlanEmpty();
    updateStaleNotice();
  }

  // Atualiza métricas, tabela e desenho a partir de um resultado já rotulado.
  function showResult(result) {
    // Cache refs before any innerHTML mutation — Android Chrome can orphan
    // sibling elements when innerHTML is set on a node in the same subtree.
    const emptyEl     = $('#plan-empty');
    const metricsEl   = $('#plan-metrics');
    const breakdownEl = $('#plan-breakdown');
    const sheetsEl    = $('#plan-sheets');
    if (!metricsEl || !breakdownEl || !sheetsEl) return;

    const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0);
    const cuts = result.sheets.reduce((a, s) => a + s.cuts, 0);
    const totalArea = result.sheets.reduce((a, s) => a + s.W * s.H, 0);
    const usedArea = result.sheets.reduce((a, s) => a + s.placements.reduce((b, p) => b + (p.realW || p.w) * (p.realH || p.h), 0), 0);
    const eff = totalArea ? (usedArea / totalArea * 100) : 0;
    const m = Budget.metricsFromPlan(result, 'cm');

    if (emptyEl) emptyEl.style.display = 'none';
    metricsEl.innerHTML =
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
    breakdownEl.innerHTML =
      `<table class="grid compact breakdown"><thead><tr><th>Material</th><th>Chapas</th><th>Mín</th>` +
      `<th>Peças</th><th>Aprov.</th><th>Status</th></tr></thead><tbody>${rows}</tbody></table>`;

    renderUnplaced(result);
    Render.renderSheets(sheetsEl, result, { showLabels: true });
    Budget.applyMetrics(state.budgetItems, m);
  }
  function metric(k, v) { return `<div class="metric"><div class="v">${v}</div><div class="k">${k}</div></div>`; }

  // Lista, no TOPO do plano, as peças que não couberam — em tabela EDITÁVEL
  // (reusa makePanelRow, então editar reflete direto na lista de peças original).
  function renderUnplaced(result) {
    const box = $('#plan-unplaced'); if (!box) return;
    box.innerHTML = '';
    const items = (result && result.unplaced) || [];
    if (!items.length) { box.hidden = true; return; }
    // mapeia cada unidade não-posicionada de volta à peça original (por valor)
    const order = [], count = new Map();
    items.forEach(it => {
      const p = state.panels.find(q => q.width === it.w && q.length === it.h
        && (q.name || '') === (it.name || '') && materialGroupKey(q.material) === it.material);
      if (!p) return;
      if (!count.has(p)) { count.set(p, 0); order.push(p); }
      count.set(p, count.get(p) + 1);
    });
    box.hidden = false;
    const total = items.length;
    const head = el('div', 'unplaced-head');
    head.innerHTML = `<span class="material-symbols-outlined">warning</span>` +
      `<b>${total} peça(s) não couberam.</b> Ajuste medidas, quantidade, material ou veio aqui — ou aumente o estoque — e recalcule.`;
    box.appendChild(head);
    if (!order.length) return; // não achou correspondência (peças editadas após o cálculo)
    const table = el('table', 'grid compact');
    table.innerHTML =
      `<thead><tr><th class="cell-act"></th><th class="cell-num">Larg.</th><th class="cell-num">Compr.</th>` +
      `<th class="cell-qty">Qtd</th><th class="cell-mat">Mat</th><th class="cell-name">Nome</th>` +
      `<th class="cell-veio">Veio</th><th class="cell-fita">Fita</th><th class="cell-act">Faltou</th></tr></thead>`;
    const tbody = el('tbody');
    order.forEach(p => {
      const tr = makePanelRow(p);
      // troca o último botão (excluir) por um marcador de quantas unidades faltaram
      const last = tr.lastChild; if (last) { last.textContent = count.get(p) + '×'; last.className = 'cell-act unplaced-count'; }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    const wrap = el('div', 'table-wrap'); wrap.appendChild(table);
    box.appendChild(wrap);
  }

  // ---------- Busca contínua (testa e melhora ao vivo) ----------
  let live = null; // { search, groupLabel, raf }

  function setRunButton(running) {
    const b = $('#run-plan');
    if (!b) return;
    b.innerHTML = running
      ? '<span class="material-symbols-outlined">pause</span>Pausar e usar este'
      : '<span class="material-symbols-outlined">play_arrow</span>Calcular plano';
    b.classList.toggle('searching', !!running);
  }
  function setPlanStatus(txt) { const e = $('#plan-status'); if (e) { e.textContent = txt || ''; e.style.display = txt ? 'block' : 'none'; } }

  function startLiveSearch() {
    const inp = buildPlanInputs();
    if (!inp) { toast('Importe um CSV ou adicione peças.'); return; }
    const search = Optimizer.createSearch(inp.gpanels, inp.gstock, inp.opts);
    live = { search, groupLabel: inp.groupLabel, raf: 0 };
    planStale = false;
    setRunButton(true);
    $('#plan-empty').style.display = 'none';
    setPlanStatus('Procurando o melhor aproveitamento…');
    updateStaleNotice(); // busca em andamento → esconde o aviso de alterações
    tickLive();
  }

  function stopLiveSearch() {
    if (!live) return;
    if (live.raf) cancelAnimationFrame(live.raf);
    live = null;
    setRunButton(false);
    setPlanStatus('');
    updateStaleNotice();
  }

  function tickLive() {
    if (!live) return;
    const search = live.search;
    const t0 = performance.now();
    let improved = false, info = null;
    do {
      info = search.step();
      if (info.improved) improved = true;
    } while (!info.converged && performance.now() - t0 < 14);

    if (improved) {
      const result = relabelResult(search.result(), live.groupLabel);
      state.plan = result;
      showResult(result);
      save();
    }
    const pct = Math.min(100, Math.round(info.det / info.totalDet * 100));
    const phase = info.det < info.totalDet ? `Testando combinações… ${pct}%`
      : (info.beam && info.beam.idx < info.beam.total) ? `Busca profunda (beam)… ${info.beam.idx}/${info.beam.total}`
      : 'Refinando (reinícios aleatórios)…';
    const ns = state.plan ? state.plan.sheets.length : 0;
    setPlanStatus(`${phase} · melhor: ${ns} chapa(s) · ${info.step} tentativas — toque em “Pausar e usar este” quando quiser.`);

    if (info.converged) {
      setPlanStatus('');
      stopLiveSearch();
      toast('Otimização estabilizou — usando o melhor plano.');
      return;
    }
    live.raf = requestAnimationFrame(tickLive);
  }

  function toggleLiveSearch() {
    if (live) {
      stopLiveSearch();
      toast('Usando o melhor plano encontrado.');
    } else {
      startLiveSearch();
    }
  }

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
      let name = 'Compartilhado';
      try { name = decodeURIComponent(res.headers.get('X-File-Name') || '') || name; } catch (e) {}
      await cache.delete('shared-csv');
      if (text && text.trim()) { importAsProject(text, name); return true; }
    } catch (e) {}
    return false;
  }
  function initShareHandlers() {
    // 1) Compartilhamento (Android/Chrome): SW redireciona com ?shared=1
    readSharedCSV().then(() => { if (location.search) history.replaceState(null, '', location.pathname); });
    // 2) "Abrir com" (File Handling API, desktop): recebe o arquivo direto
    if ('launchQueue' in window && window.launchQueue && 'setConsumer' in window.launchQueue) {
      window.launchQueue.setConsumer(async params => {
        if (params && params.files && params.files.length) {
          try {
            const file = await params.files[0].getFile();
            const text = await file.text();
            if (text && text.trim()) importAsProject(text, file.name);
          } catch (e) {}
        }
      });
    }
  }

  // ---------- Init ----------
  function init() {
    load();
    const verEl = $('#app-version'); if (verEl) verEl.textContent = APP_VERSION;
    // seleciona todo o conteúdo de campos numéricos ao focar
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && (t.inputMode === 'decimal' || t.inputMode === 'numeric' || t.type === 'number')) {
        setTimeout(() => { try { t.select(); } catch (err) {} }, 0);
      }
    });
    initTabs(); initOptions(); initImport(); initSelect(); initBudgetCfg(); initBandModal(); initProjects();
    updateProjectName(); renderStock(); renderPanels();
    showSavedPlan(); // cálculo é manual
    // touchend + click ambos disparam num único toque no Android Chrome.
    // O flag recentTouch impede que o click processe o mesmo toque.
    let recentTouch = false;
    const runBtn = $('#run-plan');
    runBtn.addEventListener('touchend', function (e) {
      recentTouch = true;
      setTimeout(function () { recentTouch = false; }, 500);
      e.preventDefault();
      toggleLiveSearch();
    }, { passive: false });
    runBtn.addEventListener('click', function () {
      if (recentTouch) return;
      toggleLiveSearch();
    });
    // Desfazer / Refazer (botões + atalhos de teclado)
    const undoBtn = $('#undo-btn'), redoBtn = $('#redo-btn');
    if (undoBtn) undoBtn.addEventListener('click', doUndo);
    if (redoBtn) redoBtn.addEventListener('click', doRedo);
    document.addEventListener('keydown', e => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return; // deixa o desfazer nativo do campo
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); doUndo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); doRedo(); }
    });
    resetHistory();
    initShareHandlers();
  }
  document.addEventListener('DOMContentLoaded', init);
})();
