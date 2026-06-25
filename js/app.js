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
      stock: [{ width: 184, length: 274, qty: 5, material: '', name: 'Chapa' }],
      options: { kerf: 0.8 }, // única opção ajustável (material/grão/labels/pesos fixos no padrão)
      materialColors: {},
      materialNames: {},
      materials: [],
      budgetQtys: {},
      budgetCfg: Budget.defaultCfg(),
      budgetDescription: '',
      budgetPhoto: '',
      plan: null,
    };
  }
  let state = emptyData();                 // dados do projeto ativo (referência viva)
  let db = { projects: [], activeId: null, budgetGlobal: { items: Budget.defaultItems() } };
  const DB_KEY = 'projeto-corte-db-v1';
  const OLD_KEY = 'projeto-corte-v1';
  const MAX_QTY = 999; // teto de quantidade por linha (peças/estoque) — evita travar a busca
  // "Sem material" (material vazio) = peça FORA do plano de corte (símbolo —).
  // Serve para desligar peças sem excluí-las.
  // Versão exibida no cabeçalho. Reflete o app.js carregado na tela (útil para
  // saber se o cache do Service Worker já atualizou). Manter igual ao N de sw.js.
  const APP_VERSION = 'v118';

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
    // Migrar quantidades do formato antigo (budgetItems.qty → budgetQtys).
    const budgetQtys = d.budgetQtys ? Object.assign({}, d.budgetQtys) : {};
    if (Array.isArray(d.budgetItems) && !d.budgetQtys) {
      d.budgetItems.forEach(it => { if (it.key && it.type !== 'auto' && it.qty) budgetQtys[it.key] = it.qty; });
    }
    // Migrar budgetCfg: campos antigos (markupPct/pixPct) são descartados.
    const dc = d.budgetCfg || {};
    const out = {
      panels: Array.isArray(d.panels) ? d.panels : e.panels,
      stock: Array.isArray(d.stock) && d.stock.length ? d.stock : e.stock,
      // só o kerf persiste; demais configs foram removidas (ignora valores antigos)
      options: { kerf: (d.options && isFinite(parseFloat(d.options.kerf))) ? parseFloat(d.options.kerf) : e.options.kerf },
      materialColors: (d.materialColors && typeof d.materialColors === 'object') ? d.materialColors : {},
      materialNames: coerceNames(d.materialNames),
      materials: Array.isArray(d.materials) ? d.materials.slice() : [],
      budgetQtys,
      budgetCfg: {
        laborPct:     dc.laborPct     != null ? dc.laborPct     : e.budgetCfg.laborPct,
        complexidade: dc.complexidade != null ? dc.complexidade : e.budgetCfg.complexidade,
        // daysPerPiece (v83) migra para daysPerUnit
        daysPerUnit:  dc.daysPerUnit  != null ? dc.daysPerUnit  : (dc.daysPerPiece != null ? dc.daysPerPiece : e.budgetCfg.daysPerUnit),
        fixacaoRate:  dc.fixacaoRate  != null ? dc.fixacaoRate  : e.budgetCfg.fixacaoRate,
        entradaPct:   dc.entradaPct   != null ? dc.entradaPct   : e.budgetCfg.entradaPct,
        credit6xFee:    dc.credit6xFee    != null ? dc.credit6xFee    : e.budgetCfg.credit6xFee,
        credit12xFee:   dc.credit12xFee   != null ? dc.credit12xFee   : e.budgetCfg.credit12xFee,
        pixDiscountPct: dc.pixDiscountPct != null ? dc.pixDiscountPct : e.budgetCfg.pixDiscountPct,
      },
      budgetDescription: d.budgetDescription || '',
      budgetPhoto: d.budgetPhoto || '',
      plan: (d.plan && typeof d.plan === 'object' && Array.isArray(d.plan.sheets)) ? d.plan : null,
    };
    return out;
  }
  function makeProject(name, data) {
    return { id: genId(), name: name || 'Projeto', createdAt: Date.now(), updatedAt: Date.now(), data: normalizeData(data) };
  }

  // Migração (v115): "Fixação" deixou de ser auto-value (subtotal = qty em R$ via
  // cfg.fixacaoRate) e virou item 'auto' normal — o VALOR UNITÁRIO do item é a
  // constante que multiplica a quantidade automática (totalN). Herda o R$/N antigo
  // (cfg.fixacaoRate do projeto ativo, ou o 1º com valor) como valor unitário.
  function migrateFixacaoItem() {
    const items = db.budgetGlobal && db.budgetGlobal.items;
    if (!Array.isArray(items)) return;
    const fx = items.find(i => i && i.key === 'fixacao');
    if (!fx || fx.type !== 'auto-value') return;
    fx.type = 'auto'; fx.src = 'totalN';
    const order = [];
    const act = db.projects.find(p => p.id === db.activeId);
    if (act) order.push(act);
    db.projects.forEach(p => { if (p !== act) order.push(p); });
    let rate = null;
    for (const p of order) {
      const r = p && p.data && p.data.budgetCfg && p.data.budgetCfg.fixacaoRate;
      if (r != null) { rate = r; if (r) break; }
    }
    // fiel ao subtotal anterior (totalN × fixacaoRate); sem valor → 0 (estava "off")
    fx.price = rate != null ? rate : 0;
  }

  function load() {
    let parsed = null;
    try { parsed = JSON.parse(localStorage.getItem(DB_KEY) || 'null'); } catch (e) {}
    if (parsed && Array.isArray(parsed.projects) && parsed.projects.length) {
      db = parsed;
      if (!db.budgetGlobal) {
        // Migração: herdar preços do primeiro projeto com budgetItems salvo.
        const items = Budget.defaultItems();
        for (const p of db.projects) {
          if (Array.isArray(p.data && p.data.budgetItems)) {
            items.forEach(def => { const f = p.data.budgetItems.find(i => i.key === def.key); if (f && f.price != null) def.price = f.price; });
            break;
          }
        }
        db.budgetGlobal = { items };
      } else {
        db.budgetGlobal.items = db.budgetGlobal.items || Budget.defaultItems();
      }
      migrateFixacaoItem(); // antes do normalizeData (lê o fixacaoRate antigo cru)
      db.projects.forEach(p => { p.data = normalizeData(p.data); });
    } else {
      let old = null;
      try { old = JSON.parse(localStorage.getItem(OLD_KEY) || 'null'); } catch (e) {}
      const proj = makeProject('Projeto 1', old);
      db = { projects: [proj], activeId: proj.id, budgetGlobal: { items: Budget.defaultItems() } };
    }
    if (!db.projects.find(p => p.id === db.activeId)) db.activeId = db.projects[0].id;
    state = activeProject().data;
  }

  function saveDb() {
    const build = (withPlan) => ({
      activeId: db.activeId,
      budgetGlobal: db.budgetGlobal,
      projects: db.projects.map(p => ({
        id: p.id, name: p.name, createdAt: p.createdAt, updatedAt: p.updatedAt,
        data: withPlan ? p.data : Object.assign({}, p.data, { plan: null }),
      })),
    });
    try {
      localStorage.setItem(DB_KEY, JSON.stringify(build(true)));
    } catch (e) {
      // quota excedida com o plano → grava sem o plano para não perder os dados
      try { localStorage.setItem(DB_KEY, JSON.stringify(build(false))); } catch (e2) {}
    }
  }
  function save() { const p = activeProject(); if (p) p.updatedAt = Date.now(); saveDb(); recordHistory(); }

  // ---------- Histórico (desfazer / refazer) ----------
  // Snapshots do projeto ativo (sem o plano). Cada save() registra um ponto;
  // desfazer/refazer navegam por eles. O plano é preservado mas marcado como stale.
  let history = [], histIndex = -1, restoringHistory = false;
  const HISTORY_MAX = 120;
  // Foto (budgetPhoto) fica FORA do histórico: é só um marcador e os bytes vivem
  // no IndexedDB por projeto — não deve ser afetada por desfazer/refazer.
  function snapData() { return JSON.stringify(Object.assign({}, state, { plan: null, budgetPhoto: '' })); }
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
      if (proj) {
        const prevPlan = state.plan;   // preserva o plano calculado durante undo/redo
        const prevPhoto = state.budgetPhoto; // foto não entra no histórico
        proj.data = normalizeData(JSON.parse(snap));
        proj.data.plan = prevPlan;
        proj.data.budgetPhoto = prevPhoto;
        state = proj.data;
        saveDb();
      }
      selected.clear();
      renderActive(); // showSavedPlan exibe o plano e reseta planStale
      if (state.plan && state.plan.sheets && state.plan.sheets.length) {
        planStale = true; updateStaleNotice(); // peças mudaram → plano pode estar desatualizado
      }
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
  const brlNum = n => (n || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const brl = n => 'R$ ' + brlNum(n);
  // Célula monetária com prefixo "R$" à esquerda e valor à direita (flex .rs).
  const brlSplit = n => '<span class="rs"><span class="cur">R$</span><span class="val">' + brlNum(n) + '</span></span>';
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
  function blankStock() { return { width: 0, length: 0, qty: 1, material: '', name: '' }; }
  const isBlankPanel = p => !(p.length > 0) && !(p.width > 0) && !String(p.material || '').trim() && !String(p.name || '').trim();
  const isBlankStock = s => !(s.width > 0) && !(s.length > 0) && !String(s.material || '').trim() && !String(s.name || '').trim();
  function ensureTrailingBlank(arr, isBlank, mk) { if (!arr.length || !isBlank(arr[arr.length - 1])) arr.push(mk()); }
  const validPanels = () => state.panels.filter(p => p.length > 0 && p.width > 0);
  const validStock = () => {
    const v = state.stock.filter(s => s.width > 0 && s.length > 0);
    return v.length ? v : [{ width: 184, length: 274, qty: 999, material: '', name: 'Chapa' }];
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
  // Botão = retângulo da peça; cada lado com fita ganha uma linha EXTERNA, na
  // cor da fita, com contorno preto fino (fina p/ 22, grossa p/ 45).
  function refreshFitaButton(b, p) {
    let any = false;
    const W = 22, H = 34, m = 6, gap = 2.6;
    const seg = (sp, x1, y1, x2, y2) => {
      if (!sp) return '';
      any = true;
      const sw = sp.w === 45 ? 4.2 : 2.4;
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#000" stroke-width="${sw + 1.3}" stroke-linecap="round"/>` +
        `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${sp.color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    };
    const body =
      `<rect x="${m}" y="${m}" width="${W - 2 * m}" height="${H - 2 * m}" fill="#eef0ed" stroke="#aeb5b0" stroke-width="0.8"/>` +
      seg(bandSpecOf(p, 'top'), m, m - gap, W - m, m - gap) +
      seg(bandSpecOf(p, 'bottom'), m, H - m + gap, W - m, H - m + gap) +
      seg(bandSpecOf(p, 'left'), m - gap, m, m - gap, H - m) +
      seg(bandSpecOf(p, 'right'), W - m + gap, m, W - m + gap, H - m);
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
    // nome da chapa (texto livre) — diferencia chapas parecidas
    const tdNm = el('td', 'cell-name');
    const nameInp = document.createElement('input'); nameInp.placeholder = 'Chapa'; nameInp.value = s.name || '';
    nameInp.addEventListener('change', () => { const cap = capFirst(nameInp.value.trim()); nameInp.value = cap; onStockField(s, 'name', cap); });
    tdNm.appendChild(nameInp); tr.appendChild(tdNm);
    if (s.grain == null) s.grain = 'v'; // padrão: veio ao longo do comprimento
    const tdV = el('td', 'cell-veio'); tdV.appendChild(veioButton(s, { stock: true, onCycle: () => { save(); markPlanStale(); } })); tr.appendChild(tdV);
    const tdD = el('td', 'cell-act'); tdD.appendChild(iconBtn('del', 'delete', 'Excluir', () => deleteRow('stock', s))); tr.appendChild(tdD);
    return tr;
  }
  function onStockField(s, f, value) {
    if (f === 'material') s[f] = String(value).trim();
    else if (f === 'qty') s[f] = clampQty(value);
    else if (f === 'name') s[f] = String(value).trim();
    else s[f] = parseNum(value);
    if (f === 'material') { save(); renderStock(); renderPanels(); }
    else { save(); afterRowEdit('stock'); }
    if (f !== 'name' && validPanels().length) markPlanStale(); // nome não afeta o plano
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
  async function deleteRow(which, obj) {
    const isBlank = which === 'panels' ? isBlankPanel(obj) : isBlankStock(obj);
    if (!isBlank) {
      const label = obj.name
        ? `"${obj.name}"`
        : (which === 'panels' ? `${obj.width}×${obj.length}` : `${obj.width}×${obj.length} cm`);
      const ok = await ui.confirm(`Excluir ${label}?`,
        { title: which === 'panels' ? 'Excluir peça' : 'Excluir chapa', danger: true, okText: 'Excluir' });
      if (!ok) return;
    }
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
    // novo projeto herdando opções do projeto atual
    const base = activeProject() ? activeProject().data : emptyData();
    const proj = makeProject(projectNameFromFile(fileName),
      { options: base.options, budgetCfg: base.budgetCfg });
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
    gotoTab('panels'); // revisar as peças; o plano é calculado manualmente no botão
    toast('Projeto: ' + proj.name);
    resetHistory();
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
    idbDelPhoto(p.id); // remove a foto de referência do IndexedDB
    if (!db.projects.length) { const np = makeProject('Projeto 1', null); db.projects.push(np); db.activeId = np.id; }
    if (p.id === db.activeId) db.activeId = db.projects[0].id;
    state = activeProject().data; saveDb();
    renderActive(); renderProjectsList(); resetHistory();
  }
  function newProject() {
    const base = activeProject() ? activeProject().data : emptyData();
    const proj = makeProject(projectNameFromFile('Projeto'),
      { options: base.options, budgetCfg: base.budgetCfg });
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
    drawBandEditor(); renderBandPalette();
    $('#band-modal').hidden = false;
  }
  function closeBandModal() { $('#band-modal').hidden = true; editing = null; }
  function drawBandEditor() {
    const p = editing.p;
    const L = p.width > 0 ? p.width : 60, C = p.length > 0 ? p.length : 40;
    // PROPORÇÃO da peça, mas LIMITADA (senão peças compridas estouram a tela)
    const maxRatio = 2.4;
    let rw = L, rh = C;
    if (rw / rh > maxRatio) rh = rw / maxRatio; else if (rh / rw > maxRatio) rw = rh / maxRatio;
    const maxPx = 168, scale = maxPx / Math.max(rw, rh);
    const w = Math.round(rw * scale), h = Math.round(rh * scale);
    const pad = 34, x0 = pad, y0 = pad, x1 = pad + w, y1 = pad + h, gap = 5;
    const b = editing.bands;
    // fitas: linha EXTERNA ao retângulo, com contorno preto fino (igual ao ícone)
    const seg = (s, ax, ay, bx, by) => {
      const sp = b[s]; if (!sp) return '';
      const sw = sp.w === 45 ? 9 : 5;
      return `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="#000" stroke-width="${sw + 2}" stroke-linecap="round"/>` +
        `<line x1="${ax}" y1="${ay}" x2="${bx}" y2="${by}" stroke="${sp.color}" stroke-width="${sw}" stroke-linecap="round"/>`;
    };
    const hit = (s, x, y, ww, hh) => `<rect class="edge-hit" data-side="${s}" x="${x}" y="${y}" width="${ww}" height="${hh}"/>`;
    const cx = x0 + w / 2, cy = y0 + h / 2;
    const fsName = Math.max(7, Math.min(Math.min(w, h) * 0.2, 16));
    const svg =
      `<svg viewBox="0 0 ${w + pad * 2} ${h + pad * 2}">` +
      `<rect x="${x0}" y="${y0}" width="${w}" height="${h}" fill="#f3f1e7" stroke="#9aa39d" stroke-width="1.4"/>` +
      seg('top', x0, y0 - gap, x1, y0 - gap) + seg('bottom', x0, y1 + gap, x1, y1 + gap) +
      seg('left', x0 - gap, y0, x0 - gap, y1) + seg('right', x1 + gap, y0, x1 + gap, y1) +
      hit('top', x0, y0 - 16, w, 22) + hit('bottom', x0, y1 - 6, w, 22) +
      hit('left', x0 - 16, y0, 22, h) + hit('right', x1 - 6, y0, 22, h) +
      `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" font-size="${fsName}" fill="#2a2a2a" font-weight="700">${esc(p.name || 'Peça')}</text>` +
      `<text x="${cx}" y="${y0 - 22}" text-anchor="middle" font-size="12" fill="#555">${fmtNum(L)}</text>` +
      `<text x="${x0 - 22}" y="${cy}" text-anchor="middle" font-size="12" fill="#555" transform="rotate(-90 ${x0 - 22} ${cy})">${fmtNum(C)}</text>` +
      `</svg>`;
    const c = $('#bm-canvas'); c.innerHTML = svg;
    c.querySelectorAll('[data-side]').forEach(el2 => el2.addEventListener('click', () => {
      const s = el2.dataset.side;
      editing.bands[s] = editing.bands[s] ? false : { w: editing.brush.w, color: editing.brush.color };
      drawBandEditor();
    }));
  }
  // Paleta SEMPRE visível na base: cores × {22,45}. Branco está sempre presente.
  // A opção selecionada (pincel) recebe um destaque de moldura.
  function renderBandPalette() {
    const box = $('#bm-palette'); if (!box || !editing) return;
    const mats = [{ label: 'Branco', color: '#ffffff' }];
    materialsOrdered().forEach(m => { const c = matColor(m); if (String(c).toLowerCase() !== '#ffffff') mats.push({ label: matLabel(m), color: c }); });
    box.innerHTML = '';
    mats.forEach(mt => BAND_WIDTHS.forEach(wd => {
      const sel = (String(mt.color).toLowerCase() === String(editing.brush.color).toLowerCase() && wd === editing.brush.w);
      const c = el('button', 'mat-chip band-w' + (sel ? ' sel' : '')); c.type = 'button';
      paintBandChip(c, mt.color, wd); c.title = `${mt.label} · ${wd}mm`;
      c.addEventListener('click', () => { editing.brush = { w: wd, color: mt.color }; renderBandPalette(); });
      box.appendChild(c);
    }));
  }
  function initBandModal() {
    $('#bm-close').addEventListener('click', closeBandModal);
    $('#bm-cancel').addEventListener('click', closeBandModal);
    $('#band-modal').addEventListener('click', e => { if (e.target.id === 'band-modal') closeBandModal(); });
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
    // Passa TODAS as linhas de estoque (o otimizador agrupa por material e usa
    // múltiplos tamanhos de chapa do mesmo material, em cascata — maior primeiro).
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

  // Re-rotula (chave de grupo → nome legível) para exibição. O nome da chapa
  // (s.stockName) já vem do otimizador por chapa (tamanho de estoque de origem).
  function relabelResult(result, groupLabel) {
    result.sheets.forEach(s => {
      if (!s.stockName) s.stockName = 'Chapa'; // fallback p/ chapa sem nome
      // Grava se é material branco ANTES de trocar a chave de grupo pelo rótulo.
      // A chave tem formato "#rrggbb|espessura"; verificar a cor hex garante
      // que renomear o material no editor não quebre a classificação no orçamento.
      s.materialWhite = String(s.material).split('|')[0] === '#ffffff';
      s.material = groupLabel[s.material] || s.material;
    });
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
    const show = planStale && hasPlan && !liveWorker;
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
    // Sempre recomputa sobras ótimas — planos carregados do localStorage têm
    // free arrays fragmentados do runtime; refineOffcuts garante a decomposição
    // correta independentemente de onde showResult é chamado.
    // Pula refineOffcuts se o worker já computou (result.__refined); senão roda
    // aqui para planos carregados do localStorage ou restaurados por undo/redo.
    if (result.sheets && !result.__refined) Optimizer.refineOffcuts(result.sheets);

    // Cache refs before any innerHTML mutation — Android Chrome can orphan
    // sibling elements when innerHTML is set on a node in the same subtree.
    const emptyEl     = $('#plan-empty');
    const metricsEl   = $('#plan-metrics');
    const breakdownEl = $('#plan-breakdown');
    const sheetsEl    = $('#plan-sheets');
    if (!metricsEl || !breakdownEl || !sheetsEl) return;

    const pieces = result.sheets.reduce((a, s) => a + s.placements.length, 0);

    if (emptyEl) emptyEl.style.display = 'none';
    metricsEl.innerHTML = '';

    // Tabela ÚNICA: resumo por material (geral, destacado) no topo + detalhe por chapa.
    const typeCount = {};
    result.sheets.forEach(s => { const k = s.material + '|' + (s.stockName || ''); typeCount[k] = (typeCount[k] || 0) + 1; });
    // índice da primeira chapa de cada material (para navegar nos cliques das linhas de resumo)
    const matFirstIdx = {};
    result.sheets.forEach((s, i) => { if (!(s.material in matFirstIdx)) matFirstIdx[s.material] = i; });
    const bm = result.byMaterial;
    let rows = '';
    Object.keys(bm).forEach(mat => {
      const d = bm[mat];
      const minSheets = Math.max(1, Math.ceil(d.usedArea / (d.area / d.sheets)));
      const effMat = d.area ? (d.usedArea / d.area * 100) : 0;
      const si = matFirstIdx[mat] != null ? ` data-sheet="${matFirstIdx[mat]}"` : '';
      rows += `<tr class="tbl-geral"${si}><td>${d.sheets} / ${minSheets}</td><td>${esc(mat)}</td><td>${d.pieces}</td><td>${effMat.toFixed(1)}%</td></tr>`;
    });
    result.sheets.forEach((s, idx) => {
      const u = s.placements.reduce((a, p) => a + (p.realW || p.w) * (p.realH || p.h), 0);
      const ef = s.W * s.H ? (u / (s.W * s.H) * 100) : 0;
      const nm = (s.stockName || 'Chapa') + (typeCount[s.material + '|' + (s.stockName || '')] > 1 ? ' ' + s.index : '');
      rows += `<tr data-sheet="${idx}"><td>${esc(nm)}</td><td>${esc(s.material)}</td><td>${s.placements.length}</td><td>${ef.toFixed(1)}%</td></tr>`;
    });
    breakdownEl.innerHTML =
      `<table class="grid compact plan-tbl"><thead><tr><th>Chapas/mín</th><th>Material</th>` +
      `<th>Peças</th><th>Aprov.</th></tr></thead><tbody>${rows}</tbody></table>`;
    breakdownEl.querySelector('tbody').addEventListener('click', e => {
      const tr = e.target.closest('tr[data-sheet]');
      if (!tr) return;
      const card = document.getElementById('sheet-card-' + tr.dataset.sheet);
      if (!card) return;
      const header = document.querySelector('.app-header');
      const gap = (header ? header.getBoundingClientRect().height : 0) + 10;
      window.scrollTo({ top: card.getBoundingClientRect().top + window.scrollY - gap, behavior: 'smooth' });
    });

    renderUnplaced(result);
    Render.renderSheets(sheetsEl, result, { showLabels: true });
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
    head.innerHTML = `<span class="material-symbols-outlined">warning</span><b>${total} peça(s) não couberam</b>`;
    box.appendChild(head);
    // Estoque PRIMEIRO (mudar o estoque também pode resolver)
    const stock = state.stock.filter(s => s.width > 0 && s.length > 0);
    if (stock.length) {
      const lbl = el('div', 'unplaced-sub'); lbl.textContent = 'Estoque';
      box.appendChild(lbl);
      const st = el('table', 'grid compact');
      st.innerHTML =
        `<thead><tr><th class="cell-act"></th><th class="cell-num">Larg.</th><th class="cell-num">Compr.</th>` +
        `<th class="cell-qty">Qtd</th><th class="cell-mat">Mat</th><th class="cell-name">Nome</th>` +
        `<th class="cell-veio">Veio</th><th class="cell-act"></th></tr></thead>`;
      const sb = el('tbody');
      stock.forEach(s => sb.appendChild(makeStockRow(s)));
      st.appendChild(sb);
      const sw = el('div', 'table-wrap'); sw.appendChild(st);
      box.appendChild(sw);
    }
    // Peças (não couberam) — editáveis
    if (order.length) {
      const lbl2 = el('div', 'unplaced-sub'); lbl2.textContent = 'Peças';
      box.appendChild(lbl2);
      const table = el('table', 'grid compact');
      table.innerHTML =
        `<thead><tr><th class="cell-act"></th><th class="cell-num">Larg.</th><th class="cell-num">Compr.</th>` +
        `<th class="cell-qty">Qtd</th><th class="cell-mat">Mat</th><th class="cell-name">Nome</th>` +
        `<th class="cell-veio">Veio</th><th class="cell-fita">Fita</th><th class="cell-act">Faltou</th></tr></thead>`;
      const tbody = el('tbody');
      order.forEach(p => {
        const tr = makePanelRow(p);
        const last = tr.lastChild; if (last) { last.textContent = count.get(p) + '×'; last.className = 'cell-act unplaced-count'; }
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      const wrap = el('div', 'table-wrap'); wrap.appendChild(table);
      box.appendChild(wrap);
    }
  }

  // ---------- Busca em Web Worker (não bloqueia a thread principal) ----------
  let liveWorker = null, _progressRaf = 0;

  function setRunButton(running) {
    const b = $('#run-plan');
    if (!b) return;
    b.disabled = !!running;
    b.innerHTML = running
      ? '<span class="material-symbols-outlined">hourglass_empty</span>Calculando…'
      : '<span class="material-symbols-outlined">play_arrow</span>Calcular plano';
    b.classList.toggle('searching', !!running);
  }
  let _displayPct = 0, _targetPct = 0, _bandHi = 5;

  // ---------- Popup de progresso por etapas ----------
  // Cada etapa tem uma faixa no progresso global (0..100). A etapa local vai de
  // 0→100% dentro da sua faixa: começa cinza (pendente), acende em verde enquanto
  // avança (ativa) e fica verde cheia com ✓ ao concluir. O popup some quando todas
  // as etapas chegam a 100%.
  const PROG_STEPS = [
    { id: 'prep',   label: 'Preparando peças',      lo: 0,  hi: 5 },
    { id: 'fast',   label: 'Busca rápida',          lo: 5,  hi: 42 },
    { id: 'deep',   label: 'Otimização profunda',   lo: 42, hi: 80 },
    { id: 'final',  label: 'Consolidando o plano',  lo: 80, hi: 94 },
    { id: 'render', label: 'Montando visualização', lo: 94, hi: 100 }
  ];
  let _progModalEl = null;
  const _progRows = {};

  function ensureProgressModal() {
    if (_progModalEl) return _progModalEl;
    const ov = document.createElement('div');
    ov.id = 'plan-progress-modal';
    ov.className = 'ppm-overlay';
    ov.setAttribute('role', 'dialog');
    ov.setAttribute('aria-label', 'Progresso do cálculo do plano');
    const card = document.createElement('div');
    card.className = 'ppm-card';
    card.innerHTML = '<h3 class="ppm-title">Calculando plano de corte</h3>';
    const ul = document.createElement('ul');
    ul.className = 'ppm-steps';
    PROG_STEPS.forEach(function (st) {
      const li = document.createElement('li');
      li.className = 'ppm-step';
      li.dataset.step = st.id;
      li.innerHTML =
        '<div class="ppm-step-top">'
        + '<span class="ppm-step-dot"><span class="material-symbols-outlined">check</span></span>'
        + '<span class="ppm-step-label">' + st.label + '</span>'
        + '<span class="ppm-step-pct">0%</span>'
        + '</div>'
        + '<div class="ppm-step-bar"><div class="ppm-step-fill"></div></div>';
      _progRows[st.id] = {
        li: li,
        pct: li.querySelector('.ppm-step-pct'),
        fill: li.querySelector('.ppm-step-fill')
      };
      ul.appendChild(li);
    });
    card.appendChild(ul);
    ov.appendChild(card);
    document.body.appendChild(ov);
    _progModalEl = ov;
    return ov;
  }

  function showProgressModal() {
    ensureProgressModal();
    updateProgressModal(0);
    // força reflow antes de abrir, para a transição de entrada rodar
    void _progModalEl.offsetWidth;
    _progModalEl.classList.add('open');
  }

  function hideProgressModal() {
    if (!_progModalEl) return;
    _progModalEl.classList.remove('open');
  }

  function updateProgressModal(g) {
    if (!_progModalEl) return;
    PROG_STEPS.forEach(function (st) {
      const row = _progRows[st.id];
      if (!row) return;
      let local = (g - st.lo) / (st.hi - st.lo) * 100;
      if (local < 0) local = 0; else if (local > 100) local = 100;
      row.fill.style.width = local + '%';
      row.pct.textContent = Math.round(local) + '%';
      row.li.classList.toggle('done', local >= 100);
      row.li.classList.toggle('active', local > 0 && local < 100);
    });
  }

  function startLiveSearch() {
    const inp = buildPlanInputs();
    if (!inp) { toast('Importe um CSV ou adicione peças.'); return; }
    planStale = false;
    _displayPct = 0; _targetPct = 0; _bandHi = 5;
    setRunButton(true);
    const emptyEl = $('#plan-empty'); if (emptyEl) emptyEl.style.display = 'none';
    showProgressModal();
    updateStaleNotice();

    liveWorker = new Worker('./js/optimizer-worker.js');
    liveWorker.onmessage = function (e) {
      const msg = e.data;
      if (msg.type === 'progress') {
        // Faixas no progresso global: det→5-42%, beam→42-80%. Math.max impede
        // retrocesso. _bandHi é o teto até onde o trickle pode subir sozinho
        // enquanto não há sinal novo (nunca passa do topo da fase atual).
        let tp;
        if (!msg.beam || msg.det < msg.totalDet) {
          tp = 5 + (msg.totalDet ? (msg.det / msg.totalDet) * 37 : 0);
          _bandHi = 42;
        } else {
          tp = 42 + (msg.beam.idx / msg.beam.total) * 38;
          _bandHi = 80;
        }
        _targetPct = Math.max(_targetPct, tp);
      } else if (msg.type === 'finalize_start') {
        // Pós-processamento (antes travava em 92%). Faixa global 80-94%.
        _bandHi = 94;
        _targetPct = Math.max(_targetPct, 80);
      } else if (msg.type === 'finalize') {
        _bandHi = 94;
        _targetPct = Math.max(_targetPct, 80 + (msg.frac || 0) * 14);
      } else if (msg.type === 'done_signal') {
        // Sinal leve — worker terminou o cálculo mas ainda não enviou os dados.
        // Cancela o RAF, anima a etapa "Montando visualização" e só então pede o
        // payload pesado (cuja desserialização bloqueia a thread principal).
        if (_progressRaf) { cancelAnimationFrame(_progressRaf); _progressRaf = 0; }
        setRunButton(false); updateStaleNotice();

        // Sprint suave dentro da faixa render (94→99%) em ~450 ms.
        const sprintFrom = _displayPct, sprintTo = 99, sprintDuration = 450, sprintStart = performance.now();
        (function sprintTick(ts) {
          const t = Math.min(1, (ts - sprintStart) / sprintDuration);
          _displayPct = sprintFrom + (sprintTo - sprintFrom) * t * (2 - t);
          updateProgressModal(_displayPct);
          if (t < 1) { requestAnimationFrame(sprintTick); return; }
          // rAF + setTimeout(0): popup repintado antes de enviar 'ready'. A
          // desserialização do payload pesado (done) só bloqueia após este ponto,
          // com a etapa "Montando visualização" já visível em andamento.
          requestAnimationFrame(function () { setTimeout(function () {
            if (liveWorker) liveWorker.postMessage({ type: 'ready' });
          }, 0); });
        })(performance.now());

      } else if (msg.type === 'done') {
        // Payload pesado chegou — popup já está pintado na tela.
        if (liveWorker) { liveWorker.terminate(); liveWorker = null; }
        const result = relabelResult(msg.result, inp.groupLabel);
        state.plan = result;
        showResult(result);
        save();
        // Todas as etapas concluídas (100%) — segura um instante e fecha o popup.
        updateProgressModal(100);
        setTimeout(hideProgressModal, 650);
      }
    };
    liveWorker.onerror = function () { stopLiveSearch(); toast('Erro no cálculo.'); };
    liveWorker.postMessage({ panels: inp.gpanels, stockList: inp.gstock, options: inp.opts });

    // RAF exclusivo para animação do progresso — roda mesmo durante steps pesados.
    // Dois componentes somados a cada frame:
    //  1) avanço rápido em direção ao alvo real (_targetPct), quando há sinal novo;
    //  2) "trickle" lento rumo ao topo da fase atual (_bandHi), para a barra NUNCA
    //     congelar mesmo durante um único passo longo (ex.: beam 700 ou finalize).
    // O trickle é assintótico (desacelera perto do teto) e limitado a _bandHi, então
    // a barra sempre se move mas jamais ultrapassa a fase real em andamento.
    (function progressTick() {
      if (!liveWorker) return;
      if (_displayPct < _targetPct) _displayPct += (_targetPct - _displayPct) * 0.12;
      if (_displayPct < _bandHi) _displayPct += (_bandHi - _displayPct) * 0.0016;
      if (_displayPct > _bandHi) _displayPct = _bandHi;
      updateProgressModal(_displayPct);
      _progressRaf = requestAnimationFrame(progressTick);
    })();
  }

  function stopLiveSearch() {
    if (_progressRaf) { cancelAnimationFrame(_progressRaf); _progressRaf = 0; }
    if (liveWorker) { liveWorker.terminate(); liveWorker = null; }
    setRunButton(false);
    hideProgressModal();
    updateStaleNotice();
  }

  // Exporta o plano completo em PDF usando a impressão nativa do navegador
  // (sem dependência externa — funciona offline). O CSS @media print mostra só
  // o conteúdo do plano (resumo + chapas) e o usuário escolhe "Salvar como PDF".
  function exportPlanPdf() {
    if (liveWorker) { toast('Aguarde o cálculo terminar.'); return; }
    if (!state.plan || !state.plan.sheets || !state.plan.sheets.length) {
      toast('Calcule o plano antes de exportar.');
      return;
    }
    if (planStale) toast('Atenção: o plano está desatualizado.');
    const projName = (($('#project-name') && $('#project-name').textContent) || 'Projeto').trim() || 'Projeto';
    const titleEl = $('#print-title'); if (titleEl) titleEl.textContent = projName;
    const metaEl = $('#print-meta');
    if (metaEl) {
      const n = state.plan.sheets.length;
      metaEl.textContent = 'Plano de corte · ' + n + (n === 1 ? ' chapa' : ' chapas')
        + ' · ' + new Date().toLocaleDateString('pt-BR');
    }
    // Garante que os rótulos das peças apareçam no PDF (estado padrão da legenda).
    const planSheetsEl = $('#plan-sheets'); if (planSheetsEl) planSheetsEl.dataset.lbl = '';
    window.print();
  }

  // ---------- Orçamento ----------
  function getBudgetMetrics() {
    const m = state.plan ? Budget.metricsFromPlan(state.plan, 'cm') : {};
    return m;
  }

  function renderBudget() {
    const metrics = getBudgetMetrics();
    const items   = db.budgetGlobal.items;
    const qtys    = state.budgetQtys;

    // Foto e descrição
    renderBudgetPhoto();
    const descEl = $('#budget-description');
    if (descEl) descEl.value = state.budgetDescription || '';

    // Tabela de itens
    const body = $('#budget-body'); if (!body) return;
    body.innerHTML = '';
    items.forEach(it => {
      const auto = it.type === 'auto' || it.type === 'auto-value';
      const qty  = auto ? (metrics[it.src] != null ? metrics[it.src] : 0) : (qtys[it.key] || 0);
      const sub  = Budget.subtotalItem(it, qty);
      // auto-value (fixação): a quantidade exibida é o IC (totalN), não o valor em R$
      const qtyDisplay = it.type === 'auto-value' ? (metrics.totalN || 0) : qty;
      // Fitas: mostra a metragem FINAL e, entre parênteses, a metragem total "fria".
      let qtyHtml = numFmt(qtyDisplay);
      const rawV = it.src ? metrics[it.src + 'Raw'] : undefined;
      if (auto && rawV != null) qtyHtml += ` <span class="bgt-raw">(${numFmt(rawV)})</span>`;
      const tr = el('tr');
      const qtyTd = auto
        ? `<td class="bgt-qty auto">${qtyHtml}</td>`
        : `<td class="bgt-qty"><input class="qty-inp" inputmode="decimal" value="${qty}" data-k="${it.key}"></td>`;
      const unitTd = it.type === 'value'
        ? `<td class="bgt-unit">—</td>`
        : `<td class="bgt-unit">${brlSplit(it.price)}</td>`;
      tr.innerHTML = `<td class="bgt-name">${esc(it.label)}</td>${qtyTd}${unitTd}<td class="bgt-sub">${brlSplit(sub)}</td>`;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-k]').forEach(inp => inp.addEventListener('input', () => {
      state.budgetQtys[inp.dataset.k] = parseNum(inp.value);
      updateBudgetTotals(); save();
    }));

    updateBudgetTotals();
  }

  function updateBudgetTotals() {
    const metrics = getBudgetMetrics();
    const items   = db.budgetGlobal.items;
    const qtys    = state.budgetQtys;

    // Subtotais na tabela
    $$('#budget-body tr').forEach((tr, i) => {
      const it  = items[i]; if (!it) return;
      const auto = it.type === 'auto' || it.type === 'auto-value';
      const qty = auto
        ? (metrics[it.src] != null ? metrics[it.src] : 0)
        : (qtys[it.key] || 0);
      const subEl = tr.querySelector('.bgt-sub');
      if (subEl) subEl.innerHTML = brlSplit(Budget.subtotalItem(it, qty));
    });

    // Resumo compacto do corte — removido; IC aparece na linha de Complexidade
    const sumEl = $('#budget-summary');
    if (sumEl) sumEl.innerHTML = '';

    const t = Budget.totals(items, qtys, metrics, state.budgetCfg);

    // Custos do serviço: materiais + mão de obra + complexidade + total
    const costsEl = $('#costs-table');
    if (costsEl) {
      costsEl.innerHTML =
        row('Tempo de produção', (Math.round(t.days * 10) / 10).toLocaleString('pt-BR') + ' Dias') +
        row('Materiais', brl(t.entrada)) +
        row('Mão de obra', brl(t.labor)) +
        (t.totalN > 0 ? row('Complexidade (' + numFmt(t.totalN) + ')', brl(t.complexTotal)) : '') +
        `<tr class="costs-total"><td>Total</td><td>${brl(t.pix)}</td></tr>`;
    }

    // Condições para o cliente: entrada+entrega, 6x, 12x, pix (desconto)
    const condEl = $('#conditions-table');
    if (condEl) {
      const disc = state.budgetCfg.pixDiscountPct || 0;
      condEl.innerHTML =
        `<tr class="cond-credit">${cell('Entrada + Entrega')}${cell(brl(t.entradaVal) + ' + ' + brl(t.entregaVal))}</tr>` +
        `<tr class="cond-credit">${cell('Crédito até 6x<span class="cond-sub">sem juros</span>')}${cell(brl(t.credit6x) + '<span class="cond-sub">até 6× de ' + brl(t.credit6x / 6) + '</span>')}</tr>` +
        `<tr class="cond-credit">${cell('Crédito até 12x<span class="cond-sub">sem juros</span>')}${cell(brl(t.credit12x) + '<span class="cond-sub">até 12× de ' + brl(t.credit12x / 12) + '</span>')}</tr>` +
        `<tr class="cond-pix">${cell('Pix<span class="cond-sub">' + disc + '% de desconto</span>')}${cell(brl(t.pixClient))}</tr>`;
    }

    renderChart();
  }

  function row(k, v) { return `<tr>${cell(k)}${cell(v)}</tr>`; }
  function cell(v)    { return `<td>${v}</td>`; }

  // ---------- Fotos de referência (IndexedDB) ----------
  // Guardadas no IndexedDB (não no localStorage) p/ suportar ALTA RESOLUÇÃO sem
  // estourar a cota. Chave = id do projeto; valor = Blob ORIGINAL (sem recompressão
  // → qualidade máxima). state.budgetPhoto vira só um marcador ('1' = tem foto).
  const PHOTO_DB = 'projeto-corte-media', PHOTO_STORE = 'photos';
  let _photoDbPromise = null;
  function photoDb() {
    if (_photoDbPromise) return _photoDbPromise;
    _photoDbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(PHOTO_DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => { const d = req.result; if (!d.objectStoreNames.contains(PHOTO_STORE)) d.createObjectStore(PHOTO_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _photoDbPromise;
  }
  function idbGetPhoto(id) {
    return photoDb().then(d => new Promise((resolve, reject) => {
      const req = d.transaction(PHOTO_STORE, 'readonly').objectStore(PHOTO_STORE).get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    })).catch(() => null);
  }
  function idbSetPhoto(id, blob) {
    return photoDb().then(d => new Promise((resolve, reject) => {
      const tx = d.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).put(blob, id);
      tx.oncomplete = () => resolve(true);
      tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    }));
  }
  function idbDelPhoto(id) {
    return photoDb().then(d => new Promise((resolve) => {
      const tx = d.transaction(PHOTO_STORE, 'readwrite');
      tx.objectStore(PHOTO_STORE).delete(id);
      tx.oncomplete = () => resolve(true); tx.onerror = () => resolve(false);
    })).catch(() => false);
  }

  // Object URL da foto exibida no momento (revogado ao trocar).
  let activePhotoUrl = null;
  function setActivePhotoUrl(url) {
    if (activePhotoUrl && activePhotoUrl !== url) { try { URL.revokeObjectURL(activePhotoUrl); } catch (e) {} }
    activePhotoUrl = url;
  }

  function renderBudgetPhoto() {
    const img  = $('#budget-photo-img');
    const plh  = $('#budget-photo-placeholder');
    const edit = $('#budget-photo-edit');
    const del  = $('#budget-photo-del');
    if (!img) return;
    const v = state.budgetPhoto;
    const has = !!v;
    plh.hidden = has; edit.hidden = !has; del.hidden = !has;
    if (!has) { img.hidden = true; img.removeAttribute('src'); setActivePhotoUrl(null); return; }
    // Legado: foto ainda como dataURL no state (antes da migração p/ IndexedDB).
    if (typeof v === 'string' && v.slice(0, 5) === 'data:') {
      setActivePhotoUrl(null); img.src = v; img.hidden = false; return;
    }
    const proj = activeProject(); const pid = proj && proj.id;
    idbGetPhoto(pid).then(blob => {
      // ainda é o mesmo projeto/foto?
      if (!state.budgetPhoto || (activeProject() && activeProject().id !== pid)) return;
      if (!blob) { img.hidden = true; img.removeAttribute('src'); setActivePhotoUrl(null); plh.hidden = false; edit.hidden = true; del.hidden = true; return; }
      const url = URL.createObjectURL(blob);
      setActivePhotoUrl(url);
      img.src = url; img.hidden = false;
    });
  }

  function dataUrlToBlob(dataUrl) {
    const m = /^data:([^;,]*?)(;base64)?,(.*)$/.exec(dataUrl); if (!m) return null;
    const mime = m[1] || 'image/jpeg', isB64 = !!m[2], data = m[3];
    try {
      let bytes;
      if (isB64) { const bin = atob(data); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
      else { const txt = decodeURIComponent(data); bytes = new Uint8Array(txt.length); for (let i = 0; i < txt.length; i++) bytes[i] = txt.charCodeAt(i); }
      return new Blob([bytes], { type: mime });
    } catch (e) { return null; }
  }

  // Migra fotos antigas (dataURL no localStorage) → IndexedDB, liberando a cota.
  async function migratePhotosToIdb() {
    let changed = false;
    for (const p of db.projects) {
      const val = p.data && p.data.budgetPhoto;
      if (typeof val === 'string' && val.slice(0, 5) === 'data:') {
        const blob = dataUrlToBlob(val);
        if (blob) { try { await idbSetPhoto(p.id, blob); p.data.budgetPhoto = '1'; changed = true; } catch (e) {} }
      }
    }
    if (changed) { saveDb(); if ($('#view-budget').classList.contains('active')) renderBudgetPhoto(); }
  }

  function openBudgetGearModal() {
    renderBudgetGearList();
    $('#budget-cfg-modal').hidden = false;
  }

  function renderBudgetGearList() {
    const list = $('#budget-cfg-list'); if (!list) return;
    list.innerHTML = '';
    const items = db.budgetGlobal.items;
    items.forEach((it, i) => {
      const div = el('div');
      div.className = 'budget-cfg-item type-' + (it.type === 'auto-value' ? 'auto' : it.type);
      const badge = `<span class="cfg-type-badge ${it.type === 'auto-value' ? 'auto' : it.type}">${it.type === 'auto' || it.type === 'auto-value' ? 'auto' : it.type === 'value' ? 'valor' : 'manual'}</span>`;
      div.innerHTML =
        `<div class="cfg-reorder">` +
          `<button data-mv="up" data-i="${i}" title="Subir">▲</button>` +
          `<button data-mv="dn" data-i="${i}" title="Descer">▼</button>` +
        `</div>` +
        `<div class="cfg-item-body">` +
          `<input class="cfg-item-label" type="text" value="${attr(it.label)}" data-lbl="${i}" placeholder="Nome do item" />` +
          `<div class="cfg-item-meta">${badge}<span class="cfg-price-wrap">R$ <input class="cfg-item-price" type="number" step="0.01" min="0" value="${it.price}" data-prc="${i}" /></span></div>` +
        `</div>` +
        `<button class="icon-btn del" data-del="${i}" title="Remover"><span class="material-symbols-outlined">delete</span></button>`;
      list.appendChild(div);
    });

    list.querySelectorAll('[data-mv]').forEach(btn => btn.addEventListener('click', () => {
      const i = +btn.dataset.i, up = btn.dataset.mv === 'up';
      const j = up ? i - 1 : i + 1;
      if (j < 0 || j >= items.length) return;
      [items[i], items[j]] = [items[j], items[i]];
      saveDb(); renderBudgetGearList();
      if ($('#view-budget').classList.contains('active')) renderBudget();
    }));
    list.querySelectorAll('[data-lbl]').forEach(inp => inp.addEventListener('input', () => {
      items[+inp.dataset.lbl].label = inp.value;
      saveDb();
      if ($('#view-budget').classList.contains('active')) renderBudget();
    }));
    list.querySelectorAll('[data-prc]').forEach(inp => inp.addEventListener('input', () => {
      items[+inp.dataset.prc].price = parseFloat(inp.value) || 0;
      saveDb();
      // renderBudget (não só updateBudgetTotals) p/ refletir o preço unitário na
      // coluna "Und." da tabela, não apenas o subtotal.
      if ($('#view-budget').classList.contains('active')) renderBudget();
    }));
    list.querySelectorAll('[data-del]').forEach(btn => btn.addEventListener('click', async () => {
      const i = +btn.dataset.del;
      const ok = await ui.confirm(`Remover "${items[i].label}"? Esta ação afeta todos os projetos.`, { danger: true, okText: 'Remover' });
      if (!ok) return;
      items.splice(i, 1);
      saveDb(); renderBudgetGearList();
      if ($('#view-budget').classList.contains('active')) renderBudget();
    }));
  }

  function openConditionsGearModal() {
    const c = state.budgetCfg;
    const sv = (id, v) => { const e = $(id); if (e) e.value = v; };
    sv('#cfg-labor', c.laborPct);
    sv('#cfg-complexidade', c.complexidade);
    sv('#cfg-days', c.daysPerUnit);
    sv('#cfg-entrada-pct', c.entradaPct);
    sv('#cfg-credit-6x', c.credit6xFee);
    sv('#cfg-credit-12x', c.credit12xFee);
    sv('#cfg-pix-discount', c.pixDiscountPct);
    $('#conditions-cfg-modal').hidden = false;
  }

  function initBudget() {
    // Foto do projeto
    const photoInput = $('#budget-photo-input');
    function openPhotoPicker() { photoInput.click(); }

    photoInput.addEventListener('change', e => {
      const f = e.target.files[0]; if (!f) return;
      const proj = activeProject();
      if (!proj) { e.target.value = ''; return; }
      const pid = proj.id;
      // Guarda o ARQUIVO ORIGINAL (sem recompressão) → qualidade máxima.
      idbSetPhoto(pid, f).then(() => {
        if (activeProject() && activeProject().id !== pid) return;
        state.budgetPhoto = '1'; save(); renderBudgetPhoto();
        const v = $('#photo-viewer'); if (v) v.hidden = true;
      }).catch(() => toast('Não foi possível salvar a imagem (muito grande?).'));
      e.target.value = '';
    });

    // Sem foto: a ÁREA INTEIRA abre o seletor (não só o textinho central — alvo de
    // toque grande no celular). Com foto, a área é coberta pela imagem (que abre o
    // visualizador) e o clique aqui é ignorado pela guarda.
    $('#budget-photo-area').addEventListener('click', e => {
      if (state.budgetPhoto) return;            // tem foto → quem trata é a imagem/edição
      if (e.target.closest('#budget-photo-del')) return;
      openPhotoPicker();
    });
    // Botão de edição (com foto) — substitui a foto.
    $('#budget-photo-edit').addEventListener('click', e => { e.stopPropagation(); openPhotoPicker(); });

    $('#budget-photo-del').addEventListener('click', () => {
      const proj = activeProject();
      if (proj) idbDelPhoto(proj.id);
      state.budgetPhoto = ''; save(); renderBudgetPhoto();
    });

    // Visualizador de foto em tela cheia (usa a imagem original em alta resolução)
    $('#budget-photo-img').addEventListener('click', () => {
      if (!state.budgetPhoto) return;
      const v = $('#photo-viewer'), vi = $('#photo-viewer-img');
      if (!v || !vi) return;
      const src = activePhotoUrl || (typeof state.budgetPhoto === 'string' && state.budgetPhoto.slice(0, 5) === 'data:' ? state.budgetPhoto : '');
      if (!src) return;
      vi.src = src;
      v.hidden = false;
    });
    $('#photo-viewer-replace').addEventListener('click', () => { $('#photo-viewer').hidden = true; openPhotoPicker(); });
    $('#photo-viewer-close').addEventListener('click', () => { $('#photo-viewer').hidden = true; });
    $('#photo-viewer').addEventListener('click', e => { if (e.target.id === 'photo-viewer') $('#photo-viewer').hidden = true; });

    // Descrição
    $('#budget-description').addEventListener('input', e => {
      state.budgetDescription = e.target.value; save();
    });

    // Gear: itens do orçamento (global)
    const closeBudgetCfg = () => {
      $('#budget-cfg-modal').hidden = true;
      if ($('#view-budget').classList.contains('active')) renderBudget();
    };
    $('#budget-cfg-btn').addEventListener('click', openBudgetGearModal);
    $('#budget-cfg-close').addEventListener('click', closeBudgetCfg);
    $('#budget-cfg-modal').addEventListener('click', e => { if (e.target === $('#budget-cfg-modal')) closeBudgetCfg(); });
    $('#budget-cfg-add').addEventListener('click', () => {
      db.budgetGlobal.items.push({ key: 'item_' + Date.now(), label: 'Novo item', type: 'manual', price: 0 });
      saveDb(); renderBudgetGearList();
      if ($('#view-budget').classList.contains('active')) renderBudget();
    });

    // Gear: condições (por projeto)
    $('#conditions-cfg-btn').addEventListener('click', openConditionsGearModal);
    $('#conditions-cfg-close').addEventListener('click', () => { $('#conditions-cfg-modal').hidden = true; });
    $('#conditions-cfg-modal').addEventListener('click', e => { if (e.target === $('#conditions-cfg-modal')) $('#conditions-cfg-modal').hidden = true; });

    const bindCfg = (id, key) => {
      const inp = $(id); if (!inp) return;
      inp.addEventListener('input', () => {
        state.budgetCfg[key] = parseFloat(inp.value) || 0;
        updateBudgetTotals(); save();
      });
    };
    bindCfg('#cfg-labor', 'laborPct');
    bindCfg('#cfg-complexidade', 'complexidade');
    bindCfg('#cfg-days', 'daysPerUnit');
    bindCfg('#cfg-entrada-pct', 'entradaPct');
    bindCfg('#cfg-credit-6x', 'credit6xFee');
    bindCfg('#cfg-credit-12x', 'credit12xFee');
    bindCfg('#cfg-pix-discount', 'pixDiscountPct');
  }

  // ---------- Gráfico ----------
  function renderChart() {
    const legend = $('#chart-legend'); if (!legend) return;
    const metrics = getBudgetMetrics();
    const data = db.budgetGlobal.items.map(it => {
      const isAuto = it.type === 'auto' || it.type === 'auto-value';
      const qty = isAuto ? (metrics[it.src] != null ? metrics[it.src] : 0) : (state.budgetQtys[it.key] || 0);
      return { label: it.label, val: Budget.subtotalItem(it, qty) };
    }).filter(d => d.val > 0).sort((a, b) => b.val - a.val);
    const total = data.reduce((a, d) => a + d.val, 0);
    legend.innerHTML = '';
    if (!total) { legend.innerHTML = '<span class="budget-summary-empty">Sem dados de custo ainda.</span>'; return; }
    const colors = ['#4a90d9', '#e74c3c', '#f1c40f', '#2ecc71', '#9b59b6', '#e67e22', '#1abc9c', '#34495e', '#95a5a6', '#d35400', '#16a085', '#c0392b'];
    data.forEach((d, i) => {
      const pct = d.val / total * 100;
      const row = el('div', 'chart-bar-row');
      row.innerHTML =
        `<div class="chart-bar-label">${esc(d.label)}</div>` +
        `<div class="chart-bar-track"><div class="chart-bar-fill" style="width:${pct.toFixed(2)}%;background:${colors[i % colors.length]}"></div></div>` +
        `<div class="chart-bar-val">${brl(d.val)}</div>`;
      legend.appendChild(row);
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
    migratePhotosToIdb(); // move fotos antigas (dataURL no localStorage) p/ IndexedDB
    const verEl = $('#app-version'); if (verEl) verEl.textContent = APP_VERSION;
    // seleciona todo o conteúdo de campos numéricos ao focar
    document.addEventListener('focusin', e => {
      const t = e.target;
      if (t && t.tagName === 'INPUT' && (t.inputMode === 'decimal' || t.inputMode === 'numeric' || t.type === 'number')) {
        setTimeout(() => { try { t.select(); } catch (err) {} }, 0);
      }
    });
    initTabs(); initOptions(); initImport(); initSelect(); initBudget(); initBandModal(); initProjects();
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
      if (!liveWorker) startLiveSearch();
    }, { passive: false });
    runBtn.addEventListener('click', function () {
      if (recentTouch || liveWorker) return;
      startLiveSearch();
    });

    // Exportar plano em PDF (via window.print → "Salvar como PDF"). Mesmo guarda
    // de duplo-disparo touch/click do Android usada no botão Calcular.
    const pdfBtn = $('#export-pdf');
    if (pdfBtn) {
      let pdfTouch = false;
      pdfBtn.addEventListener('touchend', function (e) {
        pdfTouch = true;
        setTimeout(function () { pdfTouch = false; }, 500);
        e.preventDefault();
        exportPlanPdf();
      }, { passive: false });
      pdfBtn.addEventListener('click', function () {
        if (pdfTouch) return;
        exportPlanPdf();
      });
    }
    // Toque no plano alterna entre: nome + medidas → só nome → só medidas → (repete)
    const planSheetsEl = $('#plan-sheets');
    if (planSheetsEl) {
      planSheetsEl.addEventListener('click', () => {
        const cur = planSheetsEl.dataset.lbl || '';
        planSheetsEl.dataset.lbl = cur === '' ? 'name' : cur === 'name' ? 'dim' : '';
      });
    }
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
