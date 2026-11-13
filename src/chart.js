'use strict';

// Small dependency-free canvas charts: stacked columns, percentile bands, lines and
// areas on one y-axis, with a crosshair/column tooltip. Every chart has a Chart/Table
// switch (the table shows the exact numbers behind the plot, with a CSV download),
// legend items that hide/show series, and gentle animations (off when the user prefers
// reduced motion). Colours come from CSS custom properties so light and dark themes
// are both "selected" palettes, not an automatic flip.

(function (root) {
  const moneyFmt = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: 0 });
  const FONT = '12px system-ui, -apple-system, "Segoe UI", sans-serif';

  function fmtMoney(v) {
    const r = Math.round(v);
    return moneyFmt.format(r === 0 ? 0 : r);
  }

  function fmtCompact(v) {
    const a = Math.abs(v), s = v < 0 ? '-' : '';
    const trim = x => x.replace(/\.0+$|(\.\d*[1-9])0+$/, '$1');
    if (a >= 1e9) return s + '£' + trim((a / 1e9).toFixed(2)) + 'B';
    if (a >= 1e6) return s + '£' + trim((a / 1e6).toFixed(a >= 1e8 ? 0 : a >= 1e7 ? 1 : 2)) + 'M';
    if (a >= 1e3) return s + '£' + trim((a / 1e3).toFixed(a >= 1e5 ? 0 : 1)) + 'K';
    return s + '£' + Math.round(a);
  }

  function fmtPct(v) {
    return Math.round(v * 100) + '%';
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function color(c) {
    return c && c.startsWith('--') ? cssVar(c) : c;
  }

  // "#2a78d6" + alpha -> rgba(); leaves other colour syntaxes alone.
  function withAlpha(c, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(c || '');
    if (!m) return c;
    const n = parseInt(m[1], 16);
    return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function niceTicks(min, max, count) {
    const range = max - min || 1;
    const rough = range / count;
    const mag = Math.pow(10, Math.floor(Math.log10(rough)));
    const norm = rough / mag;
    const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
    const ticks = [];
    const start = Math.floor(min / step + 1e-9) * step;
    for (let v = start; v <= max + step * 0.999; v += step) ticks.push(Math.abs(v) < step * 1e-9 ? 0 : v);
    return ticks;
  }

  const ease = k => 1 - Math.pow(1 - k, 3);
  const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
  const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const isNum = v => v != null && !Number.isNaN(v);

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  function csvText(headers, rows) {
    const esc = v => {
      const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
  }

  function download(name, text) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/csv' }));
    a.download = `horizon-${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  class Chart {
    constructor(host, opts = {}) {
      this.host = host;
      this.opts = opts;
      this.spark = !!opts.spark;
      this.height = opts.height || 340;
      this.name = opts.name || (opts.label || 'chart').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      host.classList.add('chart');
      if (this.spark) host.classList.add('spark');

      this.canvas = document.createElement('canvas');
      this.canvas.setAttribute('role', 'img');
      if (opts.label) this.canvas.setAttribute('aria-label', opts.label);
      this.canvas.style.height = this.height + 'px';
      this.tip = el('div', 'chart-tip');
      this.tip.hidden = true;

      this.view = 'chart';
      this.hidden = new Set();
      this.cfg = null;
      this.hover = -1;
      this.geo = null;
      this.disp = null;      // values as last drawn (for smooth transitions)
      this.anim = null;      // { kind: 'reveal' | 'tween', start, dur, from }
      this.revealed = false;
      this.raf = 0;

      if (!this.spark && opts.table !== false) {
        this.tools = el('div', 'chart-tools');
        const seg = el('div', 'seg mini');
        seg.setAttribute('role', 'group');
        seg.setAttribute('aria-label', 'Show as');
        this.viewBtns = ['chart', 'table'].map(v => {
          const b = el('button', null, v === 'chart' ? 'Chart' : 'Table');
          b.type = 'button';
          b.dataset.view = v;
          b.setAttribute('aria-pressed', String(v === 'chart'));
          b.addEventListener('click', () => this.setView(v));
          seg.append(b);
          return b;
        });
        this.csvBtn = el('button', 'btn small ghost csv', 'CSV');
        this.csvBtn.setAttribute('aria-label', 'Download these numbers as CSV');
        this.csvBtn.type = 'button';
        this.csvBtn.hidden = true;
        this.csvBtn.addEventListener('click', () => { const t = this.tableData(); if (t) download(this.name, csvText(t.headers, t.rows)); });
        this.tools.append(this.csvBtn, seg);
        this.tableBox = el('div', 'chart-table table-wrap');
        this.tableBox.hidden = true;
        this.tableBox.style.maxHeight = Math.max(this.height + 40, 220) + 'px';
        host.append(this.tools, this.canvas, this.tip, this.tableBox);
      } else {
        host.append(this.canvas, this.tip);
      }

      this.canvas.addEventListener('pointermove', e => this.onMove(e));
      this.canvas.addEventListener('pointerdown', e => this.onMove(e));
      this.canvas.addEventListener('pointerleave', e => { if (e.pointerType !== 'touch') this.clearHover(); });
      if (!this.spark) {
        this.canvas.tabIndex = 0;
        this.canvas.addEventListener('keydown', e => this.onKey(e));
        this.canvas.addEventListener('blur', () => this.clearHover());
      }
      new ResizeObserver(() => this.draw()).observe(host);
    }

    // cfg: { xs, bars:[{label,color,values}], areas:[{label,color,values}] (stacked, + up, − down), bands:[{label,lower,upper,color,alpha}],
    //        lines:[{label,color,values,dash,area,points}], markers:[{x,label}],
    //        refLines:[{y,label}], yFormat, yDomain, xFormat, xLabel,
    //        table() -> {headers, rows, formats}, tooltip(i) -> {title, rows:[{label,color,shape,text}]} }
    set(cfg) {
      const prev = this.disp;
      this.full = cfg;
      this.cfg = cfg = Chart.trim(cfg);
      // New data can be shorter than the year being hovered.
      if (this.hover >= cfg.xs.length) { this.hover = -1; this.tip.hidden = true; }
      if (prev && this.revealed && !reducedMotion() && this.compatible(prev, cfg)) {
        this.anim = { kind: 'tween', start: now(), dur: 420, from: prev };
      }
      if (this.view === 'table') this.renderTable();
      this.draw();
      if (this.hover >= 0) this.showTip(this.lastPointer);
    }

    // Charts over years stop at Chart.until (a year) unless they ask for the whole range.
    // Only the end is cut, so index i still means the same year for tooltips and tables.
    static trim(cfg) {
      const until = Chart.until;
      const xs = cfg.xs || [];
      if (!until || cfg.fullRange || xs.length < 3 || !(xs[0] > 1900) || xs[xs.length - 1] <= until) return cfg;
      const n = xs.findIndex(x => x > until);
      if (n < 2) return cfg;
      const cut = a => (a ? a.slice(0, n) : a);
      return {
        ...cfg,
        xs: xs.slice(0, n),
        bars: (cfg.bars || []).map(b => ({ ...b, values: cut(b.values) })),
        areas: (cfg.areas || []).map(b => ({ ...b, values: cut(b.values) })),
        lines: (cfg.lines || []).map(b => ({ ...b, values: cut(b.values) })),
        bands: (cfg.bands || []).map(b => ({ ...b, lower: cut(b.lower), upper: cut(b.upper) })),
      };
    }

    compatible(prev, cfg) {
      const n = cfg.xs.length;
      return prev.n === n && prev.bars.length === (cfg.bars || []).length && prev.areas.length === (cfg.areas || []).length &&
        prev.lines.length === (cfg.lines || []).length && prev.bands.length === (cfg.bands || []).length;
    }

    setView(v) {
      this.view = v;
      for (const b of this.viewBtns || []) b.setAttribute('aria-pressed', String(b.dataset.view === v));
      const table = v === 'table';
      this.canvas.hidden = table;
      this.tip.hidden = true;
      if (this.tableBox) this.tableBox.hidden = !table;
      if (this.csvBtn) this.csvBtn.hidden = !table;
      if (table) this.renderTable();
      else this.draw();
    }

    toggleSeries(label) {
      if (this.hidden.has(label)) this.hidden.delete(label);
      else this.hidden.add(label);
      if (this.disp && !reducedMotion()) this.anim = { kind: 'tween', start: now(), dur: 360, from: this.disp };
      this.draw();
      return !this.hidden.has(label);
    }

    // Numbers behind the chart: the caller's own table, or one column per series.
    tableData() {
      const cfg = this.full || this.cfg;   // every year, even past where the chart stops
      if (!cfg) return null;
      if (cfg.table) return cfg.table();
      const fmtV = cfg.tableFormat || (cfg.yFormat ? cfg.yFormat : fmtMoney);
      const headers = [cfg.xLabel || 'Year'];
      const cols = [];
      for (const b of cfg.bars || []) { headers.push(b.label); cols.push(b.values); }
      for (const a of cfg.areas || []) { headers.push(a.label); cols.push(a.values); }
      for (const l of cfg.lines || []) { headers.push(l.label); cols.push(l.values); }
      for (const b of cfg.bands || []) {
        const name = b.label || 'Range';
        headers.push(`${name} (low)`, `${name} (high)`);
        cols.push(b.lower, b.upper);
      }
      const rows = cfg.xs.map((x, i) => [cfg.xFormat ? cfg.xFormat(x, i) : x, ...cols.map(c => (isNum(c[i]) ? c[i] : ''))]);
      return { headers, rows, formats: [String, ...cols.map(() => v => (v === '' ? '—' : fmtV(v)))] };
    }

    renderTable() {
      const t = this.tableData();
      if (!t || !this.tableBox) return;
      const table = el('table', 'data');
      const thead = el('thead');
      const hr = el('tr');
      for (const hd of t.headers) { const th = el('th', null, hd); th.scope = 'col'; hr.append(th); }
      thead.append(hr);
      const tbody = el('tbody');
      for (const r of t.rows) {
        const tr = el('tr');
        r.forEach((v, i) => tr.append(el('td', null, t.formats && t.formats[i] ? t.formats[i](v) : String(v))));
        tbody.append(tr);
      }
      table.append(thead, tbody);
      this.tableBox.replaceChildren(table);
    }

    clearHover() {
      if (this.hover < 0) return;
      this.hover = -1;
      this.tip.hidden = true;
      this.draw();
    }

    // Series values as they should appear in this frame (hidden series fall to zero).
    resolve(k, kind) {
      const cfg = this.cfg;
      const bars = (cfg.bars || []).map(b => (this.hidden.has(b.label) ? b.values.map(() => 0) : b.values.slice()));
      const areas = (cfg.areas || []).map(a => (this.hidden.has(a.label) ? a.values.map(() => 0) : a.values.slice()));
      const lines = (cfg.lines || []).map(l => l.values.slice());
      const bands = (cfg.bands || []).map(b => [b.lower.slice(), b.upper.slice()]);
      const out = { n: cfg.xs.length, bars, areas, lines, bands };
      if (kind === 'tween' && k < 1) {
        const f = this.anim.from;
        const mix = (a, b) => b.map((v, i) => (isNum(v) && isNum(a[i]) ? a[i] + (v - a[i]) * k : v));
        out.bars = bars.map((v, j) => mix(f.bars[j], v));
        out.areas = areas.map((v, j) => mix(f.areas[j], v));
        out.lines = lines.map((v, j) => mix(f.lines[j], v));
        out.bands = bands.map((v, j) => [mix(f.bands[j][0], v[0]), mix(f.bands[j][1], v[1])]);
      }
      return out;
    }

    draw() {
      const cfg = this.cfg;
      if (!cfg || this.view === 'table') return;
      const cv = this.canvas;
      const W = cv.clientWidth, H = cv.clientHeight;
      if (W < 20 || H < 20) return;

      // Animation progress.
      let k = 1, kind = null;
      if (!this.revealed) {
        this.revealed = true;
        if (!reducedMotion()) this.anim = { kind: 'reveal', start: now(), dur: 750 };
      }
      if (this.anim) {
        k = Math.min(1, (now() - this.anim.start) / this.anim.dur);
        kind = this.anim.kind;
        if (k >= 1) { this.anim = null; kind = null; } else if (!this.raf) {
          this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
        }
      }
      const ek = ease(k);
      const reveal = kind === 'reveal' ? ek : 1;

      const dpr = window.devicePixelRatio || 1;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr);
        cv.height = Math.round(H * dpr);
      }
      const ctx = cv.getContext('2d');
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);

      const ink = {
        surface: cssVar('--surface'), muted: cssVar('--muted'), grid: cssVar('--grid'),
        axis: cssVar('--axis'), text: cssVar('--text-2'), strong: cssVar('--text'), hover: cssVar('--hover'),
      };
      const vals = this.resolve(ek, kind);
      this.disp = vals;
      const barDefs = cfg.bars || [], bandDefs = cfg.bands || [], lineDefs = cfg.lines || [];
      const xs = cfg.xs, n = xs.length;
      const fmtY = cfg.yFormat || fmtCompact;
      const showLine = j => !this.hidden.has(lineDefs[j].label);
      const showBand = j => !this.hidden.has(bandDefs[j].label || '');

      // ---- y domain (from what is shown)
      let lo = 0, hi = 0;
      if (cfg.yDomain) {
        [lo, hi] = cfg.yDomain;
      } else {
        for (let i = 0; i < n; i++) {
          let pos = 0, neg = 0;
          for (const v of vals.bars.concat(vals.areas)) { if (v[i] > 0) pos += v[i]; else neg += v[i]; }
          hi = Math.max(hi, pos); lo = Math.min(lo, neg);
        }
        vals.bands.forEach((b, j) => { if (showBand(j)) for (let i = 0; i < n; i++) { hi = Math.max(hi, b[1][i]); lo = Math.min(lo, b[0][i]); } });
        vals.lines.forEach((l, j) => { if (showLine(j)) for (const v of l) if (isNum(v)) { hi = Math.max(hi, v); lo = Math.min(lo, v); } });
        for (const r of cfg.refLines || []) { hi = Math.max(hi, r.y * 1.04); lo = Math.min(lo, r.y); }
        // Nothing but zeros (a new plan, or every series switched off): say so instead of an axis
        // of "£1 £1 £0".
        if (Math.max(Math.abs(hi), Math.abs(lo)) < 0.5 && !this.spark) {
          ctx.font = FONT;
          ctx.fillStyle = ink.muted;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('Nothing to show yet', W / 2, H / 2);
          this.geo = null;
          return;
        }
        if (hi === lo) hi = lo + 1;
      }
      const yt = niceTicks(lo, hi, H < 160 ? 3 : H < 260 ? 4 : 5);
      const ymin = cfg.yDomain ? lo : yt[0], ymax = cfg.yDomain ? hi : yt[yt.length - 1];

      ctx.font = FONT;
      let labelW = 0;
      if (!this.spark) for (const v of yt) labelW = Math.max(labelW, ctx.measureText(fmtY(v)).width);

      // ---- marker label rows (so labels never collide)
      const markers = (cfg.markers || []).filter(m => m.x >= xs[0] && m.x <= xs[n - 1]);
      const pad = this.spark ? { l: 2, r: 2, t: 4, b: 2 } : { l: Math.ceil(labelW) + 14, r: 14, t: 12, b: 28 };
      const isBar = barDefs.length > 0;
      const pw0 = W - pad.l - pad.r;
      const step = n > 1 ? xs[1] - xs[0] : 1;
      const xAt = (i, pw) => (isBar ? pad.l + (pw / n) * (i + 0.5) : pad.l + (n > 1 ? (i / (n - 1)) * pw : pw / 2));
      let rowsUsed = 0;
      const placed = [];
      if (!this.spark && markers.length) {
        ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
        const ends = [];
        for (const m of markers.slice().sort((a, b) => a.x - b.x)) {
          const x = xAt((m.x - xs[0]) / step, pw0);
          const tw = ctx.measureText(m.label).width;
          let left = Math.max(2, Math.min(W - tw - 2, x - tw / 2));
          let row = ends.findIndex(e => left > e + 8);
          if (row < 0) { row = ends.length; ends.push(-Infinity); }
          if (row > 2) { placed.push({ m, row: -1, left, tw }); continue; } // no room: guide and dot only
          ends[row] = left + tw;
          placed.push({ m, row, left, tw });
          rowsUsed = Math.max(rowsUsed, row + 1);
        }
        pad.t = 12 + rowsUsed * 16;
      }
      const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
      const slot = pw / n;
      const Xi = i => xAt(i, pw);
      const Xv = x => Xi((x - xs[0]) / step);
      const Y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * ph;
      this.geo = { pad, pw, n, slot, isBar, Xi, Y };

      // ---- grid + y labels
      if (!this.spark) {
        ctx.font = FONT;
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const v of yt) {
          const y = Math.round(Y(v)) + 0.5;
          ctx.strokeStyle = v === 0 ? ink.axis : ink.grid;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(pad.l, y);
          ctx.lineTo(W - pad.r, y);
          ctx.stroke();
          ctx.fillStyle = ink.muted;
          ctx.fillText(fmtY(v), pad.l - 8, y);
        }

        // ---- x labels: choose a step that keeps labels ~44px apart
        const pxPerYear = pw / Math.max(1, (n - 1) * step);
        const xStep = cfg.xFormat && step === 1 && n <= 12 ? 1 : [1, 2, 5, 10, 20, 50].find(s => s * pxPerYear >= 44) || 50;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = ink.muted;
        for (let i = 0; i < n; i++) {
          if (xs[i] % xStep !== 0) continue;
          ctx.fillText(cfg.xFormat ? cfg.xFormat(xs[i], i) : String(xs[i]), Xi(i), H - pad.b + 8);
        }
      }

      // ---- hovered column wash
      if (this.hover >= 0 && isBar) {
        ctx.fillStyle = ink.hover;
        ctx.fillRect(Xi(this.hover) - slot / 2, pad.t, slot, ph);
      }

      // Lines, bands and areas are revealed left to right on first draw.
      ctx.save();
      if (reveal < 1) {
        ctx.beginPath();
        ctx.rect(0, 0, pad.l + pw * reveal, H);
        ctx.clip();
      }

      // ---- bands
      vals.bands.forEach((b, j) => {
        if (!showBand(j)) return;
        const d = bandDefs[j];
        ctx.globalAlpha = d.alpha;
        ctx.fillStyle = color(d.color);
        ctx.beginPath();
        for (let i = 0; i < n; i++) ctx[i ? 'lineTo' : 'moveTo'](Xi(i), Y(b[1][i]));
        for (let i = n - 1; i >= 0; i--) ctx.lineTo(Xi(i), Y(b[0][i]));
        ctx.closePath();
        ctx.fill();
      });
      ctx.globalAlpha = 1;

      // ---- stacked areas: each layer filled softly with a solid top edge; positive
      //      values stack up from zero and negative ones down.
      const areaDefs = cfg.areas || [];
      if (areaDefs.length) {
        const zero = Y(Math.max(ymin, Math.min(0, ymax)));
        for (const sign of [1, -1]) {
          const cum = new Array(n).fill(0);
          vals.areas.forEach((v, j) => {
            const d = areaDefs[j];
            if (!v.some(x => (sign > 0 ? x > 0 : x < 0))) return;
            const lower = cum.slice();
            for (let i = 0; i < n; i++) { const x = v[i] || 0; if (sign > 0 ? x > 0 : x < 0) cum[i] += x; }
            const c = color(d.color);
            const top = Math.min(...cum.map(Y)), bot = sign > 0 ? zero : Math.max(...cum.map(Y));
            if (!Number.isFinite(top) || !Number.isFinite(bot) || !Number.isFinite(zero)) return;   // nothing drawable
            const grad = ctx.createLinearGradient(0, sign > 0 ? top : zero, 0, sign > 0 ? zero : bot);
            grad.addColorStop(0, withAlpha(c, this.hover >= 0 ? 0.38 : 0.46));
            grad.addColorStop(1, withAlpha(c, 0.16));
            ctx.fillStyle = grad;
            ctx.beginPath();
            for (let i = 0; i < n; i++) ctx[i ? 'lineTo' : 'moveTo'](Xi(i), Y(cum[i]));
            for (let i = n - 1; i >= 0; i--) ctx.lineTo(Xi(i), Y(lower[i]));
            ctx.closePath();
            ctx.fill();
            ctx.strokeStyle = c;
            ctx.lineWidth = 1.75;
            ctx.lineJoin = 'round';
            ctx.beginPath();
            for (let i = 0; i < n; i++) ctx[i ? 'lineTo' : 'moveTo'](Xi(i), Y(cum[i]));
            ctx.stroke();
          });
        }
      }

      // ---- areas under lines (soft gradient down to the baseline)
      const base = Y(Math.max(ymin, Math.min(0, ymax)));
      vals.lines.forEach((v, j) => {
        const d = lineDefs[j];
        if (!d.area || !showLine(j)) return;
        const c = color(d.color);
        const top = Math.min(...v.filter(isNum).map(Y));
        if (!Number.isFinite(top) || !Number.isFinite(base)) return;   // a line with no values yet
        const grad = ctx.createLinearGradient(0, top, 0, base);
        grad.addColorStop(0, withAlpha(c, 0.24));
        grad.addColorStop(1, withAlpha(c, 0.02));
        ctx.fillStyle = grad;
        ctx.beginPath();
        let first = -1, last = -1;
        for (let i = 0; i < n; i++) {
          if (!isNum(v[i])) continue;
          if (first < 0) { first = i; ctx.moveTo(Xi(i), base); }
          ctx.lineTo(Xi(i), Y(v[i]));
          last = i;
        }
        if (first >= 0) {
          ctx.lineTo(Xi(last), base);
          ctx.closePath();
          ctx.fill();
        }
      });
      ctx.restore();

      // ---- stacked columns: 2px surface gap between segments, 4px rounded data-end;
      //      columns grow from the baseline (staggered) on first draw.
      if (isBar) {
        const bw = Math.max(1, Math.min(24, slot - 2));
        const gap = bw >= 4 ? 2 : 0;
        const colors = barDefs.map(b => color(b.color));
        const y0 = Y(0);
        for (let i = 0; i < n; i++) {
          const g = reveal < 1 ? ease(Math.max(0, Math.min(1, reveal * 1.6 - (i / n) * 0.6))) : 1;
          if (g <= 0) continue;
          ctx.globalAlpha = this.hover >= 0 && this.hover !== i ? 0.55 : 1;
          for (const sign of [1, -1]) {
            const segs = [];
            for (let j = 0; j < vals.bars.length; j++) {
              const v = vals.bars[j][i] * g;
              if (sign > 0 ? v > 0 : v < 0) segs.push([j, v]);
            }
            let cum = 0, edge = y0;
            segs.forEach(([j, v], s) => {
              const a = s === 0 ? y0 : edge - sign * gap;
              cum += v;
              const b = Y(cum);
              edge = b;
              const top = Math.min(a, b), hgt = Math.abs(a - b);
              if (hgt < 0.5 || (sign > 0 ? b >= a : b <= a)) return;
              const r = s === segs.length - 1 ? Math.min(4, bw / 2, hgt) : 0;
              ctx.fillStyle = colors[j];
              ctx.beginPath();
              const x = Xi(i) - bw / 2;
              if (ctx.roundRect) ctx.roundRect(x, top, bw, hgt, sign > 0 ? [r, r, 0, 0] : [0, 0, r, r]);
              else ctx.rect(x, top, bw, hgt);
              ctx.fill();
            });
          }
        }
        ctx.globalAlpha = 1;
      }

      // ---- reference lines (e.g. a goal amount)
      ctx.globalAlpha = reveal;
      for (const r of cfg.refLines || []) {
        if (r.y < ymin || r.y > ymax) continue;
        const y = Math.round(Y(r.y)) + 0.5;
        ctx.strokeStyle = color(r.color || '--text-2');
        ctx.lineWidth = 1.5;
        ctx.setLineDash([2, 4]);
        ctx.beginPath();
        ctx.moveTo(pad.l, y);
        ctx.lineTo(W - pad.r, y);
        ctx.stroke();
        ctx.setLineDash([]);
        if (r.label && !this.spark) {
          ctx.font = '600 11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
          const tw = ctx.measureText(r.label).width;
          const lx = pad.l + 8;
          ctx.fillStyle = ink.surface;
          ctx.globalAlpha = 0.85 * reveal;
          ctx.fillRect(lx - 4, y - 17, tw + 8, 15);
          ctx.globalAlpha = reveal;
          ctx.fillStyle = ink.strong;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'bottom';
          ctx.fillText(r.label, lx, y - 3);
        }
      }
      ctx.globalAlpha = 1;

      // ---- lines
      ctx.save();
      if (reveal < 1) {
        ctx.beginPath();
        ctx.rect(0, 0, pad.l + pw * reveal, H);
        ctx.clip();
      }
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      vals.lines.forEach((v, j) => {
        const l = lineDefs[j];
        if (!showLine(j)) return;
        ctx.strokeStyle = color(l.color);
        ctx.lineWidth = l.width || 2;
        ctx.setLineDash(l.dash || []);
        ctx.beginPath();
        let pen = false;
        for (let i = 0; i < n; i++) {
          if (!isNum(v[i])) { pen = false; continue; }
          ctx[pen ? 'lineTo' : 'moveTo'](Xi(i), Y(v[i]));
          pen = true;
        }
        if (!l.pointsOnly) ctx.stroke();
        ctx.setLineDash([]);
        if (l.points || l.pointsOnly) {
          for (let i = 0; i < n; i++) {
            if (!isNum(v[i])) continue;
            ctx.beginPath();
            ctx.arc(Xi(i), Y(v[i]), 5, 0, Math.PI * 2);
            ctx.fillStyle = color(l.color);
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = ink.surface;
            ctx.stroke();
          }
        }
      });
      ctx.restore();
      ctx.setLineDash([]);

      // ---- markers: dashed guide, a dot, and a label in its own row
      ctx.font = '11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.globalAlpha = reveal;
      for (const { m, row, left } of placed) {
        const x = Math.round(Xv(m.x)) + 0.5;
        const ly = 12 + (row < 0 ? rowsUsed - 1 : row) * 16 + 11;
        ctx.strokeStyle = ink.axis;
        ctx.lineWidth = 1;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.moveTo(x, ly + 3);
        ctx.lineTo(x, H - pad.b);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.arc(x, ly + 3, 3, 0, Math.PI * 2);
        ctx.fillStyle = color(m.color || '--text-2');
        ctx.fill();
        if (row < 0) continue;
        ctx.fillStyle = ink.text;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'bottom';
        ctx.fillText(m.label, left, ly);
      }
      ctx.globalAlpha = 1;

      // ---- crosshair, hover dots and the year pill on the x-axis
      if (this.hover >= 0) {
        const x = Math.round(Xi(this.hover)) + 0.5;
        if (!isBar) {
          ctx.strokeStyle = ink.axis;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(x, pad.t);
          ctx.lineTo(x, H - pad.b);
          ctx.stroke();
        }
        vals.lines.forEach((v, j) => {
          if (!showLine(j) || !isNum(v[this.hover])) return;
          ctx.beginPath();
          ctx.arc(Xi(this.hover), Y(v[this.hover]), 4.5, 0, Math.PI * 2);
          ctx.fillStyle = color(lineDefs[j].color);
          ctx.fill();
          ctx.lineWidth = 2;
          ctx.strokeStyle = ink.surface;
          ctx.stroke();
        });
        if (!this.spark) {
          const label = cfg.xFormat ? cfg.xFormat(xs[this.hover], this.hover) : String(xs[this.hover]);
          ctx.font = '600 11.5px system-ui, -apple-system, "Segoe UI", sans-serif';
          const tw = ctx.measureText(label).width + 12;
          const px = Math.max(pad.l, Math.min(W - pad.r - tw, x - tw / 2));
          ctx.fillStyle = ink.strong;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(px, H - pad.b + 4, tw, 18, 9); else ctx.rect(px, H - pad.b + 4, tw, 18);
          ctx.fill();
          ctx.fillStyle = ink.surface;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(label, px + tw / 2, H - pad.b + 13.5);
        }
      }
    }

    indexAt(clientX) {
      const rect = this.canvas.getBoundingClientRect();
      const { pad, pw, n, isBar } = this.geo;
      const frac = (clientX - rect.left - pad.l) / pw;
      if (frac < -0.03 || frac > 1.03) return -1;
      const i = isBar ? Math.floor(frac * n) : Math.round(frac * (n - 1));
      return Math.max(0, Math.min(n - 1, i));
    }

    onMove(e) {
      if (!this.cfg || !this.geo) return;
      const i = this.indexAt(e.clientX);
      if (i < 0) return this.clearHover();
      this.hover = i;
      this.lastPointer = { x: e.clientX, y: e.clientY };
      this.draw();
      this.showTip(this.lastPointer);
    }

    onKey(e) {
      if (!this.cfg || !this.geo) return;
      const n = this.geo.n;
      let i = this.hover;
      if (e.key === 'ArrowRight') i = i < 0 ? 0 : Math.min(n - 1, i + 1);
      else if (e.key === 'ArrowLeft') i = i < 0 ? n - 1 : Math.max(0, i - 1);
      else if (e.key === 'Home') i = 0;
      else if (e.key === 'End') i = n - 1;
      else if (e.key === 'Escape') { this.clearHover(); return; } else return;
      e.preventDefault();
      this.hover = i;
      const rect = this.canvas.getBoundingClientRect();
      this.lastPointer = { x: rect.left + this.geo.Xi(i), y: rect.top + this.geo.pad.t + 30 };
      this.draw();
      this.showTip(this.lastPointer);
    }

    showTip(pt) {
      if (!pt || !this.cfg.tooltip || this.hover < 0 || this.view === 'table') return;
      const info = this.cfg.tooltip(this.hover);
      const tip = this.tip;
      tip.replaceChildren();
      tip.append(el('div', 'tip-title', info.title));
      for (const r of info.rows) {
        if (this.hidden.has(r.series || r.label)) continue;
        const row = el('div', 'tip-row' + (r.strong ? ' strong' : ''));
        const key = el('span', 'key ' + (r.shape || 'square'));
        if (r.color) key.style.setProperty('--key', color(r.color));
        row.append(key, el('span', 'tip-label', r.label), el('span', 'tip-val', r.text));
        tip.append(row);
      }
      if (info.note) tip.append(el('div', 'tip-note', info.note));
      tip.hidden = false;
      const host = this.host.getBoundingClientRect();
      const cv = this.canvas.getBoundingClientRect();
      const tw = tip.offsetWidth, th = tip.offsetHeight;
      let left = pt.x - host.left + 16;
      if (left + tw > host.width - 4) left = pt.x - host.left - tw - 16;
      const top0 = cv.top - host.top;
      let top = pt.y - host.top - th / 2;
      top = Math.max(top0 + 4, Math.min(top, top0 + this.height - th - 4));
      tip.style.left = Math.max(4, left) + 'px';
      tip.style.top = top + 'px';
    }
  }

  const api = { Chart, fmtMoney, fmtCompact, fmtPct, cssVar, niceTicks, csvText };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else Object.assign(root, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
