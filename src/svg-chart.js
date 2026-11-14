'use strict';

// Charts for the dossier, drawn as SVG text. A document is read, printed and saved as a PDF, so
// its pictures have to stay sharp at any size and need nothing to be running: no canvas, no
// redraw on resize. Colours are the page's own CSS variables, the same ones the live charts use.
//
// plot({ width, height, xs, areas, bars, bands, lines, markers, here, tip }) -> '<svg …>'
//   areas:   [{ label, color, values }]  stacked; positive values up from zero, negative down
//   bars:    the same, drawn as one column a year (for money that moves in a year, not balances)
//   bands:   [{ lower, upper, color, alpha }]
//   lines:   [{ label, color, values, dash }]
//   markers: [{ x, label }]              a dated event, x in the units of xs
//   here:    index into xs               "this year", for the small chart on each year's page
//   tip:     i -> text                   shown by the browser when the pointer rests on a year

(function (root) {
  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const col = c => (c && c.startsWith('--') ? `var(${c})` : c);
  const num = v => (Math.round(v * 10) / 10).toString();
  const isNum = v => v !== null && v !== undefined && !Number.isNaN(v);

  function compact(v) {
    const a = Math.abs(v), s = v < 0 ? '−' : '';
    const trim = x => x.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
    if (a >= 1e6) return `${s}£${trim((a / 1e6).toFixed(a >= 1e7 ? 1 : 2))}M`;
    if (a >= 1e3) return `${s}£${trim((a / 1e3).toFixed(a >= 1e5 ? 0 : 1))}K`;
    return `${s}£${Math.round(a)}`;
  }

  function niceTicks(min, max, count) {
    const range = max - min || 1, rough = range / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough))), norm = rough / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    for (let v = Math.floor(min / step + 1e-9) * step; v < max + step * 0.999; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return ticks;
  }

  // Stacked layers: each series sits on the ones before it, above zero or below it.
  function stack(areas, n) {
    const up = new Array(n).fill(0), down = new Array(n).fill(0);
    return areas.map(a => {
      const lower = [], upper = [];
      for (let i = 0; i < n; i++) {
        const v = isNum(a.values[i]) ? a.values[i] : 0;
        if (v >= 0) { lower.push(up[i]); up[i] += v; upper.push(up[i]); } else { upper.push(down[i]); down[i] += v; lower.push(down[i]); }
      }
      return { ...a, lower, upper };
    });
  }

  function plot(o) {
    const xs = o.xs || [], n = xs.length;
    const W = Math.max(220, Math.round(o.width || 760)), H = o.height || 260;
    const narrow = W < 480;
    const layers = stack(o.areas || [], n), cols = stack(o.bars || [], n), bands = o.bands || [], lines = o.lines || [];
    const banded = cols.length > 0;   // columns sit in the middle of their year's slot

    let lo = 0, hi = 0;
    const see = v => { if (isNum(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (const l of [...layers, ...cols]) { l.lower.forEach(see); l.upper.forEach(see); }
    for (const b of bands) { b.lower.forEach(see); b.upper.forEach(see); }
    for (const l of lines) l.values.forEach(see);
    if (hi === lo) hi = lo + 1;
    const ticks = niceTicks(lo, hi, H < 160 ? 2 : narrow ? 4 : 5);
    const d0 = Math.min(lo, ticks[0]), d1 = Math.max(hi, ticks[ticks.length - 1]);

    // Dated events sit above the plot, on a second row when two would run into each other.
    const m = { l: narrow ? 46 : 58, r: 14, t: 8, b: 22 };
    const iw = W - m.l - m.r;
    const X = i => m.l + (banded ? (i + 0.5) / n : n > 1 ? i / (n - 1) : 0.5) * iw;
    const marks = (o.markers || []).map(k => ({ ...k, i: xs.indexOf(k.x) })).filter(k => k.i >= 0).sort((a, b) => a.i - b.i);
    // Each label is written to the right of its own line. Working from the right, a label that
    // would run into the next line goes one row higher, so no label crosses a line.
    let rowsUsed = 0;
    for (let j = marks.length - 1; j >= 0; j--) {
      const k = marks[j], next = marks[j + 1];
      k.flip = X(k.i) + 4 + k.label.length * 6.2 > W - 2;
      k.row = next && !k.flip && X(k.i) + 8 + k.label.length * 6.2 > X(next.i) ? Math.min(3, next.row + 1) : 0;
      rowsUsed = Math.max(rowsUsed, k.row + 1);
    }
    m.t += rowsUsed * 14;
    const ih = H - m.t - m.b;
    const Y = v => m.t + (1 - (v - d0) / (d1 - d0)) * ih;
    const path = (vals, from = 0) => vals.map((v, i) => (isNum(v) ? `${i === from || !isNum(vals[i - 1]) ? 'M' : 'L'}${num(X(i))} ${num(Y(v))}` : '')).join('');
    const ribbon = (lower, upper) => `${upper.map((v, i) => `${i ? 'L' : 'M'}${num(X(i))} ${num(Y(v))}`).join('')}${lower.map((v, i) => [i, v]).reverse().map(([i, v]) => `L${num(X(i))} ${num(Y(v))}`).join('')}Z`;

    const out = [`<svg xmlns="http://www.w3.org/2000/svg" class="doc-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img"${o.label ? ` aria-label="${esc(o.label)}"` : ''}>`];
    for (const t of ticks) {
      if (t < d0 - 1e-9 || t > d1 + 1e-9) continue;
      out.push(`<line x1="${m.l}" x2="${W - m.r}" y1="${num(Y(t))}" y2="${num(Y(t))}" style="stroke:var(${t === 0 ? '--border-strong' : '--border'})" stroke-width="1"/>`);
      out.push(`<text x="${m.l - 6}" y="${num(Y(t) + 4)}" text-anchor="end" class="tick">${esc((o.yFormat || compact)(t))}</text>`);
    }
    // Years along the bottom: as many as fit, on round years.
    if (n) {
      const room = Math.max(2, Math.floor(iw / 58));
      const step = [1, 2, 5, 10, 20, 25, 50].find(s => (xs[n - 1] - xs[0]) / s <= room) || 50;
      xs.forEach((x, i) => { if (x % step === 0 || (n <= room && step === 1)) out.push(`<text x="${num(X(i))}" y="${H - 6}" text-anchor="middle" class="tick">${esc(x)}</text>`); });
    }
    if (banded) {
      const slot = iw / n, bw = Math.max(1, slot - (slot > 6 ? 2 : 0.6));
      for (const l of cols) {
        const d = l.values.map((v, i) => (Math.abs(v) > 0.5 ? `M${num(X(i) - bw / 2)} ${num(Y(l.upper[i]))}h${num(bw)}V${num(Y(l.lower[i]))}h${num(-bw)}Z` : '')).join('');
        if (d) out.push(`<path d="${d}" style="fill:${col(l.color)};stroke:var(--surface)" stroke-width="${slot > 6 ? 1 : 0.4}"/>`);
      }
    }
    for (const l of layers) {
      if (!l.values.some(v => Math.abs(v) > 0.5)) continue;
      out.push(`<path d="${ribbon(l.lower, l.upper)}" style="fill:${col(l.color)};stroke:var(--surface)" stroke-width="1.5" stroke-linejoin="round"/>`);
    }
    for (const b of bands) out.push(`<path d="${ribbon(b.lower, b.upper)}" style="fill:${col(b.color || '--band')}" fill-opacity="${b.alpha || 0.18}"/>`);
    for (const l of lines) out.push(`<path d="${path(l.values)}" fill="none" style="stroke:${col(l.color)}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"${l.dash ? ` stroke-dasharray="${l.dash.join(' ')}"` : ''}/>`);
    for (const k of marks) {
      const x = X(k.i), y = m.t - 5 - k.row * 14;
      out.push(`<line x1="${num(x)}" x2="${num(x)}" y1="${num(y - 9)}" y2="${m.t + ih}" style="stroke:var(--text-2)" stroke-width="1" stroke-dasharray="3 3"/>`);
      out.push(`<text x="${num(x + (k.flip ? -4 : 4))}" y="${num(y)}" text-anchor="${k.flip ? 'end' : 'start'}" class="mark">${esc(k.label)}</text>`);
    }
    if (isNum(o.here) && o.here >= 0 && o.here < n) {
      const x = X(o.here);
      out.push(`<line x1="${num(x)}" x2="${num(x)}" y1="${m.t}" y2="${m.t + ih}" style="stroke:var(--text)" stroke-width="1"/>`);
      for (const l of lines) if (isNum(l.values[o.here])) out.push(`<circle cx="${num(x)}" cy="${num(Y(l.values[o.here]))}" r="5" style="fill:${col(l.color)};stroke:var(--surface)" stroke-width="2"/>`);
    }
    if (o.tip && n > 1) {
      const w = banded ? iw / n : iw / (n - 1);
      for (let i = 0; i < n; i++) out.push(`<rect x="${num(X(i) - w / 2)}" y="${m.t}" width="${num(w)}" height="${ih}" fill="transparent"><title>${esc(o.tip(i))}</title></rect>`);
    }
    out.push('</svg>');
    return out.join('');
  }

  const api = { plot, stack, compact, niceTicks };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SvgChart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
