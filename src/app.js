'use strict';

// Horizon UI. Everything runs locally; the plan lives in localStorage and export files.

(function () {
  const E = window.Engine;
  const R = window.UKRules;
  const W = window.SpendingWizard;
  const L = window.Levers;
  const LW = window.LifeWizard;
  const B = window.Benchmarks;
  const RV = window.Review;
  const SI = window.ScenarioIdeas;
  const DRIVER_RUNS = 300;
  const MARKET = window.MARKET_DATA || null;
  const STORE = 'horizon-uk-v3';
  const EXPLORE_RUNS = 300;

  // ------------------------------------------------------------------ DOM helpers

  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // Replace an element's children, skipping empty ones (null/false never show as text).
  function setKids(el, ...kids) {
    el.replaceChildren(...kids.flat(Infinity).filter(k => k != null && k !== false));
  }

  function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === false || v == null) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'value') el.value = v;
      else if (k === 'checked') el.checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid);
    return el;
  }

  // ------------------------------------------------------------------ formatting

  const money = v => fmtMoney(v);
  const plain = v => (Number(v) || 0).toLocaleString('en-GB', { maximumFractionDigits: 2 });
  const pct = v => `${Math.round(v * 100)}%`;
  const pct1 = v => `${(Math.round(v * 1000) / 10).toFixed(1)}%`;
  const today = () => E.todayISO();

  function parseAmount(s) {
    let t = String(s).trim().toLowerCase().replace(/[£,\s]/g, '');
    let mult = 1;
    if (t.endsWith('k')) { mult = 1e3; t = t.slice(0, -1); } else if (t.endsWith('m')) { mult = 1e6; t = t.slice(0, -1); }
    const v = parseFloat(t);
    return Number.isFinite(v) ? v * mult : 0;
  }

  // ------------------------------------------------------------------ state

  function load() {
    try {
      const raw = localStorage.getItem(STORE);
      if (raw) return E.normalizeWorkspace(JSON.parse(raw));
    } catch { /* storage blocked or corrupt: start from the example */ }
    return E.defaultWorkspace();
  }

  let ws = load();
  let model = null;
  let compareDirty = true;

  const scenario = () => ws.scenarios.find(s => s.id === ws.activeId);
  const plan = () => scenario().plan;
  const people = () => plan().household.people;
  const real = () => ws.settings.realDollars;
  const D = (v, t) => (real() ? v / model.proj.pre.deflator[t] : v);
  const unitLabel = () => (real() ? "today's money" : 'future money');
  const view = () => (real() ? 'real' : 'nominal');

  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(ws)); } catch { /* ignore */ }
  }

  function compute() {
    const p = plan();
    const proj = E.project(p);
    const mc = E.monteCarlo(p, ws.settings.runs, ws.settings.seed);
    model = {
      proj, mc,
      milestones: E.milestones(p, proj),
      warnings: E.validatePlan(p),
      monthly: E.monthlyPlan(proj),
      goals: E.evaluateGoals(p, proj, mc, { runs: 500, seed: ws.settings.seed }),
      est: RV.estimateAt(p, today(), proj),
    };
  }

  let timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(refresh, 200);
  }

  function refresh() {
    clearTimeout(timer);
    save();
    compute();
    compareDirty = true;
    explorerBase = null;
    renderResults();
  }

  // ------------------------------------------------------------------ shared labels

  function agesAt(t) {
    return people().map((p, i) => `${p.name} ${model.proj.pre.ages[i][t]}`).join(', ');
  }

  function titleAt(t) {
    return `${model.proj.pre.years[t]} · ${agesAt(t)}`;
  }

  function tIndexOfYear(year) {
    return Math.max(0, Math.min(model.proj.pre.N, year - plan().startYear));
  }

  function retireT() {
    const p1 = people()[0];
    return Math.max(0, Math.min(model.proj.pre.N, p1.retireAge - p1.age));
  }

  // Overall success: on track / some risk / at risk.
  function statusFor(rate) {
    if (rate >= 0.85) return { cls: 'good', label: 'On track', icon: 'check' };
    if (rate >= 0.7) return { cls: 'warn', label: 'Some risk', icon: 'alert' };
    return { cls: 'bad', label: 'At risk', icon: 'cross' };
  }

  // Goals: likely / possible / unlikely.
  function goalStatus(prob) {
    const s = E.statusOf(prob);
    return { good: { cls: 'good', label: 'Likely', icon: 'check' }, warn: { cls: 'warn', label: 'Possible', icon: 'alert' }, bad: { cls: 'bad', label: 'Unlikely', icon: 'cross' } }[s];
  }

  function icon(name) {
    const paths = {
      check: 'M4 8.5l2.5 2.5L12 5.5',
      alert: 'M8 4.5v4M8 11.2v.3',
      cross: 'M5 5l6 6M11 5l-6 6',
    };
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'ico');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<circle cx="8" cy="8" r="7.2" fill="currentColor" opacity="0.15"/><path d="${paths[name]}" stroke="currentColor" stroke-width="1.8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    return svg;
  }

  function badge(s) {
    return h('span', { class: `status ${s.cls}` }, icon(s.icon), s.label);
  }

  // Legend under a chart. With the chart passed in, each item is a button that hides or
  // shows its series (`series` names the series when it differs from the label).
  function legend(box, items, c) {
    setKids(box, ...items.map(it => {
      const key = h('i', { class: `key ${it.shape || 'square'}`, style: `--key:${cssVar(it.color)}` });
      if (!c) return h('span', {}, key, it.label);
      const name = it.series || it.label;
      const b = h('button', {
        type: 'button', class: 'legend-item', 'aria-pressed': String(!c.hidden.has(name)), title: `Show or hide ${it.label}`,
        onclick: () => b.setAttribute('aria-pressed', String(c.toggleSeries(name))),
      }, key, it.label);
      return b;
    }));
  }

  // Small stroke icons for milestones and the plan check.
  const GLYPHS = {
    retire: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.6v1.8M8 12.6v1.8M1.6 8h1.8M12.6 8h1.8M3.5 3.5l1.3 1.3M11.2 11.2l1.3 1.3M3.5 12.5l1.3-1.3M11.2 4.8l1.3-1.3"/>',
    pension: '<rect x="3.5" y="7.2" width="9" height="6.3" rx="1.5"/><path d="M5.6 7.2V5.4a2.4 2.4 0 0 1 4.6-.9"/>',
    sp: '<ellipse cx="8" cy="4.6" rx="4.8" ry="2"/><path d="M3.2 4.6v6.6c0 1.1 2.2 2 4.8 2s4.8-.9 4.8-2V4.6M3.2 7.9c0 1.1 2.2 2 4.8 2s4.8-.9 4.8-2"/>',
    debt: '<path d="M2.5 7.6L8 3l5.5 4.6M4 6.6V13h8V6.6M6.6 13V9.8h2.8V13"/>',
    fi: '<path d="M8 2.2l1.75 3.6 3.95.55-2.85 2.75.7 3.9L8 11.15 4.45 13l.7-3.9L2.3 6.35l3.95-.55z"/>',
    goal: '<path d="M4 14V2.6M4 3.2h7.6l-1.9 2.7 1.9 2.7H4"/>',
    short: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.6v3M8 11.3v.2"/>',
    review: '<rect x="2.6" y="3.6" width="10.8" height="9.8" rx="1.8"/><path d="M2.6 6.6h10.8M5.4 2.2v2.6M10.6 2.2v2.6"/>',
    warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.6v3M8 11.3v.2"/>',
    tip: '<path d="M6.2 12.4h3.6M6.7 14h2.6M8 2a4 4 0 0 0-2.4 7.2c.6.5.9 1.1.9 1.8h3c0-.7.3-1.3.9-1.8A4 4 0 0 0 8 2z"/>',
    good: '<path d="M3.6 8.4l2.8 2.8 6-6.2"/>',
    info: '<circle cx="8" cy="8" r="6"/><path d="M8 7.3v4M8 4.9v.2"/>',
    trend: '<path d="M2 12l4-4 3 3 5-6M10.5 5H14v3.5"/>',
    'trend-down': '<path d="M2 4l4 4 3-3 5 6M10.5 11H14V7.5"/>',
    shield: '<path d="M8 1.8l5 2v3.6c0 3.1-2.1 5.6-5 6.8-2.9-1.2-5-3.7-5-6.8V3.8z"/><path d="M5.9 8l1.5 1.5 2.8-3"/>',
    piggy: '<path d="M3 8.2c0-2.4 2.2-4 5-4 2.4 0 4.2 1.1 4.8 2.8l1.2.3v2.3l-1.3.4c-.4.8-1 1.4-1.7 1.9v1.8H9.6v-1.2a7 7 0 0 1-2.6 0v1.2H5.6v-1.9C4 11 3 9.7 3 8.2z"/><path d="M6.5 4.6l-.6-1.8 2 .9M10.6 7.1v.1"/>',
    home: '<path d="M2.5 7.6L8 3l5.5 4.6M4 6.6V13h8V6.6"/><path d="M6.6 13V9.8h2.8V13"/>',
    cap: '<path d="M1.8 6.3L8 3.5l6.2 2.8L8 9.1z"/><path d="M4.4 7.6v3c1 1 2.3 1.5 3.6 1.5s2.6-.5 3.6-1.5v-3M14.2 6.3v3.6"/>',
    gift: '<rect x="2.5" y="6" width="11" height="3" rx=".8"/><path d="M3.5 9v4.5h9V9M8 6v7.5M8 6C6.5 6 4.6 5.6 4.6 4.2 4.6 3 6.4 2.8 8 6zM8 6c1.5 0 3.4-.4 3.4-1.8C11.4 3 9.6 2.8 8 6z"/>',
    heart: '<path d="M8 13.5S2.4 10.2 2.4 6.2A2.9 2.9 0 0 1 8 4.8a2.9 2.9 0 0 1 5.6 1.4c0 4-5.6 7.3-5.6 7.3z"/>',
    clock: '<circle cx="8" cy="8" r="5.8"/><path d="M8 4.8V8l2.2 1.4"/>',
    pause: '<circle cx="8" cy="8" r="5.8"/><path d="M6.6 5.8v4.4M9.4 5.8v4.4"/>',
    edit: '<path d="M10.8 2.8l2.4 2.4-7.6 7.6-3.1.7.7-3.1z"/><path d="M9.4 4.2l2.4 2.4"/>',
    layers: '<path d="M8 2.2l5.8 3L8 8.2 2.2 5.2z"/><path d="M2.2 8.1L8 11.1l5.8-3M2.2 10.9L8 13.9l5.8-3"/>',
  };

  function glyph(name) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('class', 'glyph');
    svg.setAttribute('aria-hidden', 'true');
    svg.innerHTML = `<g fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">${GLYPHS[name] || GLYPHS.info}</g>`;
    return svg;
  }

  function table(headers, rows) {
    return h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, headers.map(x => h('th', { scope: 'col' }, x)))),
      h('tbody', {}, rows.map(r => h('tr', { class: r.cls || '' }, r.cells.map(c => (c instanceof Node ? h('td', {}, c) : h('td', { class: c && c.cls }, c && c.text !== undefined ? c.text : c)))))));
  }

  // A table built from raw numbers, with a CSV download of the same numbers.
  function dataTable(name, headers, rows, formats, opts = {}) {
    const fmt = (v, i) => (formats[i] ? formats[i](v) : v);
    const tbl = table(headers, rows.map((r, k) => ({ cls: opts.rowClass ? opts.rowClass(r, k) : '', cells: r.map((v, i) => fmt(v, i)) })));
    const csvBtn = h('button', { type: 'button', class: 'btn small', onclick: () => downloadCSV(name, headers, rows) }, 'Download CSV');
    return h('div', {}, h('div', { class: 'table-tools' }, csvBtn), h('div', { class: `table-wrap ${opts.tall === false ? '' : 'tall'}` }, tbl));
  }

  // The numbers behind a chart, shown by its Chart/Table switch (with a CSV download).
  function tableOn(c, headers, rows, formats) {
    c.cfg.table = () => ({ headers, rows, formats });
    if (c.view === 'table') c.renderTable();
  }

  function downloadCSV(name, headers, rows) {
    const esc = v => {
      const s = typeof v === 'number' ? String(Math.round(v * 100) / 100) : String(v ?? '');
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const text = [headers, ...rows].map(r => r.map(esc).join(',')).join('\n');
    const a = h('a', { href: URL.createObjectURL(new Blob([text], { type: 'text/csv' })), download: `horizon-${name}-${today()}.csv` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ charts

  const charts = {};
  function chart(id, height, label) {
    if (!charts[id]) charts[id] = new Chart($('#' + id), { height, label, name: id });
    return charts[id];
  }

  // A chart in a freshly created container (for dynamic sections).
  function chartIn(host, height, label, opts = {}) {
    const div = h('div', { class: 'chart' });
    host.append(div);
    return new Chart(div, { height, label, ...opts });
  }

  const ACCOUNT_SERIES = [
    { key: 'cash', label: 'Cash', color: '--s1' },
    { key: 'isa', label: 'ISAs', color: '--s2' },
    { key: 'gia', label: 'General investment', color: '--s3' },
    { key: 'pension', label: 'Pensions', color: '--s4' },
    { key: 'bonds', label: 'Bonds & gilts', color: '--s5' },
    { key: 'property', label: 'Property', color: '--s6' },
  ];
  const TYPE_COLOR = { cash: '--s1', isa: '--s2', lisa: '--s2', gia: '--s3', pension: '--s4', bonds: '--s5', property: '--s6', debt: '--s8' };
  const SERIES_COLORS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

  function fanConfig(xs, bands, opts = {}) {
    const fmt = opts.format || money;
    const lines = [{ label: 'Median', color: opts.color || '--s1', values: bands.p50 }];
    if (opts.expected) lines.push({ label: 'Expected', color: '--muted', values: opts.expected, dash: [6, 4] });
    return {
      xs,
      yDomain: opts.yDomain, yFormat: opts.yFormat,
      bands: [
        { label: '10th–90th percentile', lower: bands.p10, upper: bands.p90, color: opts.band || '--band', alpha: 0.14 },
        { label: 'Middle half of outcomes', lower: bands.p25, upper: bands.p75, color: opts.band || '--band', alpha: 0.26 },
      ],
      lines,
      markers: opts.markers,
      table: () => ({
        headers: ['Year', '10th', '25th', 'Median', '75th', '90th', ...(opts.expected ? ['Average returns'] : [])],
        rows: xs.map((x, i) => [x, bands.p10[i], bands.p25[i], bands.p50[i], bands.p75[i], bands.p90[i], ...(opts.expected ? [opts.expected[i]] : [])]),
        formats: [String, fmt, fmt, fmt, fmt, fmt, fmt],
      }),
      tooltip: i => ({
        title: opts.title ? opts.title(i) : String(xs[i]),
        rows: [
          { label: '90th percentile', series: '10th–90th percentile', color: opts.band || '--band', shape: 'band', text: fmt(bands.p90[i]) },
          { label: '75th percentile', series: 'Middle half of outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p75[i]) },
          { label: 'Median', color: opts.color || '--s1', shape: 'line', text: fmt(bands.p50[i]), strong: true },
          { label: '25th percentile', series: 'Middle half of outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p25[i]) },
          { label: '10th percentile', series: '10th–90th percentile', color: opts.band || '--band', shape: 'band', text: fmt(bands.p10[i]) },
          ...(opts.expected ? [{ label: 'Average returns', series: 'Expected', color: '--muted', shape: 'dash', text: fmt(opts.expected[i]) }] : []),
        ],
      }),
    };
  }

  // ------------------------------------------------------------------ status & warnings

  // ------------------------------------------------------------------ overview

  function tile(label, value, extra, hero) {
    return h('div', { class: 'tile' }, h('div', { class: 'label' }, label), h('div', { class: 'value' + (hero ? ' hero' : '') }, value), extra);
  }

  const MILESTONE_COLOR = { retire: '--s4', pension: '--s3', sp: '--s7', debt: '--s6', fi: '--s2', goal: '--s1', short: '--bad', review: '--muted' };

  // Milestones from the projection plus when each goal is expected to be reached.
  function allMilestones() {
    const list = model.milestones.map(m => ({ ...m }));
    for (const g of model.goals) {
      if (g.goal.type === 'retire' || g.goal.type === 'debtFree' || !g.expectedYear) continue;
      list.push({ year: g.expectedYear, label: `Goal reached: ${g.title}`, short: g.goal.name || g.title.replace(/ by \d{4}$/, ''), kind: 'goal', goal: g.goal });
    }
    return list.sort((a, b) => a.year - b.year);
  }

  // Every goal has its own colour (a fixed palette slot) and an icon badge.
  const goalColor = g => SERIES_COLORS[g && g.color >= 0 ? g.color % 8 : 0];
  const ICON_GLYPH = { retire: 'retire', shield: 'shield', debt: 'debt', goal: 'goal', piggy: 'piggy', sp: 'sp', star: 'fi', home: 'home', cap: 'cap', gift: 'gift', heart: 'heart' };
  function goalBadge(g, size) {
    return h('span', { class: `goal-badge${size ? ` ${size}` : ''}`, style: `--gc:${cssVar(goalColor(g))}`, 'aria-hidden': 'true' }, glyph(ICON_GLYPH[g.icon] || 'goal'));
  }
  function nextGoalColour() {
    const used = new Set(plan().goals.map(g => g.color));
    for (let c = 0; c < 8; c++) if (!used.has(c)) return c;
    return plan().goals.length % 8;
  }

  function ring(fraction, label) {
    const r = 46, c = 2 * Math.PI * r, f = Math.max(0, Math.min(1, fraction));
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 112 112');
    svg.setAttribute('class', 'ring');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', label);
    svg.innerHTML = `<circle cx="56" cy="56" r="${r}" class="ring-track"/><circle cx="56" cy="56" r="${r}" class="ring-fill" stroke-dasharray="${c}" stroke-dashoffset="${c * (1 - f)}" transform="rotate(-90 56 56)"/>`;
    return svg;
  }

  // ---- dates: the plan's figures are "as at" a date; estimates move them on to any other

  const fmtDate = s => { const d = new Date(`${s}T12:00:00`); return Number.isNaN(+d) ? s : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }); };
  const asOf = () => E.asOfDate(plan());
  // Every account's estimated value today (from the figures date, or a reading since).
  const estimateToday = () => model.est;
  const sinceText = days => (days <= 0 ? 'today' : days === 1 ? 'yesterday' : days < 60 ? `${days} days ago` : `${Math.round(days / 30.4)} months ago`);
  const daysSince = d => Math.round((Date.parse(today()) - Date.parse(d)) / 864e5);

  // ---- home: your portfolio today

  const PF_GROUPS = [
    { key: 'cash', label: 'Cash', color: '--s1' },
    { key: 'isa', label: 'ISAs', color: '--s2' },
    { key: 'gia', label: 'General investment', color: '--s3' },
    { key: 'pension', label: 'Pensions', color: '--s4' },
    { key: 'bonds', label: 'Bonds & gilts', color: '--s5' },
    { key: 'property', label: 'Property', color: '--s6' },
    { key: 'debt', label: 'Mortgage & loans', color: '--s8' },
  ];

  // Types whose accounts are shown on Home (collapsed by default).
  const pfOpen = new Set();

  function renderPortfolio() {
    const p = plan();
    const est = estimateToday();
    const box = $('#homePortfolio');
    // The last update: the figures date, or the latest balance read since.
    const lastUpdate = [est.asOf, ...Object.values(est.reading).map(r => r.date)].sort().pop();
    const delta = lastUpdate < today() ? est.netWorth - RV.estimateAt(p, lastUpdate, model.proj).netWorth : null;
    const assets = PF_GROUPS.filter(g => g.key !== 'debt' && est.byType[g.key] > 0.5);
    const totalAssets = assets.reduce((s, g) => s + est.byType[g.key], 0);
    const debt = est.byType.debt || 0;
    const scale = Math.max(1, totalAssets);
    const bar = h('div', { class: 'pf-bar', role: 'img', 'aria-label': `Assets ${money(totalAssets)}, owed ${money(debt)}` },
      h('div', { class: 'pf-track' }, assets.map(g => h('span', { style: `width:${(est.byType[g.key] / scale) * 100}%;--key:${cssVar(g.color)}`, title: `${g.label}: ${money(est.byType[g.key])}` }))),
      debt > 0.5 ? h('div', { class: 'pf-track owed' }, h('span', { style: `width:${Math.min(100, (debt / scale) * 100)}%;--key:${cssVar('--s8')}`, title: `Mortgage & loans: ${money(debt)}` })) : null);
    // Accounts under a header for each type (its colour matches the bar above, with its subtotal).
    const typeOf = a => (a.type === 'lisa' ? 'isa' : a.type);
    const owner = a => (a.owner === 'joint' ? 'Joint' : (people()[E.personIndex(p, a.owner)] || {}).name || '');
    const signed = (v, debtish) => `${debtish ? '−' : ''}${money(v)}`;
    const changeTag = (change, debtish) => (Math.abs(change) >= 1 ? h('small', { class: (change > 0) !== debtish ? 'pos' : 'neg' }, `${change > 0 ? '+' : '−'}${money(Math.abs(change))}`) : null);
    const groups = PF_GROUPS.map(g => ({ ...g, accounts: p.accounts.filter(a => typeOf(a) === g.key) })).filter(g => g.accounts.length);
    const list = h('div', { class: 'pf-list', role: 'table', 'aria-label': 'Accounts, estimated today' },
      h('div', { class: 'pf-row head', role: 'row' }, h('span', { role: 'columnheader' }, 'Account'), h('span', { role: 'columnheader' }, `On ${fmtDate(est.asOf)}`),
        h('span', { role: 'columnheader' }, daysSince(est.asOf) <= 0 ? 'Today' : 'Today (estimated)')),
      groups.map(g => {
        const debtish = g.key === 'debt';
        const counted = g.accounts.filter(a => !a.excluded);
        const was = counted.reduce((acc, a) => acc + a.balance, 0);
        const now = counted.reduce((acc, a) => acc + est.byId[a.id], 0);
        const updated = r => (r ? h('span', { class: 'src updated', title: `You entered ${money(r.value)} on ${fmtDate(r.date)}${r.date < today() ? '; moved on since as the plan expects' : ''}.` }, glyph('good'), r.date === today() ? 'Updated today' : `Updated ${fmtDate(r.date)}`) : null);
        // A type with one account is a single row: the type, with the account named under it.
        if (g.accounts.length === 1) {
          const a = g.accounts[0];
          return h('div', { class: `pf-row group single${a.excluded ? ' excluded' : ''}`, role: 'row', 'data-account': a.id, style: `--item-color:${cssVar(g.color)}` },
            h('span', { class: 'pf-name', role: 'cell' }, h('i', { class: 'key square', style: `--key:${cssVar(g.color)}` }),
              h('span', { class: 'pf-two' }, h('span', {}, h('strong', {}, g.label), updated(est.reading[a.id])),
                h('small', {}, [a.name, owner(a), a.type === 'lisa' ? 'Lifetime ISA' : '', a.excluded ? 'not counted' : ''].filter(Boolean).join(' · ')))),
            h('span', { class: 'pf-was', role: 'cell' }, signed(a.balance, debtish)),
            h('span', { class: 'pf-now', role: 'cell' }, h('strong', {}, signed(est.byId[a.id], debtish)), changeTag(est.byId[a.id] - a.balance, debtish)));
        }
        const open = pfOpen.has(g.key);
        const nUpdated = g.accounts.filter(a => est.reading[a.id]).length;
        const toggle = () => { if (open) pfOpen.delete(g.key); else pfOpen.add(g.key); renderPortfolio(); };
        return [
          h('div', { class: `pf-row group${open ? ' open' : ''}`, role: 'row', style: `--item-color:${cssVar(g.color)}` },
            h('span', { class: 'pf-name', role: 'cell' }, h('i', { class: 'key square', style: `--key:${cssVar(g.color)}` }), h('strong', {}, g.label),
              h('button', { type: 'button', class: 'pf-toggle', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} the ${g.accounts.length} ${g.label} accounts`, onclick: toggle },
                `${g.accounts.length} accounts`, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸')),
              nUpdated ? h('span', { class: 'src updated' }, glyph('good'), `${nUpdated} updated`) : null),
            h('span', { class: 'pf-was', role: 'cell' }, signed(was, debtish)),
            h('span', { class: 'pf-now', role: 'cell' }, h('strong', {}, signed(now, debtish)), changeTag(now - was, debtish))),
          g.accounts.map(a => {
            const v = est.byId[a.id];
            const r = est.reading[a.id];
            return h('div', { class: `pf-row acct${a.excluded ? ' excluded' : ''}`, role: 'row', 'data-account': a.id, hidden: !open },
              h('span', { class: 'pf-name', role: 'cell' }, h('span', {}, a.name, updated(r)),
                h('small', {}, [owner(a), a.type === 'lisa' ? 'Lifetime ISA' : '', a.excluded ? 'not counted' : ''].filter(Boolean).join(' · '))),
              h('span', { class: 'pf-was', role: 'cell' }, signed(a.balance, debtish)),
              h('span', { class: 'pf-now', role: 'cell' }, signed(v, debtish), changeTag(v - a.balance, debtish)));
          }),
        ];
      }));
    const readings = Object.keys(est.reading).length;
    const days = daysSince(est.asOf);
    setKids(box, ...[
      h('div', { class: 'card-head' },
        h('div', {}, h('p', { class: 'eyebrow' }, `Today · ${agesAt(0)}`), h('h2', { id: 'pfTitle' }, 'Your portfolio'),
          h('p', { class: 'sub' }, days > 0
            ? `Estimated for today from your figures as at ${fmtDate(est.asOf)} (${sinceText(days)}), on average returns${readings ? `, with ${readings} balance${readings === 1 ? '' : 's'} you updated since` : ''}.`
            : `Your figures as at ${fmtDate(est.asOf)}. From here Horizon estimates each balance until your next review.`))),
      h('div', { class: 'pf-top' },
        h('div', { class: 'pf-total' },
          h('div', { class: 'hero-label' }, 'Estimated net worth today'),
          h('div', { class: 'hero-value' }, money(est.netWorth)),
          delta == null
            ? h('div', { class: 'delta flat' }, glyph('good'), 'Updated today')
            : h('div', { class: `delta ${delta >= 0 ? 'pos' : 'neg'}` }, glyph(delta >= 0 ? 'trend' : 'trend-down'), `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))} since your last update (${fmtDate(lastUpdate)})`)),
        h('div', { class: 'pf-mix' }, bar)),
      list,
      readings ? h('p', { class: 'hint' }, `Your goals still use the figures from ${fmtDate(est.asOf)}; the balances you updated feed into your next yearly review.`) : null,
    ].filter(Boolean));
  }

  // ---- home: this year (what to do now and what is coming)

  // ---- what to do this year for a goal: the monthly amounts that keep it on course

  function goalActions(res) {
    const g = res.goal;
    const p = plan();
    const m = model.monthly;
    const pre = model.proj.pre;
    const r0 = model.proj.rows[0];
    const out = [];
    const add = (label, value, note, main) => out.push({ label, value, note, main: !!main });
    const pensionsCount = g.type === 'retire' || (g.type === 'netWorth' && (g.measure === 'all' || g.measure === 'liquid')) || (g.type === 'passiveIncome' && g.includePensions);
    const investing = () => {
      if (m.shortfall > 0) { add('Drawing from savings', `${money(m.shortfall)} a month`, 'Spending is higher than income this year, so this comes out of savings.', true); return; }
      const parts = [m.lisa > 0.5 && `${money(m.lisa)} into Lifetime ISAs (+25% bonus)`, m.isa > 0.5 && `${money(m.isa)} into ISAs`, m.gia > 0.5 && `${money(m.gia)} into the general investment account`].filter(Boolean);
      add('Invest', `${money(m.invest)} a month`, parts.length ? parts.join(', ') : 'Nothing left over to invest this year.', true);
    };
    // Each person's workplace pension this year, in pounds even when set as a % of salary.
    const pensions = () => {
      people().forEach((person, i) => {
        let ee = 0, er = 0;
        for (const it of p.income) {
          if (it.kind !== 'salary' || it.owner !== person.id) continue;
          const v = E.incomeAfterCosts(it, p, 0, pre.econ);
          if (v <= 0) continue;
          const [a, b] = E.pensionContrib(it, v, p, 0, pre.econ);
          ee += a; er += b;
        }
        const extra = pre.people[i].extraPot[0];
        if (ee + er + extra > 0.5) {
          add(`${person.name}’s pension`, `${money((ee + er + extra) / 12)} a month`,
            [`you ${money(ee / 12)}`, `employer ${money(er / 12)}`, extra > 0.5 ? `extra ${money(extra / 12)} with tax relief` : ''].filter(Boolean).join(' + ') + '. Check your payslip matches.');
        }
        for (const db of p.income.filter(it => it.kind === 'dbpension' && it.owner === person.id && person.retireAge > person.age)) {
          add(db.name, `+${money(db.dbAccrual)} a year of pension`, `Each year ${person.name} works adds this (today’s money), paid from ${db.startAge}. Nothing to do but check the annual statement.`);
        }
      });
    };
    if (g.type === 'netWorth' || g.type === 'passiveIncome') {
      investing();
      if (pensionsCount && m.pension > 0.5) add('Pensions', `${money(m.pension)} a month`, 'Through payroll; they count towards this goal.');
      if (m.overpay > 0.5 && (g.measure === 'all' || g.measure === 'noPension')) add('Overpay the mortgage', `${money(m.overpay)} a month`, 'Less debt counts towards net worth too.');
    } else if (g.type === 'retire') {
      pensions();
      investing();
      if (out.length && !out.some(x => x.main)) out[0].main = true;
    } else if (g.type === 'debtFree') {
      add('Mortgage payments', `${money((r0.debtRegular || 0) / 12)} a month`, 'Your regular payments.', true);
      add('Overpay', m.overpay > 0.5 ? `${money(m.overpay)} a month` : 'Nothing planned', m.overpay > 0.5 ? 'From the money left over each month.' : 'Overpaying clears it sooner: try it on this tab’s levers.');
      for (const d of p.accounts.filter(a => a.type === 'debt' && !a.excluded && a.fixedUntil && a.fixedUntil <= p.startYear + 1 && a.fixedUntil >= p.startYear)) {
        add('Remortgage', `fix ends ${d.fixedUntil}`, `${d.name}: compare deals a few months before. The plan assumes ${d.rateAfterFix == null ? `the same ${d.rate}%` : `${d.rateAfterFix}%`} after.`);
      }
    } else if (g.type === 'emergency') {
      const have = E.emergencyHave(g, r0), need = res.need || 0;
      if (have >= need - 0.5) add('Covered', money(need), `${g.months} months of spending and mortgage payments. Keep it ${g.counts === 'investments' ? 'in cash, ISAs or investments' : 'in easy-access cash'}.`, true);
      else add('Top up', m.cash > 0.5 ? `${money(m.cash)} a month` : `${money(need - have)} short`, `To reach ${money(need)} (${g.months} months); you have ${money(have)}.`, true);
    }
    return out;
  }

  // The goal's tab: a "This year" card.
  function goalYearCard(res) {
    const acts = goalActions(res);
    if (!acts.length) return null;
    return h('section', { class: 'card goal-year', id: 'gpYear', style: `--gc:${cssVar(goalColor(res.goal))}` },
      h('h2', {}, `This year for this goal (${plan().startYear})`),
      h('ul', { class: 'year-acts' }, acts.map(a => h('li', { class: a.main ? 'main' : '' },
        h('span', { class: 'ya-label' }, a.label), h('strong', {}, a.value), a.note ? h('small', {}, a.note) : null))));
  }


  function renderTimeline() {
    const p = plan();
    const list = allMilestones();
    const due = RV.due(ws);
    const nextReview = due.due ? new Date().getFullYear() : due.next;
    list.push({ year: nextReview, label: `Yearly review (October ${nextReview})`, kind: 'review', sortFirst: true });
    list.sort((a, b) => a.year - b.year || (b.sortFirst ? 1 : 0) - (a.sortFirst ? 1 : 0));
    setKids($('#ovMilestones'), ...list.map(m => {
      const t = tIndexOfYear(m.year);
      const yrs = m.year - p.startYear;
      return h('li', { class: `tl-item ${m.kind}`, style: `--mc:${cssVar(m.goal ? goalColor(m.goal) : MILESTONE_COLOR[m.kind] || '--muted')}` },
        h('span', { class: 'tl-dot' }, glyph(m.goal ? ICON_GLYPH[m.goal.icon] || 'goal' : m.kind)),
        h('div', { class: 'tl-body' },
          h('div', { class: 'tl-top' }, h('span', { class: 'tl-year' }, String(m.year)), h('span', { class: 'tl-when' }, yrs <= 0 ? 'this year' : `in ${yrs} year${yrs === 1 ? '' : 's'}`)),
          h('div', { class: 'tl-label' }, m.label),
          m.kind !== 'review' ? h('div', { class: 'tl-ages' }, agesAt(t)) : null));
    }));
  }

  const ACTION_LABEL = { life: 'Future costs', strategy: 'Saving strategy', explorer: 'Try changes', accounts: 'Accounts', spending: 'Spending check-up', review: 'Start review', emergency: 'Add a goal' };
  let insightsAll = false;
  let insightsHidden = false;

  function insightAction(a) {
    if (a === 'life') return openLifeWizard();
    if (a === 'spending') return openWizard();
    if (a === 'review') return openReview();
    if (a === 'emergency') return openGoalWizard(null, 'emergency');
    if (a === 'explorer') { navigate('scenarios'); requestAnimationFrame(() => $('#explorer').scrollIntoView({ behavior: 'smooth', block: 'start' })); return; }
    navigate(a === 'accounts' ? 'finances/portfolio' : 'finances/assumptions');
    requestAnimationFrame(() => { const sec = $(`#sec-${a}`); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  function renderInsights() {
    const hidden = new Set(ws.dismissed);
    const every = B.insights(plan(), model.proj);
    const all = every.filter(i => !hidden.has(i.id));
    const gone = every.filter(i => hidden.has(i.id));
    const shown = insightsAll ? all : all.slice(0, 4);
    const toneLabel = { warn: 'Needs attention', tip: 'Tip', good: 'Looks good', info: 'For information' };
    const setHidden = (id, on) => {
      ws.dismissed = on ? [...new Set(ws.dismissed.concat([id]))] : ws.dismissed.filter(x => x !== id);
      save();
      renderInsights();
    };
    setKids($('#ovInsights'), ...[
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Worth a look'),
        h('p', { class: 'sub' }, `A quick check against common UK rules of thumb and ${R.TAX_YEAR} rules. A starting point for your own research, not financial advice.`))),
      h('ul', { class: 'insights' }, shown.map(i => h('li', { class: `insight ${i.tone}`, 'data-insight': i.id },
        h('span', { class: 'ins-ico' }, glyph(i.tone)),
        h('div', { class: 'ins-body' }, h('span', { class: 'sr-only' }, `${toneLabel[i.tone]}: `), h('strong', {}, i.title), h('p', {}, i.text)),
        h('div', { class: 'ins-actions' },
          i.action ? h('button', { type: 'button', class: 'btn small', onclick: () => insightAction(i.action) }, ACTION_LABEL[i.action]) : null,
          i.tone !== 'good' ? h('button', { type: 'button', class: 'btn small ghost', title: 'Already doing this, or not relevant: hide it', 'aria-label': `Hide: ${i.title}`, onclick: () => setHidden(i.id, true) }, 'Already sorted') : null)))),
      h('div', { class: 'add-row' },
        all.length > 4 ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { insightsAll = !insightsAll; renderInsights(); } }, insightsAll ? 'Show fewer' : `Show all ${all.length}`) : null,
        gone.length ? h('button', { type: 'button', class: 'btn small ghost', 'aria-expanded': String(insightsHidden), onclick: () => { insightsHidden = !insightsHidden; renderInsights(); } }, insightsHidden ? 'Hide sorted items' : `${gone.length} marked as sorted`) : null),
      insightsHidden && gone.length ? h('ul', { class: 'insights sorted' }, gone.map(i => h('li', { class: 'insight sorted' },
        h('span', { class: 'ins-ico' }, glyph('good')),
        h('div', { class: 'ins-body' }, h('strong', {}, i.title), h('p', {}, i.text)),
        h('div', { class: 'ins-actions' }, h('button', { type: 'button', class: 'btn small ghost', onclick: () => setHidden(i.id, false) }, 'Show again'))))) : null].filter(Boolean));
  }

  // The projection by account type, with goal markers (home page).
  function renderHomeChart() {
    const rows = model.proj.rows;
    const xs = model.proj.pre.years;
    const col = key => rows.map((r, t) => D(r[key], t));
    const bars = ACCOUNT_SERIES.map(s => ({ ...s, values: col(s.key) })).filter(s => s.values.some(v => v > 0.5));
    if (rows.some(r => r.debt > 0.5)) bars.push({ key: 'debt', label: 'Mortgage & loans', color: '--s8', values: rows.map((r, t) => -D(r.debt, t)) });
    if (rows.some(r => r.shortfall > 0.5)) bars.push({ key: 'short', label: 'Unfunded spending', color: '--muted', values: rows.map((r, t) => -D(r.shortfall, t)) });
    const nw = col('netWorth');
    const markers = [];
    const seen = new Set();
    for (const m of allMilestones()) {
      if (!['retire', 'debt', 'goal'].includes(m.kind) || seen.has(m.kind + m.year)) continue;
      seen.add(m.kind + m.year);
      markers.push({ x: m.year, label: m.kind === 'goal' ? m.short : m.label, color: m.goal ? goalColor(m.goal) : MILESTONE_COLOR[m.kind] });
    }
    const hg = model.goals.find(g => g.goal.type === 'netWorth' && g.goal.measure === 'all' && (g.goal.basis === 'real') === real());
    const refLines = hg ? [{ y: hg.goal.amount, label: `${fmtCompact(hg.goal.amount)} goal` }] : [];
    const ovCols = ['cash', 'isa', 'gia', 'pension', 'bonds', 'property'];
    chart('ovChart', 320, 'Net worth by account type over time').set({
      xs, areas: bars, markers, refLines,
      lines: [{ label: 'Net worth', color: '--text', values: nw }],
      tooltip: i => ({
        title: titleAt(i),
        rows: [
          ...bars.slice().reverse().filter(b => Math.abs(b.values[i]) > 0.5).map(b => ({ label: b.label, color: b.color, text: money(b.values[i]) })),
          { label: 'Net worth', color: '--text', shape: 'line', text: money(nw[i]), strong: true },
        ],
      }),
      table: () => ({
        headers: ['Year', 'Ages', 'Cash', 'ISAs', 'GIA', 'Pensions', 'Bonds', 'Property', 'Debt', 'Net worth'],
        rows: rows.map((r, t) => [r.year, r.ages.join(' / '), ...ovCols.map(k => D(r[k], t)), -D(r.debt, t), D(r.netWorth, t)]),
        formats: [String, String, money, money, money, money, money, money, money, money],
      }),
    });
    $('#ovChartSub').textContent = `Net worth by account type on average returns, from your figures as at ${fmtDate(asOf())}, in ${unitLabel()}. Hover a year, click the legend to hide a series, or switch to Table for every number.`;
    legend($('#ovLegend'), [...bars.map(b => ({ label: b.label, color: b.color })), { label: 'Net worth', color: '--text', shape: 'line' }], charts.ovChart);
  }

  function renderHome() {
    renderPortfolio();
    renderGoalStrip();
    renderHomeChart();
    renderInsights();
  }

  // ---- goals on the Overview: one tile each, in the goal's colour

  // How far along an amount-type goal is today.
  function goalProgress(res) {
    const g = res.goal, r0 = model.proj.rows[0];
    if (g.type === 'netWorth') return { cur: E.goalValue(r0, g.measure), target: g.amount };
    if (g.type === 'passiveIncome') return { cur: E.passiveIncome(r0, E.nonWorkIncome(model.proj.pre, 0), g), target: g.amount, perYear: true };
    if (g.type === 'emergency') return { cur: E.emergencyHave(g, r0), target: res.need || 0 };
    return null;
  }

  function goalWhen(res) {
    const g = res.goal;
    if (g.type === 'retire') return `Retire ${res.expectedYear}`;
    if (g.type === 'debtFree') return res.expectedYear ? `Paid off ${res.expectedYear}` : 'Not paid off in the plan';
    if (g.type === 'emergency') return res.expectedYear ? `Covered from ${res.expectedYear}` : 'Not covered yet';
    return res.expectedYear ? `Expected ${res.expectedYear}` : 'Not reached on average';
  }

  function driverLine(goalId) {
    const d = driverSummary(goalId);
    if (!d) return h('p', { class: 'gt-driver muted' }, 'Working out what moves it…');
    const fmt = x => `${x.d > 0 ? '+' : '−'}${Math.abs(Math.round(x.d * 100))} pts`;
    return h('p', { class: 'gt-driver' },
      d.help ? [h('span', { class: 'drv-k up' }, '▲'), `${d.help.label} `, h('strong', {}, fmt(d.help))] : h('span', { class: 'muted' }, 'Already as likely as it gets.'),
      d.risk ? [h('br'), h('span', { class: 'drv-k down' }, '▼'), `${d.risk.label} `, h('strong', {}, fmt(d.risk))] : null);
  }

  function renderGoalStrip() {
    const box = $('#ovGoalStrip');
    if (!model.goals.length) { setKids(box, goalEmpty()); return; }
    setKids(box, ...model.goals.map(res => {
      const g = res.goal;
      const st = goalStatus(res.probability);
      const prog = goalProgress(res);
      const open = () => navigate(`goal/${g.id}`);
      return h('article', {
        class: 'goal-tile', style: `--gc:${cssVar(goalColor(g))}`, 'data-goal': g.id, tabindex: '0', role: 'button',
        'aria-label': `${res.title}: ${pct(res.probability)} chance. Open its page.`,
        onclick: open, onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
      },
      h('div', { class: 'gt-head' }, goalBadge(g),
        h('div', { class: 'gt-names' }, h('strong', {}, res.title), h('span', {}, g.name ? E.autoTitle(g, plan()) : GOAL_TYPE_LABEL[g.type]))),
      h('div', { class: 'gt-body' },
        h('div', { class: 'ring-wrap small' }, ring(res.probability, `${pct(res.probability)} chance`), h('span', { class: 'ring-centre' }, pct(res.probability))),
        h('div', { class: 'gt-facts' }, badge(st), h('span', { class: 'gt-when' }, goalWhen(res)),
          prog && prog.target > 0 ? h('div', { class: 'gt-progress' },
            h('div', { class: 'gt-bar', role: 'img', 'aria-label': `${pct(Math.min(1, prog.cur / prog.target))} of the target today` }, h('span', { style: `width:${Math.min(100, (prog.cur / prog.target) * 100)}%` })),
            h('span', {}, `${fmtCompact(prog.cur)} of ${fmtCompact(prog.target)}${prog.perYear ? ' a year' : ''} today`)) : null)),
      (() => { const a = goalActions(res).find(x => x.main); return a ? h('p', { class: 'gt-action' }, h('span', {}, 'This year'), h('strong', {}, `${a.label} ${a.value}`)) : null; })(),
      driverLine(g.id));
    }), h('button', { type: 'button', class: 'goal-tile add', onclick: () => openGoalWizard() }, h('span', { class: 'plus' }, '+'), h('span', {}, 'Add a goal')));
  }

  // ---- what moves your goals: each typical change simulated against every goal

  let drivers = { key: null, base: null, rows: [], done: false, token: 0 };
  let driverTimer = null;
  const driversKey = () => `${JSON.stringify(plan())}|${ws.settings.seed}`;

  function scheduleDrivers() {
    clearTimeout(driverTimer);
    if (!['home', 'goal'].includes(route.tab)) return;
    if (drivers.done && drivers.key === driversKey()) return;
    driverTimer = setTimeout(computeDrivers, 600);
  }

  function computeDrivers() {
    const key = driversKey();
    const p = E.clonePlan(plan());
    const list = SI.driversFor(p);
    const token = drivers.token + 1;
    drivers = { key, base: null, rows: [], done: false, token };
    const evalP = q => E.evaluateGoals(q, E.project(q), E.monteCarlo(q, DRIVER_RUNS, ws.settings.seed), { runs: DRIVER_RUNS, seed: ws.settings.seed });
    let i = -1;
    const step = () => {
      if (drivers.token !== token) return;
      if (i < 0) drivers.base = evalP(p);
      else drivers.rows.push({ driver: list[i], after: evalP(SI.variantOf(list[i], p)) });
      i++;
      if (i < list.length) setTimeout(step, 0);
      else {
        drivers.done = true;
        if (route.tab === 'home') renderGoalStrip();
        if (route.tab === 'goal') { const res = model.goals.find(x => x.goal.id === route.sub); if (res) renderGoalMoves(res); }
      }
    };
    setTimeout(step, 0);
  }

  const driverDelta = (row, goalId) => {
    const b = drivers.base.find(x => x.goal.id === goalId), a = row.after.find(x => x.goal.id === goalId);
    return a && b ? a.probability - b.probability : 0;
  };

  // The choice that helps a goal most and the change that hurts it most.
  function driverSummary(goalId) {
    if (!drivers.done || drivers.key !== driversKey()) return null;
    let help = null, risk = null;
    const g = plan().goals.find(x => x.id === goalId);
    for (const r of drivers.rows) {
      if (g && !L.driverFits(r.driver.key, g, plan())) continue;
      const d = driverDelta(r, goalId);
      if (r.driver.kind === 'choice' && d >= 0.01 && (!help || d > help.d)) help = { label: r.driver.label, d };
      if (d <= -0.01 && (!risk || d < risk.d)) risk = { label: r.driver.label, d };
    }
    return { help, risk };
  }

  // ------------------------------------------------------------------ goals tab

  const GOAL_TYPE_LABEL = { netWorth: 'Reach an amount', debtFree: 'Mortgage-free', retire: 'Retire', passiveIncome: 'Passive income', emergency: 'Emergency fund' };
  let goalSolve = {};

  function goalEmpty() {
    const quick = (type, label) => h('button', { type: 'button', class: 'btn small', onclick: () => openGoalWizard(null, type) }, label);
    return h('div', { class: 'goal-empty' }, h('p', {}, 'No goals yet. Most people start with one of these:'),
      h('div', { class: 'add-row' }, quick('retire', 'Plan your retirement'), quick('emergency', 'Emergency fund'), quick('debtFree', 'Mortgage-free'), quick('fi', 'Financial independence')));
  }

  // The chance of a goal by year: reached by then, covered that year, or (retirement) still funded.
  const chanceByYear = res => res.byYear || model.mc.fundedByYear;
  const chanceLabel = g => ({ emergency: 'Covered that year', debtFree: 'Mortgage-free by then', retire: 'Money still lasting' }[g.type] || 'Reached by then');

  function goalProgressBar(prog) {
    if (!prog || !(prog.target > 0)) return null;
    return h('div', { class: 'gt-progress' },
      h('div', { class: 'gt-bar', role: 'img', 'aria-label': `${pct(Math.min(1, prog.cur / prog.target))} of the target today` }, h('span', { style: `width:${Math.min(100, (prog.cur / prog.target) * 100)}%` })),
      h('span', {}, `${fmtCompact(prog.cur)} of ${fmtCompact(prog.target)}${prog.perYear ? ' a year' : ''} today`));
  }

  // ---- one goal's own page

  let gp = null;   // { id, values, open, timer }

  function goalTargetText(res) {
    const g = res.goal, p1 = people()[0];
    const basis = g.basis === 'real' ? 'in today’s £' : 'in future £';
    if (g.type === 'netWorth') return `${money(g.amount)} ${basis} by ${g.year}: ${E.GOAL_MEASURES[g.measure].toLowerCase()}`;
    if (g.type === 'passiveIncome') return `${money(g.amount)} a year ${basis} by ${g.year}, at ${g.withdrawalRate}% of investments${g.includePensions ? ' including pensions' : ''}`;
    if (g.type === 'emergency') return `${g.months} months (${money(res.need || 0)} today) by ${g.year}, ${g.counts === 'investments' ? 'counting ISAs and investments' : 'in cash'}`;
    if (g.type === 'debtFree') return `No mortgage or loans left by ${g.year}`;
    return `${p1.name} retires at ${g.age} (${res.expectedYear}), with ${g.confidence}% confidence wanted`;
  }

  function renderGoalPage(id) {
    const box = $('#goalPage');
    const res = model.goals.find(x => x.goal.id === id);
    if (!res) {
      setKids(box, h('section', { class: 'card' }, h('p', {}, 'This goal is not in the current scenario.'),
        h('button', { type: 'button', class: 'btn', onclick: () => navigate('home') }, 'Home')));
      return;
    }
    if (!gp || gp.id !== id) gp = { id, values: null, open: {}, timer: null };
    const g = res.goal;
    const st = goalStatus(res.probability);
    const p = plan();
    const remove = () => {
      if (!confirm(`Remove the goal “${res.title}”?`)) return;
      p.goals = p.goals.filter(x => x.id !== g.id);
      navigate('home');
      refresh();
    };
    const hero = h('section', { class: 'card goal-hero', style: `--gc:${cssVar(goalColor(g))}`, 'data-goal': g.id },
      h('div', { class: 'gh-top' },
        h('span', { class: 'eyebrow' }, 'Goal'),
        h('div', { class: 'controls' },
          h('button', { type: 'button', class: 'btn small', onclick: () => openGoalWizard(g) }, g.type === 'retire' ? 'Edit retirement plan' : 'Edit goal'),
          h('button', { type: 'button', class: 'btn small ghost danger', 'aria-label': `Remove goal ${res.title}`, onclick: remove }, 'Remove'))),
      h('div', { class: 'gh-main' },
        goalBadge(g, 'large'),
        h('div', { class: 'gh-names' }, h('p', { class: 'eyebrow' }, GOAL_TYPE_LABEL[g.type]), h('h2', {}, res.title), h('p', { class: 'sub' }, goalTargetText(res))),
        h('div', { class: 'gh-chance' },
          h('div', { class: 'ring-wrap' }, ring(res.probability, `${pct(res.probability)} chance`), h('span', { class: 'ring-centre goal-pct' }, pct(res.probability))),
          badge(st))),
      h('div', { class: 'gh-facts' },
        h('div', {}, h('span', { class: 'rv-k' }, 'On average returns'), h('strong', {}, goalWhen(res))),
        h('div', {}, h('span', { class: 'rv-k' }, 'Chance'), h('strong', {}, `${pct(res.probability)} ${g.type === 'retire' ? 'the money lasts' : `by ${g.year}`}`)),
        h('div', {}, h('span', { class: 'rv-k' }, 'Measured from'), h('strong', {}, `Your figures as at ${fmtDate(asOf())}`))),
      goalProgressBar(goalProgress(res)),
      h('p', { class: 'note' }, res.summary));

    const track = h('section', { class: 'card', id: 'gpTrack' });
    const chance = h('section', { class: 'card' });
    const hist = h('section', { class: 'card', id: 'gpHistory' }, h('h2', {}, 'If history repeated'), h('p', { class: 'sub working' }, 'Replaying every starting year since 1928…'));
    const moves = h('section', { class: 'card', id: 'gpMoves' });
    const take = h('section', { class: 'card', id: 'gpTake' });
    const levers = h('section', { class: 'card', id: 'gpLevers' });
    const fullHistory = g.type === 'retire' ? h('div') : null;
    setKids(box, ...[hero, goalYearCard(res), track, h('div', { class: 'grid-2' }, chance, hist), g.type === 'retire' ? retireSummary(res) : null, moves, take, levers, fullHistory].filter(Boolean));
    goalTrackChart(track, res);
    goalChanceChart(chance, res);
    renderGoalMoves(res);
    renderGoalTake(res);
    renderGoalLevers(res);
    setTimeout(() => { renderGoalHistory(res); if (fullHistory) renderHistory(fullHistory); }, 30);
  }

  // The goal's own measure over time: its range across simulations, the average-returns
  // path and the target.
  function goalTrackChart(card, res) {
    const g = res.goal;
    const { proj, mc } = model;
    const rows = proj.rows, pre = proj.pre, N = pre.N;
    const col = goalColor(g);
    let bands, expected, target = null, title, sub, len = mc.years.length, marker = { x: g.year, label: 'Target', color: col };
    const tgt = t => D(g.basis === 'real' ? g.amount * rows[t].deflator : g.amount, t);
    if (g.type === 'netWorth' || g.type === 'passiveIncome') {
      bands = mc.goalBands[g.id][view()];
      expected = rows.map((r, t) => D(g.type === 'passiveIncome' ? E.passiveIncome(r, E.nonWorkIncome(pre, t), g) : E.goalValue(r, g.measure), t));
      target = rows.map((r, t) => tgt(t));
      title = g.type === 'passiveIncome' ? 'Passive income it could pay' : E.GOAL_MEASURES[g.measure];
      sub = g.type === 'passiveIncome' ? `${g.withdrawalRate}% of investments a year plus rent, gifts and pensions being paid, a year, in ${unitLabel()}.` : `In ${unitLabel()}. The target line is ${g.basis === 'real' ? 'in today’s money, so in future pounds it rises with prices' : 'in future pounds'}.`;
    } else if (g.type === 'emergency') {
      len = Math.min(len, Math.max(g.year - p0Year() + 6, 12));
      bands = mc.goalBands[g.id][view()];
      expected = rows.map((r, t) => D(E.emergencyHave(g, r), t));
      target = rows.map((r, t) => D(E.emergencyNeed(g, pre, t < N ? r.debtRegular : 0, t), t));
      title = g.counts === 'investments' ? 'Cash and investments against what you need' : 'Cash against what you need';
      sub = `What counts towards the fund, against ${g.months} months of spending and mortgage payments, in ${unitLabel()}.`;
    } else if (g.type === 'debtFree') {
      bands = mc.series.debt[view()];
      expected = rows.map((r, t) => D(r.debt, t));
      title = 'Mortgage and loans still owed';
      sub = `Interest rates vary after any fixed period, so the payoff date varies too. In ${unitLabel()}.`;
    } else {
      bands = mc.series.liquid[view()];
      expected = rows.map((r, t) => D(r.liquid, t));
      marker = { x: p0Year() + retireT(), label: 'Retire', color: col };
      title = 'Savings, investments and pensions';
      sub = `They grow while you work and pay for retirement after. If they run out, retirement fails in that simulation. In ${unitLabel()}.`;
    }
    const cut = a => a.slice(0, len);
    const xs = cut(mc.years);
    const b = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, cut(v)]));
    const cfg = fanConfig(xs, b, { expected: cut(expected), title: titleAt, color: col, band: col, markers: [marker] });
    if (target) {
      const tv = cut(target);
      const tLabel = g.type === 'emergency' ? 'Needed' : 'Target';
      cfg.lines.push({ label: tLabel, color: '--text', values: tv, dash: [2, 3] });
      const baseTip = cfg.tooltip, baseTable = cfg.table;
      cfg.tooltip = i => { const t = baseTip(i); t.rows.push({ label: tLabel, color: '--text', shape: 'dash', text: money(tv[i]) }); return t; };
      cfg.table = () => { const t = baseTable(); t.headers.push(tLabel); t.rows.forEach((r, i) => r.push(tv[i])); t.formats.push(money); return t; };
    }
    const host = h('div', { class: 'chart' });
    const lg = h('div', { class: 'legend' });
    setKids(card, h('h2', {}, 'How it’s tracking'), h('p', { class: 'sub' }, `${title}. ${sub}`), host, lg);
    const c = new Chart(host, { height: 300, label: `${res.title}: range over time`, name: `goal-${g.id}` });
    c.set(cfg);
    legend(lg, [
      { label: 'Median', color: col, shape: 'line' },
      { label: 'Average returns', series: 'Expected', color: '--muted', shape: 'dash' },
      ...(target ? [{ label: g.type === 'emergency' ? 'Needed' : 'Target', color: '--text', shape: 'dash' }] : []),
      { label: 'Middle half of outcomes', color: col, shape: 'band' },
      { label: '10th–90th percentile', color: col, shape: 'band' },
    ], c);
  }

  const p0Year = () => plan().startYear;

  function goalChanceChart(card, res) {
    const g = res.goal;
    const xs = model.mc.years;
    const ys = chanceByYear(res);
    const host = h('div', { class: 'chart' });
    setKids(card, h('h2', {}, g.type === 'retire' ? 'Chance the money lasts, year by year' : g.type === 'emergency' ? 'Chance it is covered, year by year' : 'Chance of reaching it, by year'),
      h('p', { class: 'sub' }, g.type === 'retire' ? 'Share of simulations with money left in each year.' : g.type === 'emergency' ? 'Share of simulations where what counts covers the need that year.' : 'Share of simulations that have reached it by each year.'), host);
    new Chart(host, { height: 200, label: `Chance of ${res.title} by year`, name: `goal-chance-${g.id}` }).set({
      xs, yDomain: [0, 1], yFormat: v => `${Math.round(v * 100)}%`,
      lines: [{ label: chanceLabel(g), color: goalColor(g), values: ys, area: true }],
      markers: g.type === 'retire' ? [{ x: p0Year() + retireT(), label: 'Retire', color: goalColor(g) }] : [{ x: g.year, label: 'Target', color: goalColor(g) }],
      tooltip: i => ({ title: titleAt(i), rows: [{ label: chanceLabel(g), color: goalColor(g), shape: 'line', text: pct(ys[i]) }] }),
    });
  }

  function renderGoalHistory(res) {
    const card = $('#gpHistory');
    const r = historyRuns();
    if (!card || !r) { if (card) card.hidden = true; return; }
    const rate = r.goalRates[res.goal.id] || 0;
    setKids(card, h('h2', {}, 'If history repeated'),
      h('div', { class: 'goal-figure' }, h('span', { class: 'goal-pct big' }, pct(rate)), badge(goalStatus(rate))),
      h('p', { class: 'note' }, `Reached in ${Math.round(rate * r.starts.length)} of ${r.starts.length} starting years since ${r.first}, replaying that period’s real markets with UK inflation. The random simulations give ${pct(res.probability)}.`),
      h('button', { type: 'button', class: 'btn small ghost', onclick: () => { const c = $('#histCard'); if (c && !c.closest('[hidden]')) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); else { navigate('finances/assumptions'); requestAnimationFrame(() => { const x = $('#histCard'); if (x) x.scrollIntoView({ behavior: 'smooth', block: 'start' }); }); } } }, 'See every starting year'));
  }

  // What moves this goal: each typical change, in percentage points.
  function renderGoalMoves(res) {
    const card = $('#gpMoves');
    if (!card) return;
    const head = [h('h2', {}, 'What moves it'), h('p', { class: 'sub' }, 'How much each change that can affect this goal would raise or lower its chance, in percentage points. Choices you control, then risks.')];
    if (!drivers.done || drivers.key !== driversKey()) {
      setKids(card, ...head, h('p', { class: 'sub working' }, `Working it out: each change is simulated across ${DRIVER_RUNS} futures…`));
      scheduleDrivers();
      return;
    }
    const b = drivers.base.find(x => x.goal.id === res.goal.id);
    const rows = drivers.rows.filter(r => L.driverFits(r.driver.key, res.goal, plan())).map(r => {
      const a = r.after.find(x => x.goal.id === res.goal.id);
      return { label: r.driver.label, kind: r.driver.kind, before: b ? b.probability : 0, after: a ? a.probability : 0, pts: Math.round(driverDelta(r, res.goal.id) * 100) };
    });
    const max = Math.max(5, ...rows.map(r => Math.abs(r.pts)));
    const bars = h('div', { class: 'divbars', role: 'list' }, rows.map(r => {
      const w = r.pts === 0 ? 0 : Math.max(0.5, (Math.abs(r.pts) / max) * 50);
      return h('div', { class: 'divbar', role: 'listitem', tabindex: '0', title: `${r.label}: ${pct(r.before)} → ${pct(r.after)}` },
        h('span', { class: 'db-label' }, h('span', { class: `kind ${r.kind}` }, r.kind === 'risk' ? 'Risk' : 'Choice'), r.label),
        h('span', { class: 'db-track' }, h('span', { class: 'db-mid' }), h('span', { class: `db-bar ${r.pts >= 0 ? 'pos' : 'neg'}`, style: `${r.pts >= 0 ? 'left' : 'right'}:50%;width:${w}%` })),
        h('span', { class: `db-val${r.pts === 0 ? ' flat' : ''}` }, r.pts === 0 ? 'No change' : `${r.pts > 0 ? '+' : '−'}${Math.abs(r.pts)} pts`));
    }));
    const tbl = h('div', { class: 'table-wrap' }, table(['Change', 'Chance now', 'With the change', 'Points'], rows.map(r => ({ cells: [r.label, pct(r.before), pct(r.after), { text: `${r.pts > 0 ? '+' : ''}${r.pts}`, cls: r.pts > 0 ? 'pos' : r.pts < 0 ? 'neg' : '' }] }))));
    setKids(card, ...head, viewToggle(bars, tbl),
      h('p', { class: 'hint' }, `${DRIVER_RUNS} simulated futures per change, the same markets for each. Try them for real below.`));
  }

  function renderGoalTake(res) {
    const card = $('#gpTake');
    if (!card) return;
    setKids(card, h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'What would it take?'), h('p', { class: 'sub' }, { debtFree: 'The share of your surplus to overpay to clear it by the target year.', emergency: 'The cash buffer that covers it.', netWorth: 'How much less to spend each month before retirement.', passiveIncome: 'How much less to spend each month before retirement.', retire: 'The earliest you could retire, and what you could spend, at your chosen confidence.' }[res.goal.type])),
      h('button', { type: 'button', class: 'btn small primary', onclick: e => solveGoal(e.currentTarget, res) }, 'Work it out')),
    h('div', { class: 'goal-solve' }, goalSolve[res.goal.id] || null));
  }

  // Levers for this goal, with the effect on every goal (the trade-offs).
  function renderGoalLevers(res) {
    const card = $('#gpLevers');
    if (!card) return;
    const groups = L.groupsForGoal(plan(), res.goal);
    groups.forEach((k, i) => { if (gp.open[k] === undefined) gp.open[k] = i === 0; });
    if (!gp.values) gp.values = L.currentValues(plan());
    const status = h('p', { class: 'sub', id: 'gpStatus', role: 'status' });
    const impact = h('div', { id: 'gpImpact' });
    const apply = h('button', { type: 'button', class: 'btn small primary', id: 'gpApply', onclick: () => applyExplorer(false, gp.values) }, 'Apply to plan');
    const asScen = h('button', { type: 'button', class: 'btn small', id: 'gpScenario', onclick: () => applyExplorer(true, gp.values) }, 'Save as new scenario');
    setKids(card, h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'Try changes'), h('p', { class: 'sub' }, 'Only the levers that can move this goal. Each one moves your other goals too: the table shows the trade-offs. Nothing changes until you apply it.')),
      h('div', { class: 'controls' }, h('button', { type: 'button', class: 'btn small', onclick: () => { gp.values = null; renderGoalLevers(res); } }, 'Reset'), asScen, apply)),
    h('div', { class: 'explorer in-wizard' },
      h('div', { class: 'explorer-levers' }, leverGroups(groups, gp.values, scheduleGoalTry, gp.open, plan(), d => L.leverFits(d, res.goal, plan()))),
      h('div', { class: 'explorer-results' }, status, impact)));
    updateGoalTry();
  }

  function scheduleGoalTry() {
    const st = $('#gpStatus');
    if (st) st.textContent = 'Updating…';
    clearTimeout(gp.timer);
    gp.timer = setTimeout(updateGoalTry, 250);
  }

  function updateGoalTry() {
    if (!gp || !$('#gpImpact')) return;
    const changed = L.changed(plan(), gp.values);
    const before = baseComparison();
    const after = changed.length ? evaluatePlan(L.apply(plan(), gp.values)) : before;
    setKids($('#gpImpact'), impactTable({ before, after }));
    $('#gpStatus').textContent = changed.length
      ? `${changed.length} change${changed.length === 1 ? '' : 's'}: ${changed.map(d => `${d.label} ${fmtLever(d, gp.values[d.key])}`).join(' · ')}.`
      : `Move a slider to compare. ${EXPLORE_RUNS} simulated futures each, same markets for both.`;
    $('#gpApply').disabled = !changed.length;
    $('#gpScenario').disabled = !changed.length;
  }

  function retireSummary(res) {
    const p = plan();
    const s = p.strategy;
    const travel = p.expenses.find(e => e.key === 'life:travel');
    const dbs = p.income.filter(i => i.kind === 'dbpension');
    const item = (k, v) => h('li', {}, h('span', {}, k), h('strong', {}, v));
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Your retirement plan'), h('p', { class: 'sub' }, 'What the chance above assumes. Change it with the retirement questionnaire.')),
        h('button', { type: 'button', class: 'btn small', onclick: () => openGoalWizard(res.goal) }, 'Edit retirement plan')),
      h('ul', { class: 'rq-facts wide' },
        people().map(x => item(`${x.name} retires at`, `${x.retireAge} (${p.startYear + x.retireAge - x.age})`)),
        item('Spending in retirement', s.retireSpending ? `${money(s.retireSpending)} a year (today’s £)` : 'As your spending list'),
        travel ? item('Extra in the early years', `${money(travel.amount)} a year to age ${travel.endAge}`) : null,
        s.slowDownAge ? item('Spending later on', `${s.slowDownPct}% from age ${s.slowDownAge}`) : null,
        people().map(x => item(`${x.name}'s State Pension`, `${money(x.statePension)} a year from ${x.statePensionAge}`)),
        dbs.map(i => item(i.name, `${money(i.amount)} a year built up, paid from ${i.startAge}`))));
  }

  function solveGoal(btn, res) {
    btn.disabled = true;
    btn.textContent = 'Working…';
    setTimeout(() => {
      const p = plan();
      const g = res.goal;
      const conf = g.confidence / 100;
      const apply = (label, fn) => h('button', { type: 'button', class: 'btn small', onclick: () => { fn(); goalSolve = {}; gp = null; renderPlan(); refresh(); } }, label);
      let out;
      if (g.type === 'debtFree') {
        const r = E.solveDebtFree(p, g.year);
        if (r.already) out = h('p', {}, `Your plan already pays the mortgage off by ${g.year} on average returns.`);
        else if (r.overpayPct === null) out = h('p', {}, `Even overpaying with all your surplus doesn't clear it by ${g.year}. Try a one-off overpayment in Try changes below.`);
        else out = h('p', {}, `Overpay with ${r.overpayPct}% of your surplus${r.capNeeded ? ' and remove the 10%-a-year overpayment limit' : ''}. `,
          apply('Apply', () => { p.strategy.overpayPct = r.overpayPct; if (r.capNeeded) p.strategy.overpayCapPct = 0; }));
      } else if (g.type === 'emergency') {
        const r = E.solveEmergency(p, g);
        out = r.already
          ? h('p', {}, g.counts === 'investments'
            ? `Cash and investments (${money(r.have)}) cover ${g.months} months (${money(r.need)}) today. The chance is below 100% only when markets fall at the wrong time.`
            : `Your cash buffer (${money(p.strategy.cashReserve)}) already covers ${g.months} months (${money(r.need)}).`)
          : h('p', {}, `Keep a cash buffer of ${money(r.buffer)} (now ${money(p.strategy.cashReserve)}): ${g.months} months of spending and mortgage payments. It fills from your surplus before anything is invested. `,
            apply('Apply', () => { p.strategy.cashReserve = r.buffer; }));
      } else if (g.type === 'netWorth') {
        const r = E.solveNetWorth(p, g);
        if (r.already) out = h('p', {}, `On average returns you get there by ${g.year} already.`);
        else if (r.spendNowPct === null) out = h('p', {}, 'Not reachable by cutting spending alone. Try retiring later or the stress-test levers.');
        else out = h('p', {}, `Spend about ${money(r.monthlyCut)} a month less before retirement (${Math.round(r.spendNowPct)}% of today's spending). `,
          apply('Apply', () => { p.strategy.spendNowPct = Math.round(r.spendNowPct); }));
      } else {
        const delta = g.age - people()[0].retireAge;
        const earliest = E.solveRetirement(p, conf, 400, ws.settings.seed);
        const spend = E.solveRetirementSpending(p, conf, 300, ws.settings.seed, delta);
        out = h('div', {},
          h('p', {}, earliest.delta === null ? `No retirement age reaches ${g.confidence}% confidence.` : `Earliest retirement at ${g.confidence}% confidence: ${people().map(x => `${x.name} ${x.retireAge + earliest.delta}`).join(', ')}.`),
          spend.amount ? h('p', {}, `Retiring at ${g.age}, you could spend about ${money(spend.amount)} a year (${money(spend.amount / 12)} a month, today's money) at ${g.confidence}% confidence. `,
            apply('Use this spending', () => { p.strategy.retireSpending = spend.amount; for (const x of people()) x.retireAge += delta; })) : null);
      }
      goalSolve[g.id] = out;
      renderGoalTake(res);
    }, 30);
  }

  // ---- lever explorer (shared by the Goals tab and the goal wizard)

  let explorerValues = null;
  let explorerBase = null;
  let explorerTimer = null;

  function fmtLever(d, v) {
    if (d.zeroLabel && ((d.unit === 'money' && v === 0) || (d.unit === 'year' && v < d.min + 1))) return d.zeroLabel;
    if (d.unit === 'money') return money(v);
    if (d.unit === 'pct' || d.unit === 'rate') return `${v}%`;
    if (d.unit === 'pts') return v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} pts`;
    return String(v);
  }

  function leverSlider(d, values, onChange, basePlan = plan()) {
    const base = d.get(basePlan);
    const out = h('output', { class: 'lever-value' }, fmtLever(d, values[d.key]));
    const desc = d.describe ? h('span', { class: 'hint' }, d.describe(values[d.key], plan())) : null;
    const input = h('input', {
      type: 'range', min: d.min, max: d.max, step: d.step, value: values[d.key], 'aria-label': d.label,
      oninput: e => {
        const v = parseFloat(e.target.value);
        values[d.key] = v;
        out.textContent = fmtLever(d, v);
        if (desc) desc.textContent = d.describe(v, plan());
        row.classList.toggle('changed', v !== base);
        onChange();
      },
    });
    const row = h('div', { class: 'lever' + (values[d.key] !== base ? ' changed' : '') },
      h('div', { class: 'lever-top' }, h('span', { class: 'lever-label' }, d.label), out),
      input,
      h('div', { class: 'lever-scale' }, h('span', {}, fmtLever(d, d.min)), h('span', {}, `Plan: ${fmtLever(d, base)}`), h('span', {}, fmtLever(d, d.max))),
      d.hint ? h('span', { class: 'hint' }, d.hint) : null,
      desc);
    return row;
  }

  function leverGroups(groups, values, onChange, openState, basePlan = plan(), fits = null) {
    const defs = L.defs(basePlan).filter(d => !fits || fits(d));
    return groups.filter(gk => defs.some(d => d.group === gk)).map(gk => {
      const det = h('details', { class: 'lever-group', open: !!openState[gk] },
        h('summary', {}, h('span', {}, L.GROUPS[gk].title), h('span', { class: 'sub' }, L.GROUPS[gk].intro)),
        defs.filter(d => d.group === gk).map(d => leverSlider(d, values, onChange, basePlan)));
      det.addEventListener('toggle', () => { openState[gk] = det.open; });
      return det;
    });
  }

  const deltaCell = (before, after, better, fmt) => {
    if (before === after || (before == null && after == null)) return { text: '—', cls: 'muted' };
    if (before == null || after == null) return { text: after == null ? 'Not reached' : 'Now reached', cls: after == null ? 'neg' : 'pos' };
    const good = better(after, before);
    return { text: `${good ? '▲' : '▼'} ${fmt(after, before)}`, cls: good ? 'pos' : 'neg' };
  };

  function impactTable(cmp, labels = ['Your plan', 'With changes']) {
    const { before, after } = cmp;
    const rows = after.goals.map(a => {
      const b = before.goals.find(x => x.goal.id === a.goal.id) || { probability: 0, expectedYear: null };
      const when = r => (r.goal.type === 'retire' ? '' : r.expectedYear ? ` · ${r.expectedYear}` : ' · not reached');
      return {
        cells: [h('span', { class: 'goal-name' }, h('i', { class: 'key dot', style: `--key:${cssVar(goalColor(a.goal))}` }), a.title), `${pct(b.probability)}${when(b)}`, `${pct(a.probability)}${when(a)}`,
          deltaCell(Math.round(b.probability * 100), Math.round(a.probability * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} pts`)],
      };
    });
    const sb = before.summary, sa = after.summary;
    rows.push({ cls: 'sep', cells: ['Chance the money lasts', pct(sb.success), pct(sa.success), deltaCell(Math.round(sb.success * 100), Math.round(sa.success * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} pts`)] });
    rows.push({ cells: [`Net worth at retirement (today's £)`, money(sb.netWorthAtRetire), money(sa.netWorthAtRetire), deltaCell(Math.round(sb.netWorthAtRetire), Math.round(sa.netWorthAtRetire), (x, y) => x > y, (x, y) => money(Math.abs(x - y)))] });
    rows.push({ cells: ['Mortgage-free', sb.debtFree ? String(sb.debtFree) : '—', sa.debtFree ? String(sa.debtFree) : '—', deltaCell(sb.debtFree, sa.debtFree, (x, y) => x < y, (x, y) => `${Math.abs(x - y)} yrs`)] });
    rows.push({ cells: ['Invest each month now', money(sb.monthly.invest), money(sa.monthly.invest), deltaCell(Math.round(sb.monthly.invest), Math.round(sa.monthly.invest), (x, y) => x > y, (x, y) => money(Math.abs(x - y)))] });
    return h('div', { class: 'table-wrap impact' }, table(['', ...labels, 'Change'], rows));
  }

  function baseComparison() {
    if (!explorerBase) {
      const p = plan();
      const proj = E.project(p);
      const mc = E.monteCarlo(p, EXPLORE_RUNS, ws.settings.seed);
      explorerBase = { proj, mc, goals: E.evaluateGoals(p, proj, mc, { runs: EXPLORE_RUNS, seed: ws.settings.seed }), summary: L.summaryOf(p, proj, mc) };
    }
    return explorerBase;
  }

  function evaluatePlan(p) {
    const proj = E.project(p);
    const mc = E.monteCarlo(p, EXPLORE_RUNS, ws.settings.seed);
    return { proj, mc, goals: E.evaluateGoals(p, proj, mc, { runs: EXPLORE_RUNS, seed: ws.settings.seed }), summary: L.summaryOf(p, proj, mc) };
  }

  function applyExplorer(asScenario, values) {
    const next = L.apply(plan(), values);
    if (asScenario) {
      const name = prompt('Name for the new scenario', `${scenario().name} – adjusted`);
      if (!name) return;
      const id = E.uid();
      ws.scenarios.push({ id, name, plan: E.normalizePlan(next) });
      ws.activeId = id;
    } else {
      scenario().plan = E.normalizePlan(next);
    }
    explorerValues = null;
    if (gp) gp.values = null;
    afterScenarioChange();
  }

  // ---- goal wizard

  let gw = null;
  const GW_STEPS = ['Choose a goal', 'Set the target', 'Try changes'];

  function openGoalWizard(existing, presetType) {
    const p = plan();
    const p1 = people()[0];
    gw = {
      step: existing || presetType ? 1 : 0,
      editing: !!existing,
      goal: existing ? { ...existing } : null,
      retire: null,
      setBuffer: false,
      bufferNeeded: 0,
      valuesFresh: false,
      values: L.currentValues(p),
      open: {},
      timer: null,
      defaults: {
        netWorth: { type: 'netWorth', amount: 1000000, measure: 'all', basis: 'nominal', year: p.startYear + 10, age: p1.retireAge, confidence: 80 },
        debtFree: { type: 'debtFree', amount: 0, measure: 'all', basis: 'nominal', year: p.startYear + 10, age: p1.retireAge, confidence: 80 },
        retire: { type: 'retire', amount: 0, measure: 'all', basis: 'nominal', year: p.startYear + (p1.retireAge - p1.age), age: p1.retireAge, confidence: 85 },
        savings: { type: 'netWorth', amount: 40000, measure: 'savings', basis: 'real', year: p.startYear + 10, age: p1.retireAge, confidence: 80 },
        passiveIncome: { type: 'passiveIncome', amount: 30000, measure: 'all', basis: 'real', year: p.startYear + 15, age: p1.retireAge, confidence: 80, withdrawalRate: 4, includePensions: true },
        emergency: { type: 'emergency', amount: 0, months: 6, measure: 'all', basis: 'nominal', year: p.startYear + 2, age: p1.retireAge, confidence: 80 },
        fi: { type: 'netWorth', name: 'Financial independence', icon: 'star', measure: 'liquid', basis: 'real', amount: Math.max(100000, Math.round(25 * p.expenses.reduce((acc, e) => acc + E.streamAt(e, p, 0), 0) / 10000) * 10000), year: p.startYear + 15, age: p1.retireAge, confidence: 80 },
        house: { type: 'netWorth', name: 'House deposit', icon: 'home', measure: 'savings', basis: 'real', amount: 40000, year: p.startYear + 5, age: p1.retireAge, confidence: 80 },
        education: { type: 'netWorth', name: 'University fund', icon: 'cap', measure: 'savings', basis: 'real', amount: 30000, year: p.startYear + 10, age: p1.retireAge, confidence: 80 },
        purchase: { type: 'netWorth', name: 'Big purchase', icon: 'gift', measure: 'savings', basis: 'real', amount: 20000, year: p.startYear + 3, age: p1.retireAge, confidence: 80 },
        legacy: { type: 'netWorth', name: 'Leave an inheritance', icon: 'heart', measure: 'all', basis: 'real', amount: 250000, year: p.startYear + E.horizon(p), age: p1.retireAge, confidence: 80 },
      },
    };
    for (const d of Object.values(gw.defaults)) d.color = nextGoalColour();
    if (presetType) gw.goal = { ...gw.defaults[presetType] };
    if (gw.goal && gw.goal.type === 'retire') initRetire();
    renderGoalWizard();
    $('#goalWiz').showModal();
  }

  // The plan with this wizard's own settings (retirement questionnaire, cash buffer) applied.
  function gwBase() {
    let p = E.clonePlan(plan());
    if (gw.goal && gw.goal.type === 'retire' && gw.retire) p = applyRetire(p);
    if (gw.goal && gw.goal.type === 'emergency' && gw.setBuffer) p.strategy.cashReserve = Math.max(p.strategy.cashReserve, gw.bufferNeeded);
    return p;
  }

  function draftPlan(withLevers) {
    const base = gwBase();
    const p = withLevers ? L.apply(base, gw.values) : base;
    const g = E.normalizeGoal({ ...gw.goal, id: gw.goal.id || 'draft' }, p.startYear, p.household.people[0]);
    p.goals = p.goals.filter(x => x.id !== g.id).concat([g]);
    return { p, g };
  }

  function renderGoalWizard() {
    const total = GW_STEPS.length;
    $('#gwStep').textContent = `Step ${gw.step + 1} of ${total}`;
    $('#gwTitle').textContent = GW_STEPS[gw.step];
    $('#gwBar').style.width = `${((gw.step + 1) / total) * 100}%`;
    $('#gwBack').disabled = gw.step === 0 || (gw.editing && gw.step === 1);
    $('#gwNext').hidden = gw.step === 0;
    $('#gwNext').textContent = gw.step === total - 1 ? 'Save goal' : 'Next';
    $('#gwNote').textContent = '';
    const body = $('#gwBody');
    const p1 = people()[0];

    if (gw.step === 0) {
      $('#gwIntro').textContent = 'Pick the kind of goal. You can have several and see how they pull against each other.';
      const ICON_OF = { retire: 'retire', emergency: 'shield', debtFree: 'debt', netWorth: 'goal', savings: 'piggy', passiveIncome: 'sp', fi: 'star', house: 'home', education: 'cap', purchase: 'gift', legacy: 'heart' };
      const opt = (type, title, text) => h('button', { type: 'button', class: 'goal-option', onclick: () => { gw.goal = { ...gw.defaults[type] }; if (type === 'retire') initRetire(); gw.step = 1; renderGoalWizard(); } },
        h('span', { class: 'goal-option-head' }, goalBadge({ icon: ICON_OF[type], color: gw.defaults[type].color }, 'small'), h('strong', {}, title)), h('span', {}, text));
      setKids(body, h('div', { class: 'goal-options' },
        opt('retire', 'Plan your retirement', 'When you stop, what you want to spend, and how likely the money is to last.'),
        opt('emergency', 'Emergency fund', 'Months of spending kept in cash, or in cash and investments.'),
        opt('debtFree', 'Mortgage-free by a year', 'Overpaying clears it sooner but leaves less to invest.'),
        opt('fi', 'Financial independence', 'Savings and pensions worth 25 years of spending: work becomes optional.'),
        opt('passiveIncome', 'Passive income by a year', 'Enough investments and rent to pay £X a year without working.'),
        opt('savings', 'Save for something', 'A house deposit, university, a car or a wedding: an amount by a year, not counting your home or pensions.'),
        opt('netWorth', 'Reach an amount by a year', 'For example £1M of net worth by 2031, or what you leave to family.')));
      return;
    }

    const g = gw.goal;
    if (gw.step === 1) {
      $('#gwIntro').textContent = 'What exactly are you aiming for?';
      if (g.color === undefined || g.color < 0) g.color = nextGoalColour();
      const ident = identityRow(g);
      const fields = [];
      if (g.type === 'passiveIncome') {
        fields.push(field('Income a year', moneyInputPlain(() => g.amount, v => { g.amount = v; previewGoal(); }, 'Goal amount')));
        fields.push(field('By the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 60, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
        fields.push(field('Measured in', h('select', { onchange: e => { g.basis = e.target.value; previewGoal(); } }, [['real', "Today's £ (after inflation)"], ['nominal', 'Future £']].map(([v, l]) => h('option', { value: v, selected: g.basis === v }, l)))));
        fields.push(field('Safe withdrawal rate', h('div', { class: 'adorn has-suf' }, h('input', { type: 'number', value: g.withdrawalRate, min: 1, max: 10, step: 0.5, oninput: e => { g.withdrawalRate = parseFloat(e.target.value) || 4; previewGoal(); } }), h('span', { class: 'suf' }, '%')), 'Share of investments you could take each year. 4% is a common rule of thumb.'));
        fields.push(h('div', { class: 'field' }, h('span', {}, 'Pensions'), h('label', { class: 'switch' }, h('input', { type: 'checkbox', role: 'switch', checked: g.includePensions, onchange: e => { g.includePensions = e.target.checked; previewGoal(); } }), 'Count pension pots'), h('span', { class: 'hint' }, 'Rent, gifts, pensions being paid and State Pension always count.')));
      } else if (g.type === 'netWorth' && g.measure === 'savings') {
        const quick = [['House deposit', 'home'], ['University fund', 'cap'], ['Big purchase', 'gift'], ['Wedding', 'heart'], ['A year out', 'sp']];
        fields.push(h('div', { class: 'field wide' }, h('span', {}, 'What for'), h('div', { class: 'idea-chips' }, quick.map(([name, iconName]) => h('button', {
          type: 'button', class: `idea-chip${g.name === name ? ' picked' : ''}`, 'aria-pressed': String(g.name === name),
          onclick: () => { g.name = name; g.icon = iconName; renderGoalWizard(); },
        }, h('span', { class: 'idea-ico' }, glyph(ICON_GLYPH[iconName])), h('span', {}, name))))));
        fields.push(field('Amount', moneyInputPlain(() => g.amount, v => { g.amount = v; previewGoal(); }, 'Goal amount'), 'Cash, ISAs, general investments and bonds.'));
        fields.push(field('By the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 60, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
        fields.push(field('Measured in', h('select', { onchange: e => { g.basis = e.target.value; previewGoal(); } }, [['real', "Today's £ (after inflation)"], ['nominal', 'Future £']].map(([v, l]) => h('option', { value: v, selected: g.basis === v }, l)))));
      } else if (g.type === 'netWorth') {
        fields.push(field('Amount', moneyInputPlain(() => g.amount, v => { g.amount = v; previewGoal(); }, 'Goal amount')));
        fields.push(field('By the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 60, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
        fields.push(field('What counts', h('select', { onchange: e => { g.measure = e.target.value; previewGoal(); } }, Object.entries(E.GOAL_MEASURES).map(([v, l]) => h('option', { value: v, selected: g.measure === v }, l)))));
        fields.push(field('Measured in', h('select', { onchange: e => { g.basis = e.target.value; previewGoal(); } }, [['nominal', 'Future £ (like a spreadsheet)'], ['real', "Today's £ (after inflation)"]].map(([v, l]) => h('option', { value: v, selected: g.basis === v }, l)))));
      } else if (g.type === 'emergency') {
        fields.push(field('How many months', h('select', { onchange: e => { g.months = +e.target.value; renderGoalWizard(); } }, [3, 4, 6, 9, 12].map(v => h('option', { value: v, selected: g.months === v }, `${v} months`))), 'Of regular spending plus mortgage payments. 3–6 months is the usual guide.'));
        fields.push(field('By the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 20, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
        if (!g.counts) g.counts = 'cash';
        fields.push(field('What counts', h('select', { 'aria-label': 'What counts', onchange: e => { g.counts = e.target.value; gw.bufferTouched = false; renderGoalWizard(); } },
          [['cash', 'Cash only'], ['investments', 'Cash, ISAs and investments']].map(([v, l]) => h('option', { value: v, selected: g.counts === v }, l))),
          g.counts === 'investments' ? 'Investments can be sold within days but may be down when you need them; the chance below allows for that.' : 'Easy-access cash: there whatever markets do.'));
        const sol = E.solveEmergency(plan(), E.normalizeGoal(g, plan().startYear, p1));
        gw.bufferNeeded = sol.buffer;
        if (!gw.bufferTouched) gw.setBuffer = !sol.already;
        const r0 = model.proj.rows[0];
        setKids(body, ident, h('div', { class: 'fields' }, fields),
          h('div', { class: 'ef-facts' },
            h('div', {}, h('span', { class: 'rv-k' }, `${g.months} months needs`), h('strong', {}, money(sol.need))),
            h('div', {}, h('span', { class: 'rv-k' }, g.counts === 'investments' ? 'Cash and investments today' : 'Cash today'), h('strong', {}, money(sol.have))),
            h('div', {}, h('span', { class: 'rv-k' }, 'Your cash buffer setting'), h('strong', {}, money(plan().strategy.cashReserve))),
            h('p', { class: 'hint' }, `Spending ${money(model.proj.pre.expenses[0] / 12)} plus mortgage ${money((r0.debtRegular || 0) / 12)} a month. Horizon keeps the buffer in cash and invests money above it.`)),
          sol.already ? h('p', { class: 'sub' }, g.counts === 'investments' ? 'What you hold already covers this; the chance shows how often a market fall would leave it short.' : 'Your buffer setting already covers this.')
            : h('div', { class: 'field' }, switchInput(`Set my cash buffer to ${money(sol.buffer)}`, () => gw.setBuffer, v => { gw.setBuffer = v; gw.bufferTouched = true; gw.valuesFresh = false; previewGoal(); }),
              h('span', { class: 'hint' }, 'It fills from your surplus before anything is invested, so it may take a year or two.')),
          h('div', { class: 'gw-preview', id: 'gwPreview' }));
        previewGoal();
        return;
      } else if (g.type === 'debtFree') {
        fields.push(field('Mortgage-free by the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 40, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
      } else {
        $('#gwIntro').textContent = 'A few questions about the retirement you want. Everything updates the preview on the right; nothing changes in your plan until you save.';
        setKids(body, ident, retireQuestions());
        previewRetire();
        return;
      }
      setKids(body, ident, h('div', { class: 'fields' }, fields), h('div', { class: 'gw-preview', id: 'gwPreview' }));
      previewGoal();
      return;
    }

    if (gw.step === 2) {
      $('#gwIntro').textContent = 'The levers that can move this goal. Each one also moves your other goals: the table shows the trade-offs.';
      const base = gwBase();
      const draftGoal = E.normalizeGoal({ ...g, id: g.id || 'draft' }, base.startYear, base.household.people[0]);
      const fits = d => L.leverFits(d, draftGoal, base);
      const groups = L.groupsForGoal(base, draftGoal);
      groups.forEach((k, i) => { if (gw.open[k] === undefined) gw.open[k] = i < 2 && k !== 'stress'; });
      if (!gw.valuesFresh) { gw.values = L.currentValues(base); gw.valuesFresh = true; }
      setKids(body, h('div', { class: 'explorer in-wizard' },
        h('div', { class: 'explorer-levers' }, leverGroups(groups, gw.values, scheduleGoalImpact, gw.open, base, fits)),
        h('div', { class: 'explorer-results' }, h('div', { class: 'gw-save', id: 'gwSave' }), h('p', { class: 'sub', id: 'gwStatus' }), h('div', { id: 'gwImpact' }))));
      updateGoalImpact();
    }
  }

  // What saving does: the plan changes the wizard makes itself, and what to do with any levers tried.
  function renderGoalSave() {
    const box = $('#gwSave');
    if (!box) return;
    const base = gwBase();
    const changed = L.changed(base, gw.values);
    const own = planChanges(plan(), base);
    if (!changed.length) gw.saveMode = 'goal';
    const choice = (mode, label) => h('label', { class: 'gw-choice' },
      h('input', { type: 'radio', name: 'gwSaveMode', value: mode, checked: gw.saveMode === mode, onchange: () => { gw.saveMode = mode; } }), label);
    setKids(box,
      own.length ? h('div', {}, h('p', { class: 'sub' }, 'Saving also updates your plan:'), h('ul', { class: 'change-list' }, own.map(x => h('li', {}, x)))) : null,
      changed.length ? h('div', { class: 'gw-choices' },
        h('p', { class: 'sub' }, 'Changes you tried: ', changed.map(d => `${d.label}: ${fmtLever(d, d.get(plan()))} → ${fmtLever(d, gw.values[d.key])}`).join(' · ')),
        h('div', { role: 'radiogroup', 'aria-label': 'When you save' },
          choice('goal', 'Just save the goal (keep my plan as it is)'),
          choice('apply', 'Save the goal and apply these changes'),
          choice('scenario', 'Save the goal and these changes as a new scenario'))) : null);
  }

  function goalWizardNext() {
    if (gw.step < GW_STEPS.length - 1) { gw.step++; renderGoalWizard(); return; }
    saveGoal(gw.saveMode || 'goal');
  }


  // Name and colour for a goal (any type).
  function identityRow(g) {
    const auto = E.autoTitle(E.normalizeGoal({ ...g, name: '' }, plan().startYear, people()[0]), plan());
    const swatches = SERIES_COLORS.map((c, i) => h('button', {
      type: 'button', class: 'swatch', style: `--sw:${cssVar(c)}`, 'aria-pressed': String(g.color === i), 'aria-label': `Colour ${i + 1}`,
      onclick: e => { g.color = i; for (const b of $$('.swatch', e.currentTarget.parentElement)) b.setAttribute('aria-pressed', String(b === e.currentTarget)); },
    }));
    return h('div', { class: 'goal-identity' },
      h('label', { class: 'field' }, h('span', {}, 'Name (optional)'),
        h('input', { type: 'text', value: g.name || '', placeholder: auto, maxlength: 60, 'aria-label': 'Goal name', oninput: e => { g.name = e.target.value; } })),
      h('div', { class: 'field' }, h('span', {}, 'Colour'), h('div', { class: 'swatches', role: 'group', 'aria-label': 'Goal colour' }, swatches)));
  }

  // ---- retirement questionnaire (inside the goal wizard)

  const plsa = () => (people().length > 1 ? B.PLSA.couple : B.PLSA.single);
  const PLSA_TEXT = {
    minimum: 'Covers all your needs, with some left for fun: a UK holiday and eating out about once a month.',
    moderate: 'More security and flexibility: a fortnight in Europe, eating out a few times a month, helping family.',
    comfortable: 'More freedom and some luxuries: three weeks in Europe, regular treats, theatre trips, a newer car.',
  };

  function initRetire() {
    const p = plan();
    const s = p.strategy;
    const p1 = people()[0];
    const std = plsa();
    const preset = Object.keys(std).find(k => std[k] === s.retireSpending);
    const travel = p.expenses.find(e => e.key === 'life:travel');
    gw.retire = {
      ages: people().map(x => x.retireAge),
      mode: s.retireSpending === 0 ? 'list' : preset || 'custom',
      custom: s.retireSpending || std.moderate,
      travelExtra: travel ? travel.amount : 0,
      travelYears: travel ? Math.max(1, travel.endAge - p1.retireAge) : 10,
      slowDownAge: s.slowDownAge,
      slowDownPct: s.slowDownAge > 0 ? s.slowDownPct : 80,
      statePension: people().map(x => x.statePension),
      answers: null,
    };
    if (gw.goal) gw.goal.age = p1.retireAge;
  }

  function retireSpendingOf(r) {
    return r.mode === 'list' ? 0 : r.mode === 'custom' ? r.custom : plsa()[r.mode];
  }

  function applyRetire(p) {
    const r = gw.retire;
    const pp = p.household.people;
    pp.forEach((x, i) => { x.retireAge = r.ages[i]; x.statePension = r.statePension[i]; });
    p.strategy.retireSpending = retireSpendingOf(r);
    p.strategy.slowDownAge = r.slowDownAge > 0 ? r.slowDownAge : 0;
    p.strategy.slowDownPct = r.slowDownAge > 0 ? r.slowDownPct : 100;
    p.expenses = p.expenses.filter(e => e.key !== 'life:travel');
    if (r.travelExtra > 0 && r.travelYears > 0) {
      p.expenses.push({
        id: 'life:travel', key: 'life:travel', category: 'Life check-up', name: 'Active retirement: travel & hobbies', owner: 'p1',
        amount: r.travelExtra, freq: 'year', inflationLinked: true, growth: 0,
        startRef: 'retire', startAge: pp[0].retireAge, endRef: 'age', endAge: pp[0].retireAge + r.travelYears,
      });
    }
    if (p.life || r.travelExtra > 0 || r.slowDownAge > 0) p.life = { ...(p.life || {}), travelExtra: r.travelExtra, travelYears: r.travelYears, slowDownAge: r.slowDownAge, slowDownPct: r.slowDownPct };
    if (gw.goal) gw.goal.age = r.ages[0];
    return E.normalizePlan(p);
  }

  // What a wizard's own settings change in the plan, in words.
  function planChanges(before, after) {
    const out = [];
    before.household.people.forEach((x, i) => {
      const y = after.household.people[i];
      if (x.retireAge !== y.retireAge) out.push(`${x.name} retires at ${y.retireAge} (was ${x.retireAge})`);
      if (Math.round(x.statePension) !== Math.round(y.statePension)) out.push(`${x.name}'s State Pension ${money(y.statePension)} a year (was ${money(x.statePension)})`);
    });
    const sb = before.strategy, sa = after.strategy;
    const spend = v => (v === 0 ? 'as your spending list' : `${money(v)} a year`);
    if (sb.retireSpending !== sa.retireSpending) out.push(`Spending in retirement ${spend(sa.retireSpending)} (was ${spend(sb.retireSpending)})`);
    if (sb.slowDownAge !== sa.slowDownAge || sb.slowDownPct !== sa.slowDownPct) out.push(sa.slowDownAge ? `Spend ${sa.slowDownPct}% from age ${sa.slowDownAge}` : 'No slow-down later in life');
    const tb = before.expenses.find(e => e.key === 'life:travel'), ta = after.expenses.find(e => e.key === 'life:travel');
    if ((tb && tb.amount) !== (ta && ta.amount) || (tb && tb.endAge) !== (ta && ta.endAge)) out.push(ta ? `Extra ${money(ta.amount)} a year for travel and hobbies in the first ${ta.endAge - after.household.people[0].retireAge} years of retirement` : 'No extra travel budget in retirement');
    if (sb.cashReserve !== sa.cashReserve) out.push(`Cash buffer ${money(sa.cashReserve)} (was ${money(sb.cashReserve)})`);
    return out;
  }

  function retireQuestions() {
    const r = gw.retire;
    const p = plan();
    const p1 = people()[0];
    const changed = () => { gw.valuesFresh = false; r.answers = null; previewRetire(); };
    const sec = (n, title, ...kids) => h('section', { class: 'rq-sec' }, h('h3', {}, h('span', { class: 'rq-n' }, String(n)), title), kids);
    const num = (get, set, opts) => h('div', { class: opts.suffix ? 'adorn has-suf' : '' },
      h('input', { type: 'number', value: get(), min: opts.min, max: opts.max, step: opts.step || 1, 'aria-label': opts.label, oninput: e => { set(parseFloat(e.target.value) || 0); changed(); } }),
      opts.suffix ? h('span', { class: 'suf' }, opts.suffix) : null);
    const moneyIn = (get, set, label) => moneyInputPlain(get, v => { set(v); changed(); }, label);

    // Spending options: the list as it stands at retirement, PLSA standards, or your own.
    const tr = Math.max(0, Math.min(model.proj.pre.N, r.ages[0] - p1.age));
    const listAtRetire = p.expenses.filter(e => !(e.key || '').startsWith('life:')).reduce((acc, e) => acc + E.streamAt(e, p, tr), 0) / Math.pow(1 + p.assumptions.inflation / 100, tr);
    const std = plsa();
    const option = (mode, title, amount, text) => h('button', {
      type: 'button', class: 'spend-option', 'aria-pressed': String(r.mode === mode),
      onclick: e => { r.mode = mode; for (const b of $$('.spend-option', e.currentTarget.parentElement)) b.setAttribute('aria-pressed', String(b === e.currentTarget)); customBox.hidden = mode !== 'custom'; changed(); },
    }, h('strong', {}, title), amount != null ? h('span', { class: 'amt' }, `${money(amount)} a year`, h('small', {}, ` · ${money(amount / 12)} a month`)) : null, h('span', { class: 'txt' }, text));
    const customBox = h('div', { class: 'field', hidden: r.mode !== 'custom' }, h('span', {}, 'Your amount (a year, today’s money)'), moneyIn(() => r.custom, v => { r.custom = v; }, 'Retirement spending'));
    const debtFree = E.debtFreeYear(model.proj);
    const retireYear = p.startYear + (r.ages[0] - p1.age);
    const sps = people().map((x, i) => h('label', { class: 'field' }, h('span', {}, `${x.name} (from ${x.statePensionAge})`), moneyIn(() => r.statePension[i], v => { r.statePension[i] = v; }, `${x.name} State Pension`)));
    const dbs = p.income.filter(i => i.kind === 'dbpension');

    return h('div', { class: 'rq' },
      h('div', { class: 'rq-questions' },
        sec(1, 'When do you want to stop working?',
          h('div', { class: 'fields' }, people().map((x, i) => h('label', { class: 'field' }, h('span', {}, `${x.name} retires at`),
            num(() => r.ages[i], v => { r.ages[i] = Math.round(v); }, { min: x.age, max: 80, suffix: 'years', label: `${x.name} retirement age` })))),
          h('p', { class: 'hint' }, `Pensions can be drawn from ${people().map(x => `${x.pensionAccessAge}`).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}; State Pension from ${people().map(x => `${x.name} ${x.statePensionAge}`).join(', ')}. Retiring before then means living on ISAs and savings.`)),
        sec(2, 'What would you like to spend each year?',
          h('div', { class: 'spend-options' },
            option('list', 'Keep my spending list', listAtRetire, 'What you spend now, minus items that stop before then (like childcare).'),
            option('minimum', 'Minimum', std.minimum, PLSA_TEXT.minimum),
            option('moderate', 'Moderate', std.moderate, PLSA_TEXT.moderate),
            option('comfortable', 'Comfortable', std.comfortable, PLSA_TEXT.comfortable),
            option('custom', 'My own amount', null, 'Type a figure, or use “What could we spend?” on the right.')),
          customBox,
          h('p', { class: 'hint' }, `Minimum, moderate and comfortable are the PLSA Retirement Living Standards 2025 for a ${people().length > 1 ? 'couple' : 'single person'}: after tax, in today’s money, with no mortgage or rent. ${debtFree ? (debtFree <= retireYear ? `Your mortgage is paid off in ${debtFree}, before you retire.` : `Your mortgage runs to ${debtFree}, after you retire: its payments come on top.`) : ''}`)),
        sec(3, 'The active early years',
          h('div', { class: 'fields' },
            h('label', { class: 'field' }, h('span', {}, 'Extra for travel & hobbies (a year)'), moneyIn(() => r.travelExtra, v => { r.travelExtra = v; }, 'Extra travel a year')),
            h('label', { class: 'field' }, h('span', {}, 'For the first'), num(() => r.travelYears, v => { r.travelYears = Math.round(v); }, { min: 0, max: 30, suffix: 'years', label: 'Years of extra travel' }))),
          h('p', { class: 'hint' }, 'Many people spend more in the first ten years or so of retirement.')),
        sec(4, 'Later on',
          h('div', { class: 'fields' },
            h('label', { class: 'field' }, h('span', {}, 'Spend less from age (0 = never)'), num(() => r.slowDownAge, v => { r.slowDownAge = Math.round(v); }, { min: 0, max: 100, label: 'Slow down age' })),
            h('label', { class: 'field' }, h('span', {}, 'Spending from then'), num(() => r.slowDownPct, v => { r.slowDownPct = v; }, { min: 30, max: 150, step: 5, suffix: '%', label: 'Spending later' }))),
          h('p', { class: 'hint' }, 'Spending often falls from the late 70s, though care costs can rise (Finances → Spending → Future costs).')),
        sec(5, 'Pensions you will be paid',
          h('div', { class: 'fields' }, sps),
          h('p', { class: 'hint' }, `Full new State Pension: ${money(R.STATE_PENSION_FULL)} a year. Get your own forecast at gov.uk/check-state-pension.${dbs.length ? ` Also counted: ${dbs.map(i => i.name).join(', ')} (edit in Finances → Income).` : ''}`)),
        sec(6, 'How sure do you want to be?',
          h('div', { class: 'fields' }, h('label', { class: 'field' }, h('span', {}, 'Confidence'),
            h('select', { onchange: e => { gw.goal.confidence = +e.target.value; r.answers = null; previewRetire(); } }, [70, 75, 80, 85, 90, 95].map(v => h('option', { value: v, selected: gw.goal.confidence === v }, `${v}% of simulated futures`))))),
          h('p', { class: 'hint' }, 'The share of simulated markets where the money lasts to the end of the plan.'))),
      h('aside', { class: 'rq-preview', id: 'rqPreview' }, h('p', { class: 'sub' }, 'Working it out…')));
  }

  let rqTimer = null;
  function previewRetire() {
    clearTimeout(rqTimer);
    rqTimer = setTimeout(() => {
      const box = $('#rqPreview');
      if (!box || !gw || !gw.retire) return;
      const r = gw.retire;
      const p = gwBase();
      const p1 = p.household.people[0];
      const proj = E.project(p);
      const mc = E.monteCarlo(p, EXPLORE_RUNS, ws.settings.seed);
      const st = goalStatus(mc.successRate);
      const tr = Math.max(0, Math.min(proj.pre.N, p1.retireAge - p1.age));
      const lastAge = p1.age + proj.pre.N;
      const spend = retireSpendingOf(r);
      const conf = gw.goal.confidence / 100;
      const chartBox = h('div', { class: 'rq-chart' });
      const answers = h('div', { class: 'rq-answers' });
      const showAnswers = () => {
        if (!r.answers) {
          setKids(answers, h('button', { type: 'button', class: 'btn small', onclick: e => {
            e.currentTarget.disabled = true; e.currentTarget.textContent = 'Working…';
            setTimeout(() => {
              const earliest = E.solveRetirement(p, conf, EXPLORE_RUNS, ws.settings.seed);
              const could = E.solveRetirementSpending(p, conf, EXPLORE_RUNS, ws.settings.seed, 0);
              r.answers = { earliest, could };
              showAnswers();
            }, 30);
          } }, 'Earliest age and what we could spend'));
          return;
        }
        const { earliest, could } = r.answers;
        setKids(answers, 
          h('p', {}, earliest.delta === null ? `No retirement age reaches ${gw.goal.confidence}%.` : `Earliest at ${gw.goal.confidence}%: ${p.household.people.map(x => `${x.name} ${x.retireAge + earliest.delta}`).join(', ')}. `,
            earliest.delta !== null && earliest.delta !== 0 ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.ages = r.ages.map(a => a + earliest.delta); renderGoalWizard(); } }, 'Use') : null),
          could.amount ? h('p', {}, `At these ages you could spend about ${money(could.amount)} a year (${money(could.amount / 12)} a month). `,
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.mode = 'custom'; r.custom = could.amount; renderGoalWizard(); } }, 'Use')) : null);
      };
      setKids(box, 
        h('div', { class: 'hero-label' }, 'Chance the money lasts'),
        h('div', { class: 'goal-figure' }, h('span', { class: 'goal-pct big' }, pct(mc.successRate)), badge(st)),
        h('div', { class: 'meter' }, h('span', { style: `width:${mc.successRate * 100}%` })),
        h('ul', { class: 'rq-facts' },
          h('li', {}, h('span', {}, 'Retire in'), h('strong', {}, `${p.startYear + tr} (${p1.name} ${p1.retireAge})`)),
          h('li', {}, h('span', {}, 'Spending a year'), h('strong', {}, spend ? money(spend) : 'As your list')),
          h('li', {}, h('span', {}, 'Saved by then (today’s £)'), h('strong', {}, money(proj.rows[tr].liquid / proj.rows[tr].deflator))),
          h('li', {}, h('span', {}, mc.medianFailYear ? 'If it runs out, typically' : 'Plan runs to'), h('strong', {}, mc.medianFailYear ? `${mc.medianFailYear} (age ${p1.age + mc.medianFailYear - p.startYear})` : `age ${lastAge}`))),
        h('h3', { class: 'chart-title' }, 'Savings, investments and pensions (today’s £)'),
        chartBox,
        answers);
      showAnswers();
      const b = mc.series.liquid.real;
      const c = chartIn(chartBox, 170, 'Range of savings over time', { name: 'retirement-preview' });
      c.set(fanConfig(mc.years, b, { title: i => `${mc.years[i]} · ${p1.name} ${p1.age + i}`, markers: [{ x: p.startYear + tr, label: 'Retire', color: '--s4' }] }));
    }, 300);
  }

  function previewGoal() {
    clearTimeout(gw.timer);
    const box = $('#gwPreview');
    if (!box) return;
    box.textContent = 'Checking…';
    gw.timer = setTimeout(() => {
      const { p, g } = draftPlan(false);
      const proj = E.project(p);
      const mc = E.monteCarlo(p, EXPLORE_RUNS, ws.settings.seed);
      const res = E.evaluateGoals(p, proj, mc, { runs: EXPLORE_RUNS, seed: ws.settings.seed }).find(x => x.goal.id === g.id);
      const st = goalStatus(res.probability);
      setKids(box, h('div', { class: 'goal-figure' }, h('span', { class: 'goal-pct big' }, pct(res.probability)), badge(st)),
        h('p', {}, `${res.title}. ${res.summary}`));
    }, 250);
  }

  function scheduleGoalImpact() {
    const st = $('#gwStatus');
    if (st) st.textContent = 'Updating…';
    clearTimeout(gw.timer);
    gw.timer = setTimeout(updateGoalImpact, 250);
  }

  function updateGoalImpact() {
    const before = (() => { const { p } = draftPlan(false); return evaluatePlan(p); })();
    const changed = L.changed(gwBase(), gw.values);
    const after = changed.length ? (() => { const { p } = draftPlan(true); return evaluatePlan(p); })() : before;
    setKids($('#gwImpact'), impactTable({ before, after }));
    $('#gwStatus').textContent = changed.length ? `${changed.length} change${changed.length === 1 ? '' : 's'} tried.` : 'Move a slider to see the trade-offs, or just save the goal.';
    renderGoalSave();
  }

  function saveGoal(mode) {
    const p = gwBase();
    const g = E.normalizeGoal({ ...gw.goal, id: gw.goal.id || E.uid() }, p.startYear, p.household.people[0]);
    if (mode === 'scenario') {
      const next = L.apply(p, gw.values);
      next.goals = E.assignGoalColours(next.goals.filter(x => x.id !== g.id).concat([g]));
      const id = E.uid();
      ws.scenarios.push({ id, name: `${scenario().name} – ${E.goalTitle(g, next)}`, plan: E.normalizePlan(next) });
      ws.activeId = id;
    } else {
      if (mode === 'apply') scenario().plan = E.normalizePlan(L.apply(p, gw.values));
      else if (planChanges(plan(), p).length) scenario().plan = E.normalizePlan(p);
      const target = plan();
      target.goals = E.assignGoalColours(target.goals.filter(x => x.id !== g.id).concat([g]));
    }
    $('#goalWiz').close();
    goalSolve = {};
    explorerValues = null;
    afterScenarioChange();
    navigate(`goal/${g.id}`);
  }

  // ------------------------------------------------------------------ cash flow

  function renderCashflow() {
    const rows = model.proj.rows.slice(0, -1);
    const xs = rows.map(r => r.year);
    const col = (fn, sign = 1) => rows.map((r, t) => sign * D(fn(r), t));
    const bars = [
      { label: 'Earnings', color: '--s1', values: col(r => r.earnings) },
      { label: 'Other income', color: '--s2', values: col(r => r.otherIncome) },
      { label: 'State Pension', color: '--s3', values: col(r => r.statePension) },
      { label: 'From savings', color: '--s4', values: col(r => r.withdrawals) },
      { label: 'Unfunded', color: '--muted', values: col(r => r.unfunded) },
      { label: 'Spending', color: '--s5', values: col(r => r.spending, -1) },
      { label: 'Tax & NI', color: '--s6', values: col(r => r.taxes, -1) },
      { label: 'Mortgage & loans', color: '--s7', values: col(r => r.debtPay, -1) },
      { label: 'Saving', color: '--s8', values: col(r => r.saved, -1) },
    ].filter(b => b.values.some(v => Math.abs(v) > 0.5));
    const keys = ['earnings', 'otherIncome', 'statePension', 'wCash', 'wGia', 'wIsa', 'wLisa', 'wPension', 'spending', 'taxes', 'pensionRelief', 'debtPay', 'overpay', 'toIsa', 'toLisa', 'lisaBonus', 'toGia', 'pensionIn', 'unfunded'];
    chart('cfChart', 360, 'Money in and out by year').set({
      xs, areas: bars,
      tooltip: i => ({
        title: titleAt(i),
        rows: bars.filter(b => Math.abs(b.values[i]) > 0.5).map(b => ({ label: b.label, color: b.color, text: money(Math.abs(b.values[i])) })),
      }),
      table: () => ({
        headers: ['Year', 'Earnings', 'Other', 'State Pension', 'From cash', 'From GIA', 'From ISA', 'From Lifetime ISA', 'From pension', 'Spending', 'Tax & NI', 'of which pension relief back', 'Mortgage', 'of which overpaid', 'Into ISA', 'Into Lifetime ISA', 'Lifetime ISA bonus', 'Into GIA', 'Into pensions', 'Unfunded'],
        rows: rows.map((r, t) => [r.year, ...keys.map(k => D(r[k], t))]),
        formats: [String, ...keys.map(() => money)],
      }),
    });
    legend($('#cfLegend'), bars.map(b => ({ label: b.label, color: b.color })), charts.cfChart);
  }

  // ------------------------------------------------------------------ simulations: what varies, and replaying history

  // ---- replaying history

  const ERAS = { 1929: 'Wall Street Crash', 1937: '1937 recession', 1966: 'Stagflation era', 1973: 'Oil crisis', 2000: 'Dot-com bust', 2008: 'Financial crisis' };
  let histCache = { key: null, res: null };

  // The plan replayed from every starting year in history (cached per plan).
  function historyRuns() {
    const H = window.HISTORY_DATA;
    if (!H) return null;
    const key = driversKey();
    if (histCache.key !== key) histCache = { key, res: E.historicalRuns(plan(), H) };
    return histCache.res;
  }

  // A full "Replaying history" card in `host` (the retirement goal, or Assumptions).
  function renderHistory(host) {
    const r = historyRuns();
    if (!r) { setKids(host, ); return; }
    const p = plan();
    const p1 = people()[0];
    const ageAt = y => p1.age + (y - p.startYear);
    const fails = r.starts.filter(x => !x.success);
    const worst = r.starts.reduce((a, b) => (b.endReal < a.endReal ? b : a));
    const best = r.starts.reduce((a, b) => (b.endReal > a.endReal ? b : a));
    const era = y => (ERAS[y] ? ` (${ERAS[y]})` : '');
    const barsBox = h('div', { class: 'chart' }), barsLegend = h('div', { class: 'legend' });
    const linesBox = h('div', { class: 'chart' }), linesLegend = h('div', { class: 'legend' });
    setKids(host, h('section', { class: 'card', id: 'histCard' },
      h('h2', {}, 'Replaying history'),
      h('p', { class: 'sub' }, `What if the markets of the past happened again? Your plan is run from every starting year since ${r.first}, using that period’s real share and bond returns (the US market: the longest reliable record) with UK inflation from the same years. ${r.complete} starting years have a full ${r.years.length - 1}-year history; later ones carry on from ${r.first} again. The US did better than most markets over the last century, so this is a kinder test than the random simulations’ bad cases.`),
      h('div', { class: 'tiles', id: 'histTiles' },
        tile('Money lasts', `${r.starts.length - fails.length} of ${r.starts.length}`, [badge(statusFor(r.successRate)), h('p', { class: 'note' }, `${pct(r.successRate)} of starting years, against ${pct(model.mc.successRate)} in the random simulations.`)], true),
        tile('Toughest start', String(worst.year), h('p', { class: 'note' }, `${era(worst.year).replace(/[()]/g, '')}${ERAS[worst.year] ? '. ' : ''}${worst.wraps ? `Runs on into ${r.first} and beyond. ` : ''}${worst.success ? `Still funded, with ${money(worst.endReal)} left at the end (today’s £).` : `Money runs out in ${worst.failYear}, when ${p1.name} is ${ageAt(worst.failYear)}.`}`)),
        tile('Kindest start', String(best.year), h('p', { class: 'note' }, `${money(best.endReal)} left at the end (today’s £).`)),
        tile('Lowest point', money(Math.min(...r.starts.map(x => x.minReal))), h('p', { class: 'note' }, 'The least ever held in savings, investments and pensions across all starting years (today’s £).'))),
      h('h3', { class: 'chart-title' }, 'Money left at the end of the plan, by the year history starts (today’s £)'), barsBox, barsLegend,
      h('h3', { class: 'chart-title' }, 'Savings, investments and pensions through famous stretches of history (today’s £)'), linesBox, linesLegend,
      h('h3', { class: 'chart-title' }, 'Your goals: random simulations and history'),
      h('div', { id: 'histGoals' }, model.goals.length
        ? h('div', { class: 'table-wrap' }, table(['Goal', 'Random simulations', 'Starting years in history'],
          model.goals.map(g => ({ cells: [h('span', { class: 'goal-name' }, goalBadge(g.goal, 'small'), g.title), pct(g.probability), pct(r.goalRates[g.goal.id] || 0)] }))))
        : h('p', { class: 'sub' }, 'Add goals to compare them here.'))));

    const xs = r.starts.map(x => x.year);
    const bars = [
      { label: 'Left at the end', color: '--s1', values: r.starts.map(x => (x.success ? x.endReal : 0)) },
      { label: 'Ran out', color: '--s8', values: r.starts.map(x => (x.success ? 0 : x.endReal)) },
    ];
    const cb = new Chart(barsBox, { height: 240, label: 'Money left at the end of the plan by starting year in history', name: 'history-starts' });
    cb.set({
      xs, bars,
      tooltip: i => {
        const x = r.starts[i];
        return { title: `Starting ${x.year}${era(x.year)}${x.wraps ? ' · carries on from ' + r.first : ''}`, rows: [
          x.success ? { label: 'Left at the end', color: '--s1', text: money(x.endReal), strong: true } : { label: 'Runs out in', color: '--s8', text: `${x.failYear} (${p1.name} ${ageAt(x.failYear)})`, strong: true },
          { label: 'Lowest point', shape: 'none', text: money(x.minReal) },
        ] };
      },
      table: () => ({
        headers: ['Starting year', 'Period', 'Money lasts', 'Runs out in', 'Lowest point (today’s £)', 'At the end (today’s £)', 'Full history?'],
        rows: r.starts.map(x => [x.year, ERAS[x.year] || '', x.success ? 'Yes' : 'No', x.failYear || '', x.minReal, x.endReal, x.wraps ? 'Wraps round' : 'Yes']),
        formats: [String, String, String, String, money, money, String],
      }),
    });
    legend(barsLegend, bars.map(b => ({ label: b.label, color: b.color })), cb);

    // Famous stretches against the range of all of history.
    const picks = Object.keys(ERAS).map(Number).filter(y => y >= r.first && y <= r.last);
    if (!picks.includes(worst.year)) picks.push(worst.year);
    const idx = y => r.starts.findIndex(x => x.year === y);
    const cfg = fanConfig(r.years, r.bands, { title: titleAt });
    cfg.lines = cfg.lines.concat(picks.map((y, k) => ({ label: `From ${y}${y === worst.year && !ERAS[y] ? ' (toughest)' : ''}`, color: SERIES_COLORS[(k + 1) % 8], values: r.liquid[idx(y)] })));
    const baseTip = cfg.tooltip;
    cfg.tooltip = i => {
      const t = baseTip(i);
      return { title: t.title, rows: [...cfg.lines.slice(1).map(l => ({ label: l.label, color: l.color, shape: 'line', text: money(l.values[i]) })), ...t.rows.filter(x => x.label === 'Median' || x.series)] };
    };
    cfg.table = () => ({
      headers: ['Year', 'Median of history', ...picks.map(y => `From ${y}`)],
      rows: r.years.map((y, i) => [y, r.bands.p50[i], ...picks.map(s => r.liquid[idx(s)][i])]),
      formats: [String, money, ...picks.map(() => money)],
    });
    const cl = new Chart(linesBox, { height: 300, label: 'Savings through famous stretches of history', name: 'history-eras' });
    cl.set(cfg);
    legend(linesLegend, [
      ...cfg.lines.slice(1).map(l => ({ label: l.label, color: l.color, shape: 'line' })),
      { label: 'Median of history', series: 'Median', color: '--s1', shape: 'line' },
      { label: 'Middle half of history', series: 'Middle half of outcomes', color: '--band', shape: 'band' },
      { label: '10th–90th percentile', color: '--band', shape: 'band' },
    ], cl);
  }

  // ---- what else varies in the simulations (on Assumptions)
  function renderFans(host) {
    const { mc, proj } = model;
    const xs = mc.years;
    const a = plan().assumptions;
    const grid = h('div', { class: 'fan-grid', id: 'mcFans' });
    const runs = h('select', { id: 'runsSelect', 'aria-label': 'Simulations', onchange: e => { ws.settings.runs = parseInt(e.target.value, 10); refresh(); } },
      [500, 1000, 2000, 5000, 10000].map(n => h('option', { value: n, selected: ws.settings.runs === n }, n.toLocaleString('en-GB'))));
    setKids(host, h('section', { class: 'card' },
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, 'How things vary in the simulations'),
          h('p', { class: 'sub' }, `Every goal’s chance comes from ${ws.settings.runs.toLocaleString('en-GB')} simulated futures. Each draws its own share and bond returns and, as switched on above, its own inflation, pay rises, house prices and interest rates. These are the ranges.`)),
        h('div', { class: 'controls' }, h('label', {}, 'Simulations', runs),
          h('button', { type: 'button', class: 'btn small', id: 'rerollBtn', onclick: () => { ws.settings.seed = Math.floor(Math.random() * 2 ** 31); refresh(); } }, 'Re-roll'))),
      grid));
    const fans = [
      { title: 'Inflation each year', text: a.varyInflation ? `Centred on ${a.inflation}% with year-to-year swings of about ${a.inflationVolatility} points; surprises fade gradually.` : 'Fixed (switched off above).', bands: mc.inflation, format: pct1, yFormat: v => `${Math.round(v * 1000) / 10}%` },
      { title: 'Earnings from work', text: a.varySalaries ? `Salaries rise at their own rate, follow inflation surprises and get a ±${a.salaryVolatility}% yearly surprise.` : 'Fixed growth (switched off).', bands: mc.series.earnings[view()], expected: proj.rows.map((r, t) => D(r.earnings, t)) },
      { title: 'Property values', text: a.varyHouses ? `Each property grows at its own rate plus inflation surprises and a ±${a.houseVolatility}% yearly swing.` : 'Fixed growth (switched off).', bands: mc.series.property[view()], expected: proj.rows.map((r, t) => D(r.property, t)) },
    ];
    for (const f of fans) {
      if (f.bands && !f.format && f.bands.p90.every(v => Math.abs(v) < 0.5)) continue; // nothing to show
      const card = h('div', { class: 'fan' }, h('h3', {}, f.title), h('p', { class: 'sub' }, f.text));
      grid.append(card);
      chartIn(card, 190, f.title).set(fanConfig(xs, f.bands, { expected: f.expected, format: f.format, yFormat: f.yFormat, title: titleAt }));
    }
  }

  // ------------------------------------------------------------------ money: every input, with its own prediction

  const MONEY_PAGES = [
    ['portfolio', 'Portfolio', () => plan().accounts.length],
    ['income', 'Income', () => plan().income.length],
    ['spending', 'Spending', () => plan().expenses.length + plan().events.length],
    ['cashflow', 'Cash flow & tax'],
    ['assumptions', 'Assumptions'],
    ['history', 'Past reviews', () => ws.checkins.length],
  ];
  let moneyPage = 'portfolio';
  let wkPerson = 0;
  let wkAccount = 'isa';

  function renderMoneyNav() {
    setKids($('#moneyNav'), ...MONEY_PAGES.map(([k, l, count]) => h('a', {
      href: `#finances/${k}`, class: 'chip', 'aria-current': k === moneyPage ? 'page' : null,
      onclick: e => { e.preventDefault(); navigate(`finances/${k}`); },
    }, h('span', {}, l), count ? h('span', { class: 'count' }, String(count())) : null)));
  }

  // ---- what your edits do: every goal's chance and the monthly investment, next to the
  //      inputs, compared with when you opened the page.

  let impactBase = null;
  const impactNow = () => ({
    goals: Object.fromEntries(model.goals.map(g => [g.goal.id, g.probability])),
    invest: model.monthly.shortfall > 0 ? -model.monthly.shortfall : model.monthly.invest,
  });

  function renderImpact() {
    const box = $(`#view-finances .money-page[data-page="${moneyPage}"] [data-impact]`);
    if (!box) return;
    if (!impactBase) impactBase = impactNow();
    const now = impactNow();
    const dPts = g => Math.round(((now.goals[g.goal.id] || 0) - (impactBase.goals[g.goal.id] ?? now.goals[g.goal.id])) * 100);
    const dInv = Math.round(now.invest - impactBase.invest);
    const moved = model.goals.some(g => dPts(g) !== 0) || Math.abs(dInv) >= 1;
    setKids(box, 
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'What your changes do'),
        h('p', { class: 'sub' }, moved ? 'Compared with when you opened this page.' : 'Change anything on the left and watch your goals here.')),
        moved ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { impactBase = null; renderImpact(); } }, 'Start comparing from here') : null),
      h('ul', { class: 'impact-list' },
        model.goals.map(g => {
          const d = dPts(g);
          return h('li', { style: `--gc:${cssVar(goalColor(g.goal))}` }, goalBadge(g.goal, 'small'),
            h('span', { class: 'im-name' }, g.title),
            h('strong', {}, pct(g.probability)),
            h('span', { class: `im-delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}` }, d ? `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} pts` : ''));
        }),
        h('li', { class: 'im-invest' }, h('span', { class: 'im-name' }, now.invest < 0 ? 'Drawing from savings' : 'Invest each month'),
          h('strong', {}, money(Math.abs(now.invest))),
          h('span', { class: `im-delta ${dInv > 0 ? 'pos' : dInv < 0 ? 'neg' : ''}` }, Math.abs(dInv) >= 1 ? `${dInv > 0 ? '+' : '−'}${money(Math.abs(dInv))}` : ''))));
  }

  // "Your figures are as at …": the date every input describes.
  function renderAsOfBar() {
    const p = plan();
    const due = RV.due(ws);
    const last = ws.checkins.filter(c => c.scenarioName !== 'Manual').sort((a, b) => a.date.localeCompare(b.date)).pop();
    const input = h('input', {
      type: 'date', value: asOf(), 'aria-label': 'Figures as at',
      onchange: e => {
        if (!E.isDate(e.target.value)) return;
        p.asOf = e.target.value;
        p.startYear = +p.asOf.slice(0, 4);
        renderAsOfBar();
        renderSection('accounts');
        refresh();
      },
    });
    setKids($('#asOfBar'), ...[
      h('span', { class: 'banner-ico' }, glyph('review')),
      h('div', { class: 'asof-text' },
        h('label', { class: 'asof-label' }, h('strong', {}, 'Your figures are as at'), input),
        h('p', { class: 'sub' }, `Balances, pay and spending below are what they were on this date, and every prediction grows them from here. The yearly review moves the date on and carries the real numbers in.${last ? ` Last review: ${fmtDate(last.date)}.` : ''}`)),
      h('div', { class: 'controls' },
        h('button', { type: 'button', class: 'btn small', id: 'updateBtn', onclick: openUpdate, title: 'Enter a few balances from your banking apps, without the full review' }, 'Update balances'),
        h('button', { type: 'button', class: due.due ? 'btn small primary' : 'btn small', onclick: () => openReview() }, due.due ? 'Start yearly review' : 'Yearly review')),
    ]);
  }

  // The predictions beside each Inputs page's inputs.
  function renderMoneyPage() {
    for (const el of $$('#view-finances .money-page')) el.hidden = el.dataset.page !== moneyPage;
    renderMoneyNav();
    renderAsOfBar();
    renderImpact();
    const fill = (id, fn) => { const body = $(id); setKids(body, ); fn(body); };
    if (moneyPage === 'portfolio') fill('#mpPortfolio', wkAccounts);
    if (moneyPage === 'income') { fill('#mpIncome', wkIncome); requestAnimationFrame(updateIncomeTrends); }
    if (moneyPage === 'spending') fill('#mpSpending', wkSpending);
    if (moneyPage === 'cashflow') { renderCashflow(); fill('#mpTax', wkTax); }
    if (moneyPage === 'assumptions') {
      fill('#mpAssumptions', wkAssumptions);
      const fans = h('div'), hist = h('div');
      $('#mpAssumptions').append(fans, hist);
      renderFans(fans);
      if (!plan().goals.some(g => g.type === 'retire')) setTimeout(() => renderHistory(hist), 30);
    }
    if (moneyPage === 'history') { renderReviewIntro(); renderProgress(); }
  }

  function wkCard(body, title, explain) {
    const card = h('section', { class: 'card' }, h('h2', {}, title));
    if (explain) card.append(h('div', { class: 'explain' }, explain));
    body.append(card);
    return card;
  }

  function wkAssumptions(body) {
    const p = plan();
    const a = p.assumptions;
    const rows = model.proj.rows;
    const card = wkCard(body, 'Prices and tax thresholds by year', [
      h('p', {}, `Prices rise ${a.inflation}% a year, so the price index for year t is (1 + ${a.inflation}%)^t. Values in today's money are future values divided by the price index.`),
      h('p', {}, `Tax thresholds stay frozen until April ${a.thresholdFreezeUntil}, then rise with prices (threshold factor). Investments move from ${a.stockPctNow}% to ${a.stockPctRetire}% stocks by retirement; the expected return is the mix of ${a.stockReturn}% for stocks and ${a.bondReturn}% for bonds.`),
    ]);
    const c = chartIn(card, 220, 'Price index and tax threshold factor', { name: 'assumptions' });
    const xs = rows.map(r => r.year);
    c.set({
      xs,
      lines: [
        { label: 'Price index', color: '--s1', values: rows.map(r => r.deflator) },
        { label: 'Tax threshold factor', color: '--s2', values: rows.map(r => r.thresholdFactor) },
      ],
      yFormat: v => v.toFixed(1),
      tooltip: i => ({ title: String(xs[i]), rows: [
        { label: 'Price index', color: '--s1', shape: 'line', text: rows[i].deflator.toFixed(3) },
        { label: 'Tax threshold factor', color: '--s2', shape: 'line', text: rows[i].thresholdFactor.toFixed(3) },
      ] }),
    });
    const lg = h('div', { class: 'legend' });
    card.append(lg);
    legend(lg, [{ label: 'Price index', color: '--s1', shape: 'line' }, { label: 'Tax threshold factor', color: '--s2', shape: 'line' }], c);
    tableOn(c, ['Year', 'Ages', 'Inflation', 'Price index', 'Tax threshold factor', 'Stocks', 'Expected return'],
      rows.map(r => [r.year, r.ages.join(' / '), r.inflation, r.deflator, r.thresholdFactor, r.stockWeight, r.expectedReturn]),
      [String, String, pct1, v => v.toFixed(3), v => v.toFixed(3), pct, pct1]);
  }

  function wkIncome(body) {
    const p = plan();
    const rows = model.proj.rows.slice(0, -1);
    const items = p.income;
    const card = wkCard(body, 'Income over time', [
      h('p', {}, 'Each amount = today\'s amount × (1 + its growth rate)^years (inflation-linked items use the price index), × any exchange rate, minus costs. Shown before tax; flat taxes appear in Cash flow. Items stop at their end age (for salaries usually retirement).'),
      h('p', {}, `State Pension = your forecast × price index from State Pension age. Simulations add random salary surprises (±${p.assumptions.salaryVolatility}% a year) and inflation surprises on top.`),
    ]);
    const xs = rows.map(r => r.year);
    const lines = items.map((it, k) => ({ label: it.name, color: SERIES_COLORS[k % 8], values: rows.map((r, t) => D(E.incomeAfterCosts(it, p, t), t)) }));
    const sp = rows.map((r, t) => D(r.statePension, t));
    if (sp.some(v => v > 0)) lines.push({ label: 'State Pension', color: SERIES_COLORS[lines.length % 8], values: sp });
    const c = chartIn(card, 260, 'Income streams over time', { name: 'income' });
    c.set({ xs, lines, tooltip: i => ({ title: titleAt(i), rows: lines.filter(l => l.values[i] > 0.5).map(l => ({ label: l.label, color: l.color, shape: 'line', text: money(l.values[i]) })) }) });
    const lg = h('div', { class: 'legend' });
    card.append(lg);
    legend(lg, lines.map(l => ({ label: l.label, color: l.color, shape: 'line' })), c);
    const headers = ['Year', 'Ages', ...lines.map(l => l.label), 'Total'];
    tableOn(c, headers,
      rows.map((r, t) => { const vals = lines.map(l => l.values[t]); return [r.year, r.ages.join(' / '), ...vals, vals.reduce((x, y) => x + y, 0)]; }),
      [String, String, ...lines.map(() => money), money]);
  }

  function wkSpending(body) {
    const p = plan();
    const s = p.strategy;
    const rows = model.proj.rows.slice(0, -1);
    const pre = model.proj.pre;
    const items = p.expenses;
    const notes = [h('p', {}, 'Each item = today\'s amount × price index (or its own growth rate). Items stop at their end age.')];
    if (s.spendNowPct !== 100) notes.push(h('p', {}, `Before retirement, spending is scaled to ${s.spendNowPct}% (the adjustment column).`));
    if (s.retireSpending > 0) notes.push(h('p', {}, `After retirement the list is replaced by ${money(s.retireSpending)} a year in today's money (× price index).`));
    const card = wkCard(body, 'Spending over time', notes);
    const xs = rows.map(r => r.year);
    const byItem = items.map(it => rows.map((r, t) => E.streamAt(it, p, t)));
    const top = items.map((it, k) => ({ it, k, total: byItem[k].reduce((x, y) => x + y, 0) })).sort((x, y) => y.total - x.total);
    const shown = top.slice(0, 6);
    const rest = top.slice(6);
    const bars = shown.map((o, j) => ({ label: o.it.name, color: SERIES_COLORS[j], values: rows.map((r, t) => D(byItem[o.k][t], t)) }));
    if (rest.length) bars.push({ label: `${rest.length} other items`, color: SERIES_COLORS[6], values: rows.map((r, t) => D(rest.reduce((acc, o) => acc + byItem[o.k][t], 0), t)) });
    const adj = rows.map((r, t) => pre.expenses[t] - byItem.reduce((acc, arr) => acc + arr[t], 0));
    const oneOff = rows.map((r, t) => pre.eventsOut[t]);
    if (oneOff.some(v => v > 0)) bars.push({ label: 'One-off events', color: SERIES_COLORS[7], values: rows.map((r, t) => D(oneOff[t], t)) });
    const c = chartIn(card, 260, 'Spending by item', { name: 'spending' });
    c.set({ xs, areas: bars, tooltip: i => ({ title: titleAt(i), rows: bars.filter(b => b.values[i] > 0.5).map(b => ({ label: b.label, color: b.color, text: money(b.values[i]) })) }) });
    const lg = h('div', { class: 'legend' });
    card.append(lg);
    legend(lg, bars.map(b => ({ label: b.label, color: b.color })), c);
    tableOn(c, ['Year', ...items.map(i => i.name), 'Adjustment', 'One-off', 'Total used'],
      rows.map((r, t) => [r.year, ...byItem.map(arr => D(arr[t], t)), D(adj[t], t), D(oneOff[t], t), D(r.spending, t)]),
      [String, ...items.map(() => money), money, money, money]);
  }

  function wkTax(body) {
    const p = plan();
    const rows = model.proj.rows.slice(0, -1);
    const pre = model.proj.pre;
    const n = people().length;
    if (wkPerson >= n) wkPerson = 0;
    const card = wkCard(body, 'Tax by year', [
      h('p', {}, `Income tax uses ${R.INCOME_TAX[p.household.region].label} bands (${R.TAX_YEAR}) on taxable income: gross salary minus your pension contributions, plus other taxable income, State Pension and 75% of pension withdrawals (25% is tax-free up to the lump sum allowance).`),
      h('p', {}, 'National Insurance is on earnings (after salary sacrifice) until State Pension age. Capital gains tax applies when the general investment account is sold, shared between the household.'),
    ]);
    if (n > 1) card.append(h('div', { class: 'chips' }, people().map((x, i) => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(i === wkPerson), onclick: () => { wkPerson = i; renderMoneyPage(); } }, x.name))));
    const i = wkPerson;
    const P = pre.people[i];
    const xs = rows.map(r => r.year);
    const it = rows.map((r, t) => D(r.persons[i].incomeTax, t));
    const ni = rows.map((r, t) => D(r.persons[i].ni, t));
    const cgt = rows.map((r, t) => D(r.cgt / n, t));
    const bars = [
      { label: 'Income tax', color: '--s1', values: it },
      { label: 'National Insurance', color: '--s2', values: ni },
      { label: 'Capital gains tax (share)', color: '--s3', values: cgt },
    ].filter(b => b.values.some(v => v > 0.5));
    const c = chartIn(card, 240, `${people()[i].name}'s tax by year`, { name: `tax-${people()[i].name}` });
    c.set({ xs, areas: bars, tooltip: k => ({ title: titleAt(k), rows: bars.map(b => ({ label: b.label, color: b.color, text: money(b.values[k]) })) }) });
    const lg = h('div', { class: 'legend' });
    card.append(lg);
    legend(lg, bars.map(b => ({ label: b.label, color: b.color })), c);
    tableOn(c, ['Year', 'Age', 'Gross salary', 'Your pension contributions', 'Other taxable', 'State Pension', 'Pension withdrawn', 'of which tax-free', 'Taxable income', 'Personal allowance', 'Higher-rate pension relief', 'Income tax (after relief)', 'NI', 'CGT (share)', 'Effective rate'],
      rows.map((r, t) => {
        const o = r.persons[i];
        const grossIncome = P.gross[t] + P.other[t] + P.statePension[t] + o.pensionDrawn;
        const tax = o.incomeTax + o.ni + r.cgt / n;
        return [r.year, r.ages[i], D(P.gross[t], t), D(P.employee[t], t), D(P.other[t], t), D(P.statePension[t], t), D(o.pensionDrawn, t), D(o.pensionTaxFree, t), D(o.taxable, t), D(o.allowance, t), D(o.relief || 0, t), D(o.incomeTax, t), D(o.ni, t), D(r.cgt / n, t), grossIncome > 0 ? tax / grossIncome : 0];
      }),
      [String, String, money, money, money, money, money, money, money, money, money, money, money, money, pct1]);
  }

  const WK_ACCOUNTS = {
    cash: { label: 'Cash', bal: 'cash', growth: 'gCash', growthLabel: 'Interest', inn: r => r.toCash + r.bondsMatured, out: r => r.wCash + r.sweepIsa + r.sweepGia, explain: 'Interest at the cash rate. Paid in: buffer top-ups from surplus and bonds that mature. Taken out: spending needs above the buffer, cash above the buffer that gets invested, and the buffer itself last of all.' },
    isa: { label: 'ISAs', bal: 'isa', growth: 'gIsa', growthLabel: 'Growth', inn: r => r.toIsa + r.sweepIsa + r.bondsToIsa + r.toLisa + r.lisaBonus, out: r => r.wIsa + r.wLisa + r.lisaHome, explain: 'Includes Lifetime ISAs. Grows at the portfolio return. Paid in: surplus up to each person\'s ISA allowance (Lifetime ISAs first, with their 25% bonus), and gilts held in the ISA when they mature. Taken out: tax-free withdrawals, Lifetime ISAs used for a first home, and from 60.' },
    gia: { label: 'General investment', bal: 'gia', growth: 'gGia', growthLabel: 'Growth', inn: r => r.toGia + r.sweepGia, out: r => r.wGia, explain: 'Grows at the portfolio return. Paid in: surplus above the ISA allowances. Sales pay capital gains tax on the gain part (see Tax).' },
    pension: { label: 'Pensions', bal: 'pension', growth: 'gPension', growthLabel: 'Growth', inn: r => r.pensionIn, out: r => r.wPension, explain: 'Grows at the portfolio return. Paid in: your and your employer\'s contributions (plus any extra with 20% relief). Taken out from the access age: 25% tax-free, the rest taxed as income.' },
    bonds: { label: 'Bonds & gilts', bal: 'bonds', growth: 'gBonds', growthLabel: 'Interest', inn: () => 0, out: r => r.bondsMatured + r.bondsToIsa, explain: 'Grows at each bond\'s fixed rate and pays out when it matures: into cash, or into the ISA if it is held in one.' },
    property: { label: 'Property', bal: 'property', growth: 'gProperty', growthLabel: 'Growth', inn: () => 0, out: r => r.propSold, explain: 'Grows at each property\'s rate. A sale adds the value to that year\'s income, which is then saved or invested.' },
    debt: { label: 'Mortgage & loans', bal: 'debt', growth: 'debtInterest', growthLabel: 'Interest added', inn: () => 0, out: r => r.debtRegular + r.overpay + r.lumpOverpay, explain: 'Interest is added each year at the mortgage rate; payments and overpayments reduce the balance. After a fixed period ends, simulations let the rate move with inflation.' },
  };

  function wkAccounts(body) {
    const rows = model.proj.rows;
    const avail = Object.keys(WK_ACCOUNTS).filter(k => rows.some(r => Math.abs(r[WK_ACCOUNTS[k].bal]) > 0.5));
    if (!avail.includes(wkAccount)) wkAccount = avail[0] || 'cash';
    const A = WK_ACCOUNTS[wkAccount];
    const card = wkCard(body, 'How each account grows', [
      h('p', {}, 'Start + growth + paid in − taken out = end. The check column confirms each row adds up.'),
      h('p', {}, A.explain),
    ]);
    card.append(h('div', { class: 'chips' }, avail.map(k => h('button', { type: 'button', class: 'chip', 'aria-pressed': String(k === wkAccount), onclick: () => { wkAccount = k; renderMoneyPage(); } }, WK_ACCOUNTS[k].label))));
    const flows = rows.slice(0, -1);
    const xs = rows.map(r => r.year);
    const c = chartIn(card, 240, `${A.label} balance`, { name: `account-${wkAccount}` });
    const bal = rows.map((r, t) => D(r[A.bal], t));
    c.set({ xs, lines: [{ label: `${A.label} balance`, color: TYPE_COLOR[wkAccount], values: bal, area: true }], tooltip: i => ({ title: titleAt(i), rows: [{ label: 'Balance at start of year', color: TYPE_COLOR[wkAccount], shape: 'line', text: money(bal[i]) }] }) });
    const isDebt = wkAccount === 'debt';
    const headers = ['Year', 'Start', A.growthLabel, isDebt ? 'Paid in' : 'Paid in', isDebt ? 'Payments & overpayments' : 'Taken out', 'End', 'Check'];
    if (isDebt) headers.splice(6, 0, 'Rate');
    tableOn(c, headers,
      flows.map((r, t) => {
        const start = r[A.bal], growth = r[A.growth], inn = A.inn(r), out = A.out(r), end = rows[t + 1][A.bal];
        const ok = Math.abs(start + growth + inn - out - end) < 1 ? '✓' : `off by ${money(start + growth + inn - out - end)}`;
        const vals = [r.year, D(start, t), D(growth, t), D(inn, t), D(out, t), D(end, t)];
        if (isDebt) {
          const d = model.proj.out.debts[0];
          vals.push(d ? d.rate[t] : 0);
        }
        vals.push(ok);
        return vals;
      }),
      [String, money, money, money, money, money, ...(isDebt ? [pct1] : []), String]);
  }

  // ------------------------------------------------------------------ scenarios: every goal, side by side

  let cmpCache = { key: null, items: null };

  // Each scenario's goals (chance and expected year) and what it invests each month. The open
  // scenario uses the same numbers as everywhere else; the others are simulated alike.
  function compareScenarios() {
    const runs = ws.settings.runs, seed = ws.settings.seed;
    const key = `${JSON.stringify(ws.scenarios.map(s => [s.id, s.plan]))}|${runs}|${seed}`;
    if (cmpCache.key !== key) {
      cmpCache = { key, items: ws.scenarios.map(s => {
        if (s.id === ws.activeId) return { s, goals: model.goals, monthly: model.monthly };
        const proj = E.project(s.plan);
        const mc = E.monteCarlo(s.plan, runs, seed);
        return { s, goals: E.evaluateGoals(s.plan, proj, mc, { runs: 500, seed }), monthly: E.monthlyPlan(proj) };
      }) };
    }
    return cmpCache.items;
  }

  function renderScenarios() {
    renderScenarioList();
    renderIdeas();
    const box = $('#compareResults');
    setKids(box, h('p', { class: 'sub working' }, `Working out ${ws.scenarios.length} scenario${ws.scenarios.length === 1 ? '' : 's'}…`));
    setTimeout(() => {
      if (route.tab !== 'scenarios') return;
      const items = compareScenarios();
      const base = items.find(x => x.s.id === ws.activeId);
      // One column per goal: the open scenario's goals first, then any only others have.
      const cols = [];
      const same = (a, b) => a.goal.id === b.goal.id || a.title === b.title;
      for (const it of [base, ...items.filter(x => x !== base)]) for (const g of it.goals) if (!cols.some(c => same(c, g))) cols.push(g);
      const find = (it, c) => it.goals.find(g => same(g, c));
      const cell = (it, c) => {
        const r = find(it, c);
        if (!r) return h('td', { class: 'sc-cell none' }, h('span', { class: 'muted' }, 'Not a goal here'));
        const b = it === base ? null : find(base, c);
        const pts = b ? Math.round((r.probability - b.probability) * 100) : 0;
        return h('td', { class: 'sc-cell', style: `--gc:${cssVar(goalColor(c.goal))}` },
          h('div', { class: 'sc-top' }, h('strong', {}, pct(r.probability)),
            b && pts ? h('span', { class: `sc-delta ${pts > 0 ? 'pos' : 'neg'}` }, `${pts > 0 ? '▲' : '▼'} ${Math.abs(pts)} pts`) : null),
          h('div', { class: 'sc-bar', role: 'img', 'aria-label': `${pct(r.probability)} chance` }, h('span', { style: `width:${r.probability * 100}%` })),
          h('small', {}, goalWhen(r)));
      };
      const invest = it => (it.monthly.shortfall > 0 ? `−${money(it.monthly.shortfall)}` : money(it.monthly.invest));
      const rows = items.map(it => h('tr', { class: it === base ? 'open' : '', 'data-scenario': it.s.id },
        h('th', { scope: 'row' }, h('strong', {}, it.s.name), it === base ? h('span', { class: 'sc-open' }, 'Open now') : null),
        cols.map(c => cell(it, c)),
        h('td', { class: 'sc-invest' }, invest(it), h('small', {}, 'a month now')),
        h('td', { class: 'sc-actions' }, it === base ? null : [
          h('button', { type: 'button', class: 'btn small', onclick: () => { ws.activeId = it.s.id; afterScenarioChange(); } }, 'Open'),
          h('button', { type: 'button', class: 'btn small ghost danger', 'aria-label': `Delete scenario ${it.s.name}`, onclick: () => {
            if (!confirm(`Delete scenario “${it.s.name}”?`)) return;
            ws.scenarios = ws.scenarios.filter(x => x.id !== it.s.id);
            save();
            renderScenarioPicker();
            renderScenarios();
          } }, 'Delete')])));
      setKids(box, h('div', { class: 'table-wrap sc-wrap' }, h('table', { class: 'data sc-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Scenario'),
          cols.map(c => h('th', { scope: 'col', style: `--gc:${cssVar(goalColor(c.goal))}` }, h('span', { class: 'heat-goal' }, goalBadge(c.goal, 'small'), h('span', {}, c.title)))),
          h('th', { scope: 'col' }, 'Invest'), h('th', { scope: 'col' }, h('span', { class: 'sr-only' }, 'Actions')))),
        h('tbody', {}, rows))),
      ws.scenarios.length < 2 ? h('p', { class: 'hint' }, 'Only one scenario so far: add a what-if below, or duplicate this one and change anything in it.') : h('p', { class: 'hint' }, 'Chance of each goal across simulated futures, and when it is reached on average returns. ▲▼ compare with the scenario you have open.'));
    }, 30);
  }

  // A what-if counts as added when a scenario made from the open one already has its name.
  const ideaName = idea => `${scenario().name}: ${idea.title}`;
  function renderIdeas() {
    const p = plan();
    setKids($('#ideaGrid'), SI.ideasFor(p).map(idea => {
      const added = ws.scenarios.some(x => x.name === ideaName(idea));
      return h('button', {
        type: 'button', class: `idea-chip${added ? ' added' : ''}`, 'data-idea': idea.id, disabled: added,
        title: added ? `Already added as “${ideaName(idea)}”` : SI.textOf(idea, p), onclick: e => addIdea(idea, e.currentTarget),
      }, h('span', { class: 'idea-ico' }, glyph(idea.icon)), h('span', {}, idea.title));
    }));
  }

  function addIdea(idea, btn) {
    const name = ideaName(idea);
    ws.scenarios.push({ id: E.uid(), name, plan: SI.variantOf(idea, plan()) });
    save();
    renderScenarioPicker();
    btn.disabled = true;
    btn.classList.add('added');
    renderScenarios();
    toast(`Added “${name}”. It is in the table above; open it to change anything in it.`);
  }

  // ------------------------------------------------------------------ progress (check-ins)

  function renderProgress() {
    const list = ws.checkins;
    const review = E.checkinReview(list);
    const tableBox = $('#progTable');
    const chartBox = $('#progChart');
    renderProgressReview();
    if (!list.length) {
      setKids(chartBox, h('p', { class: 'sub' }, 'No check-ins yet. Record one now to start tracking: next year you will see how close this year’s projection was.'));
      setKids($('#progLegend'), );
      setKids(tableBox, );
      delete charts.progChart;
      return;
    }
    if (!charts.progChart) setKids(chartBox, );
    const minY = Math.min(...list.map(c => c.year));
    const maxY = Math.max(...list.map(c => c.year)) + 8;
    const xs = [];
    for (let y = minY; y <= maxY; y++) xs.push(y);
    const lines = list.slice(-8).map((c, k) => ({
      label: `Projection from ${c.year}`,
      color: SERIES_COLORS[k % 8],
      dash: [6, 4],
      values: xs.map(y => { const i = c.predicted.years.indexOf(y); return i >= 0 ? c.predicted.netWorth[i] : null; }),
    }));
    const actual = xs.map(y => { const c = list.filter(x => x.year === y).pop(); return c ? c.actual.netWorth : null; });
    lines.push({ label: 'Actual', color: '--text', values: actual, points: true });
    chart('progChart', 320, 'Actual net worth against earlier projections').set({
      xs, lines,
      tooltip: i => ({ title: String(xs[i]), rows: lines.filter(l => l.values[i] != null).map(l => ({ label: l.label, color: l.color, shape: l.points ? 'dot' : 'dash', text: money(l.values[i]), strong: !!l.points })) }),
    });
    legend($('#progLegend'), lines.map(l => ({ label: l.label, color: l.color, shape: l.points ? 'dot' : 'dash' })), charts.progChart);

    setKids(tableBox, table(
      ['Date', 'Year', 'Net worth', 'Projected a year earlier', 'Difference', 'Spending', 'Planned investing', ''],
      review.slice().reverse().map(rv => {
        const c = rv.checkin;
        return {
          cells: [
            c.date, String(c.year), money(c.actual.netWorth),
            rv.predicted == null ? '—' : money(rv.predicted),
            rv.diff == null ? '—' : { text: `${rv.diff >= 0 ? '+' : '−'}${money(Math.abs(rv.diff))} (${rv.pct >= 0 ? '+' : '−'}${Math.abs(Math.round(rv.pct * 1000) / 10)}%)`, cls: rv.diff >= 0 ? 'pos' : 'neg' },
            c.actual.spending ? `${money(c.actual.spending / 12)}/month` : '—',
            c.monthlyInvest ? `${money(c.monthlyInvest)}/month` : '—',
            h('button', { type: 'button', class: 'btn small danger', 'aria-label': `Delete check-in ${c.date}`, onclick: () => { if (confirm(`Delete the check-in from ${c.date}?`)) { ws.checkins = ws.checkins.filter(x => x.id !== c.id); save(); renderProgress(); } } }, 'Delete'),
          ],
        };
      })));
  }

  function recordCheckin() {
    const p = plan();
    const existing = ws.checkins.find(c => c.year === p.startYear);
    if (existing && !confirm(`You already have a check-in for ${p.startYear}. Replace it with today's numbers?`)) return;
    ws.checkins = ws.checkins.filter(c => c.year !== p.startYear);
    const c = E.makeCheckin(p, scenario().name, today());
    c.goals = model.goals.map(g => ({ title: g.title, probability: g.probability, expectedYear: g.expectedYear }));
    ws.checkins.push(E.normalizeCheckin(c));
    ws.checkins.sort((a, b) => a.date.localeCompare(b.date));
    save();
    renderProgress();
    renderNotifications();
  }

  // ------------------------------------------------------------------ yearly review

  let rv = null;
  const RV_STEPS = ['Start', 'Balances', 'Income', 'Spending', 'Markets', 'How you did', 'Update scenarios'];

  function openReview() {
    newReview();
    $('#reviewWiz').showModal();
  }

  function newReview(year) {
    const draft = RV.start(ws, { ...(year ? { year } : {}), ...(rv && year ? { date: rv.draft.date } : {}) });
    rv = { step: rv && year ? rv.step : 0, draft, market: {}, scenarioIds: new Set(ws.scenarios.map(s => s.id)), note: '', evals: null, expNW: RV.byType(draft.expectedPlan).netWorth };
    renderReview();
  }

  function renderReview() {
    const total = RV_STEPS.length;
    const d = rv.draft;
    $('#rvStep').textContent = `Yearly review ${d.year} · step ${rv.step + 1} of ${total}`;
    $('#rvTitle').textContent = RV_STEPS[rv.step];
    $('#rvBar').style.width = `${((rv.step + 1) / total) * 100}%`;
    $('#rvBack').disabled = rv.step === 0;
    $('#rvNext').hidden = rv.step === total - 1;
    $('#rvNext').textContent = rv.step === total - 2 ? 'Next: update scenarios' : 'Next';
    const body = $('#rvBody');
    const fn = [rvStart, rvBalances, rvIncome, rvSpending, rvMarkets, rvResults, rvSave][rv.step];
    setKids(body, ...[].concat(fn()).filter(Boolean));
    body.scrollTop = 0;
    updateReviewNote();
  }

  function rvStart() {
    const d = rv.draft, o = d.original, pr = d.predicted;
    $('#rvIntro').textContent = 'Once a year, replace every number with what actually happened. Horizon compares it with last year’s plan, then rolls all your scenarios forward for the year ahead.';
    const choice = (year, title, text) => h('button', {
      type: 'button', class: 'goal-option' + (d.year === year ? ' selected' : ''), 'aria-pressed': String(d.year === year),
      onclick: () => newReview(year),
    }, h('strong', {}, title), h('span', {}, text));
    const years = [...new Set([d.year, o.startYear + 1, o.startYear])].sort((a, b) => b - a);
    return [
      h('div', { class: 'goal-options two' }, years.map(y => (y > o.startYear
        ? choice(y, `Start ${y}`, `Everyone is ${y - o.startYear === 1 ? 'a year' : `${y - o.startYear} years`} older. Amounts are grown the way the plan expected, ready for you to correct.`)
        : choice(y, `Update ${y}`, 'Refresh this year’s numbers without moving the plan on.')))),
      h('p', { class: 'sub' }, `Your figures are as at ${fmtDate(o.asOf || E.asOfDate(o))}. Next, every balance is estimated for ${fmtDate(d.date)} for you to correct.`),
      d.prev
        ? h('div', { class: 'rv-recap' }, h('span', { class: 'banner-ico' }, glyph('review')), h('div', {},
          h('strong', {}, `Last check-in: ${fmtDate(d.prev.date)} (${d.prev.year})`),
          h('p', {}, `Net worth was ${money(d.prev.actual.netWorth)}.${pr ? ` It predicted ${money(pr.netWorth)} for ${d.year}.` : ''}${d.prev.monthlyInvest ? ` The plan was to invest ${money(d.prev.monthlyInvest)} a month.` : ''}`)))
        : h('p', { class: 'sub' }, 'No earlier check-in yet. This review becomes the starting point; next year you will see how close it was.'),
      h('div', { class: 'rv-checklist' }, h('h3', {}, 'Have these to hand'),
        h('ul', {}, ['Bank and savings balances', 'ISA, investment and pension balances (apps or statements)', 'Mortgage statement: balance, rate and monthly payment', 'Latest payslips or take-home pay', 'A rough idea of monthly spending (bank app summaries help)'].map(x => h('li', {}, x)))),
    ];
  }

  // One row per item: last time, what the plan expected, and what it is now.
  function rvRows(kind, items, opts) {
    const d = rv.draft;
    const prog = h('p', { class: 'rv-progress' });
    const updateProg = () => {
      const pg = RV.progress(d, kind);
      setKids(prog, glyph(pg.done === pg.total ? 'good' : 'review'), `${pg.done} of ${pg.total} updated`);
      prog.classList.toggle('done', pg.done === pg.total);
    };
    const rows = items.map(it => {
      const id = it.id;
      const fmtA = v => (it.fx && it.fx !== 1 ? plain(Math.round(v)) : money(v));
      const last = d.last[kind][id], exp = d.expected[kind][id];
      const cur = () => (kind === 'accounts' ? it.balance : it.amount);
      const diff = h('span', { class: 'rv-diff' });
      const row = h('div', { class: 'rv-row' + (d.touched[kind][id] ? ' done' : ''), style: `--item-color:${cssVar(opts.color(it))}` });
      const setDiff = () => {
        const dv = cur() - exp;
        const touched = d.touched[kind][id];
        if (Math.abs(dv) < 0.5) { diff.textContent = touched ? 'As expected' : 'Estimate: check it'; diff.className = 'rv-diff muted'; return; }
        const good = (dv > 0) !== !!opts.lowerIsBetter(it);
        diff.textContent = `${dv > 0 ? '+' : '−'}${fmtA(Math.abs(dv))} vs plan`;
        diff.className = `rv-diff ${good ? 'pos' : 'neg'}`;
      };
      const input = h('input', { type: 'text', inputmode: 'decimal', value: plain(Math.round(cur() * 100) / 100), 'aria-label': `${it.name} now` });
      input.addEventListener('input', () => {
        RV.setValue(d, kind, id, parseAmount(input.value));
        row.classList.add('done');
        setDiff(); updateProg(); updateReviewNote();
        rv.evals = null;
      });
      input.addEventListener('focus', () => input.select());
      setDiff();
      const pre = it.fx && it.fx !== 1 ? null : h('span', { class: 'pre' }, '£');
      row.append(
        h('div', { class: 'rv-name' }, h('span', {}, it.name), h('span', { class: 'tag' }, opts.tag(it)), opts.note ? opts.note(it) : null),
        h('div', { class: 'rv-num' }, h('span', { class: 'rv-k' }, 'Last time'), last === undefined ? '—' : fmtA(last)),
        h('div', { class: 'rv-num' }, h('span', { class: 'rv-k' }, opts.expLabel || 'Plan expected'), fmtA(exp)),
        h('label', { class: 'rv-in' }, h('span', { class: 'rv-k' }, opts.nowLabel(it)), h('div', { class: `adorn${pre ? ' has-pre' : ''}` }, pre, input)),
        diff);
      const extra = opts.extra ? opts.extra(it, row) : null;
      if (extra) row.append(extra);
      return row;
    });
    updateProg();
    const keep = h('button', { type: 'button', class: 'btn small', onclick: () => { for (const it of items) d.touched[kind][it.id] = true; renderReview(); } }, 'Keep the rest as they are');
    return [h('div', { class: 'rv-toolbar' }, prog, keep), h('div', { class: 'rv-rows' }, rows)];
  }

  function rvBalances() {
    const d = rv.draft;
    $('#rvIntro').textContent = `What every account holds. Each one is filled in with Horizon’s estimate for the date below (where last year’s plan said you would be, on average returns, or a balance you updated since): type over it with the real figure.`;
    const dateIn = h('input', { type: 'date', value: d.date, 'aria-label': 'Balances as at', onchange: e => {
      if (!E.isDate(e.target.value)) return;
      RV.setDate(d, e.target.value);
      rv.evals = null;
      rv.expNW = RV.byType(d.expectedPlan).netWorth;
      renderReview();
    } });
    const dateRow = h('label', { class: 'asof-label' }, h('strong', {}, 'Balances as at'), dateIn,
      h('span', { class: 'hint' }, 'Usually today. This becomes the date your figures are as at.'));
    const debtExtra = (a, row) => {
      if (a.type !== 'debt') return null;
      const mark = () => { d.touched.accounts[a.id] = true; row.classList.add('done'); rv.evals = null; updateReviewNote(); };
      const num = (key, label, step, suffix) => h('label', { class: 'field' }, h('span', {}, label),
        h('div', { class: `adorn ${suffix ? 'has-suf' : 'has-pre'}` }, suffix ? null : h('span', { class: 'pre' }, '£'),
          h('input', { type: suffix ? 'number' : 'text', inputmode: 'decimal', step, value: a[key] || '', oninput: e => { a[key] = suffix ? (parseFloat(e.target.value) || 0) : parseAmount(e.target.value); mark(); } }),
          suffix ? h('span', { class: 'suf' }, suffix) : null));
      return h('details', { class: 'more rv-extra' }, h('summary', {}, 'Remortgaged or changed the payment?'),
        h('div', { class: 'fields' }, num('rate', 'Interest rate', 0.01, '%'), num('payment', 'Monthly payment', 1), num('fixedUntil', 'Fixed until (year)', 1, ' ')));
    };
    return [dateRow, ...rvRows('accounts', d.plan.accounts, {
      expLabel: 'Estimate',
      note: a => (d.readings && d.readings[a.id] ? h('small', { class: 'rv-note' }, `From your update on ${fmtDate(d.readings[a.id].date)}`) : null),
      tag: a => (a.excluded ? 'Not counted' : ACCOUNT_LABELS[a.type]),
      color: a => TYPE_COLOR[a.type],
      lowerIsBetter: a => a.type === 'debt',
      nowLabel: a => (a.type === 'debt' ? 'Owed now' : a.type === 'property' ? 'Worth now' : 'Balance now'),
      extra: debtExtra,
    })];
  }

  function rvIncome() {
    $('#rvIntro').textContent = 'Pay, rent and other income as it is now. Enter the same kind of figure as before (take-home or before tax), per month or per year as shown.';
    const per = it => (it.freq === 'month' ? 'a month' : 'a year');
    return rvRows('income', rv.draft.plan.income, {
      tag: it => (it.kind === 'dbpension' ? 'Built up so far' : `${KIND_LABELS.find(k => k[0] === it.kind)[1]}, ${per(it)}`),
      color: it => (it.kind === 'dbpension' ? '--s4' : '--s1'),
      lowerIsBetter: () => false,
      nowLabel: it => (it.kind === 'dbpension' ? 'Pension a year now' : `Now (${per(it)})`),
    });
  }

  function rvSpending() {
    const d = rv.draft;
    $('#rvIntro').textContent = 'Regular spending at today’s prices. The plan expected each item to rise with inflation; correct the ones that changed.';
    const actual = h('div', { class: 'fields rv-actual' },
      field('What did you actually spend in the last 12 months? (optional)', moneyInputPlain(() => d.actualSpending, v => { d.actualSpending = v; }, 'Actual spending last 12 months'),
        'Not counting mortgage payments. Bank apps often show yearly totals. Saved with the check-in so you can compare years.'));
    return [
      ...rvRows('expenses', d.plan.expenses, {
        tag: e => (e.freq === 'month' ? 'a month' : 'a year'),
        color: () => '--s5',
        lowerIsBetter: () => true,
        nowLabel: e => `Now (${e.freq === 'month' ? 'a month' : 'a year'})`,
      }),
      actual,
      h('p', { class: 'hint' }, 'For a walk-through with typical UK amounts for each category, run the Spending check-up (Finances → Spending) after the review.'),
    ];
  }

  function rvMarkets() {
    const d = rv.draft;
    $('#rvIntro').textContent = 'Your long-run assumptions next to the latest UK data. One year of data says little about the next thirty, so only change what you now see differently.';
    const latest = { inflation: 'cpi', cashRate: 'bankRate', bondReturn: 'gilt10y' };
    const labels = { inflation: 'Inflation', cashRate: 'Cash interest', bondReturn: 'Bond returns' };
    return [
      h('div', { class: 'rv-markets' }, RV.MARKET_FIELDS.map(f => {
        const m = d.market[f];
        const sr = MARKET && MARKET.series[latest[f]];
        const sg = MARKET && MARKET.suggested[f];
        if (sg && !rv.market[f] && m.next === m.current) m.next = sg.value;
        const input = h('input', { type: 'number', step: 0.1, value: m.next, 'aria-label': `${labels[f]} to use`, oninput: e => { m.next = parseFloat(e.target.value) || 0; rv.evals = null; } });
        return h('div', { class: 'rv-market' },
          h('h3', {}, labels[f]),
          h('dl', {},
            h('dt', {}, 'Your assumption'), h('dd', {}, `${m.current}% a year`),
            sr ? [h('dt', {}, sr.label), h('dd', {}, `${sr.value}% (${sr.date})`)] : null,
            sg ? [h('dt', {}, 'Suggested long-run'), h('dd', {}, `${sg.value}%`)] : null),
          sg ? h('p', { class: 'hint' }, sg.why) : null,
          h('div', { class: 'rv-market-set' },
            switchInput('Change to', () => !!rv.market[f], v => { rv.market[f] = v; rv.evals = null; }),
            h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, '%'))));
      })),
      h('p', { class: 'sub' }, MARKET ? `Latest data as of ${MARKET.asOf}. Scenarios that used the same value as this one get the change; scenarios with their own assumption keep it.` : 'No bundled market data found.'),
    ];
  }

  // Horizontal diverging bars (actual minus prediction), with a table view.
  function divergingBars(rows, baseLabel) {
    const max = Math.max(1, ...rows.map(r => Math.abs(r.diff)));
    const bars = h('div', { class: 'divbars', role: 'list' }, rows.map(r => {
      const pos = r.diff >= 0;
      const flat = Math.abs(r.diff) < 5; // rounding noise: on plan
      const w = flat ? 0 : Math.max(0.5, (Math.abs(r.diff) / max) * 50);
      const sign = flat ? 'On plan' : `${pos ? '+' : '−'}${fmtCompact(Math.abs(r.diff))}`;
      return h('div', { class: 'divbar', role: 'listitem', tabindex: '0', title: `${r.label}: ${baseLabel} ${money(r.base)}, actual ${money(r.actual)}${r.type === 'debt' ? ' (owed)' : ''}` },
        h('span', { class: 'db-label' }, r.type === 'debt' ? `${r.label} (less owed = +)` : r.label),
        h('span', { class: 'db-track' }, h('span', { class: 'db-mid' }), h('span', { class: `db-bar ${pos ? 'pos' : 'neg'}`, style: `${pos ? 'left' : 'right'}:50%;width:${w}%` })),
        h('span', { class: `db-val${flat ? ' flat' : ''}` }, sign));
    }));
    const tbl = table(['', baseLabel, 'Actual', 'Difference'], rows.map(r => ({ cells: [r.label, money(r.base), money(r.actual), { text: `${r.diff >= 0 ? '+' : '−'}${money(Math.abs(r.diff))}`, cls: r.diff >= 0 ? 'pos' : 'neg' }] })));
    return viewToggle(bars, h('div', { class: 'table-wrap' }, tbl));
  }

  // A Chart/Table switch for HTML visuals (charts on canvas have their own).
  function viewToggle(visual, tableEl) {
    tableEl.hidden = true;
    const btns = ['Chart', 'Table'].map((l, i) => h('button', { type: 'button', 'aria-pressed': String(i === 0), onclick: () => {
      visual.hidden = i === 1; tableEl.hidden = i === 0;
      btns.forEach((b, k) => b.setAttribute('aria-pressed', String(k === i)));
    } }, l));
    return h('div', { class: 'view-toggle' }, h('div', { class: 'chart-tools' }, h('div', { class: 'seg mini', role: 'group', 'aria-label': 'Show as' }, btns)), visual, tableEl);
  }

  function rvResults() {
    const d = rv.draft;
    $('#rvIntro').textContent = 'What actually happened against what the plan expected.';
    const v = RV.variance(d);
    const t = v.total;
    const baseLabel = v.mode === 'prediction' ? `Predicted (${d.predicted.from})` : v.mode === 'lastYear' ? `Last check-in (${d.prev.year})` : 'Plan expected';
    const close = t.pct != null && Math.abs(t.pct) < 0.02;
    const verdict = t.base == null ? '' : close ? 'Right on plan.' : t.diff > 0 ? 'Ahead of plan.' : 'Behind plan.';
    const out = [
      h('div', { class: 'rv-hero' },
        h('div', {}, h('div', { class: 'hero-label' }, `Net worth ${d.year}`), h('div', { class: 'hero-value' }, money(t.actual))),
        h('div', {}, h('div', { class: 'hero-label' }, d.predicted ? `Predicted in ${d.predicted.from}` : 'Plan expected'), h('div', { class: 'hero-value soft' }, money(t.base))),
        h('div', { class: `rv-delta ${t.diff >= 0 ? 'pos' : 'neg'}` },
          h('span', {}, `${t.diff >= 0 ? '+' : '−'}${money(Math.abs(t.diff))}`),
          t.pct != null ? h('small', {}, `${t.diff >= 0 ? '+' : '−'}${Math.abs(t.pct * 100).toFixed(1)}% · ${verdict}`) : null)),
      h('h3', { class: 'chart-title' }, v.mode === 'prediction' ? 'What made the difference (actual minus prediction)' : v.mode === 'lastYear' ? `Change since your ${d.prev.year} check-in (no breakdown was saved with that prediction)` : 'Difference from what the plan expected'),
      divergingBars(v.rows, baseLabel),
    ];

    // Last year's projection against the updated plan, in pounds of each year.
    const proj = E.project(d.plan);
    const startY = d.prev ? d.prev.year : d.year;
    const xs = [];
    for (let y = startY; y <= Math.min(d.year + 25, proj.pre.years[proj.pre.N]); y++) xs.push(y);
    const at = (years, vals, y) => { const i = years.indexOf(y); return i >= 0 ? vals[i] : null; };
    const lines = [];
    if (d.prev) lines.push({ label: `Projection from ${d.prev.year}`, color: '--muted', dash: [6, 4], values: xs.map(y => at(d.prev.predicted.years, d.prev.predicted.netWorth, y)) });
    lines.push({ label: `Updated plan (${d.year})`, color: '--s1', area: true, values: xs.map(y => at(proj.pre.years, proj.rows.map(r => r.netWorth), y)) });
    const actual = xs.map(y => { const c = ws.checkins.filter(x => x.year === y && y !== d.year).pop(); return y === d.year ? t.actual : c ? c.actual.netWorth : null; });
    lines.push({ label: 'Actual', color: '--text', values: actual, pointsOnly: true });
    const box = h('div', { class: 'rv-chart' });
    out.push(h('h3', { class: 'chart-title' }, 'Net worth: last year’s projection and the updated plan (pounds of each year)'), box);
    const leg = h('div', { class: 'legend' });
    out.push(leg);
    requestAnimationFrame(() => {
      const c = chartIn(box, 260, 'Last year’s projection and the updated plan', { name: 'review-projection' });
      c.set({ xs, lines, tooltip: i => ({ title: String(xs[i]), rows: lines.filter(l => l.values[i] != null).map(l => ({ label: l.label, color: l.color, shape: l.pointsOnly ? 'dot' : l.dash ? 'dash' : 'line', text: money(l.values[i]), strong: l.pointsOnly })) }) });
      legend(leg, lines.map(l => ({ label: l.label, color: l.color, shape: l.pointsOnly ? 'dot' : l.dash ? 'dash' : 'line' })), c);
    });

    const goalsBox = h('div', { class: 'rv-goals' }, h('p', { class: 'sub' }, 'Working out how your goals moved…'));
    out.push(h('h3', { class: 'chart-title' }, 'Your goals: if everything had gone to plan, and now'), goalsBox);
    setTimeout(() => {
      if (!rv || rv.draft !== d) return;
      if (!rv.evals) rv.evals = { before: evaluatePlan(d.expectedPlan), after: evaluatePlan(applyMarketTo(d.plan)) };
      setKids(goalsBox, impactTable(rv.evals, ['If all went to plan', 'Now']),
        h('p', { class: 'hint' }, `${EXPLORE_RUNS} simulated futures each, same markets for both. “Invest each month now” is the figure to set up for the year ahead.`));
    }, 40);
    return out;
  }

  // The reviewed plan with any market changes from the Markets step.
  function applyMarketTo(p) {
    const q = E.clonePlan(p);
    for (const f of RV.MARKET_FIELDS) if (rv.market[f]) q.assumptions[f] = rv.draft.market[f].next;
    return q;
  }

  function rvSave() {
    const d = rv.draft;
    $('#rvIntro').textContent = `Carry the ${d.year} numbers into your scenarios and record the check-in.`;
    const left = ['accounts', 'income', 'expenses'].map(k => { const pg = RV.progress(d, k); return pg.total - pg.done; });
    const changes = RV.MARKET_FIELDS.filter(f => rv.market[f]).map(f => `${{ inflation: 'Inflation', cashRate: 'Cash interest', bondReturn: 'Bond returns' }[f]} ${d.market[f].current}% → ${d.market[f].next}%`);
    return [
      h('div', { class: 'rv-scenarios' }, ws.scenarios.map(s => h('label', { class: 'rv-scen' },
        h('input', { type: 'checkbox', checked: rv.scenarioIds.has(s.id), disabled: s.id === d.scenarioId, onchange: e => { if (e.target.checked) rv.scenarioIds.add(s.id); else rv.scenarioIds.delete(s.id); } }),
        h('span', {}, h('strong', {}, s.name), h('small', {}, s.id === d.scenarioId ? `The one you reviewed. Moves from ${s.plan.startYear} to ${d.year}.` : `Moves from ${s.plan.startYear} to ${d.year} with your new balances, pay and spending; keeps its own assumptions.`))))),
      changes.length ? h('p', { class: 'sub' }, `Market changes: ${changes.join(', ')}.`) : null,
      left.some(n => n > 0) ? h('p', { class: 'hint' }, `Not updated, so the plan’s expected value is used: ${[[left[0], 'balance'], [left[1], 'income'], [left[2], 'spending item']].filter(x => x[0] > 0).map(([n, w]) => `${n} ${w}${n === 1 ? '' : w === 'income' ? 's' : 's'}`).join(', ')}.`) : null,
      field('Notes on the year (optional)', h('textarea', { rows: 3, placeholder: 'E.g. pay rise, remortgaged, new car…', oninput: e => { rv.note = e.target.value; } }, rv.note)),
      h('div', { class: 'add-row' }, h('button', { type: 'button', class: 'btn primary', id: 'rvSave', onclick: saveReview }, `Save the ${d.year} review`)),
    ];
  }

  function updateReviewNote() {
    const note = $('#rvNote');
    if (!rv) return;
    const d = rv.draft;
    const sum = (p, list) => p[list].reduce((acc, it) => acc + E.streamAt(it, p, 0), 0);
    if (rv.step === 1) {
      const nw = RV.byType(d.plan).netWorth;
      const dv = nw - rv.expNW;
      setKids(note, 'Net worth ', h('strong', {}, money(nw)), ` · plan expected ${money(rv.expNW)}`, Math.abs(dv) >= 0.5 ? h('span', { class: dv > 0 ? 'pos' : 'neg' }, ` (${dv > 0 ? '+' : '−'}${money(Math.abs(dv))})`) : '');
    } else if (rv.step === 2) {
      const now = sum(d.plan, 'income'), exp = sum(d.expectedPlan, 'income');
      setKids(note, 'Income ', h('strong', {}, `${money(now / 12)} a month`), ` · plan expected ${money(exp / 12)}`);
    } else if (rv.step === 3) {
      const now = sum(d.plan, 'expenses'), exp = sum(d.expectedPlan, 'expenses');
      setKids(note, 'Spending ', h('strong', {}, `${money(now / 12)} a month`), ` · plan expected ${money(exp / 12)}`);
    } else setKids(note, );
  }

  function saveReview() {
    const d = rv.draft;
    const finish = () => {
      const goals = rv.evals.after.goals.map(g => ({ title: g.title, probability: g.probability, expectedYear: g.expectedYear }));
      ws = RV.apply(ws, d, { scenarioIds: [...rv.scenarioIds], market: rv.market, date: d.date, goals, note: rv.note });
      $('#reviewWiz').close();
      rv = null;
      goalSolve = {};
      explorerValues = null;
      renderScenarioPicker();
      renderPlan();
      refresh();
      navigate('finances/history');
      toast(`${d.year} review saved: figures as at ${fmtDate(d.date)}, and every scenario now starts in ${d.year}. Invest ${money(model.monthly.invest)} a month this year.`);
    };
    const btn = $('#rvSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    setTimeout(() => {
      if (!rv.evals) rv.evals = { before: evaluatePlan(d.expectedPlan), after: evaluatePlan(applyMarketTo(d.plan)) };
      finish();
    }, 30);
  }

  let toastTimer = null;
  function toast(text, action) {
    const t = $('#toast');
    setKids(t, h('span', {}, text), action ? h('button', { type: 'button', class: 'btn small', onclick: () => { t.hidden = true; action.run(); } }, action.label) : null);
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, action ? 14000 : 7000);
  }

  // Progress tab: the most recent check-in against the prediction made before it.
  function renderProgressReview() {
    const box = $('#progReview');
    const list = ws.checkins.slice().sort((a, b) => a.date.localeCompare(b.date));
    const latest = list[list.length - 1];
    if (!latest) { box.hidden = true; return; }
    const prev = RV.previousCheckin(list, latest.year);
    const pred = RV.predictedFor(prev, latest.year);
    box.hidden = false;
    const kids = [h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, `Latest review: ${latest.year}`),
      h('p', { class: 'sub' }, `Recorded ${fmtDate(latest.date)} from “${latest.scenarioName || 'your plan'}”.${latest.note ? ` Notes: ${latest.note}` : ''}`)))];
    if (pred) {
      const diff = latest.actual.netWorth - pred.netWorth;
      kids.push(h('p', { class: 'rv-line' }, `Net worth ${money(latest.actual.netWorth)} against ${money(pred.netWorth)} predicted in ${pred.from}: `,
        h('strong', { class: diff >= 0 ? 'pos' : 'neg' }, `${diff >= 0 ? '+' : '−'}${money(Math.abs(diff))} (${diff >= 0 ? '+' : '−'}${Math.abs(diff / pred.netWorth * 100).toFixed(1)}%)`)));
    }
    const base = pred && pred.byType ? pred.byType : prev ? prev.actual : null;
    if (base) {
      const rows = RV.TYPES.map(t => ({ type: t, label: RV.TYPE_LABELS[t], base: base[t] || 0, actual: latest.actual[t] || 0, diff: (t === 'debt' ? -1 : 1) * ((latest.actual[t] || 0) - (base[t] || 0)) }))
        .filter(r => Math.abs(r.base) > 0.5 || Math.abs(r.actual) > 0.5);
      kids.push(h('h3', { class: 'chart-title' }, pred && pred.byType ? 'What made the difference (actual minus prediction)' : `Change since ${prev.year}`),
        divergingBars(rows, pred && pred.byType ? `Predicted (${pred.from})` : `${prev.year}`));
    }
    if (latest.goals.length && prev && prev.goals.length) {
      kids.push(h('h3', { class: 'chart-title' }, 'Goals then and now'), h('div', { class: 'table-wrap' }, table(['Goal', `${prev.year}`, `${latest.year}`, 'Change'],
        latest.goals.map(g => {
          const was = prev.goals.find(x => x.title === g.title);
          return { cells: [g.title, was ? pct(was.probability) : '—', pct(g.probability), was ? deltaCell(Math.round(was.probability * 100), Math.round(g.probability * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} pts`) : '—'] };
        }))));
    }
    setKids(box, ...kids);
  }

  // Review tab: what the yearly review does, and when.
  function renderReviewIntro() {
    const due = RV.due(ws);
    const last = ws.checkins.filter(c => c.scenarioName !== 'Manual').sort((a, b) => a.date.localeCompare(b.date)).pop();
    setKids($('#reviewIntro'), 
      h('div', { class: 'card-head' },
        h('div', {}, h('h2', {}, due.due ? `Time for your ${due.year} yearly review` : 'Yearly review'),
          h('p', { class: 'sub' }, 'Once a year, swap Horizon’s estimates for the real numbers. Every balance, income and spending item is already filled in with what the plan expected by the review date, so you only correct what is different. Horizon then shows how close last year’s plan was, moves every scenario on a year and saves the check-in for next time.')),
        h('div', { class: 'controls' },
          h('button', { type: 'button', class: 'btn', onclick: openUpdate }, 'Update balances'),
          h('button', { type: 'button', class: 'btn primary', id: 'reviewBtn', onclick: () => openReview() }, due.due ? 'Start review' : 'Start yearly review'))),
      h('ol', { class: 'rv-steps' }, ['Balances, as at the review date', 'Income', 'Spending', 'Market assumptions', 'How you did', 'Update scenarios'].map(x => h('li', {}, x))),
      h('div', { class: 'gh-facts' },
        h('div', {}, h('span', { class: 'rv-k' }, 'Your figures are as at'), h('strong', {}, fmtDate(asOf()))),
        h('div', {}, h('span', { class: 'rv-k' }, 'Last review'), h('strong', {}, last ? fmtDate(last.date) : 'None yet')),
        h('div', {}, h('span', { class: 'rv-k' }, 'Next review'), h('strong', {}, due.due ? 'Due now' : `October ${due.next}`))));
  }

  // ------------------------------------------------------------------ update balances (between reviews)

  let ud = null;

  function openUpdate() {
    ud = { date: today(), values: {} };
    renderUpdate();
    $('#updateDlg').showModal();
  }

  function renderUpdate() {
    const p = plan();
    const est = RV.estimateAt(p, ud.date, model.proj);
    const dateIn = h('input', { type: 'date', value: ud.date, max: today(), 'aria-label': 'Balances as at', onchange: e => { if (E.isDate(e.target.value)) { ud.date = e.target.value; renderUpdate(); } } });
    const rows = p.accounts.map(a => {
      const v = est.byId[a.id];
      const debtish = a.type === 'debt';
      const diff = h('span', { class: 'rv-diff muted' });
      const row = h('div', { class: `rv-row${ud.values[a.id] !== undefined ? ' done' : ''}`, style: `--item-color:${cssVar(TYPE_COLOR[a.type])}` });
      const setDiff = () => {
        const x = ud.values[a.id];
        if (x === undefined) { diff.textContent = est.reading[a.id] ? `Updated ${fmtDate(est.reading[a.id].date)}` : 'Estimated'; diff.className = 'rv-diff muted'; return; }
        const dv = x - v;
        if (Math.abs(dv) < 0.5) { diff.textContent = 'As estimated'; diff.className = 'rv-diff muted'; return; }
        diff.textContent = `${dv > 0 ? '+' : '−'}${money(Math.abs(dv))} vs estimate`;
        diff.className = `rv-diff ${(dv > 0) !== debtish ? 'pos' : 'neg'}`;
      };
      const input = h('input', { type: 'text', inputmode: 'decimal', value: plain(Math.round(ud.values[a.id] !== undefined ? ud.values[a.id] : v)), 'aria-label': `${a.name} now` });
      input.addEventListener('input', () => { ud.values[a.id] = parseAmount(input.value); row.classList.add('done'); setDiff(); updateUpdateNote(); });
      input.addEventListener('focus', () => input.select());
      setDiff();
      row.append(
        h('div', { class: 'rv-name' }, h('span', {}, a.name), h('span', { class: 'tag' }, a.excluded ? 'Not counted' : ACCOUNT_LABELS[a.type])),
        h('div', { class: 'rv-num' }, h('span', { class: 'rv-k' }, `On ${fmtDate(est.asOf)}`), money(a.balance)),
        h('div', { class: 'rv-num' }, h('span', { class: 'rv-k' }, 'Estimated'), money(v)),
        h('label', { class: 'rv-in' }, h('span', { class: 'rv-k' }, debtish ? 'Owed now' : a.type === 'property' ? 'Worth now' : 'Balance now'), h('div', { class: 'adorn has-pre' }, h('span', { class: 'pre' }, '£'), input)),
        diff);
      return row;
    });
    setKids($('#udBody'), 
      h('label', { class: 'asof-label' }, h('strong', {}, 'Balances as at'), dateIn),
      p.accounts.length ? h('div', { class: 'rv-rows' }, rows) : h('p', { class: 'sub' }, 'No accounts yet: add them in Finances → Portfolio.'));
    updateUpdateNote();
  }

  function updateUpdateNote() {
    const n = Object.keys(ud.values).length;
    $('#udNote').textContent = n ? `${n} balance${n === 1 ? '' : 's'} to save, as at ${fmtDate(ud.date)}.` : 'Type over any estimate to update it.';
    $('#udSave').disabled = !n;
  }

  function saveUpdate() {
    const n = Object.keys(ud.values).length;
    if (!n) return;
    ws = RV.recordReadings(ws, ud.values, ud.date);
    $('#updateDlg').close();
    ud = null;
    renderPlan();
    refresh();
    toast(`Updated ${n} balance${n === 1 ? '' : 's'}. They show on Home now and fill in your next yearly review.`);
  }

  function addManualCheckin(e) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const year = parseInt(f.get('year'), 10);
    const netWorth = parseAmount(f.get('netWorth'));
    const predicted = parseAmount(f.get('predicted') || '');
    const c = E.normalizeCheckin({
      date: `${year}-01-01`, year, scenarioName: 'Manual',
      actual: { netWorth, spending: parseAmount(f.get('spending') || '') },
      predicted: predicted ? { years: [year, year + 1], netWorth: [netWorth, predicted], liquid: [] } : { years: [year], netWorth: [netWorth], liquid: [] },
    });
    ws.checkins = ws.checkins.filter(x => x.year !== year || x.date.slice(5) !== '01-01');
    ws.checkins.push(c);
    ws.checkins.sort((a, b) => a.date.localeCompare(b.date));
    save();
    e.currentTarget.reset();
    renderProgress();
  }

  // ------------------------------------------------------------------ form controls

  function field(label, control, hint) {
    return h('label', { class: 'field' }, h('span', {}, label), control, hint ? h('span', { class: 'hint' }, hint) : null);
  }

  function moneyInput(get, set, opts = {}) {
    const input = h('input', { type: 'text', inputmode: 'decimal', value: plain(get()), 'aria-label': opts.label, disabled: opts.disabled });
    input.addEventListener('input', () => { set(parseAmount(input.value)); schedule(); });
    input.addEventListener('blur', () => { input.value = plain(get()); });
    if (opts.prefix === '') return h('div', { class: 'adorn' }, input);
    return h('div', { class: 'adorn has-pre' }, h('span', { class: 'pre' }, '£'), input);
  }

  function moneyInputPlain(get, set, label) {
    const input = h('input', { type: 'text', inputmode: 'decimal', value: get() ? plain(get()) : '', placeholder: '0', 'aria-label': label });
    input.addEventListener('input', () => set(parseAmount(input.value)));
    input.addEventListener('blur', () => { input.value = get() ? plain(get()) : ''; });
    return h('div', { class: 'adorn has-pre' }, h('span', { class: 'pre' }, '£'), input);
  }

  function numInput(get, set, opts = {}) {
    const input = h('input', {
      type: 'number', value: get(), step: opts.step || 1, min: opts.min, max: opts.max,
      'aria-label': opts.label, disabled: opts.disabled, inputmode: 'decimal',
    });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      set(Number.isFinite(v) ? v : 0);
      if (opts.rerender) renderSection(opts.rerender);
      schedule();
    });
    if (!opts.suffix) return input;
    return h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, opts.suffix));
  }

  function selectInput(options, get, set, opts = {}) {
    return h('select', {
      'aria-label': opts.label, disabled: opts.disabled,
      onchange: e => { set(e.target.value); if (opts.rerender) renderSection(opts.rerender); schedule(); },
    }, options.map(([v, l]) => h('option', { value: v, selected: String(get()) === String(v) }, l)));
  }

  function switchInput(label, get, set, opts = {}) {
    return h('label', { class: 'switch' }, h('input', {
      type: 'checkbox', checked: !!get(), role: 'switch',
      onchange: e => { set(e.target.checked); if (opts.rerender) renderSection(opts.rerender); if (opts.after) opts.after(); schedule(); },
    }), label);
  }

  const bind = (obj, key) => [() => obj[key], v => { obj[key] = v; }];

  function ownerOptions(includeJoint) {
    const o = people().map(p => [p.id, p.name]);
    if (includeJoint && people().length > 1) o.push(['joint', 'Joint']);
    return o;
  }

  function timingControl(item, which, sectionId) {
    const refKey = which === 'start' ? 'startRef' : 'endRef';
    const ageKey = which === 'start' ? 'startAge' : 'endAge';
    const opts = which === 'start'
      ? [['now', 'Now'], ['retire', 'At retirement'], ['age', 'At age…']]
      : [['retire', 'At retirement'], ['end', 'End of plan'], ['age', 'At age…']];
    const sel = selectInput(opts, ...bind(item, refKey), { rerender: sectionId, label: which === 'start' ? 'Starts' : 'Ends' });
    if (item[refKey] !== 'age') return sel;
    return h('div', { class: 'pair' }, sel, numInput(...bind(item, ageKey), { label: 'Age', min: 0, max: 120 }));
  }

  function deleteButton(label, onclick) {
    return h('button', { type: 'button', class: 'btn ghost icon-btn small', 'aria-label': label, title: label, onclick }, '✕');
  }

  function removeFrom(list, item, sectionId) {
    const i = list.indexOf(item);
    if (i >= 0) list.splice(i, 1);
    renderSection(sectionId);
    refresh();
  }

  // ------------------------------------------------------------------ plan editor sections

  const SECTIONS = [
    { id: 'household', title: 'Household', render: renderHousehold },
    { id: 'income', title: 'Income', render: renderIncome, count: () => plan().income.length },
    { id: 'expenses', title: 'Spending', render: renderExpenses, count: () => plan().expenses.length },
    { id: 'events', title: 'One-off events', render: renderEvents, count: () => plan().events.length },
    { id: 'accounts', title: 'Accounts', render: renderAccounts, count: () => plan().accounts.length },
    { id: 'strategy', title: 'Saving strategy', render: renderStrategy },
    { id: 'market', title: 'Markets & inflation', render: renderMarket },
    { id: 'tax', title: 'Tax rules', render: renderTax },
    { id: 'scenario', title: 'This scenario', render: renderScenarioSection },
  ];

  // Render every input section once (they keep focus while the results update).
  function renderPlan() {
    for (const s of SECTIONS) renderSection(s.id);
    renderMoneyNav();
  }

  function renderSection(id) {
    const s = SECTIONS.find(x => x.id === id);
    const el = $(`#sec-${id}`);
    if (!s || !el) return;
    setKids(el, ...[].concat(s.render()));
    if (s.count) renderMoneyNav();
    if (id === 'income') requestAnimationFrame(updateIncomeTrends);
    if (id === 'accounts') updateAccountFigures();
  }

  // Each account's estimate for today, kept in step without re-rendering the inputs.
  function updateAccountFigures() {
    if (!model) return;
    for (const el of $$('[data-est]')) {
      const v = model.est.byId[el.dataset.est];
      el.textContent = v === undefined ? '' : `≈ ${money(v)} today`;
    }
  }

  function sectionHead(id, title, sub, ...actions) {
    return h('div', { class: 'section-head' },
      h('div', {}, h('h2', { id: `h-${id}` }, title), sub ? h('p', { class: 'sub' }, sub) : null),
      actions.length ? h('div', { class: 'controls' }, actions) : null);
  }

  // Collapsible "More options" that stays open across re-renders.
  const openMore = new Set();
  function more(key, label, ...children) {
    // Remember open/closed straight away (the toggle event comes later), so a redraw
    // triggered by the next change keeps it open.
    const det = h('details', { class: 'more', open: openMore.has(key) },
      h('summary', { onclick: () => { if (det.open) openMore.delete(key); else openMore.add(key); } }, label), h('div', { class: 'more-body' }, children));
    det.addEventListener('toggle', () => { if (det.open) openMore.add(key); else openMore.delete(key); });
    return det;
  }

  // Number input that may be left empty (null).
  function optNumInput(get, set, opts = {}) {
    const input = h('input', { type: 'number', value: get() === null ? '' : get(), step: opts.step || 0.1, placeholder: opts.placeholder || '', 'aria-label': opts.label, inputmode: 'decimal' });
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      set(input.value.trim() === '' || !Number.isFinite(v) ? null : v);
      schedule();
    });
    return h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, opts.suffix || '%'));
  }

  function renderHousehold() {
    const hh = plan().household;
    const cards = hh.people.map((p, i) => h('div', { class: 'item', style: `--item-color:${cssVar(i ? '--s2' : '--s1')}` },
      h('div', { class: 'item-head' },
        h('input', { type: 'text', class: 'name', value: p.name, 'aria-label': 'Name', oninput: e => { p.name = e.target.value; schedule(); } }),
        i > 0 ? deleteButton('Remove partner', () => removePartner()) : null),
      h('div', { class: 'fields' },
        field('Age now', numInput(...bind(p, 'age'), { min: 16, max: 100 })),
        field('Retirement age', numInput(...bind(p, 'retireAge'), { min: 16, max: 100 }))),
      more(`person-${i}`, 'More options',
        h('div', { class: 'fields' },
          field('Plan until age', numInput(...bind(p, 'endAge'), { min: 50, max: 120 })),
          field('State Pension (£/year, today)', moneyInput(...bind(p, 'statePension')), `Full new State Pension is ${money(R.STATE_PENSION_FULL)}. Forecast at gov.uk/check-state-pension.`),
          field('State Pension age', numInput(...bind(p, 'statePensionAge'), { min: 60, max: 75 }), `Born ${plan().startYear - p.age}: ${R.statePensionAge(plan().startYear - p.age)} under current law.`),
          field('Can access pension from', numInput(...bind(p, 'pensionAccessAge'), { min: 50, max: 75 }), 'Minimum pension age is 57 from April 2028.'),
          field('Extra pension saving (£/month)', moneyInput(...bind(p, 'extraPension')), 'Paid from take-home pay until retirement; 20% tax relief is added, and higher-rate relief is claimed back (Saving strategy).')))));
    return [
      sectionHead('household', 'Household', 'Who the plan is for.',
        hh.people.length < 2 ? h('button', { type: 'button', class: 'btn small', onclick: addPartner }, '+ Add partner') : null),
      h('div', { class: 'fields', style: 'margin-bottom:12px' },
        h('div', { class: 'field' }, h('span', {}, 'Tax'),
          switchInput('Work out UK tax', () => !hh.ignoreTax, v => { hh.ignoreTax = !v; }, { rerender: 'household', after: () => { renderSection('income'); renderSection('tax'); } }),
          h('span', { class: 'hint' }, hh.ignoreTax ? 'Off: every amount is treated as already taxed. Good for a quick plan with take-home figures.' : 'Income tax, NI and capital gains tax for each person. Turn off to ignore tax everywhere.')),
        hh.ignoreTax ? null : field('Tax rules', selectInput([['scotland', 'Scotland'], ['ruk', 'England, Wales & NI']], ...bind(hh, 'region'), { rerender: 'tax' }))),
      h('div', { class: 'people' }, cards),
    ];
  }

  function addPartner() {
    const p1 = people()[0];
    plan().household.people.push({ id: 'p2', name: 'Partner', age: p1.age, retireAge: p1.retireAge, endAge: p1.endAge, statePension: R.STATE_PENSION_FULL, statePensionAge: p1.statePensionAge, pensionAccessAge: R.MIN_PENSION_AGE, extraPension: 0 });
    explorerValues = null;
    renderPlan();
    refresh();
  }

  function removePartner() {
    const p2 = people()[1];
    if (!confirm(`Remove ${p2.name}? Their accounts and income move to ${people()[0].name}.`)) return;
    const p = plan();
    p.household.people.splice(1, 1);
    for (const a of p.accounts) if (a.owner === 'p2') a.owner = E.OWNED_TYPES.includes(a.type) ? 'p1' : 'joint';
    for (const i of p.income) if (i.owner === 'p2') i.owner = 'p1';
    for (const e of p.expenses) if (e.owner === 'p2') e.owner = 'joint';
    scenario().plan = E.normalizePlan(p);
    explorerValues = null;
    renderPlan();
    refresh();
  }

  function growthControl(item, sectionId) {
    return h('div', { class: 'field' }, h('span', {}, 'Grows'),
      switchInput('With inflation', ...bind(item, 'inflationLinked'), { rerender: sectionId }),
      item.inflationLinked ? null : numInput(...bind(item, 'growth'), { step: 0.1, suffix: '%/yr', label: 'Growth per year' }));
  }

  function amountWithFreq(item, sectionId) {
    return h('div', { class: 'pair' }, moneyInput(...bind(item, 'amount'), { label: 'Amount', prefix: item.fx !== undefined && item.fx !== 1 ? '' : '£' }),
      selectInput([['month', 'a month'], ['year', 'a year']], ...bind(item, 'freq'), { label: 'Frequency', rerender: sectionId }));
  }

  // Inline "typical trend" charts in income cards.
  const incomeTrends = new Map();

  function updateIncomeTrends() {
    const p = plan();
    for (const item of p.income) {
      const host = document.querySelector(`[data-trend="${item.id}"]`);
      if (!host) continue;
      let c = incomeTrends.get(host);
      if (!c) { c = new Chart(host, { height: 150, label: `${item.name}: typical range over time` }); incomeTrends.set(host, c); }
      const b = E.streamBands(p, item, 300, 7);
      // Only show the years the income is paid (plus one to show it stopping).
      let last = b.expected.length - 1;
      while (last > 1 && b.expected[last - 1] <= 0) last--;
      const cut = arr => arr.slice(0, last + 1);
      const bands = {};
      for (const [k, v] of Object.entries(b[view()])) bands[k] = cut(v);
      const expected = cut(b.expected.map((v, t) => (real() ? v / b.price[t] : v)));
      const years = cut(b.years);
      c.set({
        ...fanConfig(years, bands, { expected, title: i => String(years[i]) }),
      });
      const cap = host.parentElement.querySelector('.trend-caption');
      const t10 = Math.min(10, years.length - 1);
      if (cap) {
        cap.textContent = expected[t10] > 0
          ? `In ${years[t10]}: about ${money(expected[t10])} a year (${unitLabel()}); 8 in 10 simulations between ${money(bands.p10[t10])} and ${money(bands.p90[t10])}.`
          : 'Stops within 10 years.';
      }
    }
  }

  const KIND_LABELS = [['salary', 'Salary'], ['rental', 'Rent'], ['other', 'Other income'], ['dbpension', 'Defined benefit pension (e.g. USS)']];
  const kindLabel = k => (KIND_LABELS.find(x => x[0] === k) || [k, k])[1];

  function setKind(item, v) {
    item.kind = v;
    if (v === 'dbpension') {
      const person = people()[E.personIndex(plan(), item.owner === 'joint' ? 'p1' : item.owner)];
      if (item.owner === 'joint') item.owner = person.id;
      item.startRef = 'age';
      item.startAge = person.statePensionAge;
      item.endRef = 'end';
      item.freq = 'year';
      item.tax = 'uk';
      item.inflationLinked = true;
    }
  }

  function dbWorking(item, p) {
    const person = people()[E.personIndex(p, item.owner)];
    const atStart = E.incomeAfterCosts(item, p, Math.max(0, item.startAge - person.age));
    const today = atStart / Math.pow(1 + p.assumptions.inflation / 100, Math.max(0, item.startAge - person.age));
    return `${money(item.amount)} + ${money(item.dbAccrual)} × ${Math.max(0, Math.min(person.retireAge, item.startAge) - person.age)} more years of work = ${money(today)} a year in today's money from age ${item.startAge}, rising with prices${item.lumpMultiple > 0 ? `, plus a ${money(today * item.lumpMultiple)} lump sum` : ''}.`;
  }

  function renderDbPension(item, p) {
    const person = people()[E.personIndex(p, item.owner)];
    return h('div', { class: 'item', style: `--item-color:${cssVar('--s4')}` },
      h('div', { class: 'item-head' },
        h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Income name', oninput: e => { item.name = e.target.value; schedule(); } }),
        h('span', { class: 'tag' }, 'Defined benefit pension'),
        h('span', { class: 'tag', 'data-net': item.id }, incomeTag(item, p)),
        deleteButton(`Remove ${item.name}`, () => removeFrom(p.income, item, 'income'))),
      h('div', { class: 'fields' },
        field('Whose', selectInput(ownerOptions(false), ...bind(item, 'owner'), { rerender: 'income' })),
        field('Built up so far (£ a year)', moneyInput(...bind(item, 'amount'), { label: 'Pension built up so far' }), 'From the latest benefit statement.'),
        field('Added each year you keep working', moneyInput(...bind(item, 'dbAccrual'), { label: 'Pension added each year' }), 'USS adds about 1/75 of salary a year.'),
        field('Paid from age', numInput(...bind(item, 'startAge'), { min: 50, max: 75, label: 'Pension age' }), `${person.name}'s State Pension age is ${person.statePensionAge}.`),
        field('Tax-free lump sum', numInput(...bind(item, 'lumpMultiple'), { min: 0, max: 10, step: 0.5, suffix: '× pension', label: 'Lump sum multiple' }), 'USS pays 3× the pension as cash; 0 if none.'),
        field('Tax', selectInput(taxOptions(item.kind), ...bind(item, 'tax'), { rerender: 'income' }))),
      h('p', { class: 'hint calc', 'data-calc': item.id }, dbWorking(item, p)),
      dbEstimator(item, p, person));
  }

  // "Don't know what's built up?" Estimate it from the scheme, year joined and salary.
  function dbEstimate(item) {
    return E.estimateDb({ scheme: item.dbScheme || 'uss', joined: item.dbJoined || plan().startYear, salary: item.dbSalary, startYear: plan().startYear, realGrowth: 1 });
  }

  function dbEstimateText(item, person) {
    const e = dbEstimate(item);
    if (!item.dbSalary) return 'Enter the salary to see an estimate.';
    const age = e.pensionAge || person.statePensionAge;
    return `${e.years} year${e.years === 1 ? '' : 's'} so far ≈ ${money(e.builtUp)} a year of pension built up (today's money); each further year adds ≈ ${money(e.perYear)}. Normally paid from ${age}${e.lumpMultiple ? `, plus a lump sum of ${e.lumpMultiple}× the pension` : ''}.`;
  }

  function dbEstimator(item, p, person) {
    if (!item.dbScheme) item.dbScheme = 'uss';
    const pay = p.income.find(i => i.kind === 'salary' && i.owner === item.owner);
    const guess = pay ? (E.taxOf(pay, p) === 'uk' ? pay.amount * (pay.freq === 'month' ? 12 : 1) : R.grossFromTakeHome(pay.amount * (pay.freq === 'month' ? 12 : 1), p.household.region)) : 0;
    if (!item.dbSalary && guess) item.dbSalary = Math.round(guess / 100) * 100;
    return more(`db-est-${item.id}`, 'Not sure what’s built up? Estimate it',
      h('div', { class: 'fields' },
        field('Scheme', selectInput(Object.entries(R.DB_SCHEMES).map(([k, v]) => [k, `${v.label}${k === 'other' ? '' : ` (1/${v.accrual})`}`]), ...bind(item, 'dbScheme'), { label: 'Scheme' })),
        field('Joined in', numInput(...bind(item, 'dbJoined'), { min: 1960, max: p.startYear, label: 'Year joined' })),
        field('Salary now (before tax, a year)', moneyInput(...bind(item, 'dbSalary'), { label: 'Salary for the estimate' }), pay ? `${E.taxOf(pay, p) === 'uk' ? 'From' : 'Worked out roughly from'} ${pay.name}: ${money(guess)}.` : null)),
      h('p', { class: 'hint calc-est', 'data-dbest': item.id }, dbEstimateText(item, person)),
      h('p', { class: 'hint' }, 'Assumes earlier salaries were about 1% a year lower in today’s money, and full-time membership since joining. Your annual benefit statement (or the scheme’s online account) gives the exact figure.'),
      h('div', { class: 'add-row' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
        const e = dbEstimate(item);
        item.amount = Math.round(e.builtUp);
        item.dbAccrual = Math.round(e.perYear);
        item.lumpMultiple = e.lumpMultiple;
        item.startAge = e.pensionAge || person.statePensionAge;
        renderSection('income');
        refresh();
      } }, 'Use this estimate')));
  }
  function taxOptions(kind) {
    return kind === 'salary'
      ? [['uk', 'Before tax (work out tax & NI)'], ['none', 'Take-home (already taxed)'], ['flat', 'Flat tax rate']]
      : [['none', 'No tax (gift or already taxed)'], ['uk', 'UK income tax'], ['flat', 'Flat tax rate']];
  }

  function renderIncome() {
    const p = plan();
    const ignore = p.household.ignoreTax;
    const items = p.income.map(item => {
      if (item.kind === 'dbpension') return renderDbPension(item, p);
      const isSalary = item.kind === 'salary';
      const owner = item.owner === 'joint' ? people()[0] : people()[E.personIndex(p, item.owner)];
      const hasCosts = item.fx !== 1 || item.costPct > 0 || item.fixedCosts > 0;
      const costFields = [
        field(item.fx !== 1 ? `Exchange rate (£ per unit)` : 'Paid in another currency?', numInput(...bind(item, 'fx'), { step: 0.01, min: 0, label: 'Exchange rate' }), 'Leave at 1 for pounds. E.g. 0.84 for euros.'),
        field('Costs (% of income)', numInput(...bind(item, 'costPct'), { step: 1, min: 0, max: 100, suffix: '%' }), item.kind === 'rental' ? 'Maintenance, management, voids.' : 'Any share that never reaches you.'),
        field('Fixed costs (£/year, today)', moneyInput(...bind(item, 'fixedCosts')), 'E.g. insurance or service charges.'),
      ];
      return h('div', { class: 'item', style: `--item-color:${cssVar('--s1')}` },
        h('div', { class: 'item-head' },
          h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Income name', oninput: e => { item.name = e.target.value; schedule(); } }),
          h('span', { class: 'tag' }, kindLabel(item.kind)),
          h('span', { class: 'tag', title: 'This year, after costs and any flat tax', 'data-net': item.id }, incomeTag(item, p)),
          deleteButton(`Remove ${item.name}`, () => removeFrom(p.income, item, 'income'))),
        h('div', { class: 'fields' },
          field('Whose', selectInput(ownerOptions(!isSalary), ...bind(item, 'owner'), { rerender: 'income' })),
            field('Amount', amountWithFreq(item, 'income')),
          field('Tax', selectInput(taxOptions(item.kind), ...bind(item, 'tax'), { rerender: 'income' }), ignore && item.tax === 'uk' ? 'Tax is switched off for the household.' : null),
          item.tax === 'flat' ? field('Tax rate', numInput(...bind(item, 'taxRate'), { step: 1, min: 0, max: 100, suffix: '%' }), 'E.g. tax withheld abroad.') : null,
          item.kind === 'rental' ? costFields : null),
        item.kind === 'rental' && hasCosts ? h('p', { class: 'hint calc', 'data-calc': item.id }, incomeWorking(item, p)) : null,
        more(`income-${item.id}`, 'More options',
          h('div', { class: 'fields' },
            growthControl(item, 'income'),
            field(`Starts (${owner.name}'s age)`, timingControl(item, 'start', 'income')),
            field('Ends', timingControl(item, 'end', 'income')),
            item.kind !== 'rental' ? costFields : null),
          item.kind !== 'rental' && hasCosts ? h('p', { class: 'hint calc', 'data-calc': item.id }, incomeWorking(item, p)) : null,
          isSalary && item.owner !== 'joint' ? h('div', { class: 'sub-fields' },
            h('h3', {}, 'Workplace pension'),
            h('div', { class: 'fields', style: 'margin-top:8px' },
              field('Contributions as', selectInput([['pct', '% of salary'], ['fixed', '£ per month']], ...bind(item, 'pensionMode'), { rerender: 'income' })),
              field('You pay', item.pensionMode === 'pct' ? numInput(...bind(item, 'employeePension'), { step: 0.5, suffix: '%' }) : moneyInput(...bind(item, 'employeePension'))),
              field('Employer pays', item.pensionMode === 'pct' ? numInput(...bind(item, 'employerPension'), { step: 0.5, suffix: '%' }) : moneyInput(...bind(item, 'employerPension'))),
              item.tax === 'uk' && !ignore
                ? h('div', { class: 'field' }, h('span', {}, 'Paid by'), switchInput('Salary sacrifice', ...bind(item, 'sacrifice')), h('span', { class: 'hint' }, 'Saves NI too (only on the first £2,000 a year from April 2029).'))
                : h('p', { class: 'hint', style: 'align-self:center' }, 'Take-home pay is after your contributions; both still go into the pot.'))) : null),
        h('details', { class: 'trend' },
          h('summary', {}, 'Typical trend'),
          h('p', { class: 'hint' }, `Dashed: the expected path. Shaded: where 50% and 80% of simulations land, with ${isSalary ? 'salary and ' : ''}inflation surprises. In ${unitLabel()}, after costs.`),
          h('div', { class: 'chart mini', 'data-trend': item.id }),
          h('p', { class: 'trend-caption sub' })));
    });
    return [
      sectionHead('income', 'Income', 'Salaries, rent, gifts, side income. Enter the amount as at the date above; it grows from there. Extra settings are under “More options”. Added the wrong kind? Remove it and add the right one.'),
      h('div', { class: 'items' }, items.length ? items : h('p', { class: 'sub' }, 'No income yet.')),
      h('div', { class: 'add-row' }, KIND_LABELS.map(([kind, label]) => h('button', { type: 'button', class: 'btn small', onclick: () => {
        const item = E.normalizePlan({ ...p, income: [{ name: kind === 'dbpension' ? 'Defined benefit pension' : kind === 'salary' ? 'Salary' : label, owner: 'p1', kind, tax: 'none', amount: 0, freq: kind === 'dbpension' ? 'year' : 'month', growth: kind === 'salary' ? 3 : 0, inflationLinked: kind !== 'salary' }] }).income[0];
        setKind(item, kind);
        p.income.push(item);
        renderSection('income');
        refresh();
      } }, `+ ${kind === 'dbpension' ? 'Defined benefit pension' : label}`))),
    ];
  }

  function incomeTag(item, p) {
    const afterCosts = E.incomeAfterCosts(item, p, 0);
    const net = E.taxOf(item, p) === 'flat' ? afterCosts * (1 - item.taxRate / 100) : afterCosts;
    return net > 0 ? `${money(net / 12)}/month now` : 'Not this year';
  }

  // Keep the per-income figures in step with edits without re-rendering the inputs.
  function updateIncomeFigures() {
    const p = plan();
    for (const el of $$('[data-net]')) { const it = p.income.find(i => i.id === el.dataset.net); if (it) el.textContent = incomeTag(it, p); }
    for (const el of $$('[data-calc]')) { const it = p.income.find(i => i.id === el.dataset.calc); if (it) el.textContent = it.kind === 'dbpension' ? dbWorking(it, p) : incomeWorking(it, p); }
    for (const el of $$('[data-dbest]')) { const it = p.income.find(i => i.id === el.dataset.dbest); if (it) el.textContent = dbEstimateText(it, people()[E.personIndex(p, it.owner)]); }
  }

  // "€1,148 × 0.84 − 10% costs − 10% tax = £781 a month", like a spreadsheet formula.
  function incomeWorking(item, p) {
    const per = item.freq === 'month' ? 'a month' : 'a year';
    const parts = [item.fx !== 1 ? `${plain(item.amount)} × ${item.fx}` : money(item.amount)];
    let v = item.amount * item.fx;
    if (item.costPct > 0) { parts.push(`− ${item.costPct}% costs`); v *= 1 - item.costPct / 100; }
    if (item.fixedCosts > 0) { const fc = item.fixedCosts / (item.freq === 'month' ? 12 : 1); parts.push(`− ${money(fc)} fixed costs`); v -= fc; }
    const tax = E.taxOf(item, p);
    if (tax === 'flat' && item.taxRate > 0) { parts.push(`− ${item.taxRate}% tax`); v *= 1 - item.taxRate / 100; }
    return `This year: ${parts.join(' ')} = ${money(Math.max(0, v))} ${per}${tax === 'uk' ? ', before UK income tax' : ''}.`;
  }

  function renderExpenses() {
    const p = plan();
    const now = p.expenses.reduce((acc, e) => acc + E.streamAt(e, p, 0), 0);
    const rows = p.expenses.map(item => {
      const amt = E.streamAt(item, p, 0);
      const more = h('details', {},
        h('summary', { class: 'btn small ghost', 'aria-label': `More options for ${item.name}` }, 'More'));
      const panel = h('div', { class: 'row-more', hidden: true },
        h('div', { class: 'fields' },
          growthControl(item, 'expenses'),
          field('Starts', timingControl(item, 'start', 'expenses')),
          people().length > 1 ? field('Ages refer to', selectInput(ownerOptions(true).map(([v, l]) => [v, v === 'joint' ? people()[0].name : l]), ...bind(item, 'owner'))) : null));
      more.addEventListener('toggle', () => { panel.hidden = !more.open; });
      return h('div', { class: 'row-item', style: `--item-color:${cssVar('--s5')}` },
        h('div', { class: 'row-main' },
          h('div', { class: 'name-cell' },
            h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Expense name', oninput: e => { item.name = e.target.value; schedule(); } }),
            amt <= 0 ? h('span', { class: 'tag' }, 'Not this year') : item.category ? h('span', { class: 'tag' }, item.category) : null),
          moneyInput(...bind(item, 'amount'), { label: `${item.name} amount` }),
          selectInput([['month', 'a month'], ['year', 'a year']], ...bind(item, 'freq'), { label: 'Frequency', rerender: 'expenses' }),
          timingControl(item, 'end', 'expenses'),
          more,
          deleteButton(`Remove ${item.name}`, () => removeFrom(p.expenses, item, 'expenses'))),
        panel);
    });
    const s = p.strategy;
    const adjust = [];
    if (s.spendNowPct !== 100) adjust.push(`scaled to ${s.spendNowPct}% before retirement`);
    if (s.retireSpending > 0) adjust.push(`replaced by ${money(s.retireSpending)} a year after retirement`);
    return [
      sectionHead('expenses', 'Spending', null,
        h('button', { type: 'button', class: 'btn small primary', onclick: openWizard }, 'Spending check-up'),
        h('button', { type: 'button', class: 'btn small', id: 'lifeBtn', onclick: openLifeWizard, title: 'Children, cars, home repairs, retirement travel and care: big costs that come later, added as dated spending items' }, 'Future costs'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { p.expenses.push(E.normalizePlan({ ...p, expenses: [{ name: 'New expense', amount: 0, freq: 'month', inflationLinked: true }] }).expenses[0]); renderSection('expenses'); refresh(); } }, '+ Add expense')),
      h('p', { class: 'total sub', style: 'margin:-6px 0 12px' }, 'This year: ', h('strong', {}, `${money(now / 12)} a month`), ` · ${money(now)} a year. Amounts are today's prices and rise with inflation unless you change it under More. Mortgage payments are under Accounts.${adjust.length ? ` Your saving strategy has this list ${adjust.join(' and ')}.` : ''}`),
      rows.length
        ? h('div', { class: 'rows' }, h('div', { class: 'row-head', 'aria-hidden': 'true' }, h('span', {}, 'What'), h('span', {}, 'Amount'), h('span', {}, 'How often'), h('span', {}, 'Until'), h('span'), h('span')), rows)
        : h('p', { class: 'sub' }, 'No spending yet. The check-up walks you through it.'),
    ];
  }

  function renderEvents() {
    const p = plan();
    const rows = p.events.map(ev => h('div', { class: 'row-item', style: `--item-color:${cssVar(ev.kind === 'income' ? '--s3' : ev.kind === 'overpay' ? '--s8' : '--s7')}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'name-cell' }, h('input', { type: 'text', class: 'name', value: ev.name, 'aria-label': 'Event name', oninput: e => { ev.name = e.target.value; schedule(); } })),
        selectInput([['expense', 'Spend'], ['income', 'Receive'], ['overpay', 'Pay off mortgage']], ...bind(ev, 'kind'), { rerender: 'events', label: 'Kind' }),
        numInput(...bind(ev, 'year'), { min: p.startYear, max: p.startYear + 80, label: 'Year' }),
        moneyInput(...bind(ev, 'amount'), { label: `${ev.name} amount` }),
        deleteButton(`Remove ${ev.name}`, () => removeFrom(p.events, ev, 'events')))));
    return [
      sectionHead('events', 'One-off events', "A new car, a wedding, an inheritance, a lump-sum mortgage overpayment. Amounts are in today's money and rise with inflation to the year they happen.",
        h('button', { type: 'button', class: 'btn small', onclick: () => { p.events.push(E.normalizePlan({ ...p, events: [{ name: 'New event', kind: 'expense', year: p.startYear + 1, amount: 0 }] }).events[0]); renderSection('events'); refresh(); } }, '+ Add event')),
      rows.length
        ? h('div', { class: 'rows events' }, h('div', { class: 'row-head', 'aria-hidden': 'true' }, h('span', {}, 'What'), h('span', {}, 'Kind'), h('span', {}, 'Year'), h('span', {}, 'Amount'), h('span')), rows)
        : h('p', { class: 'sub' }, 'No events.'),
    ];
  }

  const ACCOUNT_LABELS = {
    cash: 'Cash & savings', isa: 'ISA', lisa: 'Lifetime ISA', gia: 'General investment account', pension: 'Pension (workplace / SIPP)',
    bonds: 'Bonds & gilts', property: 'Property', debt: 'Mortgage or loan',
  };

  function renderAccounts() {
    const p = plan();
    const items = p.accounts.map(a => {
      const main = [];
      const extra = [];
      main.push(field(a.type === 'property' ? 'Value' : a.type === 'debt' ? 'Amount owed' : 'Balance', moneyInput(...bind(a, 'balance'))));
      if (E.OWNED_TYPES.includes(a.type)) main.push(field('Whose', selectInput(ownerOptions(false), ...bind(a, 'owner'))));
      if (a.type === 'lisa') {
        main.push(field('Pay in each year', moneyInput(...bind(a, 'contribution')), `Up to ${money(R.LISA.maxContribution)}; the government adds 25%. Paid from your surplus before other ISAs, until 50.`));
        extra.push(field('Saving for', selectInput([['retirement', 'Retirement (from 60)'], ['home', 'A first home']], ...bind(a, 'purpose'), { rerender: 'accounts' })));
        if (a.purpose === 'home') extra.push(field('Buying in', numInput(...bind(a, 'homeYear'), { min: plan().startYear, max: plan().startYear + 40, label: 'First home year' }), `Paid out that year with no charge if the home costs up to ${money(R.LISA.homePriceCap)}. Add the purchase itself as a one-off event.`));
        extra.push(h('p', { class: 'hint' }, `Withdrawals before 60 for anything else lose 25%, so the plan only uses it that way as a last resort. It counts within the ${money(R.ISA_ALLOWANCE)} ISA allowance and must be opened before 40.`));
      }
      if (a.type === 'gia') extra.push(field('Amount you paid in', moneyInput(...bind(a, 'basis')), 'Used to work out capital gains.'));
      if (a.type === 'bonds') {
        main.push(field('Interest', numInput(...bind(a, 'rate'), { step: 0.05, suffix: '%' })));
        extra.push(field('Matures in', numInput(...bind(a, 'maturityYear'), { min: 0, max: 2100 }), a.inIsa ? '0 = never. Pays out into the ISA.' : '0 = never. Pays out into cash.'));
        extra.push(h('div', { class: 'field' }, h('span', {}, 'Wrapper'),
          switchInput('Held in an ISA', ...bind(a, 'inIsa'), { rerender: 'accounts' }),
          h('span', { class: 'hint' }, 'When it matures the money stays in the ISA, without using that year’s allowance.')));
      }
      if (a.type === 'property') {
        main.push(field('Growth', numInput(...bind(a, 'rate'), { step: 0.1, suffix: '%/yr' }), 'Average; simulations add swings.'));
        extra.push(field('Sell in year', numInput(...bind(a, 'sellYear'), { min: 0, max: 2100 }), '0 = keep. Sale money is saved or invested.'));
      }
      if (a.type === 'debt') {
        main.push(field('Interest rate', numInput(...bind(a, 'rate'), { step: 0.05, suffix: '%' })));
        main.push(field('Monthly payment', moneyInput(...bind(a, 'payment'))));
        extra.push(field('Rate fixed until', numInput(...bind(a, 'fixedUntil'), { min: 0, max: 2100, rerender: 'accounts' }), '0 = fixed for good. The new rate applies from the following year.'));
        if (a.fixedUntil) {
          extra.push(field('Rate after the fix ends', optNumInput(...bind(a, 'rateAfterFix'), { placeholder: `Same (${a.rate}%)`, suffix: '%', step: 0.05, label: 'Rate after the fix ends' }),
            `Empty = the same rate.${MARKET ? ` Bank Rate is ${MARKET.series.bankRate.value}% (${MARKET.series.bankRate.date}).` : ''} Simulations also move it with inflation surprises.`));
          extra.push(field('When the fix ends', selectInput([['payment', 'Keep the payment (end date moves)'], ['term', 'Keep the end date (payment changes)']], ...bind(a, 'afterFix'), { label: 'When the fix ends' }),
            'Lenders usually reset the payment to keep the end date; keeping the payment shows how long it would take.'));
        }
      }
      extra.push(h('div', { class: 'field' }, h('span', {}, 'In the plan'),
        switchInput('Count this account', () => !a.excluded, v => { a.excluded = !v; }, { rerender: 'accounts' }),
        h('span', { class: 'hint' }, 'Turn off for something you want to list but not count, e.g. a home owned by family.')));
      return h('div', { class: 'item' + (a.excluded ? ' excluded' : ''), style: `--item-color:${cssVar(TYPE_COLOR[a.type])}` },
        h('div', { class: 'item-head' },
          h('input', { type: 'text', class: 'name', value: a.name, 'aria-label': 'Account name', oninput: e => { a.name = e.target.value; schedule(); } }),
          h('span', { class: 'tag' }, a.excluded ? 'Not counted' : ACCOUNT_LABELS[a.type]),
          h('span', { class: 'tag est', 'data-est': a.id, title: 'Estimated value today, moved on from this figure the way the plan expects' }),
          deleteButton(`Remove ${a.name}`, () => removeFrom(p.accounts, a, 'accounts'))),
        h('div', { class: 'fields' }, main),
        more(`account-${a.id}`, 'More options', h('div', { class: 'fields' }, extra)));
    });
    const add = type => h('button', { type: 'button', class: 'btn small', onclick: () => {
      p.accounts.push(E.normalizePlan({ ...p, accounts: [{ name: ACCOUNT_LABELS[type], type, owner: 'p1', balance: 0 }] }).accounts[0]);
      explorerValues = null;
      renderSection('accounts');
      refresh();
    } }, `+ ${ACCOUNT_LABELS[type]}`);
    return [
      sectionHead('accounts', 'Accounts', `What you had and owed on ${fmtDate(asOf())}. The yearly review brings them up to date; for a quick update between reviews, use Update balances on Home.`),
      h('div', { class: 'items' }, items),
      h('div', { class: 'add-row' }, Object.keys(ACCOUNT_LABELS).map(add)),
    ];
  }

  function renderStrategy() {
    const s = plan().strategy;
    return [
      sectionHead('strategy', 'Saving strategy', 'What happens to money left over each year: first the cash buffer, then mortgage overpayments, then ISAs, then a general investment account.'),
      h('div', { class: 'fields' },
        field('Cash buffer to keep', moneyInput(...bind(s, 'cashReserve')), 'Topped up first; spent last in retirement.'),
        field('Overpay mortgage with', numInput(...bind(s, 'overpayPct'), { min: 0, max: 100, step: 5, suffix: '%' }), 'Share of the surplus. Try a range in Scenarios.'),
        field('Overpayment limit', numInput(...bind(s, 'overpayCapPct'), { min: 0, max: 100, step: 1, suffix: '%/yr' }), 'Of the balance. 0 = no limit. Many lenders allow 10% a year.'),
        field('ISA allowance per person', moneyInput(...bind(s, 'isaAllowance')), `${money(R.ISA_ALLOWANCE)} in ${R.TAX_YEAR}.`),
        field('Spending before retirement', numInput(...bind(s, 'spendNowPct'), { min: 0, max: 300, step: 1, suffix: '%' }), 'Of your spending list. 100% = as listed.'),
        h('div', { class: 'field' }, h('span', {}, 'Pension tax relief'), switchInput('Claim higher-rate relief', ...bind(s, 'claimRelief')),
          h('span', { class: 'hint' }, 'On extra pension saving from take-home pay: tax above 20% (21–48% in Scotland, 40–45% elsewhere) comes back through self-assessment.')),
        field('Spending in retirement (a year)', moneyInput(...bind(s, 'retireSpending')), (() => {
          const std = people().length > 1 ? B.PLSA.couple : B.PLSA.single;
          return `Today’s money. 0 = keep using your spending list. PLSA guide for a ${people().length > 1 ? 'couple' : 'single person'}: moderate ${money(std.moderate)}, comfortable ${money(std.comfortable)}.`;
        })()),
        h('div', { class: 'field' }, h('span', {}, 'Spare cash'), switchInput('Invest cash above the buffer', ...bind(s, 'sweepCash')), h('span', { class: 'hint' }, 'E.g. gilts that mature or a windfall are invested each year instead of sitting in cash.'))),
      more('strategy-later', 'Spending later in life',
        h('div', { class: 'fields' },
          field('Spend less from age', numInput(...bind(s, 'slowDownAge'), { min: 0, max: 110 }), '0 = never. Future costs (in Spending) can set this.'),
          field('Spending from then', numInput(...bind(s, 'slowDownPct'), { min: 0, max: 200, step: 5, suffix: '%' }), 'Of normal spending.'))),
      h('p', { class: 'sub', style: 'margin-top:12px' }, 'In retirement, money comes from: cash above the buffer → pensions up to each person’s tax-free allowance → general investment account → ISAs → more pension (taxed) → the cash buffer.'),
    ];
  }

  function renderMarket() {
    const a = plan().assumptions;
    const out = [sectionHead('market', 'Markets & inflation', 'Long-run averages. The main ones are below; the rest are under “More options”.')];
    if (MARKET) {
      const sg = MARKET.suggested;
      out.push(h('div', { class: 'market-card' },
        h('h3', {}, `Latest UK data (as of ${MARKET.asOf})`),
        h('ul', {}, Object.values(MARKET.series).map(sr => h('li', {}, h('span', {}, sr.label, ' ', h('a', { href: sr.source, target: '_blank', rel: 'noopener noreferrer' }, 'source')), h('strong', {}, `${sr.value}% (${sr.date})`)))),
        h('p', { class: 'sub' }, `Suggested planning assumptions: inflation ${sg.inflation.value}%, cash ${sg.cashRate.value}%, bonds ${sg.bondReturn.value}%. ${sg.inflation.why}`),
        h('div', { class: 'add-row' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
          a.inflation = sg.inflation.value; a.cashRate = sg.cashRate.value; a.bondReturn = sg.bondReturn.value;
          renderSection('market'); refresh();
        } }, 'Use suggested values'))));
    }
    out.push(h('div', { class: 'fields' },
      field('Inflation', numInput(...bind(a, 'inflation'), { step: 0.1, suffix: '%/yr' })),
      field('Stock returns', numInput(...bind(a, 'stockReturn'), { step: 0.1, suffix: '%/yr' }), 'Average, before inflation.'),
      field('Stocks now', numInput(...bind(a, 'stockPctNow'), { min: 0, max: 100, step: 5, suffix: '%' })),
      field('Stocks at retirement', numInput(...bind(a, 'stockPctRetire'), { min: 0, max: 100, step: 5, suffix: '%' }), 'Moves gradually between the two.'),
      field('Cash interest', numInput(...bind(a, 'cashRate'), { step: 0.1, suffix: '%/yr' })),
      field('Fund & platform fees', numInput(...bind(a, 'fees'), { step: 0.01, min: 0, max: 3, suffix: '%/yr' }), 'Taken off ISA, GIA and pension growth, e.g. a global tracker’s charge plus the platform’s fee.')));
    out.push(more('market-returns', 'Use your own return for investments or pensions',
      h('p', { class: 'hint' }, 'Leave empty to use the stock/bond mix above. Set a number to use a fixed average instead, like a spreadsheet (simulations still add the usual swings).'),
      h('div', { class: 'fields' },
        field('ISAs & general investment', optNumInput(...bind(a, 'investReturn'), { placeholder: 'Mix', suffix: '%/yr', label: 'Investment return' })),
        field('Pensions', optNumInput(...bind(a, 'pensionReturn'), { placeholder: 'Mix', suffix: '%/yr', label: 'Pension return' })))));
    out.push(more('market-advanced', 'More options',
      h('div', { class: 'fields' },
        field('Stock volatility', numInput(...bind(a, 'stockVolatility'), { step: 0.5, suffix: '%' }), 'Typical year-to-year swing.'),
        field('Bond returns', numInput(...bind(a, 'bondReturn'), { step: 0.1, suffix: '%/yr' })),
        field('Bond volatility', numInput(...bind(a, 'bondVolatility'), { step: 0.5, suffix: '%' })),
        field('Tax thresholds frozen until', numInput(...bind(a, 'thresholdFreezeUntil'), { min: 2020, max: 2100 }), 'Then rise with inflation.'),
        field('State Pension growth above inflation', numInput(...bind(a, 'statePensionRealGrowth'), { step: 0.1, suffix: '%/yr' })))));
    const vary = (key, label, fields, explain) => h('div', { class: 'vary' },
      switchInput(label, ...bind(a, key), { rerender: 'market' }),
      h('p', { class: 'hint' }, explain),
      a[key] ? h('div', { class: 'fields' }, fields) : null);
    out.push(more('market-vary', 'What else varies in simulations',
      h('p', { class: 'sub' }, 'Stock and bond returns always vary. These make the Monte Carlo also test your plan against changing prices, pay, house values and interest rates.'),
      h('div', { class: 'vary-grid' },
        vary('varyInflation', 'Inflation', [
          field('Yearly swing', numInput(...bind(a, 'inflationVolatility'), { step: 0.1, min: 0, suffix: 'pts' })),
          field('Persistence', numInput(...bind(a, 'inflationPersistence'), { step: 0.05, min: 0, max: 0.95 }), '0 = surprises vanish next year; 0.9 = they linger.'),
        ], 'Prices drive spending, rent, State Pension and tax thresholds.'),
        vary('varySalaries', 'Salaries', [field('Yearly surprise', numInput(...bind(a, 'salaryVolatility'), { step: 0.5, min: 0, suffix: '%' }))], 'Pay rises vary from year to year and follow inflation.'),
        vary('varyHouses', 'House prices', [field('Yearly swing', numInput(...bind(a, 'houseVolatility'), { step: 0.5, min: 0, suffix: '%' }), 'UK house prices typically swing 5–10% a year.')], 'Each property grows at its rate plus surprises.'),
        vary('varyRates', 'Interest rates', [field('Moves with inflation', numInput(...bind(a, 'rateSensitivity'), { step: 0.1, min: 0, max: 2, suffix: '×' }))], 'Cash interest and mortgages after their fixed period follow inflation surprises.'))));
    return out;
  }

  function renderTax() {
    const region = plan().household.region;
    const rows = R.bandTable(region).map(b => ({ cells: [b.name, `${money(b.from + (b.from ? 1 : 0))} – ${b.to === Infinity ? 'and above' : money(b.to)}`, `${Math.round(b.rate * 100)}%`] }));
    return [
      sectionHead('tax', `Tax rules (${R.TAX_YEAR})`, plan().household.ignoreTax ? 'UK tax is switched off for this household (see Household), so none of this is applied. Flat rates on individual incomes still are.' : `${R.INCOME_TAX[region].label} income tax on earnings, pensions and other income.`),
      h('div', { class: 'table-wrap rules-table' }, table(['Band', 'Income', 'Rate'], rows)),
      h('ul', { class: 'sub', style: 'margin-top:12px;padding-left:18px;display:grid;gap:4px' },
        h('li', {}, `Personal allowance falls by £1 for every £2 of income over ${money(R.PA_TAPER_START)}.`),
        h('li', {}, `National Insurance: ${R.NI.mainRate * 100}% on earnings between ${money(R.NI.primaryThreshold)} and ${money(R.NI.upperEarningsLimit)}, ${R.NI.upperRate * 100}% above. Stops at State Pension age.`),
        h('li', {}, `Capital gains (UK-wide rates): ${money(R.CGT.annualExempt)} tax-free each, then ${R.CGT.basicRate * 100}% or ${R.CGT.higherRate * 100}%.`),
        h('li', {}, `Pensions: 25% tax-free up to ${money(R.LUMP_SUM_ALLOWANCE)} each; the rest is taxed as income. Annual allowance ${money(R.PENSION_ANNUAL_ALLOWANCE)}.`),
        h('li', {}, `Thresholds frozen until April ${R.FREEZE_UNTIL}. Salary sacrifice NI saving capped at ${money(R.SACRIFICE_NI_CAP)} a year from April ${R.SACRIFICE_NI_CAP_FROM}.`),
        h('li', {}, 'Not modelled: dividend and savings-interest tax, property income tax, inheritance tax (including pensions from April 2027), tapered annual allowance, the Pension Tax Allowance, and higher-rate relief on personal pension contributions.')),
    ];
  }

  const renderScenarioList = () => renderSection('scenario');

  function renderScenarioSection() {
    const s = scenario();
    return [
      h('div', { class: 'fields' },
        field('Name of this scenario', h('input', { type: 'text', value: s.name, 'aria-label': 'Scenario name', oninput: e => { s.name = e.target.value || 'Untitled'; renderScenarioPicker(); save(); compareDirty = true; } })),
        h('div', { class: 'field' }, h('span', {}, ' '),
          h('button', { type: 'button', class: 'btn small danger', disabled: ws.scenarios.length < 2, onclick: () => {
            if (!confirm(`Delete scenario “${s.name}”?`)) return;
            ws.scenarios = ws.scenarios.filter(x => x.id !== s.id);
            ws.activeId = ws.scenarios[0].id;
            afterScenarioChange();
          } }, 'Delete this scenario'))),
    ];
  }

  // ------------------------------------------------------------------ spending wizard

  let wiz = null;

  function openWizard() {
    wiz = { step: 0, answers: W.answersFromPlan(plan()), keepOthers: null };
    renderWizard();
    $('#wizard').showModal();
  }

  // A typical-range bar under a check-up question, with the answer marked on it.
  function guideView(guide, a) {
    if (!guide) return { el: null, update() {} };
    const el = h('div', { class: 'wiz-guide' });
    const update = () => {
      const perYear = a.freq === 'year';
      const k = perYear ? 12 : 1;
      const monthly = (a.amount || 0) / k;
      const kids = [];
      if (guide.low != null && !guide.none) {
        const max = Math.max(guide.high * 1.5, monthly * 1.1, 1);
        const pos = B.position(monthly, guide);
        const words = { below: 'Below typical', typical: 'Typical', above: 'Above typical' };
        kids.push(h('div', { class: 'guide-row' },
          h('div', { class: 'guide-track', role: 'img', 'aria-label': `Typical ${money(guide.low * k)} to ${money(guide.high * k)}; yours ${money(monthly * k)}` },
            h('span', { class: 'guide-band', style: `left:${(guide.low / max) * 100}%;width:${Math.max(1, ((guide.high - guide.low) / max) * 100)}%` }),
            monthly > 0 ? h('span', { class: 'guide-mark', style: `left:${Math.min(100, (monthly / max) * 100)}%` }) : null),
          h('span', { class: 'guide-text' }, `Typical ${money(guide.low * k)}–${money(guide.high * k)} ${perYear ? 'a year' : 'a month'}`),
          monthly > 0 && pos ? h('span', { class: `guide-pos ${pos}` }, words[pos]) : null));
      } else if (guide.none && monthly > 0) {
        kids.push(h('span', { class: 'guide-text' }, 'Not usually needed for a household like yours.'));
      }
      const extra = guide.tip || guide.note;
      if (extra) kids.push(h('p', { class: 'guide-note' }, extra));
      setKids(el, ...kids);
      el.hidden = !kids.length;
    };
    update();
    return { el, update };
  }

  // Review step: spending against a typical home and the 50/30/20 guide.
  function renderWizardCompare() {
    const box = $('#wizCompare');
    if (!box) return;
    const p = plan();
    const t = W.totals(wiz.answers);
    let needs = 0, wants = 0;
    for (const q of W.QUESTIONS) {
      const v = (wiz.answers[q.key].amount || 0) * (wiz.answers[q.key].freq === 'month' ? 12 : 1);
      if (B.NEEDS.has(q.key)) needs += v; else wants += v;
    }
    if (wiz.keepOthers) {
      for (const e of W.uncovered(p, wiz.answers)) {
        const v = E.streamAt(e, p, 0);
        const q = B.questionFor(e);
        if (q && B.NEEDS.has(q.key)) needs += v; else wants += v;
      }
    }
    const debt = model.proj.rows[0].debtPay || 0;
    needs += debt;
    const take = B.moneyThisYear(p, model.proj).takeHome;
    const saving = Math.max(0, take - needs - wants);
    const total = Math.max(take, needs + wants);
    const segs = [['Needs', needs, '--s1', 50], ['Wants', wants, '--s2', 30], ['Saving', saving, '--s3', 20]];
    const bar = (vals, cls) => h('div', { class: `split-bar ${cls || ''}` }, vals.map(([l, v, c]) => (v > 0 ? h('span', { style: `width:${(v / total) * 100}%;--key:${cssVar(c)}`, title: `${l}: ${money(v / 12)} a month` }) : null)));
    const visual = h('div', { class: 'split' },
      h('div', { class: 'split-label' }, h('strong', {}, 'You'), bar(segs)),
      h('div', { class: 'split-label' }, h('span', {}, 'Guide'), bar(segs.map(([l, , c, g]) => [l, total * g / 100, c]), 'guide')),
      h('div', { class: 'legend' }, segs.map(([l, v, c, g]) => h('span', {}, h('i', { class: 'key square', style: `--key:${cssVar(c)}` }), `${l} ${total ? Math.round(v / total * 100) : 0}% (guide ${g}%) · ${money(v / 12)}/month`))));
    const tbl = h('div', { class: 'table-wrap' }, table(['', 'A month', 'Share of take-home', 'Guide'], segs.map(([l, v, , g]) => ({ cells: [l, money(v / 12), total ? pct(v / total) : '—', `${g}%`] }))));
    const month = t.month + (wiz.keepOthers ? W.uncovered(p, wiz.answers).reduce((acc, e) => acc + E.streamAt(e, p, 0), 0) / 12 : 0);
    setKids(box, 
      h('h3', { class: 'chart-title' }, 'How it compares'),
      h('p', { class: 'sub' }, `Take-home this year about ${money(take / 12)} a month. Needs include your mortgage (${money(debt / 12)} a month), bills, food, transport and childcare; wants are the rest. The 50/30/20 split is a popular rule of thumb, not a rule.`),
      viewToggle(visual, tbl),
      h('p', { class: 'sub', style: 'margin-top:10px' }, `The average UK household (2.4 people) spent about ${money(B.ONS_AVERAGE_MONTH)} a month on goods and services in 2023/24 (ONS), not counting mortgage payments. Your list: ${money(month)} a month.`));
  }

  function renderWizard() {
    const steps = W.STEPS;
    const total = steps.length + 1;
    const isReview = wiz.step === steps.length;
    const step = steps[wiz.step];
    $('#wizStep').textContent = `Step ${wiz.step + 1} of ${total}`;
    $('#wizTitle').textContent = isReview ? 'Review' : step.title;
    $('#wizIntro').textContent = isReview ? 'Here is your spending by category. Apply it to update the plan.' : wiz.step === 0 && W.QUESTIONS.some(q => wiz.answers[q.key].from) ? `${step.intro} We've filled in what we could from your current spending.` : step.intro;
    $('#wizBar').style.width = `${((wiz.step + 1) / total) * 100}%`;
    const body = $('#wizBody');

    if (!isReview) {
      const hh = B.household(plan());
      setKids(body, ...step.questions.map(q => {
        const a = wiz.answers[q.key];
        const guide = guideView(B.forQuestion(q.key, hh), a);
        return h('div', { class: 'wiz-q' },
          h('div', { class: 'q' }, q.label, q.hint ? h('small', {}, q.hint) : null),
          moneyInputPlain(() => a.amount, v => { a.amount = v; updateWizTotal(); guide.update(); }, q.label),
          h('select', { 'aria-label': `${q.label} frequency`, onchange: e => { a.freq = e.target.value; updateWizTotal(); guide.update(); } },
            [['month', 'a month'], ['year', 'a year']].map(([v, l]) => h('option', { value: v, selected: a.freq === v }, l))),
          guide.el);
      }), ...(step.endAge ? [field(`These stop when ${people()[0].name} is`, h('input', { type: 'number', value: wiz.answers._childrenEndAge, min: people()[0].age, max: 100, oninput: e => { wiz.answers._childrenEndAge = parseInt(e.target.value, 10) || people()[0].age; } }))] : []),
      h('p', { class: 'hint wiz-source' }, 'Typical ranges are a rough UK guide scaled to your household, from ONS Family Spending, Ofgem and common rules of thumb (2026 prices). A sense check, not a target.'));
    } else {
      const t = W.totals(wiz.answers);
      const others = W.uncovered(plan(), wiz.answers);
      const othersTotal = others.reduce((acc, e) => acc + E.streamAt(e, plan(), 0), 0);
      if (wiz.keepOthers === null) wiz.keepOthers = true;
      setKids(body, ...[
        h('div', { class: 'table-wrap wiz-summary' }, table(['Category', 'A month', 'A year'],
          steps.map(s => ({ cells: [s.title, money((t.byStep[s.id] || 0) / 12), money(t.byStep[s.id] || 0)] })).concat([{ cls: 'hl', cells: ['Total', money(t.month), money(t.year)] }]))),
        others.length ? h('div', { class: 'field' },
          switchInput(`Keep my ${others.length} other expense${others.length === 1 ? '' : 's'} (${money(othersTotal / 12)}/month)`, () => wiz.keepOthers, v => { wiz.keepOthers = v; updateWizTotal(); renderWizardCompare(); }),
          h('span', { class: 'hint' }, `Not covered by the check-up: ${others.map(e => e.name).join(', ')}. Turn off if your answers already include them.`)) : null,
        h('div', { id: 'wizCompare' })].filter(Boolean));
      renderWizardCompare();
    }
    $('#wizBack').disabled = wiz.step === 0;
    $('#wizNext').textContent = isReview ? 'Apply to plan' : 'Next';
    updateWizTotal();
    const first = body.querySelector('input');
    if (first) first.focus();
  }

  function updateWizTotal() {
    const t = W.totals(wiz.answers);
    let month = t.month;
    if (wiz.step === W.STEPS.length && wiz.keepOthers) month += W.uncovered(plan(), wiz.answers).reduce((acc, e) => acc + E.streamAt(e, plan(), 0), 0) / 12;
    setKids($('#wizTotal'), 'Total ', h('strong', {}, `${money(month)} a month`), ` · ${money(month * 12)} a year`);
  }

  function wizardNext() {
    if (wiz.step < W.STEPS.length) {
      wiz.step++;
      renderWizard();
      return;
    }
    plan().expenses = E.normalizePlan({ ...plan(), expenses: W.applyAnswers(plan(), wiz.answers, { keepOthers: wiz.keepOthers }) }).expenses;
    $('#wizard').close();
    renderSection('expenses');
    refresh();
  }

  // ------------------------------------------------------------------ life check-up

  let lw = null;

  function openLifeWizard() {
    lw = { step: 0, a: LW.answersFromPlan(plan()) };
    renderLifeWizard();
    $('#lifeWiz').showModal();
  }

  function lwNum(key, label, opts = {}) {
    const a = lw.a;
    const input = opts.money
      ? moneyInputPlain(() => a[key], v => { a[key] = v; updateLifeTotal(); }, label)
      : h('input', { type: 'number', value: a[key], min: opts.min, max: opts.max, step: opts.step || 1, 'aria-label': label, oninput: e => { a[key] = parseFloat(e.target.value) || 0; updateLifeTotal(); } });
    return field(label, opts.suffix ? h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, opts.suffix)) : input, opts.hint);
  }

  function renderLifeWizard() {
    const steps = LW.STEPS;
    const total = steps.length + 1;
    const review = lw.step === steps.length;
    const step = steps[lw.step];
    const a = lw.a;
    const p1 = people()[0];
    $('#lwStep').textContent = `Step ${lw.step + 1} of ${total}`;
    $('#lwTitle').textContent = review ? 'Review' : step.title;
    $('#lwIntro').textContent = review ? 'Everything the check-up adds to your plan, in today’s money. Apply it to see the effect on your goals.' : step.intro;
    $('#lwBar').style.width = `${((lw.step + 1) / total) * 100}%`;
    const body = $('#lwBody');
    let content;
    if (review) {
      const s = LW.summary(plan(), a);
      content = [
        s.lines.length ? h('div', { class: 'table-wrap' }, table(['Item', 'When', 'Total (today’s £)'], s.lines.map(l => ({ cells: [l.name, l.when, money(l.total)] })).concat([{ cls: 'hl', cells: ['Total', '', money(s.total)] }]))) : h('p', {}, 'Nothing to add.'),
        s.slowDown ? h('p', { class: 'sub' }, `${s.slowDown} (applies to all spending).`) : null,
      ];
    } else if (step.id === 'children') {
      const kids = a.children;
      content = [
        field('How many children?', h('input', { type: 'number', min: 0, max: 8, value: kids.length, 'aria-label': 'Number of children', oninput: e => {
          const n = Math.max(0, Math.min(8, parseInt(e.target.value, 10) || 0));
          while (kids.length < n) kids.push({ name: '', age: 0 });
          kids.length = n;
          renderLifeWizard();
        } })),
        kids.length ? h('div', { class: 'fields' }, kids.map((c, i) => h('div', { class: 'field' }, h('span', {}, `Child ${i + 1}`),
          h('div', { class: 'pair' },
            h('input', { type: 'text', value: c.name, placeholder: 'Name (optional)', 'aria-label': `Child ${i + 1} name`, oninput: e => { c.name = e.target.value; } }),
            h('input', { type: 'number', value: c.age, min: 0, max: 30, 'aria-label': `Child ${i + 1} age`, style: 'width:80px', oninput: e => { c.age = parseInt(e.target.value, 10) || 0; updateLifeTotal(); } }))))) : null,
        kids.length ? h('div', { class: 'fields' },
          lwNum('schoolCost', 'School costs (a year, each, to 18)', { money: true, hint: 'Uniforms, trips, clubs. Childcare stays in your spending list.' }),
          lwNum('uniPerYear', 'University support (a year)', { money: true, hint: 'Scottish students pay no tuition at Scottish universities.' }),
          lwNum('uniYears', 'Years at university', { min: 0, max: 7 }),
          lwNum('carAt17', 'Driving lessons & first car', { money: true }),
          lwNum('depositHelp', 'Help with a house deposit', { money: true }),
          lwNum('weddingHelp', 'Help with a wedding', { money: true }),
          lwNum('helpAge', 'At their age', { min: 18, max: 50 })) : null,
      ];
    } else if (step.id === 'cars') {
      content = [h('div', { class: 'fields' },
        lwNum('cars', 'Cars in the household', { min: 0, max: 4 }),
        lwNum('carCost', 'Cost of each replacement', { money: true }),
        lwNum('carEvery', 'Replace every', { min: 1, max: 30, suffix: 'years' }),
        lwNum('carNext', 'Next replacement in', { min: plan().startYear, max: plan().startYear + 30, hint: 'Stops when you are 80.' }))];
    } else if (step.id === 'home') {
      content = [h('div', { class: 'fields' },
        lwNum('homeCost', 'Major repairs or renovation', { money: true, hint: 'Roof, boiler, kitchen, bathroom, windows.' }),
        lwNum('homeEvery', 'Every', { min: 0, max: 40, suffix: 'years', hint: '0 = never.' }),
        lwNum('homeNext', 'Next one in', { min: plan().startYear, max: plan().startYear + 40 }))];
    } else if (step.id === 'retirement') {
      content = [h('div', { class: 'fields' },
        lwNum('travelExtra', 'Extra travel & hobbies (a year)', { money: true, hint: `On top of normal spending, from retirement (${p1.name} at ${p1.retireAge}).` }),
        lwNum('travelYears', 'For how many years', { min: 0, max: 30 }),
        lwNum('slowDownAge', 'Spend less from age', { min: 0, max: 100, hint: '0 = never. Spending often falls in your late 70s.' }),
        lwNum('slowDownPct', 'Spending from then', { min: 30, max: 150, suffix: '%', hint: 'Of normal spending.' }))];
    } else {
      content = [h('div', { class: 'fields' },
        lwNum('careAge', 'Possible care costs from age', { min: 0, max: 110, hint: '0 = leave out. Scotland pays part of personal and nursing care.' }),
        lwNum('careCost', 'Care costs (a year)', { money: true, hint: 'A care home in Scotland is often £50,000–£80,000 a year before support.' }),
        lwNum('careYears', 'For how many years', { min: 0, max: 20 }),
        lwNum('familyAmount', 'Helping parents or family (a year)', { money: true }),
        lwNum('familyFrom', `From ${p1.name}'s age`, { min: 18, max: 110 }),
        lwNum('familyTo', 'Until age', { min: 18, max: 110 }))];
    }
    setKids(body, ...[].concat(content).filter(Boolean));
    $('#lwBack').disabled = lw.step === 0;
    $('#lwNext').textContent = review ? 'Apply to plan' : 'Next';
    updateLifeTotal();
  }

  function updateLifeTotal() {
    const s = LW.summary(plan(), lw.a);
    setKids($('#lifeWiz .wiz-total'), 'Adds ', h('strong', {}, money(s.total)), ' over your lifetime (today’s money)');
  }

  function lifeNext() {
    if (lw.step < LW.STEPS.length) { lw.step++; renderLifeWizard(); return; }
    scenario().plan = LW.apply(plan(), lw.a);
    $('#lifeWiz').close();
    explorerValues = null;
    renderPlan();
    refresh();
  }

  // ------------------------------------------------------------------ chrome: navigation, notifications, theme, files

  // Tabs: Home, one per goal, Finances, Scenarios. Addresses from earlier layouts still work.
  const LEGACY = {
    overview: 'home', goals: 'home', plan: 'finances/portfolio', cashflow: 'finances/cashflow', workings: 'finances/portfolio',
    montecarlo: 'finances/assumptions', outlook: 'finances/assumptions', progress: 'finances/history', review: 'finances/history',
  };
  let route = { tab: 'home', sub: null };

  // "#goal/<id>" opens a goal's tab; "#finances/<page>" a Finances page; otherwise a tab.
  function parseRoute(hash) {
    let s = String(hash || '').replace(/^#/, '');
    if (LEGACY[s]) s = LEGACY[s];
    const [a, b] = s.split('/');
    if (a === 'goal' && b) return { tab: 'goal', sub: decodeURIComponent(b) };
    if (a === 'finances' || a === 'money') return { tab: 'finances', sub: MONEY_PAGES.some(x => x[0] === b) ? b : moneyPage };
    return { tab: ['home', 'scenarios'].includes(a) ? a : 'home', sub: null };
  }
  const routeHash = r => (r.tab === 'goal' ? `goal/${encodeURIComponent(r.sub)}` : r.tab === 'finances' ? `finances/${r.sub}` : r.tab);

  function navigate(hash) {
    const r = parseRoute(hash);
    const target = `#${routeHash(r)}`;
    if (location.hash !== target) {
      try { history.pushState(null, '', target); } catch { /* some file:// pages: the address just doesn't change */ }
    }
    applyRoute(r);
  }

  // A short name for a goal's tab.
  const goalTabName = g => g.name || ({ debtFree: 'Mortgage-free', retire: 'Retirement', emergency: 'Emergency fund', passiveIncome: 'Passive income' }[g.type]) || E.autoTitle(g, plan());

  // Home, the goals (each in its colour, + to add), then Finances and Scenarios at the right.
  // On a phone the right-hand pair stays pinned while the goals scroll under it.
  function renderTabs() {
    const goals = plan().goals;
    const tab = (key, label, extra = {}) => h('button', {
      role: 'tab', type: 'button', 'data-tab': key, 'aria-selected': String(tabKey(route) === key), class: extra.cls || null, style: extra.style || null,
      onclick: () => navigate(key),
    }, extra.icon || null, label);
    setKids($('#tabList'),
      tab('home', 'Home'),
      h('div', { class: 'goal-tabs', role: 'presentation' },
        h('span', { class: 'tab-group-label', 'aria-hidden': 'true' }, 'Goals'),
        goals.map(g => tab(`goal/${g.id}`, goalTabName(g), { cls: 'goal-tab', style: `--gc:${cssVar(goalColor(g))}`, icon: glyph(ICON_GLYPH[g.icon] || 'goal') })),
        h('button', { type: 'button', class: 'tab-add', title: 'Add a goal', 'aria-label': 'Add a goal', onclick: () => openGoalWizard() }, '+')),
      h('div', { class: 'side-tabs', role: 'presentation' },
        tab(`finances/${moneyPage}`, 'Finances'),
        tab('scenarios', 'Scenarios')));
  }
  const tabKey = r => (r.tab === 'goal' ? `goal/${r.sub}` : r.tab === 'finances' ? `finances/${moneyPage}` : r.tab);

  function routeChrome(r) {
    route = r;
    if (r.tab === 'finances') moneyPage = r.sub;
    for (const v of $$('main > .view')) v.hidden = v.id !== `view-${r.tab}`;
    renderTabs();
    if (model) renderScenarioPicker();
  }

  function applyRoute(r) {
    const moved = route.tab !== r.tab || route.sub !== r.sub;
    if (moved) impactBase = null;
    routeChrome(r);
    renderView();
    scheduleDrivers();
    if (moved) window.scrollTo(0, 0);
    requestAnimationFrame(() => Object.values(charts).forEach(c => c.draw()));
  }

  // For the tests and the console.
  const showTab = (name, sub) => navigate(sub ? (name === 'goal' ? `goal/${sub}` : `${name}/${sub}`) : name);
  const currentTab = () => route.tab;

  // Draw whatever is on screen.
  function renderView() {
    const r = route;
    if (r.tab === 'home') renderHome();
    if (r.tab === 'goal') renderGoalPage(r.sub);
    if (r.tab === 'finances') renderMoneyPage();
    if (r.tab === 'scenarios') renderScenarios();
    renderInflationSwitches();
  }

  // ---- "Adjust for inflation": future amounts in today's money (on) or in the pounds of
  //      each year (off). Only charts that look ahead have it; today's figures are the same either way.

  function renderInflationSwitches() {
    for (const box of $$('[data-inflation]')) {
      if (box.closest('[hidden]')) continue;
      setKids(box, h('label', { class: 'switch small', title: 'On: amounts in later years are shown in today’s money, so £1 buys what £1 buys today. Off: the actual pounds of each year, which grow with prices.' },
        h('input', { type: 'checkbox', role: 'switch', checked: real(), 'aria-label': 'Adjust for inflation', onchange: e => { ws.settings.realDollars = e.target.checked; save(); compareDirty = true; renderResults(); } }),
        'Adjust for inflation'));
    }
  }

  // ---- notifications: the yearly review, figures getting old, saving a copy, plan checks

  function notifications() {
    const out = [];
    const due = RV.due(ws);
    const est = model.est;
    const lastUpdate = [est.asOf, ...Object.values(est.reading).map(r => r.date)].sort().pop();
    const days = daysSince(lastUpdate);
    if (due.due) {
      out.push({ id: 'review', icon: 'review', tone: 'accent', title: due.reason === 'behind' ? `Your plan still starts in ${plan().startYear}: time for a yearly review` : `Time for your ${due.year} yearly review`,
        text: 'Swap the estimates for real numbers, see how close last year’s plan was, and roll every scenario on a year.', actions: [['Start review', () => openReview()]] });
    } else if (days >= 30) {
      out.push({ id: 'update', icon: 'clock', tone: 'accent', title: `Your figures are ${days >= 60 ? `${Math.round(days / 30.4)} months` : `${Math.round(days / 7)} weeks`} old`,
        text: `Last updated ${fmtDate(lastUpdate)}. Update a few balances from your banking apps, or do a full review.`,
        actions: [['Update balances', openUpdate], ['Full review', () => openReview()]] });
    }
    for (const w of model.warnings) out.push({ id: `w:${w}`, icon: 'warn', tone: 'warn', title: 'Check your plan', text: w, actions: [] });
    return out;
  }

  function renderNotifications() {
    const list = notifications();
    const urgent = list.filter(n => n.tone !== 'soft').length;
    const count = $('#notifyCount');
    count.hidden = !urgent;
    count.textContent = String(urgent);
    $('#notifyBtn').setAttribute('aria-label', urgent ? `Notifications: ${urgent}` : 'Notifications');
    $('#notifyBtn').classList.toggle('has-news', urgent > 0);
    setKids($('#notifyPop'), 
      h('p', { class: 'notify-head' }, 'Notifications'),
      list.length ? h('ul', { class: 'notify-list' }, list.map(n => h('li', { class: `notify-item ${n.tone}`, 'data-notify': n.id },
        h('span', { class: 'ins-ico' }, glyph(n.icon)),
        h('div', {}, h('strong', {}, n.title), h('p', {}, n.text),
          n.actions.length ? h('div', { class: 'add-row' }, n.actions.map(([label, fn], i) => h('button', { type: 'button', class: `btn small${i === 0 ? ' primary' : ''}`, onclick: () => { $('#notifyMenu').open = false; fn(); } }, label))) : null))))
        : h('p', { class: 'sub' }, 'Nothing needs doing. Horizon will remind you when your figures are a month old and when the yearly review comes round.'));
  }

  function renderScenarioPicker() {
    const sel = $('#scenarioSelect');
    setKids(sel, ws.scenarios.map(s => h('option', { value: s.id, selected: s.id === ws.activeId }, s.name)));
    const pill = $('#scenarioPill');
    pill.hidden = ws.scenarios.length < 2;
    setKids(pill, h('span', { class: 'rv-k' }, 'Scenario'), h('strong', {}, scenario().name));
    pill.title = 'Showing this scenario. Switch or compare in Scenarios.';
  }

  function afterScenarioChange() {
    goalSolve = {};
    explorerValues = null;
    gp = null;
    renderScenarioPicker();
    renderPlan();
    refresh();
  }

  function applyTheme() {
    const t = ws.settings.theme;
    if (t === 'auto') delete document.documentElement.dataset.theme;
    else document.documentElement.dataset.theme = t;
    const labels = { auto: ['◐', 'Theme: automatic'], light: ['☀', 'Theme: light'], dark: ['☾', 'Theme: dark'] };
    $('#themeBtn').textContent = labels[t][0];
    $('#themeBtn').setAttribute('aria-label', `${labels[t][1]}. Click to change.`);
    $('#themeBtn').title = labels[t][1];
    requestAnimationFrame(() => {
      Object.values(charts).forEach(c => c.draw());
      if (route.tab === 'finances') renderPlan(); // item colours come from tokens
      if (model) renderResults();
    });
  }

  function renderSavedNote() {
    const d = ws.settings.lastSaved;
    $('#savedNote').textContent = `${d ? `Last saved to a file on ${fmtDate(d)}.` : 'Not saved to a file yet.'} A saved file keeps a copy and lets you carry on on another computer.`;
  }

  function renderResults() {
    renderTabs();
    renderView();
    if (route.tab === 'finances' && moneyPage === 'income') updateIncomeTrends();
    updateIncomeFigures();
    updateAccountFigures();
    renderSavedNote();
    renderNotifications();
    renderScenarioPicker();
    scheduleDrivers();
  }

  // Save everything (every scenario, goal, check-in and setting) to one file.
  function exportFile() {
    ws.settings.lastSaved = today();
    save();
    const blob = new Blob([JSON.stringify(ws, null, 2)], { type: 'application/json' });
    const a = h('a', { href: URL.createObjectURL(blob), download: `horizon-plan-${today()}.json` });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    renderSavedNote();
    toast('Saved to your downloads. To carry on on another computer, open Horizon there and use Data → Open a saved file.');
  }

  async function importFile(file) {
    try {
      const data = JSON.parse(await file.text());
      if (!data || typeof data !== 'object' || !(Array.isArray(data.scenarios) || data.household || data.accounts)) throw new Error('This does not look like a Horizon plan file.');
      if (!confirm('Open this file? It replaces the plan in this browser, so save yours to a file first if you want to keep it.')) return;
      ws = E.normalizeWorkspace(data);
      afterImport();
      toast(`Opened your plan: figures as at ${fmtDate(asOf())}.`);
    } catch (err) {
      alert(`Could not open the file: ${err.message}`);
    }
  }

  function afterImport() {
    goalSolve = {};
    explorerValues = null;
    gp = null;
    applyTheme();
    renderScenarioPicker();
    renderPlan();
    refresh();
  }

  // ------------------------------------------------------------------ wiring

  function wire() {
    for (const b of $$('.tabs button')) b.addEventListener('click', () => navigate(b.dataset.tab));
    $('.tabs').addEventListener('keydown', e => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const tabs = $$('.tabs button');
      const i = tabs.findIndex(b => b.getAttribute('aria-selected') === 'true');
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      next.focus();
      navigate(next.dataset.tab);
    });
    window.addEventListener('popstate', () => applyRoute(parseRoute(location.hash)));
    window.addEventListener('hashchange', () => { const r = parseRoute(location.hash); if (r.tab !== route.tab || r.sub !== route.sub) applyRoute(r); });
    $('#scenarioSelect').addEventListener('change', e => { ws.activeId = e.target.value; afterScenarioChange(); });
    $('#dupScenario').addEventListener('click', () => {
      const s = scenario();
      const id = E.uid();
      ws.scenarios.push({ id, name: `${s.name} (copy)`, plan: E.clonePlan(s.plan) });
      ws.activeId = id;
      afterScenarioChange();
      navigate('scenarios');
      const name = $('#sec-scenario input');
      if (name) { name.scrollIntoView({ block: 'center' }); name.focus(); name.select(); }
      toast('A copy of the plan. Rename it here, then change anything in it: every edit applies to this scenario only.');
    });
    $('#scenarioPill').addEventListener('click', () => navigate('scenarios'));
    $('#themeBtn').addEventListener('click', () => {
      const order = ['auto', 'light', 'dark'];
      ws.settings.theme = order[(order.indexOf(ws.settings.theme) + 1) % 3];
      save();
      applyTheme();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => applyTheme());

    $('#exportBtn').addEventListener('click', () => { $('#dataMenu').open = false; exportFile(); });
    $('#importBtn').addEventListener('click', () => { $('#dataMenu').open = false; $('#importFile').click(); });
    $('#importFile').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
    $('#ovAddGoal').addEventListener('click', () => openGoalWizard());
    $('#blankBtn').addEventListener('click', () => {
      $('#dataMenu').open = false;
      if (!confirm('Start a blank plan? This replaces everything in Horizon. Save to a file first if you want to keep your data.')) return;
      const id = E.uid();
      const blank = E.normalizePlan({ startYear: E.currentYear(), asOf: today(), household: { region: 'scotland', people: [{ name: 'You', age: 35, retireAge: 65 }] }, accounts: [], income: [], expenses: [], events: [], goals: [] });
      ws = E.normalizeWorkspace({ scenarios: [{ id, name: 'My plan', plan: blank }], activeId: id, checkins: [], settings: ws.settings });
      afterImport();
      navigate('finances/assumptions');
      toast('A blank plan, with figures as at today. Start with who it is for, then add accounts, income and spending; then add goals on Home.');
    });
    $('#resetBtn').addEventListener('click', () => {
      $('#dataMenu').open = false;
      if (!confirm('Replace everything with the example plan? Save to a file first if you want to keep your data.')) return;
      ws = E.defaultWorkspace();
      afterImport();
    });
    document.addEventListener('click', e => { for (const m of [$('#dataMenu'), $('#notifyMenu')]) if (m.open && !m.contains(e.target)) m.open = false; });



    $('#checkinBtn').addEventListener('click', recordCheckin);
    $('#rvNext').addEventListener('click', () => { if (rv.step < RV_STEPS.length - 1) { rv.step++; renderReview(); } });
    $('#rvBack').addEventListener('click', () => { if (rv.step > 0) { rv.step--; renderReview(); } });
    $('#rvClose').addEventListener('click', () => $('#reviewWiz').close());
    $('#rvForm').addEventListener('submit', e => e.preventDefault());
    $('#manualCheckin').addEventListener('submit', addManualCheckin);

    $('#udSave').addEventListener('click', saveUpdate);
    $('#udCancel').addEventListener('click', () => $('#updateDlg').close());
    $('#udClose').addEventListener('click', () => $('#updateDlg').close());
    $('#udForm').addEventListener('submit', e => e.preventDefault());

    $('#wizNext').addEventListener('click', wizardNext);
    $('#wizBack').addEventListener('click', () => { if (wiz.step > 0) { wiz.step--; renderWizard(); } });
    $('#wizClose').addEventListener('click', () => $('#wizard').close());
    $('#wizForm').addEventListener('submit', e => e.preventDefault());

    $('#lwNext').addEventListener('click', lifeNext);
    $('#lwBack').addEventListener('click', () => { if (lw.step > 0) { lw.step--; renderLifeWizard(); } });
    $('#lwClose').addEventListener('click', () => $('#lifeWiz').close());
    $('#lwForm').addEventListener('submit', e => e.preventDefault());
    $('#gwNext').addEventListener('click', goalWizardNext);
    $('#gwBack').addEventListener('click', () => { if (gw.step > 0) { gw.step--; renderGoalWizard(); } });
    $('#gwClose').addEventListener('click', () => $('#goalWiz').close());
    $('#gwForm').addEventListener('submit', e => e.preventDefault());


    $('#taxYear').textContent = R.TAX_YEAR;
  }

  // ------------------------------------------------------------------ start

  wire();
  applyTheme();
  renderScenarioPicker();
  routeChrome(parseRoute(location.hash));
  renderPlan();
  refresh();

  // Exposed for automated tests only.
  window.__horizon = { get ws() { return ws; }, get model() { return model; }, get route() { return route; }, refresh, showTab, navigate, openReview, openUpdate };
})();
