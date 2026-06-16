/* ============================================================
 * optimizer.js — Plano de corte por aproveitamento.
 * Algoritmo: bin-packing guilhotinado com lista de retângulos
 * livres (heurística Best Short Side Fit) + corte (kerf) e
 * suporte a rotação / direção do grão.
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

  // Cria uma chapa nova com um retângulo livre completo.
  function newSheet(material, W, H, index) {
    return {
      material, index, W, H,
      placements: [],
      free: [{ x: 0, y: 0, w: W, h: H }],
      cuts: 0,
    };
  }

  // Tenta encaixar peça (pw x ph) em algum retângulo livre da chapa.
  // Retorna {rectIdx, rotated, score} ou null.
  function findFit(sheet, pw, ph, allowRotate) {
    let best = null;
    sheet.free.forEach((r, i) => {
      // sem rotação
      if (pw <= r.w + 1e-6 && ph <= r.h + 1e-6) {
        const short = Math.min(r.w - pw, r.h - ph);
        if (!best || short < best.score) best = { rectIdx: i, rotated: false, score: short };
      }
      // com rotação
      if (allowRotate && ph <= r.w + 1e-6 && pw <= r.h + 1e-6) {
        const short = Math.min(r.w - ph, r.h - pw);
        if (!best || short < best.score) best = { rectIdx: i, rotated: true, score: short };
      }
    });
    return best;
  }

  // Divide o retângulo livre após colocar a peça (corte guilhotinado).
  // Acrescenta o kerf às dimensões ocupadas.
  function splitRect(sheet, fit, pw, ph, kerf) {
    const r = sheet.free[fit.rectIdx];
    sheet.free.splice(fit.rectIdx, 1);

    const usedW = pw + kerf;
    const usedH = ph + kerf;
    const remRight = r.w - usedW;   // sobra à direita
    const remBottom = r.h - usedH;  // sobra abaixo

    // Escolhe o eixo do corte guilhotinado pela maior sobra (SAS-like).
    const rects = [];
    if (remRight > 1e-6 && remBottom > 1e-6) {
      if (remRight >= remBottom) {
        // corte vertical primeiro
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

  /**
   * optimize(panels, stockList, options)
   *  panels: [{width,length,qty,material,name,grain,bands}]
   *  stockList: [{width,length,qty,material}]
   *  options: {kerf, considerMaterial, considerGrain, allowRotate}
   *  → { sheets:[...], unplaced:[...], byMaterial:{...} }
   */
  function optimize(panels, stockList, options) {
    const o = Object.assign({ kerf: 0, considerMaterial: true, considerGrain: true, allowRotate: true }, options);
    const items = expand(panels);

    // Agrupa por material (ou tudo junto).
    const groups = {};
    items.forEach(it => {
      const key = o.considerMaterial ? it.material : '__all__';
      (groups[key] = groups[key] || []).push(it);
    });

    // Função que devolve dimensões da chapa para um material.
    function stockFor(material) {
      let s = stockList.find(s => o.considerMaterial && s.material && s.material === material);
      if (!s) s = stockList.find(s => !s.material) || stockList[0];
      return s || { width: 184, length: 274, qty: 999 };
    }

    const sheets = [];
    const unplaced = [];

    Object.keys(groups).forEach(material => {
      const list = groups[material].slice();
      // ordena por área desc (peças maiores primeiro)
      list.sort((a, b) => (b.w * b.h) - (a.w * a.h));

      const stock = stockFor(material);
      const W = stock.width, H = stock.length;
      let sheetIndex = 0;
      const matSheets = [];

      list.forEach(it => {
        let pw = it.w, ph = it.h;
        // grão fixa orientação → desliga rotação para esta peça
        const allowRotate = o.allowRotate && !(o.considerGrain && it.grain);

        let placed = false;
        for (const sheet of matSheets) {
          const fit = findFit(sheet, pw, ph, allowRotate);
          if (fit) {
            const fw = fit.rotated ? ph : pw;
            const fh = fit.rotated ? pw : ph;
            const r = sheet.free[fit.rectIdx];
            sheet.placements.push({
              x: r.x, y: r.y, w: fw, h: fh,
              name: it.name, rotated: fit.rotated, bands: it.bands,
            });
            splitRect(sheet, fit, fw, fh, o.kerf);
            placed = true;
            break;
          }
        }

        if (!placed) {
          // abre nova chapa
          if (pw > W + 1e-6 || ph > H + 1e-6) {
            // tenta rotacionada na chapa nova
            if (allowRotate && ph <= W + 1e-6 && pw <= H + 1e-6) {
              // ok rotacionada
            } else {
              unplaced.push(it);
              return;
            }
          }
          const sheet = newSheet(o.considerMaterial ? material : 'Geral', W, H, ++sheetIndex);
          const fit = findFit(sheet, pw, ph, allowRotate);
          if (!fit) { unplaced.push(it); return; }
          const fw = fit.rotated ? ph : pw;
          const fh = fit.rotated ? pw : ph;
          const r = sheet.free[fit.rectIdx];
          sheet.placements.push({ x: r.x, y: r.y, w: fw, h: fh, name: it.name, rotated: fit.rotated, bands: it.bands });
          splitRect(sheet, fit, fw, fh, o.kerf);
          matSheets.push(sheet);
        }
      });

      matSheets.forEach(s => sheets.push(s));
    });

    // métricas por material
    const byMaterial = {};
    sheets.forEach(s => {
      const m = byMaterial[s.material] || (byMaterial[s.material] = { sheets: 0, pieces: 0, area: 0, usedArea: 0, cuts: 0 });
      m.sheets++;
      m.cuts += s.cuts;
      m.area += s.W * s.H;
      s.placements.forEach(p => { m.pieces++; m.usedArea += p.w * p.h; });
    });

    return { sheets, unplaced, byMaterial };
  }

  global.Optimizer = { optimize };
})(window);
