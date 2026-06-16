/* ============================================================
 * optimizer.js — Plano de corte por aproveitamento (seccionadora).
 *
 * Cortes 100% guilhotinados (de borda a borda), como numa
 * seccionadora real. Para maximizar o aproveitamento o packer
 * roda VÁRIAS estratégias (ordens de peças × heurísticas de
 * encaixe/divisão) e escolhe a melhor pelo critério:
 *   1) menor número de chapas   (o que mais afeta o %)
 *   2) menos cortes             (mais rápido na máquina)
 *   3) maior sobra contígua     (retalho reaproveitável)
 *
 * Eixos da chapa: x = Largura (W), y = Comprimento (H).
 * ============================================================ */
(function (global) {
  'use strict';

  // Expande os painéis pela quantidade em peças individuais.
  function expand(panels) {
    const items = [];
    panels.forEach((p, idx) => {
      for (let i = 0; i < p.qty; i++) {
        items.push({
          w: p.width, h: p.length,        // w = largura, h = comprimento
          material: p.material,
          name: p.name,
          grain: p.grain,
          bands: p.bands || {},
          srcIndex: idx,
        });
      }
    });
    return items;
  }

  function newSheet(material, W, H, index) {
    return { material, index, W, H, placements: [], free: [{ x: 0, y: 0, w: W, h: H }], cuts: 0 };
  }

  // Procura o melhor retângulo livre para a peça (pw x ph).
  // Heurística "Best Area Fit": menor sobra de área → encaixe mais justo,
  // o que tende a deixar um único retalho grande no fim.
  function findFit(sheet, pw, ph, allowRotate) {
    let best = null;
    for (let i = 0; i < sheet.free.length; i++) {
      const r = sheet.free[i];
      // sem rotação
      if (pw <= r.w + 1e-6 && ph <= r.h + 1e-6) {
        const waste = r.w * r.h - pw * ph;
        const short = Math.min(r.w - pw, r.h - ph);
        if (!best || waste < best.waste - 1e-6 || (Math.abs(waste - best.waste) <= 1e-6 && short < best.short))
          best = { rectIdx: i, rotated: false, waste, short };
      }
      // com rotação
      if (allowRotate && ph <= r.w + 1e-6 && pw <= r.h + 1e-6) {
        const waste = r.w * r.h - pw * ph;
        const short = Math.min(r.w - ph, r.h - pw);
        if (!best || waste < best.waste - 1e-6 || (Math.abs(waste - best.waste) <= 1e-6 && short < best.short))
          best = { rectIdx: i, rotated: true, waste, short };
      }
    }
    return best;
  }

  // Divide o retângulo livre após a peça (corte guilhotinado) somando o kerf.
  // splitPref: 'maxrect' mantém o maior sub-retângulo possível (retalho útil);
  //            'minrect' favorece tiras (bom quando há muitas peças iguais).
  function splitRect(sheet, rectIdx, pw, ph, kerf, splitPref) {
    const r = sheet.free[rectIdx];
    sheet.free.splice(rectIdx, 1);

    const usedW = pw + kerf, usedH = ph + kerf;
    const remRight = r.w - usedW;    // sobra à direita da peça
    const remBottom = r.h - usedH;   // sobra abaixo da peça
    const rects = [];

    if (remRight > 1e-6 && remBottom > 1e-6) {
      // dois cortes possíveis; escolhe o eixo que preserva o maior retalho
      // Corte horizontal: faixa inferior ocupa toda a largura.
      const horizBig = Math.max(r.w * remBottom, remRight * usedH);
      // Corte vertical: faixa direita ocupa toda a altura.
      const vertBig = Math.max(remRight * r.h, usedW * remBottom);
      const cutVertical = splitPref === 'maxrect' ? (vertBig >= horizBig) : (remRight >= remBottom);
      if (cutVertical) {
        rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: r.h });
        rects.push({ x: r.x, y: r.y + usedH, w: usedW, h: remBottom });
      } else {
        rects.push({ x: r.x, y: r.y + usedH, w: r.w, h: remBottom });
        rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: usedH });
      }
      sheet.cuts += 2;
    } else if (remRight > 1e-6) {
      rects.push({ x: r.x + usedW, y: r.y, w: remRight, h: r.h });
      sheet.cuts += 1;
    } else if (remBottom > 1e-6) {
      rects.push({ x: r.x, y: r.y + usedH, w: r.w, h: remBottom });
      sheet.cuts += 1;
    }
    rects.forEach(rc => { if (rc.w > 1e-6 && rc.h > 1e-6) sheet.free.push(rc); });
  }

  // Empacota uma lista (já ordenada) numa estratégia. Devolve as chapas.
  function packOnce(list, W, H, o, splitPref) {
    let sheetIndex = 0;
    const sheets = [];
    const unplaced = [];

    list.forEach(it => {
      const pw = it.w, ph = it.h;
      const allowRotate = o.allowRotate && !(o.considerGrain && it.grain);

      let target = null, fit = null;
      // 1) tenta nas chapas abertas
      for (const sheet of sheets) {
        const f = findFit(sheet, pw, ph, allowRotate);
        if (f) { target = sheet; fit = f; break; }
      }
      // 2) senão, abre nova chapa
      if (!target) {
        const cabe = (pw <= W + 1e-6 && ph <= H + 1e-6) ||
                     (allowRotate && ph <= W + 1e-6 && pw <= H + 1e-6);
        if (!cabe) { unplaced.push(it); return; }
        target = newSheet(it.__mat, W, H, ++sheetIndex);
        fit = findFit(target, pw, ph, allowRotate);
        sheets.push(target);
      }
      const fw = fit.rotated ? ph : pw;
      const fh = fit.rotated ? pw : ph;
      const r = target.free[fit.rectIdx];
      target.placements.push({ x: r.x, y: r.y, w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
      splitRect(target, fit.rectIdx, fw, fh, o.kerf, splitPref);
    });

    return { sheets, unplaced };
  }

  // Avalia um resultado: melhor = menos chapas, menos cortes, maior retalho.
  function largestFree(sheets) {
    let max = 0;
    sheets.forEach(s => s.free.forEach(r => { const a = r.w * r.h; if (a > max) max = a; }));
    return max;
  }
  function score(res) {
    const cuts = res.sheets.reduce((a, s) => a + s.cuts, 0);
    return { sheets: res.sheets.length, unplaced: res.unplaced.length, cuts, leftover: largestFree(res.sheets) };
  }
  function better(a, b) {
    if (!b) return true;
    if (a.unplaced !== b.unplaced) return a.unplaced < b.unplaced;
    if (a.sheets !== b.sheets) return a.sheets < b.sheets;
    if (a.cuts !== b.cuts) return a.cuts < b.cuts;
    return a.leftover > b.leftover;
  }

  // Empacota um grupo testando várias estratégias e devolvendo a melhor.
  function packGroup(items, W, H, o, matName) {
    items.forEach(it => it.__mat = matName);
    const orders = {
      area:  (a, b) => (b.w * b.h) - (a.w * a.h),
      maxside: (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h),
      height: (a, b) => b.h - a.h || b.w - a.w,
      width:  (a, b) => b.w - a.w || b.h - a.h,
      perim:  (a, b) => (b.w + b.h) - (a.w + a.h),
    };
    let best = null, bestScore = null;
    for (const key of Object.keys(orders)) {
      const list = items.slice().sort(orders[key]);
      for (const pref of ['maxrect', 'minrect']) {
        const res = packOnce(list, W, H, o, pref);
        const sc = score(res);
        if (better(sc, bestScore)) { best = res; bestScore = sc; }
      }
    }
    return best;
  }

  /**
   * optimize(panels, stockList, options)
   *  → { sheets, unplaced, byMaterial }
   */
  function optimize(panels, stockList, options) {
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true }, options);
    const items = expand(panels);

    const groups = {};
    items.forEach(it => {
      const key = o.considerMaterial ? it.material : '__all__';
      (groups[key] = groups[key] || []).push(it);
    });

    function stockFor(material) {
      let s = stockList.find(s => o.considerMaterial && s.material && s.material === material);
      if (!s) s = stockList.find(s => !s.material) || stockList[0];
      return s || { width: 184, length: 274, qty: 999 };
    }

    const sheets = [];
    const unplaced = [];

    Object.keys(groups).forEach(material => {
      const stock = stockFor(material);
      const matName = o.considerMaterial ? material : 'Geral';
      const res = packGroup(groups[material], stock.width, stock.length, o, matName);
      // re-numera as chapas globalmente por material
      res.sheets.forEach((s, i) => { s.index = i + 1; sheets.push(s); });
      res.unplaced.forEach(u => unplaced.push(u));
    });

    const byMaterial = {};
    sheets.forEach(s => {
      const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
      m.sheets++; m.cuts += s.cuts; m.area += s.W * s.H;
      s.placements.forEach(p => { m.pieces++; m.usedArea += p.w * p.h; });
    });

    return { sheets, unplaced, byMaterial };
  }

  global.Optimizer = { optimize };
})(window);
