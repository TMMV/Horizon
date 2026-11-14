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
  const QS = window.QuickStart;
  const DS = window.Dossier;
  const SV = window.SvgChart;
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
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(typeof kid === 'string' ? sayYou(kid) : kid);
    return el;
  }

  // A plan with nobody named yet calls the person "You": "You is 49" and "You’s pension" are
  // put right as the page is drawn.
  let youMode = false;
  const YOU_VERBS = { is: 'are', was: 'were', has: 'have', does: 'do', retires: 'retire', gives: 'give', puts: 'put', pays: 'pay', stops: 'stop', works: 'work', keeps: 'keep', takes: 'take', gets: 'get', turns: 'turn', reaches: 'reach', claims: 'claim', draws: 'draw', earns: 'earn', starts: 'start', needs: 'need', owns: 'own', owes: 'owe', saves: 'save', spends: 'spend', moves: 'move', buys: 'buy', sells: 'sell', leaves: 'leave', dies: 'die', lives: 'live', goes: 'go', makes: 'make', uses: 'use', sacrifices: 'sacrifice' };
  const YOU_RE = new RegExp(`\\bYou (${Object.keys(YOU_VERBS).join('|')})\\b`, 'g');
  // A household with no home and no mortgage is not told about "mortgage payments".
  let debtMode = 'mortgage';   // 'mortgage' | 'loans' | 'none'
  function sayDebt(s) {
    if (debtMode === 'mortgage' || s.indexOf('ortgage') < 0) return s;
    return s.replace(/ and mortgage payments/g, debtMode === 'loans' ? ' and loan payments' : '')
      .replace(/Mortgage and loan payments/g, 'Loan payments').replace(/mortgage and loan payments/g, 'loan payments');
  }
  function sayYou(s) {
    s = sayDebt(s);
    if (!youMode || s.indexOf('You') < 0) return s;
    return s.replace(/\bYou[’']s\b/g, 'Your').replace(YOU_RE, (m, v) => `You ${YOU_VERBS[v]}`)
      .replace(/([a-z,;)] )(You|Your)\b/g, (m, a, b) => a + b.toLowerCase());
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

  // A plan started blank keeps three months of spending and debt payments as its cash buffer,
  // until the person types their own.
  function syncBuffer(p) {
    if (!p.strategy.autoBuffer) return;
    const out = p.expenses.reduce((acc, e) => acc + E.streamAt(e, p, 0), 0)
      + p.accounts.filter(a => a.type === 'debt' && !a.excluded && a.balance > 0).reduce((acc, d) => acc + (d.payment || 0) * 12, 0);
    p.strategy.cashReserve = Math.ceil(out / 4 / 100) * 100;   // rounded up: never a few pounds short of three months
  }

  function compute() {
    const p = plan();
    youMode = p.household.people.some(x => x.name === 'You');
    debtMode = p.accounts.some(a => !a.excluded && (a.type === 'property' || (a.type === 'debt' && /mortgage/i.test(a.name)))) ? 'mortgage' : p.accounts.some(a => !a.excluded && a.type === 'debt' && a.balance > 0) ? 'loans' : 'none';
    syncBuffer(p);
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
    refreshSetup();
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
    lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
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
    if (c.full) c.full.table = c.cfg.table;
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
    { key: 'property', get label() { return propLabel(); }, color: '--s6' },
  ];
  const TYPE_COLOR = { cash: '--s1', isa: '--s2', lisa: '--s2', gia: '--s3', pension: '--s4', bonds: '--s5', property: '--s6', asset: '--s7', debt: '--s8' };
  // Other assets (a business, a share of a family home…) are shown with property in projections.
  const propLabel = () => (plan().accounts.some(a => a.type === 'asset' && !a.excluded) ? 'Property & other assets' : 'Property');
  // A home to be bought later is not owned yet `years` after the figures date.
  const notYet = (a, years = 0) => RV.notYet(plan(), a, years);
  const SERIES_COLORS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s8'];

  function fanConfig(xs, bands, opts = {}) {
    const fmt = opts.format || money;
    const lines = [{ label: 'Median', color: opts.color || '--s1', values: bands.p50 }];
    if (opts.expected) lines.push({ label: 'Expected', color: '--muted', values: opts.expected, dash: [6, 4] });
    return {
      xs,
      yDomain: opts.yDomain, yFormat: opts.yFormat,
      bands: [
        { label: '8 in 10 outcomes', lower: bands.p10, upper: bands.p90, color: opts.band || '--band', alpha: 0.14 },
        { label: 'Middle half of outcomes', lower: bands.p25, upper: bands.p75, color: opts.band || '--band', alpha: 0.26 },
      ],
      lines,
      markers: opts.markers,
      table: () => ({
        headers: ['Year', 'Bad case (1 in 10)', 'Worse half', 'Middle', 'Better half', 'Good case (1 in 10)', ...(opts.expected ? ['Average returns'] : [])],
        rows: xs.map((x, i) => [x, bands.p10[i], bands.p25[i], bands.p50[i], bands.p75[i], bands.p90[i], ...(opts.expected ? [opts.expected[i]] : [])]),
        formats: [String, fmt, fmt, fmt, fmt, fmt, fmt],
      }),
      tooltip: i => ({
        title: opts.title ? opts.title(i) : String(xs[i]),
        rows: [
          { label: 'Good case (1 in 10 do better)', series: '8 in 10 outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p90[i]) },
          { label: 'Better half', series: 'Middle half of outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p75[i]) },
          { label: 'Median', color: opts.color || '--s1', shape: 'line', text: fmt(bands.p50[i]), strong: true },
          { label: 'Worse half', series: 'Middle half of outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p25[i]) },
          { label: 'Bad case (1 in 10 do worse)', series: '8 in 10 outcomes', color: opts.band || '--band', shape: 'band', text: fmt(bands.p10[i]) },
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

  const MILESTONE_COLOR = { retire: '--s4', pension: '--s3', sp: '--s7', debt: '--s6', home: '--s6', fi: '--s2', goal: '--s1', short: '--bad', review: '--muted' };

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
  // A plan year is the twelve months from the figures date: with figures as at 14 November,
  // "2026" is 14 November 2026 to 13 November 2027. Null when it is the calendar year.
  const planYearSpan = (date, t = 0) => {
    if (!E.isDate(date) || date.slice(5) === '01-01') return null;
    const y = +date.slice(0, 4) + t, md = date.slice(5) === '02-29' ? '02-28' : date.slice(5);
    const end = new Date(`${y + 1}-${md}T12:00:00Z`);
    end.setUTCDate(end.getUTCDate() - 1);
    return { from: `${y}-${md}`, to: end.toISOString().slice(0, 10) };
  };
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
    { key: 'lisa', label: 'Lifetime ISAs', color: '--s2' },
    { key: 'bonds', label: 'Bonds & gilts', color: '--s5' },
    { key: 'property', label: 'Property', color: '--s6' },
    { key: 'asset', label: 'Other assets', color: '--s7' },
    { key: 'debt', label: 'Mortgage & loans', color: '--s8' },
  ];

  // Types whose accounts are shown on Home, and groups (available now, locked…) opened; all folded at first.
  const pfOpen = new Set();
  const pfClassOpen = new Set();

  // How far ahead the portfolio on Home looks: 0 = today, or a number of years ('retire' = when
  // the first person retires).
  let pfAhead = 0;
  function aheadYears() {
    const t = pfAhead === 'retire' ? Math.min(...people().map(x => x.retireAge - x.age).filter(v => v > 0)) : +pfAhead;
    return Number.isFinite(t) ? Math.max(0, Math.min(t, model.proj.pre.N)) : 0;
  }

  // ---- Money set aside: which part of an account is spoken for (an emergency fund, savings
  // building up for a known cost, a yearly budget that stays in the account until it is spent).
  const accountName = id => (plan().accounts.find(a => a.id === id) || {}).name || '';
  function reserveText(r) {
    const where = accountName(r.accountId) ? `In ${accountName(r.accountId)}` : 'No account chosen';
    if (r.kind === 'emergency') return `${where}; rises with prices. Only for the unexpected: not to spend or invest.`;
    if (r.kind === 'saving') return r.dueYear
      ? `${where}: ${money(r.amount)} of the ${money(r.target)} due in ${r.dueYear}, building up by about ${money(r.perYear)} a year. Already spoken for, so not counted in net worth.`
      : `${where}. No planned cost with this name ahead.`;
    return `${where}: ${money(r.yearly)} for ${r.year}${r.left ? ` plus ${money(r.left)} kept from last year` : ''}, counted as spent, so not in net worth. The review asks what is left.`;
  }
  function reservesPanel(list, when, short = 0) {
    const held = list.reduce((acc, r) => acc + r.held, 0) - short;
    const tag = r => (r.kind === 'budget' ? 'available until spent · not in net worth' : r.kind === 'saving' ? 'spoken for · not in net worth' : 'keep · counts in net worth');
    return h('div', { class: 'pf-reserves', id: 'pfReserves' },
      h('div', { class: 'pf-res-head' }, h('h3', {}, 'Set aside'), h('span', { class: 'muted' }, `${money(held)} held ${when}${short >= 0.5 ? ` · ${money(short)} still to put aside` : ''}`)),
      list.map(r => h('div', { class: `pf-res-row ${r.kind}`, 'data-reserve': r.id },
        h('span', { class: 'pf-res-name' }, h('span', {}, h('strong', {}, r.name), h('span', { class: `pf-res-kind ${r.kind}` }, tag(r))), h('small', {}, reserveText(r))),
        h('span', { class: 'pf-res-val' }, h('strong', {}, money(r.amount)),
          r.kind === 'saving' && r.target ? h('span', { class: 'pf-res-bar', role: 'img', 'aria-label': `${Math.round((r.amount / r.target) * 100)}% of ${money(r.target)}` },
            h('i', { style: `width:${Math.min(100, (r.amount / r.target) * 100).toFixed(1)}%` })) : null))),
      h('button', { type: 'button', class: 'linkish', onclick: () => navigate('finances/saving') }, 'Change what is set aside'));
  }

  function renderPortfolio() {
    const p = plan();
    const now = estimateToday(), todayEst = now;
    const ahead = aheadYears();
    const futureDate = (() => { const d = new Date(`${today()}T00:00:00Z`); d.setUTCFullYear(d.getUTCFullYear() + ahead); return d.toISOString().slice(0, 10); })();
    const est = ahead ? RV.estimateAt(p, futureDate, model.proj) : now;
    const aheadYear = Number(futureDate.slice(0, 4));
    // Money set aside on that date, and how much of each account it takes.
    const res = E.reservesAt(p, est.years || 0);
    const heldIn = {};
    for (const r of res) if (r.accountId) heldIn[r.accountId] = (heldIn[r.accountId] || 0) + r.held;
    // What is really held: never more than the account has (the rest is still to put aside).
    const heldTotal = Object.entries(heldIn).reduce((acc, [id, v]) => acc + Math.min(v, Math.max(0, est.byId[id] ?? v)), 0);
    const heldShort = Object.values(heldIn).reduce((acc, v) => acc + v, 0) - heldTotal;
    const resTag = a => {
      const v = heldIn[a.id] || 0;
      if (v < 0.5) return null;
      const parts = res.filter(r => r.accountId === a.id && r.held >= 0.5).map(r => `${r.name} ${money(r.held)}${r.kind === 'saving' ? ' (spoken for)' : r.kind === 'budget' ? ' (to spend)' : ''}`);
      const free = est.byId[a.id] - v;
      const over = free < -Math.max(50, v * 0.01);
      return h('span', { class: `pf-res-tag${over ? ' over' : ''}`, title: over ? 'More is set aside than the account holds: move money in or set aside less.' : 'How this balance splits: money set aside, and what is free to use.' },
        glyph(over ? 'warn' : 'lock'), [...parts, over ? `${money(-free)} short` : `free ${money(Math.max(0, free))}`].join(' · '));
    };
    const deflate = ahead ? Math.pow(1 + p.assumptions.inflation / 100, ahead) : 1;
    // The left column: the figures you entered, or today when looking ahead.
    const baseOf = a => (ahead ? now.byId[a.id] : a.balance);
    const box = $('#homePortfolio');
    // The last update: the figures date, or the latest balance read since.
    const lastUpdate = [est.asOf, ...Object.values(est.reading).map(r => r.date)].sort().pop();
    const delta = lastUpdate < today() ? est.netWorth - RV.estimateAt(p, lastUpdate, model.proj).netWorth : null;
    // Each type's total today: its accounts, plus money the plan expects where there is no account yet.
    // A home to be bought later is listed but not counted until it is bought.
    const later = a => notYet(a, est.years);
    const missingOf = (list, key) => list.filter(m => m.type === key && !(key === 'property' && p.accounts.some(a => a.type === 'property' && !a.excluded && !later(a))));
    const typeTotal = key => p.accounts.filter(a => a.type === key && !a.excluded && !later(a)).reduce((acc, a) => acc + est.byId[a.id], 0)
      + missingOf(est.missing, key).reduce((acc, m) => acc + m.value, 0);
    const typeWas = key => p.accounts.filter(a => a.type === key && !a.excluded && !notYet(a, now.years)).reduce((acc, a) => acc + baseOf(a), 0)
      + (ahead ? missingOf(now.missing, key).reduce((acc, m) => acc + m.value, 0) : 0);
    const classes = accessClasses(ahead)
      .map(c => ({ ...c, groups: c.types.map(k => PF_GROUPS.find(g => g.key === k)).filter(g => typeTotal(g.key) > 0.5 || p.accounts.some(a => a.type === g.key)) }))
      .filter(c => c.groups.length);
    const classTotal = c => c.groups.reduce((x, g) => x + typeTotal(g.key), 0);
    const totalAssets = classes.filter(c => c.key !== 'owed').reduce((acc, c) => acc + classTotal(c), 0);
    const avail = classes.find(c => c.key === 'now');
    const owed = classes.find(c => c.key === 'owed');
    const totalOwed = owed ? classTotal(owed) : 0;
    const ring = portfolioDonut(classes.filter(c => c.key !== 'owed').map(c => c.groups.map(g => ({ key: g.key, label: g.label, color: g.color, value: typeTotal(g.key), group: c.label }))),
      totalAssets, key => {
        const c = classes.find(x => x.types.includes(key));
        const many = p.accounts.filter(a => a.type === key).length > 1;
        const shown = c && pfClassOpen.has(c.key) && (!many || pfOpen.has(key));
        if (shown) { if (many) pfOpen.delete(key); else pfClassOpen.delete(c.key); }
        else { if (c) pfClassOpen.add(c.key); if (many) pfOpen.add(key); }
        renderPortfolio();
      });
    // Accounts under their type, and types under when the money can be used.
    const owner = a => (a.owner === 'joint' ? 'Joint' : (people()[E.personIndex(p, a.owner)] || {}).name || '');
    const signed = (v, debtish) => `${debtish && v >= 0.5 ? '−' : ''}${money(v)}`;
    const changeTag = (change, debtish) => (Math.abs(change) >= 1 ? h('small', { class: (change > 0) !== debtish ? 'pos' : 'neg' }, `${change > 0 ? '+' : '−'}${money(Math.abs(change))}`) : null);
    const updated = r => (r ? h('span', { class: 'src updated', title: `You entered ${money(r.value)} on ${fmtDate(r.date)}${r.date < today() ? '; moved on since as the plan expects' : ''}.` }, glyph('good'), r.date === today() ? 'Updated today' : `Updated ${fmtDate(r.date)}`) : null);
    const typeRows = g => {
      const debtish = g.key === 'debt';
      const accounts = p.accounts.filter(a => a.type === g.key);
      // Money for an ISA or general account someone has yet to open: shown under their name.
      const toOpen = missingOf(est.missing, g.key).filter(m => m.owner);
      const openWas = m => (ahead ? (todayEst.missing.find(x => x.type === m.type && x.owner === m.owner) || { value: 0 }).value : 0);
      const was = typeWas(g.key), now = typeTotal(g.key);
      // A type with one account is a single row: the type, with the account named under it.
      if (accounts.length === 1 && !toOpen.length) {
        const a = accounts[0];
        return h('div', { class: `pf-row group single${a.excluded ? ' excluded' : ''}`, role: 'row', 'data-account': a.id, 'data-type': g.key, style: `--item-color:${cssVar(g.color)}` },
          h('span', { class: 'pf-name', role: 'cell' }, h('i', { class: 'key square', style: `--key:${cssVar(g.color)}` }),
            h('span', { class: 'pf-two' }, h('span', {}, h('strong', {}, g.label), updated(est.reading[a.id])),
              h('small', {}, [a.name, owner(a), a.excluded ? 'not counted' : '', later(a) ? `buying in ${a.buyYear}: not counted yet` : ''].filter(Boolean).join(' · '), resTag(a)))),
          h('span', { class: 'pf-was', role: 'cell' }, signed(baseOf(a), debtish)),
          h('span', { class: 'pf-now', role: 'cell' }, h('strong', {}, signed(est.byId[a.id], debtish)), changeTag(est.byId[a.id] - baseOf(a), debtish)));
      }
      const open = pfOpen.has(g.key);
      const rows = accounts.length + toOpen.length;
      const nUpdated = accounts.filter(a => est.reading[a.id]).length;
      const toggle = () => { if (open) pfOpen.delete(g.key); else pfOpen.add(g.key); renderPortfolio(); };
      return [
        h('div', { class: `pf-row group${open ? ' open' : ''}`, role: 'row', 'data-type': g.key, style: `--item-color:${cssVar(g.color)}` },
          h('span', { class: 'pf-name', role: 'cell' }, h('i', { class: 'key square', style: `--key:${cssVar(g.color)}` }), h('strong', {}, g.label),
            rows
              ? h('button', { type: 'button', class: 'pf-toggle', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} the ${rows} ${g.label} accounts`, onclick: toggle },
                accounts.length ? `${rows} accounts` : `${rows} to open`, h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸'))
              : h('small', { class: 'muted' }, 'expected; no account yet'),
            nUpdated ? h('span', { class: 'src updated' }, glyph('good'), `${nUpdated} updated`) : null),
          h('span', { class: 'pf-was', role: 'cell' }, signed(was, debtish)),
          h('span', { class: 'pf-now', role: 'cell' }, h('strong', {}, signed(now, debtish)), changeTag(now - was, debtish))),
        accounts.map(a => {
          const v = est.byId[a.id];
          const r = est.reading[a.id];
          return h('div', { class: `pf-row acct${a.excluded ? ' excluded' : ''}`, role: 'row', 'data-account': a.id, hidden: !open },
            h('span', { class: 'pf-name', role: 'cell' }, h('span', {}, a.name, updated(r)),
              h('small', {}, [owner(a), a.excluded ? 'not counted' : '', later(a) ? `buying in ${a.buyYear}: not counted yet` : ''].filter(Boolean).join(' · '), resTag(a))),
            h('span', { class: 'pf-was', role: 'cell' }, signed(baseOf(a), debtish)),
            h('span', { class: 'pf-now', role: 'cell' }, signed(v, debtish), changeTag(v - baseOf(a), debtish)));
        }),
        toOpen.map(m => {
          const who = people().find(x => x.id === m.owner);
          return h('div', { class: 'pf-row acct to-open', role: 'row', 'data-to-open': `${m.type}:${m.owner}`, hidden: !open },
            h('span', { class: 'pf-name', role: 'cell' }, h('span', {}, `${who ? who.name : ''} ${m.type === 'isa' ? 'stocks & shares ISA' : 'general investment account'}`),
              h('small', {}, m.type === 'isa' ? 'Not opened yet: the plan uses this person’s own ISA allowance' : 'Not opened yet: the plan puts money here once the ISAs are full')),
            h('span', { class: 'pf-was', role: 'cell' }, money(openWas(m))),
            h('span', { class: 'pf-now', role: 'cell' }, money(m.value), changeTag(m.value - openWas(m), false)));
        }),
      ];
    };
    const list = h('div', { class: 'pf-list', role: 'table', 'aria-label': ahead ? `Accounts by when the money can be used, expected in ${aheadYear}` : 'Accounts by when the money can be used, estimated today' },
      h('div', { class: 'pf-row head', role: 'row' }, h('span', { role: 'columnheader' }, 'Account'),
        h('span', { role: 'columnheader' }, ahead ? 'Today' : `On ${fmtDate(est.asOf)}`),
        h('span', { role: 'columnheader' }, ahead ? `In ${aheadYear} (expected)` : daysSince(est.asOf) <= 0 ? 'Today' : 'Today (estimated)')),
      classes.map(c => {
        const owed = c.key === 'owed';
        const now = classTotal(c), was = c.groups.reduce((x, g) => x + typeWas(g.key), 0);
        const open = pfClassOpen.has(c.key);
        const toggle = () => { if (open) pfClassOpen.delete(c.key); else pfClassOpen.add(c.key); renderPortfolio(); };
        return [
          h('div', { class: `pf-row access ${c.key}${open ? ' open' : ''}`, role: 'row', 'data-access': c.key, 'data-types': c.groups.map(g => g.key).join(' '), onclick: toggle },
            h('span', { class: 'pf-name', role: 'cell' }, h('button', { type: 'button', class: 'pf-class-btn', 'aria-expanded': String(open), 'aria-label': `${open ? 'Hide' : 'Show'} ${c.label}`, onclick: e => { e.stopPropagation(); toggle(); } },
              h('span', { class: 'chev', 'aria-hidden': 'true' }, '▸')), h('span', { class: 'pf-two' }, h('strong', {}, c.label), h('small', {}, c.note))),
            h('span', { class: 'pf-was', role: 'cell' }, signed(was, owed)),
            h('span', { class: 'pf-now', role: 'cell' }, h('strong', {}, signed(now, owed)),
              !owed && totalAssets > 0 ? h('small', { class: 'muted' }, `${Math.round((now / totalAssets) * 100)}% of what you own`) : null)),
          open ? c.groups.map(typeRows) : null,
        ];
      }));
    const readings = ahead ? 0 : Object.keys(est.reading).length;
    const days = daysSince(est.asOf);
    // Today, or a number of years ahead.
    const N = model.proj.pre.N;
    const firstRet = Math.min(...people().map(x => x.retireAge - x.age).filter(v => v > 0));
    const picks = [[0, 'Today'], [5, '5 years'], [10, '10 years'], [15, '15 years'], [20, '20 years']].filter(([v]) => v < N)
      .concat(Number.isFinite(firstRet) && firstRet < N ? [['retire', 'Retirement']] : []);
    const picker = h('div', { class: 'seg mini pf-ahead', role: 'group', 'aria-label': 'Show the portfolio for' }, picks.map(([v, label]) => h('button', {
      type: 'button', 'aria-pressed': String(String(pfAhead) === String(v)), 'data-ahead': String(v),
      title: v === 'retire' ? `When ${people().find(x => x.retireAge - x.age === firstRet).name} retires (${p.startYear + firstRet})` : v ? `In ${new Date().getFullYear() + v}` : 'Today',
      onclick: () => { pfAhead = v; renderPortfolio(); },
    }, label)));
    // The balances you updated, against what the plan expected on those days.
    let vsPlan = 0;
    for (const a of p.accounts) {
      const r = est.reading[a.id];
      if (!r) continue;
      const e = RV.expectedBalances(p, RV.yearsBetween(est.asOf, r.date), model.proj).byId[a.id];
      vsPlan += (a.type === 'debt' ? -1 : 1) * (r.value - (e === undefined ? a.balance : e));
    }
    setKids(box, ...[
      h('div', { class: 'card-head' },
        h('div', {}, h('p', { class: 'eyebrow' }, `${ahead ? `In ${aheadYear}` : 'Today'} · ${agesAt(ahead)}`), h('h2', { id: 'pfTitle' }, ahead ? 'Where you’ll be' : 'Your portfolio'),
          h('p', { class: 'sub' }, ahead
            ? `What the plan expects in ${aheadYear}, on average returns, in the pounds of that year, next to today. Pick “Today” to go back.`
            : days > 0
              ? `Estimated for today from your figures as at ${fmtDate(est.asOf)} (${sinceText(days)}), on average returns${readings ? `, with ${readings} balance${readings === 1 ? '' : 's'} you updated since` : ''}.`
              : `Your figures as at ${fmtDate(est.asOf)}. From here Horizon estimates each balance until your next review.`)),
        h('div', { class: 'controls' }, picker)),
      h('div', { class: 'pf-body' },
      h('div', { class: 'pf-side' },
        h('div', { class: 'pf-total' },
          h('div', { class: 'hero-label' }, ahead ? `Expected net worth in ${aheadYear}` : 'Estimated net worth today'),
          h('div', { class: 'hero-value' }, money(est.netWorth)),
          ahead
            ? h('div', { class: `delta ${est.netWorth >= now.netWorth ? 'pos' : 'neg'}` }, glyph(est.netWorth >= now.netWorth ? 'trend' : 'trend-down'),
              `${est.netWorth >= now.netWorth ? '+' : '−'}${money(Math.abs(est.netWorth - now.netWorth))} from today · ${money(est.netWorth / deflate)} in today’s money`)
            : delta == null
              ? h('div', { class: 'delta flat' }, glyph('good'), 'Updated today')
              : h('div', { class: `delta ${delta >= 0 ? 'pos' : 'neg'}` }, glyph(delta >= 0 ? 'trend' : 'trend-down'), `${delta >= 0 ? '+' : '−'}${money(Math.abs(delta))} since your last update (${fmtDate(lastUpdate)})`),
          readings && Math.abs(vsPlan) >= 1 ? h('div', { class: `delta vs-plan ${vsPlan >= 0 ? 'pos' : 'neg'}`, id: 'pfVsPlan' }, glyph(vsPlan >= 0 ? 'good' : 'warn'),
            `${money(Math.abs(vsPlan))} ${vsPlan >= 0 ? 'ahead of' : 'behind'} the plan on the ${readings} balance${readings === 1 ? '' : 's'} you updated`) : null),
        // How the net worth is made up, so the numbers add up, beside the donut.
        h('div', { class: 'pf-visual' }, h('div', { class: 'pf-mix' }, ring), h('dl', { class: 'pf-sum', id: 'pfSum' },
          h('div', {}, h('dt', {}, 'What you own'), h('dd', {}, money(totalAssets))),
          avail ? h('div', { class: 'sub-line' }, h('dt', {}, 'of which available now'), h('dd', {}, money(classTotal(avail)))) : null,
          avail && heldTotal >= 0.5 ? h('div', { class: 'sub-line deeper' }, h('dt', {}, 'set aside'), h('dd', {}, money(heldTotal))) : null,
          avail && heldTotal >= 0.5 ? h('div', { class: 'sub-line deeper free' }, h('dt', {}, 'free to use'), h('dd', {}, money(Math.max(0, classTotal(avail) - heldTotal)))) : null,
          h('div', {}, h('dt', {}, 'What you owe'), h('dd', {}, `${totalOwed >= 0.5 ? '−' : ''}${money(totalOwed)}`)),
          est.locked >= 0.5 ? h('div', { class: 'locked-line' }, h('dt', {}, 'Set aside to spend'), h('dd', {}, `−${money(est.locked)}`)) : null,
          h('div', { class: 'total' }, h('dt', {}, 'Net worth'), h('dd', {}, money(totalAssets - totalOwed - (est.locked || 0)))))),
        res.length ? reservesPanel(res, ahead ? `in ${aheadYear}` : 'today', heldShort)
          : ahead ? null : h('p', { class: 'hint pf-res-none' }, 'Keep an emergency fund, money for repairs or a holiday budget in these accounts? ',
            h('button', { type: 'button', class: 'linkish', onclick: () => navigate('finances/saving') }, 'Mark it as set aside'), ' and Home shows what can be touched.'),
        readings ? h('p', { class: 'hint' }, `Your goals still use the figures from ${fmtDate(est.asOf)}; the balances you updated feed into your next yearly review.`) : null),
      list),
    ].filter(Boolean));
  }

  // Everyone in the plan has stopped work (pages then leave out what is about working years).
  const allRetired = () => people().every(x => x.retireAge <= x.age);
  // A defined benefit pension or annuity that is already being paid.
  const inPayment = (item, p = plan()) => {
    const x = p.household.people[E.personIndex(p, item.owner === 'joint' ? 'p1' : item.owner)];
    return (item.kind === 'dbpension' || item.kind === 'annuity') && !!x && x.age >= item.startAge;
  };

  // The portfolio by when the money can be used.
  function accessClasses(ahead = 0) {
    const ages = [...new Set(people().map(x => x.pensionAccessAge))].join(' / ');
    const drawing = people().filter(x => x.age + ahead >= x.pensionAccessAge).map(x => x.name);
    return [
      { key: 'now', label: 'Available now', types: ['cash', 'isa', 'gia', 'bonds'], note: 'Cash, ISAs, investments and gilts: can be withdrawn or sold' },
      drawing.length === people().length && !plan().accounts.some(a => a.type === 'lisa' && !a.excluded)
        ? { key: 'locked', label: 'Pensions you can draw', types: ['pension', 'lisa'], note: 'Can be drawn now: a quarter tax-free, the rest taxed as income (an inherited pot may be tax-free)' }
        : { key: 'locked', label: 'Locked away for now', types: ['pension', 'lisa'],
          note: `Pensions from ${ages}${drawing.length ? ` (${drawing.join(' and ')} can draw now)` : ''}; Lifetime ISAs from 60${E.ownsHome(plan()) ? '' : ' or for a first home'}` },
      { key: 'property', label: propLabel(), types: ['property', 'asset'], note: 'Only usable by selling or downsizing' },
      { key: 'owed', label: 'Owed', types: ['debt'], note: 'Mortgage and loans' },
    ];
  }

  // A donut of what you own: one ring of types, grouped (a wider gap) by when they can be used.
  // Hover or focus a slice: it stands out, the centre gives its details and its row lights up.
  function portfolioDonut(groups, total, onPick) {
    const NS = 'http://www.w3.org/2000/svg';
    const R = 54, W = 20, C = 2 * Math.PI * R;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 140 140');
    svg.setAttribute('class', 'pf-donut-svg');
    const items = groups.flatMap((g, gi) => g.filter(x => x.value > 0.5).map((x, i) => ({ ...x, gap: i === 0 && gi > 0 ? 5 : 1.6 })));
    const gaps = items.length > 1 ? items.reduce((acc, x) => acc + x.gap, 0) : 0;
    const label = h('small', {}, 'What you own'), value = h('strong', {}, fmtCompact(total)), note = h('small', {}, `${items.length} kinds of account`);
    const centre = h('div', { class: 'pf-donut-centre', 'aria-live': 'polite' }, label, value, note);
    const arcs = [];
    const show = x => {
      for (const a of arcs) { a.el.classList.toggle('on', a.x === x); a.el.classList.toggle('dim', !!x && a.x !== x); }
      for (const row of $$('#homePortfolio .pf-row[data-type]')) row.classList.toggle('hl', !!x && row.dataset.type === x.key);
      for (const row of $$('#homePortfolio .pf-row[data-types]')) row.classList.toggle('hl', !!x && row.dataset.types.split(' ').includes(x.key) && !row.classList.contains('open'));
      if (x) { label.textContent = x.label; value.textContent = money(x.value); note.textContent = `${Math.round((x.value / Math.max(1, total)) * 100)}% of what you own · ${x.group.toLowerCase()}`; }
      else { label.textContent = 'What you own'; value.textContent = fmtCompact(total); note.textContent = `${items.length} kinds of account`; }
    };
    let at = 0;
    for (const x of items) {
      const len = Math.max(0.5, (x.value / Math.max(1, total)) * (C - gaps));
      const c = document.createElementNS(NS, 'circle');
      for (const [k, v] of [['cx', 70], ['cy', 70], ['r', R], ['fill', 'none'], ['stroke', cssVar(x.color)], ['stroke-width', W],
        ['stroke-dasharray', `${len} ${C - len}`], ['stroke-dashoffset', -at], ['transform', 'rotate(-90 70 70)'],
        ['tabindex', 0], ['role', 'img'], ['aria-label', `${x.label}: ${money(x.value)}, ${Math.round((x.value / Math.max(1, total)) * 100)}% of what you own`], ['data-type', x.key], ['class', 'arc']]) c.setAttribute(k, String(v));
      c.addEventListener('pointerenter', () => show(x));
      c.addEventListener('focus', () => show(x));
      c.addEventListener('pointerleave', () => show(null));
      c.addEventListener('blur', () => show(null));
      c.addEventListener('click', () => onPick && onPick(x.key));
      c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (onPick) onPick(x.key); } });
      arcs.push({ x, el: c });
      svg.append(c);
      at += len + (items.length > 1 ? x.gap : 0);
    }
    const box = h('div', { class: 'pf-donut', role: 'group', 'aria-label': `What you own, ${money(total)}, by kind of account` }, svg, centre);
    // The table points back: hovering a row lights up its slice.
    requestAnimationFrame(() => {
      for (const row of $$('#homePortfolio .pf-row[data-type]')) {
        const x = items.find(i => i.key === row.dataset.type);
        if (!x) continue;
        row.addEventListener('pointerenter', () => show(x));
        row.addEventListener('pointerleave', () => show(null));
      }
      // A folded group: hovering it lights up all its slices.
      for (const row of $$('#homePortfolio .pf-row[data-types]')) {
        const keys = row.dataset.types.split(' ');
        row.addEventListener('pointerenter', () => { for (const a of arcs) { a.el.classList.toggle('on', keys.includes(a.x.key)); a.el.classList.toggle('dim', !keys.includes(a.x.key)); } });
        row.addEventListener('pointerleave', () => show(null));
      }
    });
    return box;
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
      // What is left over goes to expensive debt, then the cash buffer, before anything is invested.
      if (!parts.length && m.hiDebt > 0.5) add('Pay off debt', `${money(m.hiDebt)} a month`, `What is left over goes to the expensive debt first${m.cash > 0.5 ? `, then ${money(m.cash)} a month into cash savings` : ''}. After that it is invested.`, true);
      else if (!parts.length && m.cash > 0.5) add('Save', `${money(m.cash)} a month`, `Into cash savings first, until the buffer reaches ${money(p.strategy.cashReserve)}. After that it is invested.`, true);
      else add('Invest', `${money(m.invest)} a month`, (parts.length ? parts.join(', ') : 'Nothing left over to invest this year.') + (parts.length && m.cash > 0.5 ? `; and ${money(m.cash)} into cash savings` : ''), true);
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
        const under = pre.people[i].sacrificed[0] || 0;   // "Keep income under £100,000"
        if (ee + er + extra + under > 0.5) {
          add(`${person.name}’s pension`, `${money((ee + er + extra + under) / 12)} a month`,
            [ee > 0.5 ? `${people().length > 1 ? person.name : 'you'} ${money(ee / 12)}` : '', er > 0.5 ? `employer ${money(er / 12)}` : '', under > 0.5 ? `${money(under / 12)} more by salary sacrifice, to keep income under ${money(E.stayUnderLine(p.strategy) || R.PA_TAPER_START)}` : '', extra > 0.5 ? `${ee + er > 0.5 ? 'extra ' : ''}${money(extra / 12)} paid in yourself, with tax relief` : ''].filter(Boolean).join(' + ') + (ee + er > 0.5 ? '. Check your payslip matches.' : '. Check the pension provider’s statement matches.'));
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

  const ACTION_LABEL = { market: 'Markets & inflation', saving: 'Saving & investing', 'guide:estate': 'Open the guide', life: 'Future costs', strategy: 'Saving strategy', explorer: 'Try changes', accounts: 'Accounts', spending: 'Spending check-up', review: 'Start review', emergency: 'Add a goal' };

  function insightAction(a) {
    if (a === 'life') return openLifeWizard();
    if (a === 'spending') return openWizard();
    if (a === 'review') return openReview();
    if (a === 'emergency') return openGoalWizard(null, 'emergency');
    if (a.startsWith('compare:')) { openComparison(a.slice(8)); return; }
    if (a.startsWith('guide:')) { openGuide(a.slice(6)); return; }
    navigate(a === 'accounts' ? 'finances/portfolio' : a === 'strategy' || a === 'saving' ? 'finances/saving' : 'finances/assumptions');
    requestAnimationFrame(() => { const sec = $(`#sec-${a}`); if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // A suggestion's button shows only when there is somewhere for it to go.
  const actionFits = a => !!a && (a.startsWith('guide:') ? !!GUIDES[a.slice(6)] : !a.startsWith('compare:') || SI.comparisonsFor(plan()).some(c => c.id === a.slice(8)));

  // ---- "i" explanations and suggestion markers, added to labels as the page is drawn
  // Each term matches a label, a card or section heading, or a figure's caption by its text.
  const TERMS = [
    { match: /^Why you are where you are$/, title: 'Why you are where you are',
      text: () => 'Your net worth on the review date next to what the plan expected for that date, split into the reasons: markets, money put in, the home’s value, the mortgage, pensions, budgets not spent, money kept set aside, and cash with everything else (whatever is left over). The parts always add up to the difference. Markets and money put in can only be told apart if you say how much you paid in.' },
    { match: /^Paid into ISAs and investments/, title: 'Paid into ISAs and investments',
      text: () => 'Add up what went into your ISAs, Lifetime ISAs and general investment accounts since your last figures, minus anything you took out. Your provider’s app usually shows this as “contributions” or in the transaction history. Leave it empty if you are not sure: the review then shows markets and money put in together.' },
    { match: /^Your plan, step by step$/, title: 'Your plan, step by step',
      text: () => 'Worked out from your plan, not typed in: the monthly amounts to set up now, the dates when something changes (a fixed rate ending, a gilt maturing, someone retiring) and the jobs to do every year. Change the plan and the list follows.' },
    { match: /^Worth a look$/, title: 'Worth a look',
      text: () => 'Suggestions from rules of thumb (not financial advice) and step-by-step guides, most important first. Hide one with “Already sorted” or “Not now”; “Show hidden” brings them back.' },
    { match: /^Set aside to spend$/, title: 'Set aside to spend',
      text: () => 'Money you expect to spend: savings building up for a planned cost (like repairs every few years, kept invested until needed) and what is left of a yearly budget (like holidays, in the bank until spent). It is already spoken for, so it is left out of net worth, and of goals measured on net worth or savings. The emergency fund is not here: it is not meant to be spent, so it still counts.' },
    { match: /^(Set aside|set aside|free to use|Money set aside)$/, title: 'Money set aside',
      text: () => 'Part of an account that is spoken for: the emergency fund, money building up for a known cost (like repairs every few years) and yearly budgets (like holidays) that sit in the bank until spent. The plan already counts what they pay for, so nothing is taken twice; marking them shows what is free to use or invest. A budget is counted as spent each year; at the yearly review you say how much is left and whether to keep it or free it up.' },
    { match: /^(ISAs|ISA allowance per person|ISAs & general investment)$/, title: 'ISAs',
      text: () => `Tax-free savings and investments: no tax on interest, dividends or gains, and the money can be taken out at any time. Each person can pay in ${money(R.ISA_ALLOWANCE)} a year across all their ISAs (a Lifetime ISA counts towards it); allowance not used by 5 April is lost.` },
    { match: /Lifetime ISA/, title: 'Lifetime ISA',
      text: () => `Opened between 18 and 39 and paid into until 50: up to ${money(R.LISA.maxContribution)} a year, and the government adds 25% (${money(R.LISA.maxContribution * R.LISA.bonus)}). It can be used from 60, or towards a first home up to £450,000; any other withdrawal loses 25%, about 6% of your own money.` },
    { match: /^General investment( account)?$/, title: 'General investment account',
      text: () => `For investing beyond the ISAs, with no limit. Tax is due on dividends above £500 a year each and on gains above ${money(R.CGT.annualExempt)} a year each when you sell (${Math.round(R.CGT.basicRate * 100)}% or ${Math.round(R.CGT.higherRate * 100)}%). Moving some into ISAs each April (“Bed and ISA”) and using both people’s allowances keeps it down.` },
    { match: /^Once the ISAs are full$/, title: 'Pensions first',
      text: () => `With this on, money left once the ISAs are full goes into the pension of whoever pays the highest rate of tax and is still working, instead of a general account. Tax relief at their top rate makes each £1 worth more (for a 45% taxpayer, £1 in costs about 55p). Up to ${money(R.PENSION_ANNUAL_ALLOWANCE)} a year each, employer included, and no more than their pay. The catch: it is locked until the minimum pension age (${R.MIN_PENSION_AGE}), and three-quarters is taxed as income when drawn.` },
    { match: /^(Pensions|Into pensions|Extra into .+ pension|Workplace pension)$/, title: 'Pensions',
      text: () => `Saving for retirement with tax relief at your top rate: £1 in the pension costs 80p of take-home pay at 20%, 58p at 42% and 55p at 45%, and employers often add more. From ${R.MIN_PENSION_AGE} a quarter can be taken tax-free (up to ${money(R.LUMP_SUM_ALLOWANCE)} each in all) and the rest is taxed as income. Up to ${money(R.PENSION_ANNUAL_ALLOWANCE)} a year each, employer included.` },
    { match: /^(Pension tax relief|You pay|Employer pays|Contributions as|Paid by)$/, title: 'How pension tax relief reaches you',
      text: () => 'Salary sacrifice: you take a lower salary and the employer pays the difference into the pension, so the relief is automatic and NI is saved too (some employers add their NI saving). Net pay: the contribution comes off before tax, also automatic. Relief at source: it comes off after tax and the provider adds 20%; anyone paying more than 20% claims the rest from HMRC (self-assessment, up to 4 years back).' },
    { match: /^Above £100,000$/, title: 'The £100,000 line',
      text: () => 'Above £100,000 of income the tax-free personal allowance shrinks by £1 for every £2, so the pay between £100,000 and £125,140 is taxed at about 62% (69.5% in Scotland) with NI, and Tax-Free Childcare stops. Income here means after pension contributions, so salary sacrifice brings it down.' },
    { match: /^(Coupons|Bonds & gilts|Matures in)$/, title: 'Gilts and their coupons',
      text: () => 'A gilt is a loan to the UK government: it pays a fixed coupon twice a year and is repaid in full on a set date. Gains on gilts are free of capital gains tax even outside an ISA; coupons are taxed as interest unless held in an ISA. Buying them costs a dealing charge each time, so small coupons are cheaper to add to a fund you already buy each month, or to hold bonds through a gilt index fund with regular investing.' },
    { match: /^Cash buffer to keep$/, title: 'Cash buffer',
      text: () => 'Easy-access cash for emergencies; 3–6 months of spending and mortgage payments is the usual guide. The plan tops it up before investing and spends it first when money is short, so investments are not sold in a bad year.' },
    { match: /^(Overpay mortgage with|Overpayment limit)$/, title: 'Overpaying the mortgage',
      text: () => 'Every £1 overpaid earns a sure return equal to the mortgage rate and clears the debt sooner. Most fixed deals let you overpay 10% of the balance a year without a charge. Investing is expected to earn more over time, with ups and downs.' },
    { match: /^Spending in retirement/, title: 'Spending in retirement',
      text: () => 'What you spend each year once retired, in today’s money: the plan raises it with prices every year, so it buys the same as it would today. 0 keeps your spending list as it stands then. Future costs (care, help for family) still come on top.' },
    { match: /^Inflation$/, title: 'Inflation',
      text: () => `How fast prices rise each year. Spending, the State Pension and most allowances rise with it; cash loses value if its interest is lower. Plans use a long-run figure (the Bank of England aims for 2%); ${plan().assumptions.inflation}% is used here.` },
    { match: /^In shares( now| by retirement)?$/, title: 'Shares and bonds',
      text: () => 'Shares grow more over time but can fall by a third in a bad year; bonds and gilts grow less and move less. Moving from shares towards bonds as retirement nears means a crash just before you stop hurts less.' },
    { match: /^(Available now|Locked away( for now)?)$/, title: 'Available or locked away',
      text: () => `Available now: cash, ISAs, general investments and gilts, which can be sold within days. Locked away: pensions (from ${R.MIN_PENSION_AGE}) and Lifetime ISAs (from 60, or a 25% charge). Property can only be used by selling or downsizing.` },
    { match: /^Money in and out$/, title: 'Actual pounds or today’s money',
      text: () => 'Actual pounds are what you will see in each year: prices rise, so spending and pay rise too. Today’s money divides every year by inflation so amounts compare with what things cost now, and costs that only keep up with prices look flat. The buttons on the card switch between them.' },
    { match: /^Coming in$/, title: 'Coming in',
      text: () => 'Pay after income tax, NI and pension contributions, plus rent and other income. Where pay is entered as take-home, the tax already taken from it is estimated.' },
    { match: /^Tax & NI$/, title: 'Tax and NI',
      text: () => 'Income tax and National Insurance on pay, tax on rent, pensions drawn and investments. For pay entered as take-home it is estimated by working the gross pay back from the take-home figure.' },
    { match: /^Chance the money lasts$/, title: 'Chance the money lasts',
      text: () => `The plan is run through ${ws.settings.runs.toLocaleString('en-GB')} simulated futures, each with its own ups and downs in markets and inflation. This is the share of them where your savings never run out before the end of the plan. 85–90% is a common aim; 100% would mean spending very little.` },
    { match: /^Tax rules$/, title: 'Income tax bands',
      text: () => (plan().household.region === 'scotland'
        ? 'Scotland: 19% starter, 20% basic, 21% intermediate, 42% higher, 45% advanced and 48% top rate, after a £12,570 personal allowance. Above £100,000 the allowance shrinks by £1 for every £2, so each £1 between £100,000 and £125,140 costs about 69.5% with NI. NI is UK-wide: 8% up to £50,270, then 2%.'
        : 'England, Wales and Northern Ireland: 20% basic, 40% higher and 45% additional rate, after a £12,570 personal allowance. Above £100,000 the allowance shrinks by £1 for every £2, so each £1 between £100,000 and £125,140 costs about 62% with NI. NI: 8% up to £50,270, then 2%.') },
    { match: /^(Net worth|Estimated net worth today|Expected net worth in \d{4})$/, title: 'Net worth',
      text: () => 'Everything you own (cash, investments, pensions, homes) minus what you owe. Pensions and homes count in full even though they cannot be spent today; “Available now” is what could be.' },
    { match: /^Another way to split it$/, title: 'The usual order',
      text: () => 'Not extra money: another way to split what your plan already puts away each month. A common UK order: an emergency fund first (counting ISAs if your emergency-fund goal does), then the employer’s full pension match, pension where it gets 40%+ relief (unless your pay is kept at a line such as £60,000 for Child Benefit), Lifetime ISAs (for a first home, or money that can wait until 60), then stocks & shares ISAs, and a general account last. Rules of thumb, not advice.' },
    { match: /^(State Pension \(£\/year, today\)|State Pension age)$/, title: 'State Pension',
      text: () => `The full new State Pension is ${money(R.STATE_PENSION_FULL)} a year, rising each year at least with prices. It needs 35 qualifying years of NI (10 for any at all), and starts at 66–68 depending on when you were born. Check your own forecast and record at gov.uk/check-state-pension.` },
    { match: /^(Tax-free lump sum|Scheme|Joined in)$/, title: 'Defined benefit pensions',
      text: () => 'A pension that pays a set income for life, rising with prices, worked out from your salary and years in the scheme (USS and other public-sector schemes). Taken before its normal pension age it is reduced for good; USS also pays a tax-free lump sum of 3× the pension.' },
  ];
  const termFor = text => TERMS.find(t => t.match.test(text)) || null;

  // One popover for every "i" and suggestion marker.
  let infoOpen = null;
  let infoAt = 0;   // when it opened: the scroll that brought the button into view may still be arriving
  function infoPop() {
    let el = $('#infoPop');
    if (!el) {
      el = h('div', { id: 'infoPop', class: 'info-pop', role: 'dialog', hidden: true });
      document.body.append(el);
      document.addEventListener('click', e => { if (infoOpen && !el.contains(e.target) && !infoOpen.contains(e.target)) closeInfo(); }, true);
      document.addEventListener('keydown', e => { if (e.key === 'Escape' && infoOpen) { const b = infoOpen; closeInfo(); b.focus(); } });
      // Scrolling the page (or the panel the button is in) moves the button away: close. Other scrolling, like a carousel, doesn't.
      window.addEventListener('scroll', e => { if (infoOpen && Date.now() - infoAt > 250 && (e.target === document || (e.target.contains && e.target.contains(infoOpen)))) closeInfo(); }, true);
      window.addEventListener('resize', () => { if (infoOpen) closeInfo(); });
    }
    return el;
  }
  function closeInfo() {
    const el = $('#infoPop');
    if (el) el.hidden = true;
    if (infoOpen) infoOpen.setAttribute('aria-expanded', 'false');
    infoOpen = null;
  }
  function openInfo(btn, ...content) {
    const el = infoPop();
    if (infoOpen === btn) { closeInfo(); return; }
    closeInfo();
    setKids(el, ...content);
    el.setAttribute('aria-label', btn.getAttribute('aria-label') || 'Details');
    el.hidden = false;
    infoOpen = btn;
    infoAt = Date.now();
    btn.setAttribute('aria-expanded', 'true');
    const r = btn.getBoundingClientRect();
    const w = Math.min(340, window.innerWidth - 32);
    el.style.width = `${w}px`;
    el.style.left = `${Math.max(16, Math.min(window.innerWidth - w - 16, r.left - 16))}px`;
    const below = r.bottom + 8, hgt = el.offsetHeight;
    el.style.top = `${below + hgt > window.innerHeight - 8 && r.top - hgt - 8 > 8 ? r.top - hgt - 8 : below}px`;
  }
  function infoBtn(term) {
    const b = h('button', { type: 'button', class: 'info-btn', 'aria-label': `About: ${term.title}`, 'aria-expanded': 'false', 'aria-controls': 'infoPop' }, glyph('info'));
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      openInfo(b, h('strong', { class: 'ip-title' }, term.title), h('p', {}, term.text()));
    });
    return b;
  }

  // Plan checks that point at a field or an item ("label:<text>" / "item:<id>").
  let tipCache = { model: null, map: new Map() };
  function tipIndex() {
    if (tipCache.model === model) return tipCache.map;
    const map = new Map();
    const p = plan();
    const add = (key, i) => { if (!map.has(key)) map.set(key, []); if (!map.get(key).includes(i)) map.get(key).push(i); };
    const salaries = pid => p.income.filter(x => x.kind === 'salary' && x.owner === pid);
    const person = i => p.household.people.find(x => i.text.startsWith(x.name) || i.title.startsWith(x.name) || i.id.endsWith(`-${x.id}`) || i.id === `trap-${x.name}`);
    const hidden = new Set(ws.dismissed);
    for (const i of model ? B.insights(p, model.proj) : []) {
      if (hidden.has(i.id) || (i.tone !== 'warn' && i.tone !== 'tip')) continue;
      if (i.id === 'isa-full') { add('label:Once the ISAs are full', i); add('label:General investment account', i); }
      else if (i.id.startsWith('trap') || i.id === 'child-benefit') {
        const x = person(i);
        if (x) { for (const it of salaries(x.id)) add(`item:${it.id}`, i); add(`label:Extra into ${x.name}’s pension`, i); if (i.id.startsWith('trap-ahead')) add('label:Above £100,000', i); }
      } else if (i.id.startsWith('uss-match-')) {
        for (const it of p.income.filter(x => x.kind === 'dbpension' && x.dbScheme === 'uss' && i.id === `uss-match-${x.owner}`)) add(`item:${it.id}`, i);
      } else if (i.id.startsWith('remortgage-')) {
        for (const a of p.accounts.filter(x => x.type === 'debt' && x.fixedUntil)) add(`item:${a.id}`, i);
      } else if (i.id === 'buffer') add('label:Cash buffer to keep', i);
      else if (i.id === 'overpay') add('label:Overpay mortgage with', i);
      else if (i.id === 'lisa') add('label:ISAs', i);
      else if (i.id === 'iht') add('label:Spending in retirement (a year)', i);
      else if (i.id.startsWith('gilt-coupons-')) add(`item:${i.id.slice(13)}`, i);
      else if (i.id === 'mix') { add('label:In shares now', i); add('label:In shares by retirement', i); }
    }
    tipCache = { model, map };
    return map;
  }
  function tipBtn(list) {
    const b = h('button', { type: 'button', class: 'tip-btn', 'aria-label': `Suggestion: ${list[0].title}`, 'aria-expanded': 'false', 'aria-controls': 'infoPop', title: 'A suggestion for this' }, glyph('tip'));
    b.addEventListener('click', e => {
      e.preventDefault(); e.stopPropagation();
      openInfo(b, ...list.map(i => h('div', { class: 'ip-tip' },
        h('span', { class: 'eyebrow' }, 'Suggestion'),
        h('strong', { class: 'ip-title' }, i.title),
        h('p', {}, i.text),
        h('div', { class: 'ip-actions' },
          actionFits(i.action) ? h('button', { type: 'button', class: 'btn small primary', onclick: () => { closeInfo(); insightAction(i.action); } },
            i.action.startsWith('compare:') ? 'Compare the options' : ACTION_LABEL[i.action] || 'Open') : null,
          h('button', { type: 'button', class: 'linkish', onclick: () => { ws.dismissed = [...new Set(ws.dismissed.concat([i.id]))]; save(); closeInfo(); tipCache.model = null; redecorate(); renderSuggestions(); } }, 'Already sorted')))));
    });
    return b;
  }

  const INFO_SPOTS = '.rv-explain h3, .do-head h3, .pf-res-head > h3, .field > span:first-child, .card-head h2, .section-head h2, .io-fig > span:first-child, .pf-two > strong, .hero-label, .pf-sum dt, .sub-fields > h3, .io-split h3';
  function decorate(root) {
    if (!root || !root.querySelectorAll) return;
    const spots = [...(root.matches && root.matches(INFO_SPOTS) ? [root] : []), ...root.querySelectorAll(INFO_SPOTS)];
    const tips = tipIndex();
    for (const el of spots) {
      if (el.dataset.info) continue;
      const text = el.textContent.trim();
      el.dataset.info = text;
      const term = termFor(text);
      const tip = tips.get(`label:${text}`);
      if (!term && !tip) continue;
      // Keep the control's name what it was: a label's text would otherwise include the new buttons.
      const field = el.parentElement;
      if (field && field.tagName === 'LABEL') {
        const ctl = field.querySelector('input, select, textarea');
        if (ctl && !ctl.hasAttribute('aria-label') && !ctl.hasAttribute('aria-labelledby')) ctl.setAttribute('aria-label', text);
      }
      if (term) el.append(infoBtn(term));
      if (tip) el.append(tipBtn(tip));
    }
    for (const row of [...(root.matches && root.matches('.sum-row[data-item]') ? [root] : []), ...root.querySelectorAll('.sum-row[data-item]')]) {
      if (row.dataset.tipDone) continue;
      row.dataset.tipDone = '1';
      const tip = tips.get(`item:${row.dataset.item}`);
      if (!tip) continue;
      // A button can't sit inside the row (itself a button): the marker sits on its corner.
      const wrap = h('div', { class: 'sum-wrap' });
      row.replaceWith(wrap);
      wrap.append(row, tipBtn(tip));
    }
  }
  // After a new projection, suggestion markers are redrawn (the "i" explanations stay).
  function redecorate() {
    for (const b of $$('.tip-btn')) { const w = b.parentElement; b.remove(); if (w && w.classList.contains('sum-wrap')) { const row = w.querySelector('.sum-row'); if (row) w.replaceWith(row); } }
    for (const el of $$('[data-info]')) delete el.dataset.info;
    for (const el of $$('[data-tip-done]')) delete el.dataset.tipDone;
    for (const b of $$('.info-btn:not(.keep)')) b.remove();   // the guide's own stay
    decorate(document.body);
  }
  let decorating = false;
  const infoObserver = typeof MutationObserver !== 'undefined' ? new MutationObserver(list => {
    if (decorating) return;
    decorating = true;
    try { for (const m of list) for (const n of m.addedNodes) if (n.nodeType === 1 && !n.closest('#infoPop, .chart-tip, canvas')) decorate(n); } finally { decorating = false; }
  }) : null;

  // The projection by account type, or by when the money can be used, with goal markers (home page).
  let homeBy = 'type';
  const ACCESS_SERIES = [
    { key: 'now', label: 'Available now', color: '--s1', of: r => r.cash + r.isa - (r.lisa || 0) + r.gia + r.bonds },
    { key: 'locked', label: 'Pensions & Lifetime ISAs', color: '--s4', of: r => r.pension + (r.lisa || 0) },
    { key: 'property', get label() { return propLabel(); }, color: '--s6', of: r => r.property },
  ];

  function renderHomeChart() {
    const rows = model.proj.rows;
    const xs = model.proj.pre.years;
    const col = key => rows.map((r, t) => D(r[key], t));
    setKids($('#ovGroup'), h('div', { class: 'seg mini', role: 'group', 'aria-label': 'Group the chart by' },
      [['type', 'By account'], ['access', 'By access']].map(([k, label]) => h('button', { type: 'button', 'aria-pressed': String(homeBy === k), 'data-by': k,
        onclick: () => { homeBy = k; renderHomeChart(); } }, label))));
    const bars = homeBy === 'access'
      ? ACCESS_SERIES.map(s => ({ ...s, values: rows.map((r, t) => D(s.of(r), t)) })).filter(s => s.values.some(v => v > 0.5))
      : ACCOUNT_SERIES.map(s => ({ ...s, values: col(s.key) })).filter(s => s.values.some(v => v > 0.5));
    if (rows.some(r => r.debt > 0.5)) bars.push({ key: 'debt', label: 'Mortgage & loans', color: '--s8', values: rows.map((r, t) => -D(r.debt, t)) });
    if (rows.some(r => r.shortfall > 0.5)) bars.push({ key: 'short', label: 'Spending not covered', color: '--muted', values: rows.map((r, t) => -D(r.shortfall, t)) });
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
    const anyLocked = rows.some(r => r.locked >= 0.5);
    chart('ovChart', 320, 'Net worth by account type over time').set({
      xs, areas: bars, markers, refLines,
      lines: [{ label: 'Net worth', color: '--text', values: nw }],
      tooltip: i => ({
        title: titleAt(i),
        rows: [
          ...bars.slice().reverse().filter(b => Math.abs(b.values[i]) > 0.5).map(b => ({ label: b.label, color: b.color, text: money(b.values[i]) })),
          ...(rows[i] && rows[i].locked >= 0.5 ? [{ label: 'Set aside to spend', color: '--muted', text: `−${money(D(rows[i].locked, i))}` }] : []),
          { label: 'Net worth', color: '--text', shape: 'line', text: money(nw[i]), strong: true },
        ],
      }),
      table: () => (homeBy === 'access' ? {
        headers: ['Year', 'Ages', ...ACCESS_SERIES.map(a => a.label), 'Debt', ...(anyLocked ? ['Set aside to spend'] : []), 'Net worth'],
        rows: rows.map((r, t) => [r.year, r.ages.join(' / '), ...ACCESS_SERIES.map(a => D(a.of(r), t)), -D(r.debt, t), ...(anyLocked ? [-D(r.locked, t)] : []), D(r.netWorth, t)]),
        formats: [String, String, money, money, money, money, money, ...(anyLocked ? [money] : [])],
      } : {
        headers: ['Year', 'Ages', 'Cash', 'ISAs', 'GIA', 'Pensions', 'Bonds', 'Property', 'Debt', ...(anyLocked ? ['Set aside to spend'] : []), 'Net worth'],
        rows: rows.map((r, t) => [r.year, r.ages.join(' / '), ...ovCols.map(k => D(r[k], t)), -D(r.debt, t), ...(anyLocked ? [-D(r.locked, t)] : []), D(r.netWorth, t)]),
        formats: [String, String, money, money, money, money, money, money, money, money, ...(anyLocked ? [money] : [])],
      }),
    });
    $('#ovChartSub').textContent = `${homeBy === 'access' ? 'What you own by when it can be used' : 'What you own by account type'}, on average returns, from your figures as at ${fmtDate(asOf())}, in ${unitLabel()}. The areas add up to your net worth (the line); debt sits below zero. Hover a year, or switch to Table for every number.`;
    legend($('#ovLegend'), [...bars.map(b => ({ label: b.label, color: b.color })), { label: 'Net worth', color: '--text', shape: 'line' }], charts.ovChart);
  }

  function renderHome() {
    renderShort();
    renderPortfolio();
    renderGoalStrip();
    renderHomeChart();
    renderTodo();
    renderInOut();
    renderSuggestions();
  }

  // ---- home: what to do, and when (instructions worked out from the plan)
  // "Mortgage" when there is one (or a home), otherwise "loans".
  const debtWord = () => (plan().accounts.some(a => !a.excluded && (a.type === 'property' || (a.type === 'debt' && /mortgage/i.test(a.name)))) ? 'mortgage' : 'loans');

  // ---- home: the answer in a few plain sentences, before any figures
  function renderShort() {
    const box = $('#homeShort');
    if (!box) return;
    const goals = model.goals || [];
    const say = res => {
      const pc = Math.round((res.probability || 0) * 100), st = res.status;
      if (res.goal.type === 'emergency') return st === 'good' ? 'Yes: the cash you keep covers it.' : `Not yet. ${res.summary}`;
      const lead = st === 'good' ? 'Yes, likely' : st === 'warn' ? 'Possibly' : 'Unlikely as things stand';
      const what = res.goal.type === 'retire' ? 'the money lasts' : res.goal.type === 'debtFree' ? 'the debts are cleared in time' : 'you get there in time';
      return `${lead}: ${what} in ${pc} of 100 futures tried.`;
    };
    const now = todoItems().filter(x => x.when === 'now').slice(0, 3);
    const su = ws.guides.setup && ws.guides.setup.answers;
    const doubt = B.insights(plan(), model.proj).find(i => i.id === 'spending-missing');
    setKids(box,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', { id: 'shortTitle' }, 'In short'),
        h('p', { class: 'sub' }, isExamplePlan() ? 'An example household, to show what Horizon tells you.' : 'What your figures say, in plain words. The detail is further down the page.'))),
      doubt ? h('div', { class: 'short-doubt', id: 'shortDoubt' }, h('strong', {}, `Check this first: ${doubt.title.charAt(0).toLowerCase()}${doubt.title.slice(1)}`),
        h('p', {}, 'The answers below assume all of that is saved. If it is not, they are too good.'),
        h('button', { type: 'button', class: 'btn small primary', onclick: openWizard }, 'Go through my spending')) : null,
      goals.length ? h('ul', { class: 'short-list' }, goals.map(res => {
        const st = goalStatus(res.probability || 0);
        return h('li', { class: `short-goal ${st.cls}` },
          h('span', { class: 'short-ico' }, icon(st.icon)),
          h('div', {}, h('strong', {}, res.goal.type === 'retire' && !res.retired ? `${res.title}?` : res.title), h('span', {}, say(res)),
            waysBox(res),
            h('button', { type: 'button', class: 'short-link', onclick: () => navigate(`goal/${res.goal.id}`) }, 'See why, and what would change it')));
      })) : h('p', { class: 'short-none' }, 'No goals yet. Add one (stop working at an age, an emergency fund, saving up for something) and Horizon gives a plain answer. ',
        h('button', { type: 'button', class: 'btn small primary', onclick: () => openGoalWizard() }, '+ Add a goal')),
      now.length ? h('div', { class: 'short-now' }, h('strong', {}, 'This month'),
        h('ul', {}, now.map(x => h('li', {}, x.title)))) : null,
      h('div', { class: 'short-plan' },
        h('div', {}, h('strong', {}, 'Your plan, year by year'),
          h('span', {}, `Every year from ${plan().startYear} written out: what comes in, what goes out, how much to put where, what each account should hold, and what changes. Read it, print it or save it as a PDF, and follow it.`)),
        h('button', { type: 'button', class: 'btn primary', id: 'shortDossier', onclick: openDossier }, 'Open the plan')),
      su && su.quick === 'yes' ? h('p', { class: 'short-foot' }, 'Worked out from round figures and typical values. ',
        h('button', { type: 'button', class: 'short-link', onclick: () => openSetup() }, 'Make it more exact')) : null);
    fillWays();
  }

  // ---- what would get a goal there: worked out after the page is drawn, one goal at a time
  // (each takes a second or so), and kept until the plan changes.
  let ways = { key: '', by: {} }, waysBusy = false;
  const waysBox = res => (res.status === 'good' ? null : h('div', { class: 'ways', 'data-ways': res.goal.id }));
  function fillWays() {
    const key = driversKey();
    if (ways.key !== key) ways = { key, by: {} };
    let todo = null;
    for (const el of $$('[data-ways]')) {
      const id = el.getAttribute('data-ways'), w = ways.by[id];
      if (!w) { setKids(el, h('span', { class: 'ways-wait' }, 'Working out what would get you there…')); todo = todo || id; continue; }
      const notes = w.filter(x => ['early', 'none', 'wait'].includes(x.id)), acts = w.filter(x => !notes.includes(x));
      setKids(el, notes.map(x => h('p', {}, x.text)),
        acts.length ? [h('strong', {}, acts.length > 1 ? 'What would get you there (any one of these):' : 'What would get you there:'), h('ul', {}, acts.map(x => h('li', {}, x.text)))] : null);
    }
    if (!todo || waysBusy) return;
    waysBusy = true;
    setTimeout(() => {
      waysBusy = false;
      if (driversKey() === ways.key) {
        const res = (model.goals || []).find(r => r.goal.id === todo);
        ways.by[todo] = res ? E.waysThere(plan(), res, { seed: ws.settings.seed }) : [];
      }
      fillWays();
    }, 60);
  }

  function todoItems() {
    const p = plan(), proj = model.proj, rows = proj.rows, pre = proj.pre, mp = model.monthly;
    const ps = people();
    const N = pre.N;
    const out = [];
    const add = (when, title, text, action, date) => out.push({ when, title, text, action, date });
    const m = v => money(v / 12);
    const go = (label, where) => [label, () => navigate(where)];
    const year0 = p.startYear;
    const hidden = new Set(ws.dismissed);
    const ins = B.insights(p, proj).filter(i => !hidden.has(i.id) && i.tone !== 'good');

    // Now: where this month's money goes.
    const isas = p.accounts.filter(a => a.type === 'isa' && !a.excluded);
    if (mp.isa > 0.5) {
      // Shared between the people by the room each has left (after a Lifetime ISA, or their own
      // amounts), then between one person's ISAs by their own amounts, else by balance.
      const set = isas.some(a => a.monthly !== null);
      const lisaSet = p.accounts.filter(x => x.type === 'lisa' && !x.excluded).reduce((acc, a) => acc + a.contribution, 0);
      const lisaOf = x => (lisaSet > 0 ? (rows[0].toLisa || 0) * p.accounts.filter(a => a.type === 'lisa' && !a.excluded && a.owner === x.id).reduce((acc, a) => acc + a.contribution, 0) / lisaSet : 0);
      const own = x => isas.filter(a => a.owner === x.id);
      const room = ps.map(x => Math.max(0, Math.min(set ? own(x).reduce((acc, a) => acc + (a.monthly || 0) * 12, 0) : Infinity, p.strategy.isaAllowance - lisaOf(x))));
      const finite = room.map(v => (Number.isFinite(v) ? v : p.strategy.isaAllowance));
      const sumRoom = finite.reduce((acc, v) => acc + v, 0);
      const parts = [], paidInto = [];
      ps.forEach((x, i) => {
        const v = mp.isa * (sumRoom > 0 ? finite[i] / sumRoom : 1 / ps.length);
        if (v < 0.5) return;
        const list = own(x);
        if (!list.length) { parts.push(`${money(v)} into a new ISA for ${x.name}`); return; }
        const w = list.map(a => (set ? (a.monthly || 0) : a.balance)), sw = w.reduce((acc, y) => acc + y, 0);
        list.forEach((a, k) => { const y = v * (sw > 0 ? w[k] / sw : 1 / list.length); if (y >= 0.5) { parts.push(`${money(y)} into ${a.name}`); paidInto.push(a); } });
      });
      const sh = Math.round(E.stockWeight(p, 0) * 100);
      const allCash = paidInto.length > 0 && paidInto.every(a => a.holding === 'cash') && parts.length === paidInto.length;
      add('now', `Pay ${money(mp.isa)} a month into ISAs`, parts.join(', ') + (allCash ? '. A cash ISA: it earns the cash rate and doesn’t fall.' : `. Invest it ${sh >= 100 ? 'all in shares (a global tracker fund, for example)' : `${sh}% in shares and ${100 - sh}% in bonds`}: the mix the plan uses this year.`), go('Set amounts', 'finances/saving'));
    }
    {
      // What the plan can actually pay into Lifetime ISAs this year (nothing when savings are being drawn on).
      const lisas = p.accounts.filter(x => x.type === 'lisa' && !x.excluded && x.contribution > 0);
      const set = lisas.reduce((acc, a) => acc + a.contribution, 0);
      const paid = rows[0].toLisa || 0;
      for (const a of lisas) {
        const v = set > 0 ? paid * a.contribution / set : 0;
        if (v >= 0.5) add('now', `Pay ${money(v / 12)} a month into ${a.name}`, `The government adds 25% (${money(v * R.LISA.bonus)} a year)${v < a.contribution - 1 ? `; that is what is left over this year, of the ${money(a.contribution)} set` : ''}.`, go('Set amounts', 'finances/saving'));
      }
    }
    if (mp.gia > 0.5) add('now', `Pay ${money(mp.gia)} a month into the general account`, 'What is left once the ISAs are full.', go('Set amounts', 'finances/saving'));
    if (mp.hiDebt > 0.5) {
      const dear = p.accounts.filter(a => a.type === 'debt' && !a.excluded && a.balance > 0 && a.rate >= 8).sort((x, y) => y.rate - x.rate);
      add('now', `Pay off ${dear.map(a => a.name).join(' and ') || 'expensive debt'} first: ${money(mp.hiDebt)} a month more`, `At ${dear.map(a => `${a.rate}%`).join(' and ')}, it costs more than any saving or investment earns, so everything left over goes to it before saving. Moving it to a 0% balance transfer card would save the interest meanwhile.${mp.cash > 0.5 ? ' The amount is this year’s total spread over twelve months: it is cleared within the year.' : ''}`, go('Accounts', 'finances/portfolio'));
    }
    if (mp.cash > 0.5) {
      const out12 = (rows[0].spending + (rows[0].debtRegular || 0)) / 12;
      const months = out12 > 0 && p.strategy.cashReserve > 0 ? ` (${(p.strategy.cashReserve / out12).toFixed(1)} months of spending)` : '';
      add('now', `${mp.hiDebt > 0.5 ? 'Then put' : 'Put'} ${money(mp.cash)} a month into savings`, `${mp.hiDebt > 0.5 ? 'Once that debt is cleared: topping' : 'Topping'} up the cash buffer to ${money(p.strategy.cashReserve)}${months}. After that, what is left over is invested.`, go('Saving strategy', 'finances/saving'));
    }
    if (mp.overpay > 0.5) add('now', `Overpay the mortgage by ${money(mp.overpay)} a month`, 'As the saving strategy says.', go('Saving strategy', 'finances/saving'));
    ps.forEach((x, i) => {
      const P = pre.people[i];
      if (!(P.ee[0] > 0.5) || x.retireAge <= x.age) return;
      const pay = p.income.filter(it => it.kind === 'salary' && it.owner === x.id);
      const sac = pay.some(it => it.sacrifice);
      const er = P.contrib[0] - P.ee[0] - P.sacrificed[0];
      const both = pay.find(it => it.pensionTo === 'db' && (it.potEmployee > 0 || it.potEmployer > 0));
      if (both) {
        const c = E.pensionSplit(both, E.incomeAfterCosts(both, p, 0), p, 0);
        add('now', `${x.name}: ${money(c.ee / 12)} a month into pensions${sac ? ' by salary sacrifice' : ''}`,
          `${money((c.ee - c.potEe) / 12)} into the defined benefit scheme (it builds the pension paid from ${(p.income.find(it => it.kind === 'dbpension' && it.owner === x.id) || {}).startAge || 'pension age'}) and ${money(c.potEe / 12)} into the pension pot${c.potEr > 0.5 ? `, where the employer adds ${money(c.potEr / 12)}` : ''}. Both rise with pay.`,
          go('Income', 'finances/income'));
        return;
      }
      add('now', `${x.name}: ${money(P.ee[0] / 12)} a month into the pension${sac ? ' by salary sacrifice' : ''}`,
        `${er > 0.5 ? `The employer adds ${m(er)}. ` : ''}${pay.some(it => it.pensionMode === 'fixed') ? `The plan raises it with pay each year: about ${m(P.ee[1] || 0)} a month next year.` : 'A share of pay, so it rises with pay.'}`,
        go('Income', 'finances/income'));
    });
    for (const i of ins.filter(i => i.id.startsWith('uss-match-'))) add('now', i.title.replace(': the USS match is free money', ': choose the USS match'), i.text, null);

    // Dated: deadlines and changes the plan makes along the way.
    const lisa = ins.find(i => i.id === 'lisa');
    if (lisa && mp.surplus - mp.hiDebt > 25) {
      const who = ps.filter(x => x.age < R.LISA.openBefore && !p.accounts.some(a => a.type === 'lisa' && a.owner === x.id));
      const by = Math.min(...who.map(x => year0 + R.LISA.openBefore - x.age));
      add(E.ownsHome(p) ? by : 'now', `Open Lifetime ISAs before turning 40: ${who.map(x => x.name).join(' and ')}`, `Even with £1, so the option stays open: up to £4,000 a year each then gets a 25% bonus until 50${E.ownsHome(p) ? ', usable from 60' : ', usable for a first home (up to £450,000) or from 60'}.`, ['Compare the options', () => openComparison('sacrifice-lisa')]);
    }
    for (const d of p.accounts.filter(a => a.type === 'debt' && !a.excluded && a.balance > 0 && a.fixedUntil > year0)) {
      add(d.fixedUntil - 1 === year0 ? 'now' : d.fixedUntil - 1, `${d.name}: start looking at new deals`, `The fixed rate ends in ${d.fixedUntil}. Most lenders let you reserve a new rate up to six months ahead at no cost, so if yours ends in the first half of ${d.fixedUntil}, start in the autumn of ${d.fixedUntil - 1}.`, ['Compare rates', () => openComparison('mortgage-rate')], `${d.fixedUntil - 1}-10-01`);
    }
    for (const d of p.accounts.filter(a => a.type === 'debt' && !a.excluded && a.balance > 0 && a.fixedUntil >= year0)) {
      add(d.fixedUntil, `${d.name}: the fixed rate ends`, `Compare deals about six months before, to avoid the lender’s standard variable rate. The plan assumes ${d.rateAfterFix === null ? `${d.rate}%` : `${d.rateAfterFix}%`} afterwards.`, ['Compare rates', () => openComparison('mortgage-rate')], `${d.fixedUntil}-06-01`);   // about six months before it ends
    }
    const saveOf = r => ({ isa: r.toIsa + (r.toLisa || 0), gia: r.toGia, pen: r.toPension || 0, over: r.overpay, cash: r.toCash });
    const where = r => { const s = saveOf(r); return [[s.isa, 'into ISAs'], [s.pen, 'into pensions (with relief)'], [s.gia, 'into the general account'], [s.over, 'off the mortgage'], [s.cash, 'into cash']].filter(x => x[0] > 0.5 * 12).map(([v, l]) => `${m(v)} a month ${l}`).join(', '); };
    // Gilts and bonds that mature: the money is invested again.
    for (const a of p.accounts.filter(x => x.type === 'bonds' && !x.excluded && x.maturityYear >= year0 && x.maturityYear - year0 < N)) {
      const k = a.maturityYear - year0;
      add(a.maturityYear, `${a.name} matures`, `It is repaid, so ${a.coupons === 'payout' ? `about ${money(a.balance)}` : `with the coupons along the way about ${money(a.balance * Math.pow(1 + a.rate / 100, k))}`} comes back ${a.inIsa ? 'as cash inside the ISA: invest it in the ISA’s funds (it uses no allowance)' : 'as cash: the plan invests it, into ISAs while there is allowance'}.`, null);
    }
    // The shares/bonds mix moves towards retirement: rebalance once a year.
    {
      const a = p.assumptions, p1 = ps[0];
      const yrs = p1.retireAge - p1.age;
      if (a.stockPctNow !== a.stockPctRetire && yrs > 0) {
        const marks = [5, 10, 15].filter(k => k < yrs).concat([yrs]).filter((v, j, arr) => arr.indexOf(v) === j);
        add('yearly', 'Each year: rebalance the investments', `The plan moves from ${a.stockPctNow}% in shares now to ${a.stockPctRetire}% when ${p1.name} retires, the rest in bonds or gilts: ${marks.map(k => `${Math.round(E.stockWeight(p, k) * 100)}% in ${year0 + k}`).join(', ')}. Pensions count too: most pension funds can be set to do this on their own (“lifestyling”).`, go('Assumptions', 'finances/assumptions'));
      }
    }
    const dEnd = rows.findIndex((r, t) => t > 0 && t < N && rows[0].debt > 0.5 && r.debt <= 0.5);
    if (dEnd > 0) add(rows[dEnd].year, `No more ${debtWord()} payments`, `The last one was paid during ${rows[dEnd].year - 1}. The payments become savings: the plan then puts ${where(rows[dEnd])} (in ${rows[dEnd].year} pounds).`, go('Set amounts', 'finances/saving'));
    const giaStart = rows.findIndex((r, t) => t > 0 && t < N && r.toGia > 100);
    const fromSale = giaStart > 0 && (rows[giaStart].propSold || 0) > 0.5;
    if (fromSale) add(rows[giaStart].year, `The sale puts ${money(rows[giaStart].propSold)} into savings`, `Up to ${money(p.strategy.isaAllowance * ps.length)} of it can go into ISAs that year; the rest goes into a general investment account, where gains are taxed. Each April after, move ${money(p.strategy.isaAllowance * ps.length)} of it into ISAs (“Bed and ISA”).`, go('Saving & investing', 'finances/saving'));
    else if (giaStart > 0 && !(dEnd > 0 && giaStart === dEnd)) add(rows[giaStart].year, 'ISAs full: the rest goes into the general account', `About ${m(rows[giaStart].toGia)} a month at first, where gains and dividends are taxed.${p.strategy.pensionFirst ? '' : ' “Pensions first” would put it into pensions with tax relief instead.'}`, ['Compare the options', () => openComparison('after-isa')]);
    const penStart = rows.findIndex((r, t) => t < N && (r.toPension || 0) > 0.5);
    if (penStart >= 0) add(penStart === 0 ? 'now' : rows[penStart].year, `Pay ${m(rows[penStart].toPension)} a month more into pensions`, 'Pensions first: once the ISAs are full, into the pension of whoever pays the most tax (with tax relief on top), by salary sacrifice or a personal contribution.', go('Saving & investing', 'finances/saving'));
    ps.forEach((x, i) => {
      const P = pre.people[i];
      const k = P.sacrificed.findIndex((v, t) => t < N && v > 0.5);
      if (k < 0) return;
      const last = Math.min(N - 1, x.retireAge - x.age - 1);
      const at = t => (P.ee[t] + P.sacrificed[t]) / 12;
      const partly = over100kText(x, i, k);
      add(k === 0 ? 'now' : rows[k].year, `${x.name}: raise the salary sacrifice to about ${money(at(k))} a month`,
        `From ${money(P.ee[k] / 12)}: the pay above ${money(E.stayUnderLine(p.strategy))} (about ${m(P.sacrificed[k])} a month) goes into the pension${partly ? ', bringing income down towards the line' : ', so income stays under the line'}${E.stayUnderLine(p.strategy) < R.PA_TAPER_START ? ', where the Child Benefit charge starts' : ' where tax reaches over 60%'}. How: ask payroll to raise the salary sacrifice each time pay goes up (most allow changes at any time, or once a year).${partly} Take-home pay falls by what is sacrificed, less the tax${P.sacrificed[k] && rows[k].year < R.SACRIFICE_NI_CAP_FROM ? ' and NI' : ''} saved. Keep raising it as pay rises: about ${money(at(last))} a month by ${rows[last].year}.`,
        go('Saving & investing', 'finances/saving'));
    });

    // Retirement: what stops, what starts, and how much to take.
    ps.forEach((x, i) => {
      const t0 = x.retireAge - x.age;
      if (t0 >= N) return;
      const t = Math.max(0, t0);   // already retired: from now
      if (t0 > 0) add(rows[t].year, `${x.name} retires at ${x.retireAge}`, `Pay and pension contributions stop.${x.retireAge < x.pensionAccessAge ? ` Pensions can be drawn from ${x.pensionAccessAge}; until then savings and ISAs pay the way.` : ''}`, ['Can I retire then?', () => openGuide('retire', { who: x.id })]);
      const ny = E.spYears(x);
      if (ny.voluntary > 0 && x.age < x.statePensionAge) {
        add(t0 > 0 ? rows[t].year : 'now', `${x.name}: pay voluntary NI for ${ny.voluntary} year${ny.voluntary === 1 ? '' : 's'}`,
          `With no pay from ${x.retireAge}, those years don’t count towards the State Pension unless paid for. Class 3 costs about ${money(R.NI_YEARS.class3Week * 52)} a year (£${R.NI_YEARS.class3Week.toFixed(2)} a week at 2026/27 rates); each year adds about ${money(R.STATE_PENSION_FULL / R.NI_YEARS.full)} a year of State Pension, for life. How: check the NI record at gov.uk/check-national-insurance-record, then pay HMRC each year (gov.uk “Pay voluntary Class 3 National Insurance”, by Direct Debit or bank transfer). Gaps can also be paid up to 6 years later. Until ${rows[t].year + ny.voluntary - 1}.`,
          go('Your State Pension', 'finances/assumptions'), `${rows[t].year}-05-01`);
      } else if (!ny.known && t > 0 && x.retireAge < x.statePensionAge) {
        add('now', `${x.name}: check the National Insurance record`, `The State Pension forecast assumes NI is paid until ${x.statePensionAge}; stopping at ${x.retireAge} can cost part of it. How: gov.uk/check-national-insurance-record shows the full years so far; type them under More options for ${x.name} and Horizon works out the rest.`, go('Your details', 'finances/assumptions'));
      }
      const sp = pre.people[i].statePension.findIndex((v, k) => k < N && v > 0);
      if (sp > 0) add(rows[sp].year, `${x.name}: claim the State Pension`, `From ${E.spStart(x)}${x.spDefer ? ` (put off ${x.spDefer} year${x.spDefer === 1 ? '' : 's'}, so about ${Math.round((E.spDeferUplift(x) - 1) * 100)}% more for life)` : ''}: about ${m(pre.people[i].statePension[sp])} a month. It is not paid automatically: claim it at gov.uk about 4 months before.`, null);
      for (const db of p.income.filter(it => it.kind === 'dbpension' && it.owner === x.id)) {
        const k = db.startAge - x.age;
        if (k > 0 && k < N) add(rows[k].year, `${x.name}: claim the ${db.dbScheme === 'uss' ? 'USS' : 'workplace'} pension`, `From ${db.startAge}: about ${money(E.incomeAfterCosts(db, p, k) / 12)} a month${db.lumpMultiple > 0 ? `, plus a tax-free lump sum of about ${money(E.incomeAfterCosts(db, p, k) * db.lumpMultiple)}` : ''}. Tell the scheme a few months before.`, null);
      }
    });
    // Working for oneself with nothing going into a pension: what paying in would cost and build.
    ps.forEach((x, i) => {
      const o = E.ownPensionTrial(p, proj, i);
      if (!o) return;
      add('now', `${x.name}: decide how much to pay into a pension`,
        `Working for ${x.name === 'You' ? 'yourself' : 'themselves'}, nothing goes into a pension unless it is paid in, and the plan has nothing going in. ${o.pay > 0
          ? `For example, ${money(o.pay)} a month: the government adds ${money(o.pot - o.pay)} of tax relief, so ${money(o.pot)} goes in${o.cost < o.pay - 1 ? `, and it costs about ${money(o.cost)} a month once the higher-rate relief is claimed on the tax return` : ''}. Kept up until ${x.retireAge}, that builds a pension of about ${money(o.built)} in today’s money. The plan would otherwise put that money into ISAs, with no tax relief.`
          : 'Nothing is left over each month at the moment, so there is nothing to pay in yet.'} A pension cannot be taken out before ${x.pensionAccessAge}. With your own company, the company can pay in instead, which also saves corporation tax: ask the accountant. Type an amount under “Extra into ${x.name}’s pension” to see what it does to the plan.`,
        go('Try an amount', 'finances/saving'));
    });
    const firstRet = Math.min(...ps.map(x => x.retireAge - x.age).filter(t => t > 0));
    const draws = [];
    let prev = null;
    // Everyone retired already: from this year.
    for (let t = Number.isFinite(firstRet) ? Math.max(1, firstRet) : 0; t < N; t++) {
      const r = rows[t];
      const w = r.withdrawals;
      if (w < 600 && prev === null) continue;
      if (prev === null || Math.abs(w - prev) > Math.max(6000, prev * 0.35)) { draws.push(t); prev = w; }
      if (draws.length >= 3) break;
    }
    for (const t of draws) {
      const r = rows[t];
      const parts = [[r.wPension, 'pensions (a quarter tax-free)'], [r.wIsa, 'ISAs'], [r.wGia, 'the general account'], [r.wCash, 'cash'], [r.wLisa, 'Lifetime ISAs']].filter(x => x[0] > 600);
      if (r.withdrawals < 600) add(t === 0 ? 'now' : r.year, 'Savings no longer needed to live on', 'Pensions and other income cover spending; what is left over is saved again.', null);
      else add(t === 0 ? 'now' : r.year, `Take about ${m(r.withdrawals)} a month from savings`, `To cover spending of ${m(r.spending)} a month (in ${r.year} pounds) on top of other income: ${parts.map(([v, l]) => `${m(v)} from ${l}`).join(', ')}. In this order, tax stays low.`, null);
    }

    // Every year.
    const pots = E.reservesAt(p, model.est ? model.est.years || 0 : 0);
    const budgets = pots.filter(r => r.kind === 'budget');
    if (budgets.length) add('yearly', `At the review: what is left of the ${budgets.map(r => r.name.toLowerCase()).join(' and ')} budget${budgets.length > 1 ? 's' : ''}?`,
      `${budgets.map(r => `${money(r.yearly)} for ${r.name.toLowerCase()}`).join(', ')} this year, in ${[...new Set(budgets.map(r => accountName(r.accountId) || 'an account'))].join(' and ')}. The plan counts it as spent; what is left can be kept for the year after or freed up to invest.`, ['Start review', () => openReview()], '10-01');
    for (const r of pots) {
      const where = accountName(r.accountId) || 'an account';
      if (r.kind === 'emergency') {
        const acc = p.accounts.find(a => a.id === r.accountId);
        const has = acc ? (model.est && model.est.byId[acc.id] !== undefined ? model.est.byId[acc.id] : acc.balance) : r.amount;
        add('now', has + 0.5 < r.amount ? `Build the emergency fund in ${where} to ${money(r.amount)}` : `Keep ${money(r.amount)} in ${where} as the emergency fund`,
          `${has + 0.5 < r.amount ? `It holds about ${money(has)} now, so ${money(r.amount - has)} is still to put aside. ` : ''}Marked on Home as set aside: not for spending or investing. It rises with prices.`, go('Set aside', 'finances/saving'));
      }
      else if (r.kind === 'saving' && r.dueYear) {
        const spare = Math.max(0, mp.surplus || 0);
        const needs = pots.filter(x => x.kind === 'saving' && x.dueYear).reduce((acc, x) => acc + x.perYear / 12, 0);
        add('now', `Count about ${money(r.perYear / 12)} a month in ${where} as for ${r.name.toLowerCase()}`, `It is already part of what goes in each month. Home shows it building up to ${money(r.target)} for ${r.dueYear}, spoken for and left out of net worth; then it is taken out to pay.${needs > spare + 1 ? ` All the pots together need about ${money(needs)} a month, more than the ${money(spare)} left over now: the plan pays the difference from savings when each cost comes, so a smaller cost, a later date or more put aside already would help.` : ''}`, go('Set aside', 'finances/saving'));
      }
    }
    // Before this tax year ends: what has a deadline, with the plan's own amounts.
    {
      const td = today(), yr = +td.slice(0, 4), md = td.slice(5);
      const endY = md <= '04-05' ? yr : yr + 1, by = `By 5 April ${endY}`, r0 = rows[0];
      // Months left until 5 April: the plan's amounts are for twelve months from the figures date.
      const monthsLeft = Math.max(1, Math.round((Date.parse(`${endY}-04-05`) - Date.parse(td)) / 864e5 / 30.44));
      const byThen = v => `about ${money(v / 12)} a month, so about ${money(v / 12 * monthsLeft)} more by then`;
      const join = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
      const earns = k => p.income.some(it => it.kind === k && E.incomeAfterCosts(it, p, 0) > 0.5);
      const why = [earns('self') ? 'self-employed income' : '', earns('rental') ? 'rent' : '', (r0.hicbc || 0) > 0.5 ? 'the Child Benefit charge' : '', (r0.cgt || 0) > 0.5 ? 'gains on investments' : ''].filter(Boolean);
      if (why.length && !(md > '01-31' && md <= '04-05')) add('tax', `By 31 January ${endY}: send the tax return and pay what is due`,
        `For the tax year that ended on 5 April ${endY - 1}, because of ${join(why)}. HMRC charges £100 for a late return, and interest on tax paid late. If that only started since then, the first return is due a year later.`, null, `${endY}-01-10`);
      const planned = r0.toIsa + (r0.toLisa || 0), allow = p.strategy.isaAllowance;
      if (planned > 0.5 || isas.length || r0.gia > 500) add('tax', `${by}: use this year’s ISA allowance`,
        `Each person can pay up to ${money(allow)} into ISAs before 5 April; what is not used is lost. ${planned > 0.5 ? `The plan pays in ${byThen(planned)}.` : 'The plan pays nothing in for now.'}${r0.gia > 500
          ? ` Move up to ${money(Math.min(r0.gia, Math.max(0, allow * ps.length - planned)))} from the general investment account into ISAs (“Bed and ISA”: sell, and buy the same again inside the ISA), so its gains and income are tax-free from then on.`
          : p.strategy.cashReserve > 0 ? ` Spare cash beyond the buffer of ${money(p.strategy.cashReserve)} can go in too.` : ''}`, go('Set amounts', 'finances/saving'), `${endY}-03-01`);
      for (const a of p.accounts.filter(x => x.type === 'lisa' && !x.excluded && x.contribution > 0)) add('tax', `${by}: pay into ${a.name} for this year’s bonus`,
        `Up to ${money(R.LISA.maxContribution)} a tax year gets 25% added (up to ${money(R.LISA.maxContribution * R.LISA.bonus)}). The bonus on anything not paid in by 5 April is lost for good.`, go('Set amounts', 'finances/saving'), `${endY}-03-01`);
      if (earns('salary') || earns('self')) {
        const total = pre.people.reduce((acc, P) => acc + (P.contrib[0] || 0), 0) + (r0.toPension || 0);
        add('tax', `${by}: decide on a pension top-up`,
          `Anything paid into a pension before 5 April gets this tax year’s relief${(r0.hicbc || 0) > 0.5 ? `, and brings down the Child Benefit charge (about ${money(r0.hicbc)} a year in the plan)` : ''}. ${total > 0.5 ? `The plan pays in ${byThen(total)}, employers included` : 'The plan pays nothing in for now'}; up to ${money(R.PENSION_ANNUAL_ALLOWANCE)} a year is allowed (no more than you earn). It is worth most to anyone paying higher-rate tax. Money in a pension cannot be taken out before ${Math.min(...ps.map(x => x.pensionAccessAge))}.`, go('Saving & investing', 'finances/saving'), `${endY}-03-01`);
      }
    }
    // Next year: the amounts to set up, against this year's.
    if (N > 1) {
      const a = DS.yearBlock(p, proj, null, 1, []).todo.find(x => x.auto);
      if (a) { add(year0 + 1, a.title, a.text, go('Set amounts', 'finances/saving'), (planYearSpan(asOf(), 1) || { from: `${year0 + 1}-01-05` }).from); out[out.length - 1].fromDoc = true; }
    }
    add('yearly', 'By 5 April: use the tax-year allowances', 'ISAs, pension top-ups and moving the general account into ISAs. Unused allowances are lost.', ['Tax year-end check', () => openGuide('tax')], '03-01');
    add('yearly', 'Each autumn: the yearly review', 'Swap the estimates for real balances so the plan tracks what actually happened.', ['Start review', () => openReview()], '10-01');
    return out;
  }

  // The steps as a calendar file (.ics), made here and saved to this computer: each one on its
  // date (or 15 January of its year), the yearly ones repeating, with a reminder that morning.
  function todoCalendar(items) {
    const y0 = new Date().getFullYear();
    const esc = s => String(s).replace(/\\/g, '\\\\').replace(/[,;]/g, m => `\\${m}`).replace(/\n/g, '\\n');
    const fold = line => { const out = []; let s = line; while (s.length > 60) { out.push(s.slice(0, 60)); s = ` ${s.slice(60)}`; } out.push(s); return out.join('\r\n'); };
    const day = iso => iso.replace(/-/g, '');
    const next = d => { const x = new Date(`${d}T00:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
    const hash = s => { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0; return h.toString(36); };
    const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Horizon//Plan steps//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:Horizon: plan steps'];
    for (const i of items) {
      const date = i.when === 'now' ? today()
        : i.when === 'yearly' ? `${y0}-${i.date || '01-15'}`
        : /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : `${i.when}-01-15`;
      lines.push('BEGIN:VEVENT', `UID:${hash(`${i.title}|${i.when}`)}@horizon-plan`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}Z`,
        `DTSTART;VALUE=DATE:${day(date)}`, `DTEND;VALUE=DATE:${day(next(date))}`,
        ...(i.when === 'yearly' ? ['RRULE:FREQ=YEARLY'] : []),
        fold(`SUMMARY:${esc(i.title)}`),
        fold(`DESCRIPTION:${esc(`${i.text}${i.action ? `\n\nIn Horizon: ${i.action[0]}.` : ''}`)}`),
        'BEGIN:VALARM', 'ACTION:DISPLAY', fold(`DESCRIPTION:${esc(i.title)}`), 'TRIGGER;RELATED=START:PT9H', 'END:VALARM',
        'END:VEVENT');
    }
    lines.push('END:VCALENDAR');
    return lines.join('\r\n');
  }

  function downloadCalendar() {
    // What changes over the years and what comes round each year; “now” is on Home already.
    const blob = new Blob([todoCalendar(todoItems().filter(i => i.when !== 'now'))], { type: 'text/calendar' });
    const a = h('a', { href: URL.createObjectURL(blob), download: 'horizon-plan-steps.ics' });
    document.body.append(a); a.click(); a.remove();
    toast('Saved “horizon-plan-steps.ics”: open it to add the steps to your calendar. After big changes to the plan, save it again (the same steps are updated, not doubled, in most calendars).');
  }

  function renderTodo() {
    const box = $('#ovTodo');
    if (!box || !model) return;
    const items = todoItems();
    const y0 = plan().startYear;
    const rank = w => (w === 'now' ? -1 : w === 'tax' ? -0.5 : w === 'yearly' ? 1e6 : w);
    items.sort((a, b) => rank(a.when) - rank(b.when));
    const soon = items.filter(i => i.when === 'now' || i.when === 'tax' || i.when === 'yearly' || i.when <= y0 + 12);
    const later = items.filter(i => !soon.includes(i));
    const label = w => (w === 'now' ? 'Now' : w === 'tax' ? 'This tax year' : w === 'yearly' ? 'Every year' : String(w));
    const row = i => h('li', { class: `todo-item${i.when === 'now' ? ' now' : ''}`, 'data-when': label(i.when) },
      h('span', { class: 'todo-when' }, label(i.when)),
      h('div', { class: 'todo-body' }, h('strong', {}, i.title), h('p', {}, i.text),
        i.action ? h('button', { type: 'button', class: 'linkish', onclick: i.action[1] }, i.action[0]) : null));
    setKids(box,
      h('div', { class: 'do-head' }, h('h3', {}, 'Your plan, step by step'),
        h('p', { class: 'sub' }, 'What to pay where now, what changes along the way, and how much to take in retirement. Amounts a month, in the pounds of that year; change the plan and the list follows.'),
        h('button', { type: 'button', class: 'btn small', id: 'todoCalendar', title: 'A calendar file with each step on its date and a reminder that morning, made on this computer.', onclick: downloadCalendar }, glyph('review'), 'Add the steps to my calendar')),
      h('ol', { class: 'todo' }, soon.map(row)),
      later.length ? more('home-todo-later', `Later on (${later.length})`, h('ol', { class: 'todo' }, later.map(row))) : null);
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
    if (g.type === 'retire') return res.retired ? 'Retired' : `Retire ${res.expectedYear}`;
    if (g.type === 'debtFree') return !plan().accounts.some(a => a.type === 'debt' && a.balance > 0 && !a.excluded && (!E.goalDebtId(plan()) || a.id === E.goalDebtId(plan()))) ? 'Nothing owed' : res.expectedYear ? `Nothing owed from ${res.expectedYear}` : 'Not paid off in the plan';
    if (g.type === 'emergency') return res.expectedYear ? `Covered from ${res.expectedYear}` : 'Not covered yet';
    return res.expectedYear ? `Expected ${res.expectedYear}` : 'Not reached on average';
  }

  function driverLine(goalId) {
    const d = driverSummary(goalId);
    if (!d) return h('p', { class: 'gt-driver muted' }, 'Working out what moves it…');
    const fmt = x => `${x.d > 0 ? '+' : '−'}${Math.abs(Math.round(x.d * 100))} points`;
    return h('p', { class: 'gt-driver' },
      d.help ? [h('span', { class: 'drv-k up' }, '▲'), `${d.help.label} `, h('strong', {}, fmt(d.help))] : h('span', { class: 'muted' }, 'Already as likely as it gets.'),
      d.risk ? [h('br'), h('span', { class: 'drv-k down' }, '▼'), `${d.risk.label} `, h('strong', {}, fmt(d.risk))] : null);
  }

  function renderGoalStrip() {
    const box = $('#ovGoalStrip');
    if (!model.goals.length) { setKids(box, goalEmpty()); return; }
    setKids(box, carousel(model.goals.map(res => {
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
    }), 'Goals', 'goals'));
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
  let goalSolveKey = '';   // the plan the answers in goalSolve were worked out for

  // Goal types worth offering: one of each kind that only makes sense once, a retirement goal per
  // person, and financial independence only without a retirement goal (they answer the same question).
  function goalOffers(p) {
    const has = t => p.goals.some(g => g.type === t);
    const hasDebt = p.accounts.some(a => a.type === 'debt' && a.balance > 0 && !a.excluded);
    return {
      retire: p.household.people.some(x => !p.goals.some(g => g.type === 'retire' && E.retiree(p, g).id === x.id)),
      emergency: !has('emergency'),
      debtFree: hasDebt && !has('debtFree'),
      fi: !has('retire') && !p.goals.some(g => g.type === 'netWorth' && g.name === 'Financial independence'),
    };
  }

  function goalEmpty() {
    const quick = (type, label) => h('button', { type: 'button', class: 'btn small', onclick: () => openGoalWizard(null, type) }, label);
    return h('div', { class: 'goal-empty' }, h('p', {}, 'No goals yet. Most people start with one of these:'),
      h('div', { class: 'add-row' }, ...(o => [o.retire && quick('retire', allRetired() ? 'Will the money last?' : 'Plan your retirement'), o.emergency && quick('emergency', 'Emergency fund'), o.debtFree && quick('debtFree', 'Mortgage-free'), o.fi && quick('fi', 'Financial independence')])(goalOffers(plan()))));
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
    const g = res.goal;
    const basis = g.basis === 'real' ? 'in today’s £' : 'in future £';
    if (g.type === 'netWorth') return `${money(g.amount)} ${basis} by ${g.year}: ${E.GOAL_MEASURES[g.measure].toLowerCase()}`;
    if (g.type === 'passiveIncome') return `${money(g.amount)} a year ${basis} by ${g.year}, at ${g.withdrawalRate}% of investments${g.includePensions ? ' including pensions' : ''}`;
    if (g.type === 'emergency') return `${g.months} months (${money(res.need || 0)} today) by ${g.year}, ${g.counts === 'investments' ? 'counting ISAs and investments' : 'in cash'}`;
    if (g.type === 'debtFree') return E.goalDebtId(plan()) && g.debtId === E.goalDebtId(plan()) ? `Nothing owed on it by ${g.year}; anything overpaid goes to it first` : `No mortgage or loans left by ${g.year}`;
    // The person the goal is for (its owner), not always the first.
    const who = people().find(x => x.id === g.owner) || people()[0];
    if (res.retired) return `${who.name} has retired; the money is to last to ${who.endAge}, with ${g.confidence}% confidence wanted`;
    return `${who.name} retires at ${g.age} (${res.expectedYear}), with ${g.confidence}% confidence wanted`;
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
    setKids(box, ...[hero, goalYearCard(res), track, h('div', { class: 'grid-2' }, chance, hist), g.type === 'retire' ? retireSummary(res) : null, g.type === 'retire' ? retireTradeoffs(res) : null, g.type === 'retire' ? savingsFlowCard() : null, moves, take, levers, fullHistory].filter(Boolean));
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
      const one = E.goalDebtId(plan()) ? plan().accounts.find(a => a.id === E.goalDebtId(plan())) : null;
      bands = mc.series.goalDebt[view()];
      expected = rows.map((r, t) => D(model.proj.out.goalDebt[t], t));
      title = one ? `${one.name}: still owed` : 'Mortgage and loans still owed';
      sub = `Interest rates vary after any fixed period, so the payoff date varies too. In ${unitLabel()}.`;
    } else {
      bands = mc.series.liquid[view()];
      expected = rows.map((r, t) => D(r.liquid, t));
      marker = res.retired ? null : { x: res.expectedYear, label: sayYou(`${E.retiree(plan(), g).name} retires`), color: col };
      title = 'Savings, investments and pensions';
      sub = `${allRetired() ? 'They pay for what pensions and other income don’t cover.' : 'They grow while you work and pay for retirement after.'} If they run out, retirement fails in that simulation. In ${unitLabel()}.`;
    }
    len = goalChartLen(res, len);
    const cut = a => a.slice(0, len);
    const xs = cut(mc.years);
    const b = Object.fromEntries(Object.entries(bands).map(([k, v]) => [k, cut(v)]));
    const cfg = fanConfig(xs, b, { expected: cut(expected), title: titleAt, color: col, band: col, markers: [marker].filter(Boolean) });
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
    setKids(card, h('h2', {}, 'How it’s tracking'), h('p', { class: 'sub' }, `${title}. ${sub} The range comes from ${model.mc.runs || ws.settings.runs} simulated futures drawn from your assumptions (returns, inflation, pay${plan().accounts.some(x => x.type === 'property' && !x.excluded) ? ', house prices' : ''}); the chance at the top of the page counts these.`), host, lg);
    const c = new Chart(host, { height: 300, label: `${res.title}: range over time`, name: `goal-${g.id}` });
    c.set(cfg);
    legend(lg, [
      { label: 'Median', color: col, shape: 'line' },
      { label: 'Average returns', series: 'Expected', color: '--muted', shape: 'dash' },
      ...(target ? [{ label: g.type === 'emergency' ? 'Needed' : 'Target', color: '--text', shape: 'dash' }] : []),
      { label: 'Middle half of outcomes', color: col, shape: 'band' },
      { label: '8 in 10 outcomes', color: col, shape: 'band' },
    ], c);
  }

  const p0Year = () => plan().startYear;
  // How many years a goal's charts show: for a goal with a target year, to four years past the
  // target (or past the year it is expected, if later), and at least eight years.
  function goalChartLen(res, len) {
    const g = res.goal;
    if (g.type === 'retire' || g.type === 'emergency') return len;
    const last = Math.max(g.year, res.expectedYear || 0);
    return Math.min(len, Math.max(last - p0Year() + 5, 9));
  }

  function goalChanceChart(card, res) {
    const g = res.goal;
    const len = goalChartLen(res, model.mc.years.length);
    const xs = model.mc.years.slice(0, len);
    const ys = chanceByYear(res).slice(0, len);
    const host = h('div', { class: 'chart' });
    setKids(card, h('h2', {}, g.type === 'retire' ? 'Chance the money lasts, year by year' : g.type === 'emergency' ? 'Chance it is covered, year by year' : 'Chance of reaching it, by year'),
      h('p', { class: 'sub' }, g.type === 'retire' ? 'Share of simulations with money left in each year.' : g.type === 'emergency' ? 'Share of simulations where what counts covers the need that year.' : 'Share of simulations that have reached it by each year.'), host);
    new Chart(host, { height: 200, label: `Chance of ${res.title} by year`, name: `goal-chance-${g.id}` }).set({
      xs, yDomain: [0, 1], yFormat: v => `${Math.round(v * 100)}%`,
      lines: [{ label: chanceLabel(g), color: goalColor(g), values: ys, area: true }],
      markers: g.type === 'retire' ? (res.retired ? [] : [{ x: res.expectedYear, label: 'Retire', color: goalColor(g) }]) : [{ x: g.year, label: 'Target', color: goalColor(g) }],
      tooltip: i => ({ title: titleAt(i), rows: [{ label: chanceLabel(g), color: goalColor(g), shape: 'line', text: pct(ys[i]) }] }),
    });
  }

  // The two answers come from different pasts: say how the replayed history differs from what the plan assumes.
  function historyGap(res, rate) {
    const H = window.HISTORY_DATA, a = plan().assumptions, g = res.goal;
    if (!H || Math.abs(rate - res.probability) < 0.08) return null;
    const mean = v => v.reduce((x, y) => x + y, 0) / v.length;
    const shares = mean(H.stocksReal.map((s, i) => (1 + s) * (1 + H.ukInflation[i]) - 1)) * 100, prices = mean(H.ukInflation) * 100;
    const homes = plan().accounts.some(x => x.type === 'property' && !x.excluded);
    const kinder = rate > res.probability;
    const parts = [
      `shares returned about ${shares.toFixed(0)}% a year in that history, against the ${a.stockReturn}% you assume`,
      `prices rose about ${prices.toFixed(1)}% a year, against ${a.inflation}%${g.type === 'netWorth' && g.basis !== 'real' ? ' (faster inflation lifts house prices and pay, so a target set in actual pounds is reached sooner)' : ''}`,
      homes && a.varyHouses ? `house prices in the replay only follow inflation, where the simulations also let them swing by about ${a.houseVolatility}% a year` : null,
    ].filter(Boolean);
    return `Why they differ: ${parts.join('; ')}. ${kinder ? 'History is the kinder of the two here; the simulations are the more careful figure, and the one Horizon uses.' : 'The simulations are the kinder of the two here; history shows the plan has had harder stretches than the averages you assume.'}`;
  }

  function renderGoalHistory(res) {
    const card = $('#gpHistory');
    const r = historyRuns();
    if (!card || !r) { if (card) card.hidden = true; return; }
    const rate = r.goalRates[res.goal.id] || 0;
    const gap = historyGap(res, rate);
    setKids(card, h('h2', {}, 'If history repeated'),
      h('div', { class: 'goal-figure' }, h('span', { class: 'goal-pct big' }, pct(rate)), badge(goalStatus(rate))),
      h('p', { class: 'note' }, `Reached in ${Math.round(rate * r.starts.length)} of ${r.starts.length} starting years since ${r.first}, replaying that period’s real markets with UK inflation. The random simulations give ${pct(res.probability)}.`),
      gap ? h('p', { class: 'note', id: 'gpHistoryWhy' }, gap) : null,
      (() => {
        // The same measure against the same target, from the replay: comparable with "How it's tracking".
        const g = res.goal, b = r.goalBands && r.goalBands[g.id];
        if (!b) return null;
        const len = goalChartLen(res, r.years.length), cut = v => v.slice(0, len), col = goalColor(g);
        const xs = cut(r.years), bands = Object.fromEntries(Object.entries(b).map(([k, v]) => [k, cut(v)]));
        const cfg = fanConfig(xs, bands, { title: titleAt, color: col, band: col, markers: [{ x: g.year, label: 'Target', color: col }] });
        const tv = xs.map(() => g.amount);
        cfg.lines.push({ label: 'Target', color: '--text', values: tv, dash: [2, 3] });
        const host = h('div', { class: 'chart' }), lg = h('div', { class: 'legend' });
        requestAnimationFrame(() => {
          const c = new Chart(host, { height: 240, label: `${res.title}: range if history repeated`, name: `goal-hist-${g.id}` });
          c.set(cfg);
          legend(lg, [{ label: 'Median', color: col, shape: 'line' }, { label: 'Target', color: '--text', shape: 'dash' }, { label: 'Middle half of starting years', series: 'Middle half of outcomes', color: col, shape: 'band' }, { label: '8 in 10 starting years', series: '8 in 10 outcomes', color: col, shape: 'band' }], c);
        });
        return h('div', { id: 'gpHistoryChart' }, h('p', { class: 'sub' }, `${E.GOAL_MEASURES[g.measure] || 'The amount'} across the ${r.starts.length} starting years, in ${g.basis === 'real' ? 'today’s money' : 'the actual pounds of each year'}: compare it with “How it’s tracking”, which is the simulations’ range.`), host, lg);
      })(),
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
      const pts = Math.round(driverDelta(r, res.goal.id) * 100);
      // Choices that cost the goal: why that can happen.
      const why = r.driver.kind !== 'choice' || pts >= 0 ? null : r.driver.key === 'pension'
        ? `Money paid into a pension cannot be used until ${Math.min(...people().map(x => x.pensionAccessAge))}: before then there is less to pay the bills with.`
        : r.driver.key === 'overpay' ? 'Money paid off the mortgage cannot be taken out again when cash runs short.'
          : r.driver.key === 'retireEarlier' ? 'Fewer years of saving and more years to pay for.' : null;
      return { label: r.driver.label, kind: r.driver.kind, before: b ? b.probability : 0, after: a ? a.probability : 0, pts, why };
    });
    const max = Math.max(5, ...rows.map(r => Math.abs(r.pts)));
    const bars = h('div', { class: 'divbars', role: 'list' }, rows.map(r => {
      const w = r.pts === 0 ? 0 : Math.max(0.5, (Math.abs(r.pts) / max) * 50);
      return h('div', { class: 'divbar', role: 'listitem', tabindex: '0', title: `${r.label}: ${pct(r.before)} → ${pct(r.after)}` },
        h('span', { class: 'db-label' }, h('span', { class: `kind ${r.kind}` }, r.kind === 'risk' ? 'Risk' : 'Choice'), r.label, r.why ? h('small', { class: 'db-why' }, r.why) : null),
        h('span', { class: 'db-track' }, h('span', { class: 'db-mid' }), h('span', { class: `db-bar ${r.pts >= 0 ? 'pos' : 'neg'}`, style: `${r.pts >= 0 ? 'left' : 'right'}:50%;width:${w}%` })),
        h('span', { class: `db-val${r.pts === 0 ? ' flat' : ''}` }, r.pts === 0 ? 'No change' : `${r.pts > 0 ? '+' : '−'}${Math.abs(r.pts)} points`));
    }));
    const tbl = h('div', { class: 'table-wrap' }, table(['Change', 'Chance now', 'With the change', 'Points'], rows.map(r => ({ cells: [r.label, pct(r.before), pct(r.after), { text: `${r.pts > 0 ? '+' : ''}${r.pts}`, cls: r.pts > 0 ? 'pos' : r.pts < 0 ? 'neg' : '' }] }))));
    setKids(card, ...head, viewToggle(bars, tbl),
      h('p', { class: 'hint' }, `${DRIVER_RUNS} simulated futures per change, the same markets for each. Try them for real below.`));
  }

  function renderGoalTake(res) {
    const card = $('#gpTake');
    if (!card) return;
    setKids(card, h('div', { class: 'card-head' },
      h('div', {}, h('h2', {}, 'What would it take?'), h('p', { class: 'sub' }, { debtFree: 'The share of your surplus to overpay to clear it by the target year.', emergency: 'The cash buffer that covers it.', netWorth: 'How much less to spend each month before retirement.', passiveIncome: 'How much less to spend each month before retirement.', retire: res.retired ? 'What you could spend each year, at your chosen confidence.' : 'The earliest you could retire, and what you could spend, at your chosen confidence.' }[res.goal.type])),
      h('button', { type: 'button', class: 'btn small primary', onclick: e => solveGoal(e.currentTarget, res) }, 'Work it out')),
    h('div', { class: 'goal-solve' }, (goalSolveKey === driversKey() && goalSolve[res.goal.id]) || null));
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
    setKids($('#gpImpact'), impactTable({ before, after }, undefined, { goals: model.goals, success: model.mc.successRate }));
    $('#gpStatus').textContent = changed.length
      ? `${changed.length} change${changed.length === 1 ? '' : 's'}: ${changed.map(d => `${d.label} ${fmtLever(d, gp.values[d.key])}`).join(' · ')}.`
      : `Move a slider to compare. ${EXPLORE_RUNS} simulated futures each, same markets for both.`;
    $('#gpApply').disabled = !changed.length;
    $('#gpScenario').disabled = !changed.length;
  }

  // What stopping work at their planned age means for one person, in plan `p`.
  function retireConsequences(p, x) {
    const out = [];
    if (x.retireAge < E.spStart(x)) {
      const y = E.spYears(x);
      out.push(`No State Pension for ${E.spStart(x) - x.retireAge} years after stopping work (it starts at ${E.spStart(x)}). ${!y.known ? 'A full State Pension needs 35 qualifying years of National Insurance, and a forecast assumes you keep paying until State Pension age: add your qualifying years so far (under More options for each person) to see what stopping early costs.'
        : y.missing > 0 ? `Stopping at ${x.retireAge} leaves ${y.projected} of the ${y.forecast} NI years the forecast assumes, so about ${money(x.statePension * y.share)} a year instead of ${money(x.statePension)}. Voluntary NI (about ${money(R.NI_YEARS.class3Week * 52)} a year for ${y.missing} year${y.missing === 1 ? '' : 's'}) would buy it back.`
        : y.voluntary ? `Voluntary NI for ${y.voluntary} year${y.voluntary === 1 ? '' : 's'} after stopping keeps the full forecast.` : 'The NI record is full by then, so the State Pension is not affected.'}`);
    }
    if (p.accounts.some(a => a.type === 'pension' && a.owner === x.id && !a.excluded)) {
      out.push(x.retireAge < x.pensionAccessAge
        ? `Personal and workplace pensions can’t be drawn until ${x.pensionAccessAge}: ${x.pensionAccessAge - x.retireAge} years living on ISAs, savings and other income first.`
        : `Personal and workplace pensions can be drawn from ${x.pensionAccessAge} with no penalty: a quarter tax-free, the rest taxed as income.`);
    }
    for (const db of p.income.filter(i => i.kind === 'dbpension' && i.owner === x.id)) {
      const early = E.dbEarly(db, x);
      const npa = early.npa || db.startAge;
      const built = db.amount + db.dbAccrual * Math.max(0, Math.min(x.retireAge, npa) - x.age);
      const lost = Math.max(0, npa - x.retireAge) * db.dbAccrual;
      if (lost > 0.5) out.push(`${db.name}: stopping at ${x.retireAge} instead of ${npa} means ${npa - x.retireAge} fewer years building it, about ${money(lost)} a year less pension (today’s money).`);
      if (early.npa && db.startAge > x.age) {
        const at = age => {
          const f = E.dbEarly({ ...db, startAge: age }, x).factor;
          return `${money(built * f)} a year${f < 1 ? ` (${(f * 100).toFixed(1)}%)` : ''}${db.lumpMultiple ? ` + ${money(built * f * db.lumpMultiple)} lump sum` : ''}`;
        };
        out.push(db.startAge < npa
          ? `${db.name} is taken at ${db.startAge}, ${npa - db.startAge} years before its Normal Pension Age of ${npa}, so it is cut to ${at(db.startAge)}. Waiting until ${npa}: ${at(npa)}.`
          : `${db.name} is paid in full from ${npa}: ${at(npa)}. Taking it at ${Math.max(x.retireAge, x.pensionAccessAge)} instead would cut it to ${at(Math.max(x.retireAge, x.pensionAccessAge))} (${(R.DB_SCHEMES[db.dbScheme] || {}).label || 'the scheme'}’s early retirement factors).`);
      }
    }
    return out;
  }

  // What stopping work at the planned age costs or means, person by person.
  function retireTradeoffs(res) {
    if (allRetired()) return null;
    const p = plan();
    const rows = model.proj.rows;
    const realAt = (v, t) => v / rows[Math.max(0, Math.min(rows.length - 1, t))].deflator;
    const owner = E.retiree(p, res.goal);
    const list = [owner, ...people().filter(x => x !== owner)];
    const items = list.map(x => {
      const out = retireConsequences(p, x);
      return out.length ? h('li', {}, h('strong', {}, `${people().length > 1 ? `${x.name}: ` : ''}retiring at ${x.retireAge} (${p.startYear + x.retireAge - x.age})`), h('ul', {}, out.map(t => h('li', {}, t)))) : null;
    });
    // The years between the first person stopping work and the last State Pension starting.
    const t0 = Math.min(...people().map(x => x.retireAge - x.age)), t1 = Math.max(...people().map(x => x.statePensionAge - x.age));
    let bridge = 0, n = 0;
    let gap = 0;
    for (let t = Math.max(0, t0); t < Math.min(rows.length - 1, t1); t++) { bridge += realAt(rows[t].withdrawals, t); gap += realAt(rows[t].unfunded || 0, t); n++; }
    return h('section', { class: 'card', id: 'gpTradeoffs' },
      h('div', { class: 'card-head' }, h('h2', {}, 'What retiring then means'),
        h('button', { type: 'button', class: 'btn small', onclick: () => openGuide('retire', { who: owner.id }) }, 'Try another age')),
      n ? h('p', { class: 'sub' }, `From ${p.startYear + t0} to ${p.startYear + t1} (until the State Pensions start) your savings pay for about ${money(bridge / n)} a year of living costs on average, ${money(bridge)} in all, in today’s money.${gap >= 1 ? ` Another ${money(gap / n)} a year (${money(gap)} in all) is not covered: the money runs out before then.` : ''}`) : null,
      h('ul', { class: 'tradeoffs' }, items));
  }

  // Why savings grow or shrink each year: what is paid in, what investments earn, what is taken out.
  function savingsFlowCard() {
    const rows = model.proj.rows.slice(0, -1);
    const xs = rows.map(r => r.year);
    const v = f => rows.map((r, t) => D(f(r), t));
    const paidIn = v(r => r.pensionIn + r.toCash + r.toIsa + r.toGia + r.toLisa + r.lisaBonus);
    const growth = v(r => r.gCash + r.gIsa + r.gGia + r.gPension + r.gBonds);
    const out = v(r => -(r.withdrawals + (r.lisaHome || 0)));
    const net = xs.map((_, i) => paidIn[i] + growth[i] + out[i]);
    const card = h('section', { class: 'card', id: 'gpFlows' },
      h('h2', {}, 'Why your savings grow or shrink'),
      h('p', { class: 'sub' }, `Each year: what goes in from pay and pensions, what investments earn, and what is taken out to live on, in ${unitLabel()}. Savings grow whenever earnings on them are bigger than what is taken out. Money is taken from cash, then pensions: tax-free up to each person’s allowance, and a big pot also at the basic rates, at a steady pace that would last the plan. Then the general account and ISAs, and only then pension taxed at 40% or more. ISAs keep growing while you draw on the rest.`));
    const c = chartIn(card, 260, 'Savings: paid in, investment growth and taken out each year', { name: 'savings-flows' });
    c.set({
      xs,
      bars: [
        { label: 'Paid in from pay and pensions', color: '--s1', values: paidIn },
        { label: 'Investment growth', color: '--s2', values: growth },
        { label: 'Taken out to live on', color: '--s8', values: out },
      ],
      lines: [{ label: 'Change in savings', color: '--text', values: net }],
      tooltip: i => ({ title: titleAt(i), rows: [
        { label: 'Paid in', color: '--s1', text: money(paidIn[i]) },
        { label: 'Investment growth', color: '--s2', text: money(growth[i]) },
        { label: 'Taken out', color: '--s8', text: money(out[i]) },
        { label: 'Change in savings', color: '--text', shape: 'line', text: money(net[i]), strong: true },
      ] }),
    });
    const lg = h('div', { class: 'legend' });
    card.append(lg);
    legend(lg, [{ label: 'Paid in from pay and pensions', color: '--s1' }, { label: 'Investment growth', color: '--s2' }, { label: 'Taken out to live on', color: '--s8' }, { label: 'Change in savings', color: '--text', shape: 'line' }], c);
    return card;
  }

  function retireSummary(res) {
    const p = plan();
    const s = p.strategy;
    const travel = p.expenses.find(e => e.key === 'life:travel');
    const dbs = p.income.filter(i => i.kind === 'dbpension');
    const item = (k, v) => h('li', {}, h('span', {}, k), h('strong', {}, v));
    // Savings when the last person stops work, against a year of spending then (today's money).
    const rows = model.proj.rows;
    const tr = Math.max(0, Math.min(rows.length - 2, Math.max(...people().map(x => x.retireAge - x.age))));
    const real0 = (v, t) => v / rows[t].deflator;
    const pot = real0(rows[tr].liquid, tr), spend = real0(rows[tr + 1].spending, tr + 1);
    const rate = pot > 0 ? spend / pot : 0;
    const lasting = h('p', { class: 'hint', id: 'gpDrawRate' }, pot > 0 ? (rate < 0.03
      ? `${allRetired() ? 'Today' : `When ${people().length > 1 ? 'you have both' : 'you have'} stopped work (${rows[tr].year})`} the plan has about ${fmtCompact(pot)} in savings, investments and pensions (today’s money), and spends about ${money(spend)} a year: ${(rate * 100).toFixed(1)}% of it. That is well below the 3–4% usually thought sustainable, so on average returns the savings keep growing through retirement. ${allRetired() ? 'You could spend more' : 'You could retire earlier or spend more'}: try the levers below.`
      : rate > 0.15
        ? `${allRetired() ? 'Today' : `When ${people().length > 1 ? 'you have both' : 'you have'} stopped work (${rows[tr].year})`} the plan has about ${fmtCompact(pot)} in savings, investments and pensions (today’s money), and spends about ${money(spend)} a year: on their own the savings would last about ${Math.max(0, pot / spend).toFixed(1)} year${pot / spend >= 0.95 && pot / spend < 1.05 ? '' : 's'}, so pensions and other income have to pay most of it.`
        : `${allRetired() ? 'Today' : `When ${people().length > 1 ? 'you have both' : 'you have'} stopped work (${rows[tr].year})`} the plan has about ${fmtCompact(pot)} in savings, investments and pensions (today’s money), and spends about ${money(spend)} a year: ${(rate * 100).toFixed(1)}% of it. 3–4% a year is usually thought sustainable.${rate > 0.045 && !allRetired() ? ' That is the first year, before the State Pension and any other pensions start; once they do, much less has to come from savings, which is why the chance can still be good.' : ''}`) : '');
    return h('section', { class: 'card' },
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Your retirement plan'), h('p', { class: 'sub' }, 'What the chance above assumes. Change it with the retirement questionnaire.')),
        h('button', { type: 'button', class: 'btn small', onclick: () => openGoalWizard(res.goal) }, 'Edit retirement plan')),
      h('ul', { class: 'rq-facts wide' },
        people().map(x => (x.retireAge <= x.age ? item(x.name, 'Retired') : item(`${x.name} retires at`, `${x.retireAge} (${p.startYear + x.retireAge - x.age})`))),
        item(allRetired() ? 'Spending' : 'Spending in retirement', s.retireSpending ? `${money(s.retireSpending)} a year (today’s £)` : 'As your spending list'),
        travel ? item('Extra in the early years', `${money(travel.amount)} a year to age ${travel.endAge}`) : null,
        s.slowDownAge ? item('Spending later on', `${s.slowDownPct}% from age ${s.slowDownAge}`) : null,
        people().map(x => item(`${x.name}'s State Pension`, `${money(x.statePension * E.spYears(x).share * E.spDeferUplift(x))} a year from ${E.spStart(x)}`)),
        dbs.map(i => item(i.name, inPayment(i, p) ? `${money(i.amount)} a year, being paid now` : `${money(i.amount)} a year built up, paid from ${i.startAge}`))),
      lasting);
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
            apply('Apply', () => { p.strategy.cashReserve = r.buffer; p.strategy.autoBuffer = false; }));
      } else if (g.type === 'netWorth') {
        const r = E.solveNetWorth(p, g);
        if (r.already) out = h('p', {}, `On average returns you get there by ${g.year} already.`);
        else if (r.spendNowPct === null) out = h('p', {}, 'Not reachable by cutting spending alone. Try retiring later or the stress-test levers.');
        else out = h('p', {}, `Spend about ${money(r.monthlyCut)} a month less before retirement (${Math.round(r.spendNowPct)}% of today's spending). `,
          apply('Apply', () => { p.strategy.spendNowPct = Math.round(r.spendNowPct); }));
      } else {
        const gone = allRetired();
        const delta = gone ? 0 : g.age - E.retiree(p, g).retireAge;
        const earliest = gone ? null : E.solveRetirement(p, conf, 400, ws.settings.seed);
        const spend = E.solveRetirementSpending(p, conf, 300, ws.settings.seed, delta);
        out = h('div', {},
          gone ? null : h('p', {}, earliest.delta === null ? `No retirement age reaches ${g.confidence}% confidence.` : `Earliest retirement at ${g.confidence}% confidence: ${people().map(x => `${x.name} ${x.retireAge + earliest.delta}`).join(', ')}.`),
          !spend.amount && gone ? h('p', {}, `No level of spending reaches ${g.confidence}% confidence.`) : null,
          spend.amount ? h('p', {}, `${gone ? 'You' : `Retiring at ${g.age}, you`} could spend about ${money(spend.amount)} a year (${money(spend.amount / 12)} a month, today's money) at ${g.confidence}% confidence. `,
            apply('Use this spending', () => { p.strategy.retireSpending = spend.amount; for (const x of people()) x.retireAge += delta; })) : null);
      }
      goalSolve[g.id] = out;
      goalSolveKey = driversKey();
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
    if (d.unit === 'pts') return v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} points`;
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

  // `live`: the chances the page itself shows for the plan as it is (worked out over more
  // futures than a comparison has time for). The table then starts from those and applies the
  // change the comparison found, so the same goal never shows two different chances.
  function impactTable(cmp, labels = ['Your plan', 'With changes'], live = null) {
    const { before, after } = cmp;
    const pair = (b, a, shown) => (shown === undefined || shown === null ? [b, a] : [shown, Math.max(0, Math.min(1, shown + (a - b)))]);
    const rows = after.goals.map(a => {
      const b = before.goals.find(x => x.goal.id === a.goal.id) || { probability: 0, expectedYear: null };
      const lv = live && live.goals ? live.goals.find(x => x.goal.id === a.goal.id) : null;
      const [pb, pa] = pair(b.probability || 0, a.probability || 0, lv ? lv.probability || 0 : null);
      const when = r => (r.goal.type === 'retire' ? '' : r.expectedYear ? ` · ${r.expectedYear}` : ' · not reached');
      return {
        cells: [h('span', { class: 'goal-name' }, h('i', { class: 'key dot', style: `--key:${cssVar(goalColor(a.goal))}` }), a.title), `${pct(pb)}${when(b)}`, `${pct(pa)}${when(a)}`,
          deltaCell(Math.round(pb * 100), Math.round(pa * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} points`)],
      };
    });
    const sb = before.summary, sa = after.summary;
    const [lb, la] = pair(sb.success, sa.success, live ? live.success : null);
    rows.push({ cls: 'sep', cells: ['Chance the money lasts', pct(lb), pct(la), deltaCell(Math.round(lb * 100), Math.round(la * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} points`)] });
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
      setTimeout(() => toast(`“${name}” is a new scenario, now open. Go back to ${ws.scenarios[0].name} from the banner at the top.`), 0);
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
        retire: { type: 'retire', amount: 0, measure: 'all', basis: 'nominal', year: p.startYear + (nextRetiree(p).retireAge - nextRetiree(p).age), age: nextRetiree(p).retireAge, owner: nextRetiree(p).id, confidence: 85 },
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
    if (gw.goal && gw.goal.type === 'emergency' && gw.setBuffer) { p.strategy.cashReserve = Math.max(p.strategy.cashReserve, gw.bufferNeeded); p.strategy.autoBuffer = false; }
    return p;
  }

  function draftPlan(withLevers) {
    const base = gwBase();
    const p = withLevers ? L.apply(base, gw.values) : base;
    const g = E.normalizeGoal({ ...gw.goal, id: gw.goal.id || 'draft' }, p.startYear, p.household.people[0], p.household.people);
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
      const offer = goalOffers(plan());
      const retireText = people().length > 1 && plan().goals.some(x => x.type === 'retire')
        ? `${nextRetiree(plan()).name}’s retirement: when, what you want to spend, and how likely the money is to last.`
        : 'When you stop, what you want to spend, and how likely the money is to last.';
      setKids(body, h('div', { class: 'goal-options' },
        offer.retire ? opt('retire', allRetired() ? 'Will the money last?' : 'Plan your retirement', allRetired() ? 'What you spend, what comes in, and how likely the money is to last.' : retireText) : null,
        offer.emergency ? opt('emergency', 'Emergency fund', 'Months of spending kept in cash, or in cash and investments.') : null,
        offer.debtFree ? opt('debtFree', 'Mortgage-free by a year', 'Overpaying clears it sooner but leaves less to invest.') : null,
        offer.fi ? opt('fi', 'Financial independence', 'Savings and pensions worth 25 years of spending: work becomes optional.') : null,
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
        const sol = E.solveEmergency(plan(), E.normalizeGoal(g, plan().startYear, p1, people()));
        if (gw.bufferNeeded !== sol.buffer) gw.valuesFresh = false;
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
        const owed = plan().accounts.filter(a => a.type === 'debt' && !a.excluded);
        if (owed.length > 1) fields.push(field('Which one', h('select', { 'aria-label': 'Which mortgage or loan', onchange: e => { g.debtId = e.target.value; previewGoal(); } },
          [['', 'Everything owed'], ...owed.map(a => [a.id, a.name])].map(([v, l]) => h('option', { value: v, selected: (g.debtId || '') === v }, l))),
          'Pick one to follow it alone: anything overpaid then goes to it first. Otherwise the most expensive is overpaid first, and the goal is met when nothing at all is owed.'));
        fields.push(field(owed.length > 1 ? 'Paid off by the start of' : 'Mortgage-free by the start of', h('input', { type: 'number', value: g.year, min: plan().startYear, max: plan().startYear + 40, oninput: e => { g.year = parseInt(e.target.value, 10) || g.year; previewGoal(); } })));
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
      const draftGoal = E.normalizeGoal({ ...g, id: g.id || 'draft' }, base.startYear, base.household.people[0], base.household.people);
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
    const auto = E.autoTitle(E.normalizeGoal({ ...g, name: '' }, plan().startYear, people()[0], people()), plan());
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

  // Whose retirement a new retirement goal is about: the first person without one yet.
  const nextRetiree = p => p.household.people.find(x => !p.goals.some(g => g.type === 'retire' && g.owner === x.id)) || p.household.people[0];

  function initRetire() {
    const p = plan();
    const s = p.strategy;
    const p1 = people()[0];
    const std = plsa();
    const preset = Object.keys(std).find(k => std[k] === s.retireSpending);
    const travel = p.expenses.find(e => e.key === 'life:travel');
    gw.retire = {
      ages: people().map(x => x.retireAge),
      mode: s.retireSpending === 0 ? 'list' : s.retireSpending === withMargin(p, p1.retireAge) ? 'margin' : preset || 'custom',
      custom: s.retireSpending || std.moderate,
      travelExtra: travel ? travel.amount : 0,
      travelYears: travel ? Math.max(1, travel.endAge - p1.retireAge) : 10,
      slowDownAge: s.slowDownAge,
      slowDownPct: s.slowDownAge > 0 ? s.slowDownPct : 80,
      statePension: people().map(x => x.statePension),
      answers: null,
    };
    if (gw.goal) gw.goal.age = E.retiree(p, gw.goal).retireAge;
  }

  // The spending list as it stands when the first person retires (today's money), and the same
  // with a margin on top: room for the unexpected, and for spending more while you are able.
  const RETIRE_MARGIN = 50;
  function listAtRetire(p, age) {
    const p1 = p.household.people[0];
    const tr = Math.max(0, Math.min(E.horizon(p), age - p1.age));
    return p.expenses.filter(e => !(e.key || '').startsWith('life:')).reduce((acc, e) => acc + E.streamAt(e, p, tr), 0) / Math.pow(1 + p.assumptions.inflation / 100, tr);
  }
  const withMargin = (p, age) => Math.round((listAtRetire(p, age) * (1 + RETIRE_MARGIN / 100)) / 100) * 100;

  function retireSpendingOf(r, p = plan()) {
    return r.mode === 'list' ? 0 : r.mode === 'custom' ? r.custom : r.mode === 'margin' ? withMargin(p, r.ages[0]) : plsa()[r.mode];
  }

  function applyRetire(p) {
    const r = gw.retire;
    const pp = p.household.people;
    pp.forEach((x, i) => {
      // A retirement goal that was about this person's planned age moves with it.
      for (const g of p.goals) if (g.type === 'retire' && E.retiree(p, g).id === x.id && g.age === x.retireAge) g.age = r.ages[i];
      x.retireAge = r.ages[i];
      x.statePension = r.statePension[i];
    });
    p.strategy.retireSpending = retireSpendingOf(r, p);
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
    if (gw.goal) gw.goal.age = r.ages[Math.max(0, pp.findIndex(x => x.id === E.retiree(p, gw.goal).id))];
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
    // The answers to "A few questions": the share mix and saving choices.
    const ab = before.assumptions, aa = after.assumptions;
    if (ab.stockPctNow !== aa.stockPctNow || ab.stockPctRetire !== aa.stockPctRetire) out.push(`${aa.stockPctNow}% in shares now, ${aa.stockPctRetire}% at retirement (was ${ab.stockPctNow}% and ${ab.stockPctRetire}%)`);
    const onOff = (key, label) => { if (!!sb[key] !== !!sa[key]) out.push(`${label}: ${sa[key] ? 'on' : 'off'}`); };
    onOff('pensionFirst', 'Pensions before the general account');
    if (E.stayUnderLine(sb) !== E.stayUnderLine(sa)) out.push(E.stayUnderLine(sa) ? `Keep income under ${money(E.stayUnderLine(sa))}` : 'No longer keeping income under a line');
    onOff('claimRelief', 'Claim higher-rate relief');
    onOff('sweepCash', 'Invest cash above the buffer');
    if (sb.overpayPct !== sa.overpayPct) out.push(`Overpay the mortgage with ${sa.overpayPct}% of what is left (was ${sb.overpayPct}%)`);
    const sac = p => p.income.filter(i => i.kind === 'salary' && i.sacrifice).map(i => i.id).sort().join();
    if (sac(before) !== sac(after)) out.push('How pension contributions are paid (salary sacrifice)');
    const lisas = p => p.accounts.filter(a => a.type === 'lisa').length;
    if (lisas(before) !== lisas(after)) out.push(`Lifetime ISAs: ${lisas(after)} (was ${lisas(before)})`);
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
    const listThen = listAtRetire(p, r.ages[0]);
    const std = plsa();
    const option = (mode, title, amount, text) => h('button', {
      type: 'button', class: 'spend-option', 'aria-pressed': String(r.mode === mode),
      onclick: e => { r.mode = mode; for (const b of $$('.spend-option', e.currentTarget.parentElement)) b.setAttribute('aria-pressed', String(b === e.currentTarget)); customBox.hidden = mode !== 'custom'; changed(); },
    }, h('strong', {}, title), amount != null ? h('span', { class: 'amt' }, `${money(amount)} a year`, h('small', {}, ` · ${money(amount / 12)} a month`)) : null, h('span', { class: 'txt' }, text));
    const customBox = h('div', { class: 'field', hidden: r.mode !== 'custom' }, h('span', {}, 'Your amount (a year, today’s money)'), moneyIn(() => r.custom, v => { r.custom = v; }, 'Retirement spending'));
    const debtFree = E.debtFreeYear(model.proj);
    const retireYear = p.startYear + (r.ages[0] - p1.age);
    const sps = people().map((x, i) => h('label', { class: 'field' }, h('span', {}, `${x.name} (from ${E.spStart(x)})`), moneyIn(() => r.statePension[i], v => { r.statePension[i] = v; }, `${x.name} State Pension`)));
    const dbs = p.income.filter(i => i.kind === 'dbpension');

    return h('div', { class: 'rq' },
      h('div', { class: 'rq-questions' },
        people().every(x => x.retireAge <= x.age) ? sec(1, 'You’re retired already',
          h('p', { class: 'hint' }, 'The plan draws on pensions and savings from now. The questions below are about what you spend and what you have coming in.')) : sec(1, 'When do you want to stop working?',
          people().length > 1 && gw.goal ? h('div', { class: 'field' }, h('span', {}, 'This goal is about'), h('div', { class: 'idea-chips', role: 'group', 'aria-label': 'Whose retirement' },
            people().map(x => h('button', { type: 'button', class: 'idea-chip', 'data-owner': x.id, 'aria-pressed': String(E.retiree(p, gw.goal).id === x.id),
              onclick: () => { gw.goal.owner = x.id; changed(); renderGoalWizard(); } }, `${x.name} retiring`)))) : null,
          h('div', { class: 'fields' }, people().map((x, i) => h('label', { class: 'field' }, h('span', {}, `${x.name} retires at`),
            num(() => r.ages[i], v => { r.ages[i] = Math.round(v); }, { min: x.age, max: 80, suffix: 'years', label: `${x.name} retirement age` })))),
          h('p', { class: 'hint' }, `Pensions can be drawn from ${people().map(x => `${x.pensionAccessAge}`).filter((v, i, a) => a.indexOf(v) === i).join(' / ')}; State Pension from ${people().map(x => `${x.name} ${E.spStart(x)}`).join(', ')}. Retiring before then means living on ISAs and savings.`)),
        sec(2, 'What would you like to spend each year?',
          h('div', { class: 'spend-options' },
            option('list', 'Keep my spending list', listThen, 'What you spend now, minus items that stop before then (like childcare).'),
            option('margin', `My list + ${RETIRE_MARGIN}%`, withMargin(p, r.ages[0]), 'Your list then, with room on top for the unexpected and for doing more while you can.'),
            option('minimum', 'Minimum', std.minimum, PLSA_TEXT.minimum),
            option('moderate', 'Moderate', std.moderate, PLSA_TEXT.moderate),
            option('comfortable', 'Comfortable', std.comfortable, PLSA_TEXT.comfortable),
            option('custom', 'My own amount', null, 'Type a figure, or use “What could we spend?” on the right.')),
          customBox,
          h('p', { class: 'hint' }, `Every amount rises with prices each year, so it buys the same as it would today. Minimum, moderate and comfortable are the PLSA Retirement Living Standards 2025 for a ${people().length > 1 ? 'couple' : 'single person'}: after tax, in today’s money, with no mortgage or rent. ${debtFree && model.proj.rows[0].debt > 0.5 ? (debtFree <= retireYear ? `Your mortgage is paid off in ${debtFree}, before you retire.` : `Your mortgage runs to ${debtFree}, after you retire: its payments come on top.`) : ''}`)),
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
      const spend = retireSpendingOf(r, p);
      const conf = gw.goal.confidence / 100;
      const gone = p.household.people.every(x => x.retireAge <= x.age);
      const chartBox = h('div', { class: 'rq-chart' });
      const answers = h('div', { class: 'rq-answers' });
      const showAnswers = () => {
        if (!r.answers) {
          setKids(answers, h('button', { type: 'button', class: 'btn small', onclick: e => {
            e.currentTarget.disabled = true; e.currentTarget.textContent = 'Working…';
            setTimeout(() => {
              const earliest = gone ? { delta: 0 } : E.solveRetirement(p, conf, EXPLORE_RUNS, ws.settings.seed);
              const could = E.solveRetirementSpending(p, conf, EXPLORE_RUNS, ws.settings.seed, 0);
              r.answers = { earliest, could };
              showAnswers();
            }, 30);
          } }, gone ? 'What we could spend' : 'Earliest age and what we could spend'));
          return;
        }
        const { earliest, could } = r.answers;
        setKids(answers, 
          gone ? null : h('p', {}, earliest.delta === null ? `No retirement age reaches ${gw.goal.confidence}%.` : `Earliest at ${gw.goal.confidence}%: ${p.household.people.map(x => `${x.name} ${x.retireAge + earliest.delta}`).join(', ')}. `,
            earliest.delta !== null && earliest.delta !== 0 ? h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.ages = r.ages.map(a => a + earliest.delta); renderGoalWizard(); } }, 'Use') : null),
          could.amount ? h('p', {}, `${gone ? 'You' : 'At these ages you'} could spend about ${money(could.amount)} a year (${money(could.amount / 12)} a month). `,
            h('button', { type: 'button', class: 'btn small ghost', onclick: () => { r.mode = 'custom'; r.custom = could.amount; renderGoalWizard(); } }, 'Use')) : null);
      };
      setKids(box, 
        h('div', { class: 'hero-label' }, 'Chance the money lasts'),
        h('div', { class: 'goal-figure' }, h('span', { class: 'goal-pct big' }, pct(mc.successRate)), badge(st)),
        h('div', { class: 'meter' }, h('span', { style: `width:${mc.successRate * 100}%` })),
        h('ul', { class: 'rq-facts' },
          gone ? null : h('li', {}, h('span', {}, 'Retire in'), h('strong', {}, `${p.startYear + tr} (${p1.name} ${p1.retireAge})`)),
          h('li', {}, h('span', {}, 'Spending a year'), h('strong', {}, spend ? money(spend) : 'As your list')),
          h('li', {}, h('span', {}, gone ? 'Savings and pensions today' : 'Saved by then (today’s £)'), h('strong', {}, money(proj.rows[tr].liquid / proj.rows[tr].deflator))),
          h('li', {}, h('span', {}, mc.medianFailYear ? 'If it runs out, typically' : 'Plan runs to'), h('strong', {}, mc.medianFailYear ? `${mc.medianFailYear} (age ${p1.age + mc.medianFailYear - p.startYear})` : `age ${lastAge}`))),
        h('h3', { class: 'chart-title' }, 'Savings, investments and pensions (today’s £)'),
        chartBox,
        mc.series.liquid.real.p10.some(v => v < -0.5) ? h('p', { class: 'hint' }, 'Below £0, the money has run out: the figure is the spending that couldn’t be paid, added up.') : null,
        answers);
      showAnswers();
      const b = mc.series.liquid.real;
      const c = chartIn(chartBox, 170, 'Range of savings over time', { name: 'retirement-preview' });
      c.set(fanConfig(mc.years, b, { title: i => `${mc.years[i]} · ${p1.name} ${p1.age + i}`, markers: gone ? [] : [{ x: p.startYear + tr, label: 'Retire', color: '--s4' }] }));
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
      const mc = E.monteCarlo(p, ws.settings.runs, ws.settings.seed);
      const res = E.evaluateGoals(p, proj, mc, { runs: 500, seed: ws.settings.seed }).find(x => x.goal.id === g.id);
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
    const g = E.normalizeGoal({ ...gw.goal, id: gw.goal.id || E.uid() }, p.startYear, p.household.people[0], p.household.people);
    if (mode === 'scenario') {
      const next = L.apply(p, gw.values);
      next.goals = E.assignGoalColours(next.goals.filter(x => x.id !== g.id).concat([g]));
      const id = E.uid();
      const name = `${scenario().name} – ${E.goalTitle(g, next)}`;
      for (const s of ws.scenarios) if (!s.plan.goals.some(x => x.id === g.id)) s.plan.goals = E.assignGoalColours(s.plan.goals.concat([{ ...g }]));
      ws.scenarios.push({ id, name, plan: E.normalizePlan(next) });
      ws.activeId = id;
      setTimeout(() => toast(`Saved as the scenario “${name}”, now open. The goal is in your other scenarios too; go back to ${ws.scenarios[0].name} from the banner at the top.`), 0);
    } else {
      if (mode === 'apply') scenario().plan = E.normalizePlan(L.apply(p, gw.values));
      else if (planChanges(plan(), p).length) scenario().plan = E.normalizePlan(p);
      const target = plan();
      const isNew = !target.goals.some(x => x.id === g.id);
      target.goals = E.assignGoalColours(target.goals.filter(x => x.id !== g.id).concat([g]));
      // A new goal is added to the other scenarios too, so they can all be compared on it.
      if (isNew) for (const s of ws.scenarios) if (s !== scenario() && !s.plan.goals.some(x => x.id === g.id)) s.plan.goals = E.assignGoalColours(s.plan.goals.concat([{ ...g }]));
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
      // Pay and other income together (the table keeps them apart): fewer bands to read.
      { label: 'Pay & other income', color: '--s1', values: col(r => r.earnings + r.otherIncome) },
      { label: 'State Pension', color: '--s3', values: col(r => r.statePension) },
      { label: 'From savings', color: '--s4', values: col(r => r.withdrawals) },
      { label: 'Not covered', color: '--muted', values: col(r => r.unfunded) },
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
      { label: '8 in 10 outcomes', color: '--band', shape: 'band' },
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
    ['saving', 'Saving & investing'],
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
    const p = plan();
    if (!p.income.length || !model.goals.length) {
      impactBase = null;
      setKids(box, h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'What your changes do'),
        h('p', { class: 'sub' }, `Once ${!p.income.length ? 'your income' : ''}${!p.income.length && !model.goals.length ? ' and ' : ''}${!model.goals.length ? 'a goal' : ''} ${!p.income.length && !model.goals.length ? 'are' : 'is'} in, this shows what each change does to your goals and to what you can invest.`))));
      return;
    }
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
            h('span', { class: `im-delta ${d > 0 ? 'pos' : d < 0 ? 'neg' : ''}` }, d ? `${d > 0 ? '▲' : '▼'} ${Math.abs(d)} points` : ''));
        }),
        h('li', { class: 'im-invest', title: 'What is left each month after tax, spending and the mortgage, once the cash buffer is full: so adding cash above the buffer, or a bigger buffer, moves it too.' }, h('span', { class: 'im-name' }, now.invest < 0 ? 'Drawing from savings' : 'Invest each month', h('small', {}, now.invest < 0 ? 'spending is more than comes in' : 'left over, once the cash buffer is full')),
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
    if (moneyPage === 'saving') { fill('#mpSaving', wkSaving); updateSavingFigures(); }
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
      h('p', {}, `Prices rise ${a.inflation}% a year, so £100 of today’s shopping costs about ${money(Math.pow(1 + a.inflation / 100, 10) * 100)} in 10 years. “Today’s money” divides later amounts by how much prices have risen (the price index).`),
      h('p', {}, `Tax thresholds stay frozen until April ${a.thresholdFreezeUntil}, then rise with prices (the line below shows by how much). Investments move from ${a.stockPctNow}% to ${a.stockPctRetire}% stocks by retirement; the expected return is the mix of ${a.stockReturn}% for stocks and ${a.bondReturn}% for bonds.`),
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
      h('p', {}, 'Each amount grows from today’s by its own yearly rise (with prices, for items linked to inflation), converted at any exchange rate, minus costs. Shown before tax; flat taxes appear in Cash flow. Items stop at their end age (for salaries usually retirement).'),
      h('p', {}, `State Pension = your forecast × price index from State Pension age. Simulations add random salary surprises (±${p.assumptions.salaryVolatility}% a year) and inflation surprises on top.`),
    ]);
    const xs = rows.map(r => r.year);
    const lines = items.map((it, k) => ({ label: it.name, color: SERIES_COLORS[k % 8], values: rows.map((r, t) => D(E.incomeAfterCosts(it, p, t) + E.bonusAt(it, p, t) + (it.shares > 0 && E.isActive(it, p, t) ? it.shares * E.expectedGrowth(it, p, t) * (it.fx || 1) : 0), t)) }));
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
      h('p', {}, 'National Insurance is on earnings (after salary sacrifice) until State Pension age. Capital gains tax applies when the general investment account is sold, shared between the household. With an income called “Child Benefit” in the plan, the charge on incomes over £60,000 (all of it from £80,000) is included in the higher earner’s income tax.'),
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
    cash: { label: 'Cash', bal: 'cash', growth: 'gCash', growthLabel: 'Interest', inn: r => r.toCash + r.bondsMatured + (r.lisaHome || 0) + (r.releaseIn || 0), out: r => r.wCash + r.sweepIsa + r.sweepGia, explain: 'Interest at the cash rate. Paid in: buffer top-ups from surplus and bonds that mature. Taken out: spending needs above the buffer, cash above the buffer that gets invested, and the buffer itself last of all.' },
    isa: { label: 'ISAs', bal: 'isa', growth: 'gIsa', growthLabel: 'Growth', inn: r => r.toIsa + r.sweepIsa + r.bondsToIsa + r.toLisa + r.lisaBonus, out: r => r.wIsa + r.wLisa + r.lisaHome, explain: 'Includes Lifetime ISAs. Grows at the portfolio return. Paid in: surplus up to each person\'s ISA allowance (Lifetime ISAs first, with their 25% bonus), and gilts held in the ISA when they mature. Taken out: tax-free withdrawals, Lifetime ISAs used for a first home, and from 60.' },
    gia: { label: 'General investment', bal: 'gia', growth: 'gGia', growthLabel: 'Growth', inn: r => r.toGia + r.sweepGia + (r.sharesKept || 0), out: r => r.wGia, explain: 'Grows at the portfolio return. Paid in: surplus above the ISA allowances, and share awards kept as shares. Sales pay capital gains tax on the gain part (see Tax).' },
    pension: { label: 'Pensions', bal: 'pension', growth: 'gPension', growthLabel: 'Growth', inn: r => r.pensionIn, out: r => r.wPension + (r.annuityBought || 0), explain: 'Grows at the portfolio return. Paid in: your and your employer\'s contributions (plus any extra with 20% relief). Taken out from the access age: 25% tax-free, the rest taxed as income.' },
    bonds: { label: 'Bonds & gilts', bal: 'bonds', growth: 'gBonds', growthLabel: 'Interest', inn: () => 0, out: r => r.bondsMatured + r.bondsToIsa, explain: 'Grows at each bond\'s fixed rate and pays out when it matures: into cash, or into the ISA if it is held in one.' },
    property: { label: 'Property', bal: 'property', growth: 'gProperty', growthLabel: 'Growth', inn: r => r.propBought || 0, out: r => r.propSold + (r.releaseRepaid || 0), explain: 'Grows at each property\'s rate. Paid in: a home bought that year, at its price. A sale adds the value to that year\'s income, which is then saved or invested.' },
    debt: { label: 'Mortgage & loans', bal: 'debt', growth: 'debtInterest', growthLabel: 'Interest added', inn: r => r.debtNew || 0, out: r => r.debtRegular + r.overpay + r.lumpOverpay + (r.hiDebtPay || 0) + (r.debtForgiven || 0) + (r.releaseRepaid || 0), explain: 'Interest is added each year at the mortgage rate; payments and overpayments reduce the balance. After a fixed period ends, simulations let the rate move with inflation.' },
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

  // One goal in a scenario: its chance, the change from `b` (the plan it is compared with) and when.
  function scoreCell(r, b, c) {
    if (!r) return h('td', { class: 'sc-cell none' }, h('span', { class: 'muted' }, 'Not a goal here'));
    const pts = b ? Math.round((r.probability - b.probability) * 100) : 0;
    return h('td', { class: 'sc-cell', style: `--gc:${cssVar(goalColor(c.goal))}` },
      h('div', { class: 'sc-top' }, h('strong', {}, pct(r.probability)),
        b && pts ? h('span', { class: `sc-delta ${pts > 0 ? 'pos' : 'neg'}` }, `${pts > 0 ? '▲' : '▼'} ${Math.abs(pts)} points`) : null),
      h('div', { class: 'sc-bar', role: 'img', 'aria-label': `${pct(r.probability)} chance` }, h('span', { style: `width:${r.probability * 100}%` })),
      h('small', {}, goalWhen(r)));
  }
  const invest = it => (it.monthly.shortfall > 0 ? `Draws ${money(it.monthly.shortfall)}` : money(it.monthly.invest));

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
    renderComparisons();
    renderIdeas();
    const box = $('#compareResults');
    setKids(box, h('p', { class: 'sub working' }, `Working out ${ws.scenarios.length} scenario${ws.scenarios.length === 1 ? '' : 's'}…`));
    setTimeout(() => {
      if (route.tab !== 'scenarios') return;
      const items = compareScenarios();
      const base = items.find(x => x.s.id === ws.scenarios[0].id) || items[0];
      const open = items.find(x => x.s.id === ws.activeId);
      // One column per goal: the main plan's goals first, then any only others have.
      const cols = [];
      const same = (a, b) => a.goal.id === b.goal.id || a.title === b.title;
      for (const it of [base, ...items.filter(x => x !== base)]) for (const g of it.goals) if (!cols.some(c => same(c, g))) cols.push(g);
      const find = (it, c) => it.goals.find(g => same(g, c));
      const cell = (it, c) => scoreCell(find(it, c), it === base ? null : find(base, c), c);
      const rows = items.map(it => h('tr', { class: it === open ? 'open' : '', 'data-scenario': it.s.id },
        h('th', { scope: 'row' }, h('strong', {}, it.s.name), it === base ? h('span', { class: 'sc-main' }, 'Main plan') : null, it === open ? h('span', { class: 'sc-open' }, 'Open now') : null),
        cols.map(c => cell(it, c)),
        h('td', { class: 'sc-invest' }, invest(it), h('small', {}, 'a month now')),
        h('td', { class: 'sc-actions' }, it === open ? null : [
          h('button', { type: 'button', class: 'btn small', onclick: () => { ws.activeId = it.s.id; afterScenarioChange(); } }, 'Open'),
          it === base ? null : h('button', { type: 'button', class: 'btn small ghost danger', 'aria-label': `Delete scenario ${it.s.name}`, onclick: () => {
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
      ws.scenarios.length < 2 ? h('p', { class: 'hint' }, 'Only one scenario so far: add a what-if below, or duplicate this one and change anything in it.') : h('p', { class: 'hint' }, `Chance of each goal across simulated futures, and when it is reached on average returns. ▲▼ compare with your main plan, ${ws.scenarios[0].name}.`));
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

  // ---- comparisons: a common choice made two ways, next to the plan as it is (nothing saved)

  let cmpPick = null;
  let cmpRun = { key: null, rows: null };

  function openComparison(id) {
    cmpPick = id;
    navigate('scenarios');
    requestAnimationFrame(() => { const c = $('#compareCard'); if (c) c.scrollIntoView({ behavior: 'smooth', block: 'start' }); });
  }

  // How a plan does: goals, this year's investing, and savings and pensions when the first person retires.
  function scorePlan(q, proj, goals) {
    const p1 = q.household.people[0];
    const t = Math.max(0, Math.min(proj.pre.N, p1.retireAge - p1.age));
    const v = proj.rows[t].liquid;
    return { goals, monthly: E.monthlyPlan(proj), atRetire: real() ? v / proj.pre.deflator[t] : v, retireYear: proj.rows[t].year };
  }

  function renderComparisons() {
    const p = plan();
    const list = SI.comparisonsFor(p);
    if (cmpPick && !list.some(c => c.id === cmpPick)) cmpPick = null;
    setKids($('#cmpGrid'), list.map(c => h('button', {
      type: 'button', class: 'idea-chip', 'data-compare': c.id, 'aria-pressed': String(c.id === cmpPick),
      onclick: () => { cmpPick = cmpPick === c.id ? null : c.id; renderComparisons(); },
    }, h('span', { class: 'idea-ico' }, glyph(c.icon)), h('span', {}, c.title))));
    const box = $('#cmpResult');
    const c = list.find(x => x.id === cmpPick);
    if (!c) { setKids(box); return; }
    const head = h('p', { class: 'cmp-text' }, SI.textOf(c, p));
    setKids(box, head, h('p', { class: 'sub working' }, 'Working it out…'));
    const runs = ws.settings.runs, seed = ws.settings.seed;
    const key = `${c.id}|${JSON.stringify(p)}|${runs}|${seed}|${real()}`;
    setTimeout(() => {
      if (route.tab !== 'scenarios' || cmpPick !== c.id) return;
      if (cmpRun.key !== key) {
        const base = { name: c.base || 'As now', text: 'Your plan as it is', ...scorePlan(p, model.proj, model.goals) };
        cmpRun = { key, rows: [base, ...SI.optionsOf(c, p).map(o => {
          const proj = E.project(o.plan);
          return { ...o, ...scorePlan(o.plan, proj, E.evaluateGoals(o.plan, proj, E.monteCarlo(o.plan, runs, seed), { runs: 500, seed })) };
        })] };
      }
      const [base, ...opts] = cmpRun.rows;
      const cols = base.goals;
      const find = (it, g) => it.goals.find(x => x.goal.id === g.goal.id);
      const name = o => `${scenario().name}: ${o.name}`;
      const kept = opts.every(o => ws.scenarios.some(s => s.name === name(o)));
      const p1 = p.household.people[0];
      const row = it => h('tr', { class: it === base ? 'open' : '' },
        h('th', { scope: 'row' }, h('strong', {}, it.name), h('small', { class: 'cmp-what' }, it.text)),
        cols.map(g => scoreCell(find(it, g), it === base ? null : find(base, g), g)),
        h('td', { class: 'sc-invest' }, fmtCompact(it.atRetire), h('small', {}, `in ${it.retireYear}`)),
        h('td', { class: 'sc-invest' }, invest(it), h('small', {}, 'a month now')));
      setKids(box, head, h('div', { class: 'table-wrap sc-wrap' }, h('table', { class: 'data sc-table cmp-table' },
        h('thead', {}, h('tr', {}, h('th', { scope: 'col' }, 'Choice'),
          cols.map(g => h('th', { scope: 'col', style: `--gc:${cssVar(goalColor(g.goal))}` }, h('span', { class: 'heat-goal' }, goalBadge(g.goal, 'small'), h('span', {}, g.title)))),
          h('th', { scope: 'col' }, `Savings & pensions when ${p1.name} retires (${unitLabel()})`), h('th', { scope: 'col' }, 'Invest'))),
        h('tbody', {}, [base, ...opts].map(row)))),
      h('div', { class: 'add-row' },
        h('p', { class: 'hint' }, `Chance of each goal across simulated futures; ▲▼ compare with your plan as it is. Money in ${unitLabel()}.`),
        h('button', { type: 'button', class: 'btn small', id: 'cmpKeep', disabled: kept, onclick: () => {
          for (const o of opts) if (!ws.scenarios.some(s => s.name === name(o))) ws.scenarios.push({ id: E.uid(), name: name(o), plan: E.clonePlan(o.plan) });
          save();
          renderScenarioPicker();
          renderScenarios();
          toast(`Kept ${opts.length === 1 ? 'it' : `all ${opts.length}`} as scenarios in the table above.`);
        } }, kept ? 'Kept as scenarios' : 'Keep as scenarios')));
    }, 30);
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
    return [dateRow, ...rvRows('accounts', d.plan.accounts.filter(a => !RV.notYet(d.plan, a, 0)), {
      expLabel: 'Estimate',
      note: a => [d.readings && d.readings[a.id] ? h('small', { class: 'rv-note' }, `From your update on ${fmtDate(d.readings[a.id].date)}`) : null, rvSplit(a)],
      tag: a => (a.excluded ? 'Not counted' : ACCOUNT_LABELS[a.type]),
      color: a => TYPE_COLOR[a.type],
      lowerIsBetter: a => a.type === 'debt',
      nowLabel: a => (a.type === 'debt' ? 'Owed now' : a.type === 'property' ? 'Worth now' : 'Balance now'),
      extra: debtExtra,
    }), rvReserves()];
  }

  // How the plan expected an account to split on the review date: each pot set aside, and the rest.
  function rvSplit(a) {
    const d = rv.draft, o = d.original;
    const pots = E.reservesAt(o, RV.yearsBetween(E.asOfDate(o), d.date)).filter(r => r.accountId === a.id && r.held >= 0.5);
    if (!pots.length) return null;
    const exp = d.expected.accounts[a.id] || 0;
    const held = pots.reduce((acc, r) => acc + r.held, 0);
    return h('small', { class: 'rv-note rv-split' }, glyph('lock'), `Expected: ${pots.map(r => `${r.name} ${money(r.held)}`).join(' + ')} + free ${money(Math.max(0, exp - held))}`);
  }

  // Money set aside, as it actually went: what is in the emergency fund, what has been put aside
  // for each cost, and how much of each budget was spent (the rest kept for next year or freed up).
  function rvReserves() {
    const d = rv.draft, o = d.original;
    if (!(o.reserves || []).length) return null;
    const list = E.reservesAt(o, RV.yearsBetween(E.asOfDate(o), d.date));
    const lastYear = d.years > 0 ? E.reservesAt(o, 0) : [];
    const input = id => d.reserveInputs[id] || {};
    const set = (id, values) => { RV.setReserve(d, id, values); rv.evals = null; updateReviewNote(); };
    const seg = (id, key, opts, label) => h('div', { class: 'seg mini', role: 'group', 'aria-label': label }, opts.map(([v, l]) => h('button', {
      type: 'button', 'aria-pressed': String(input(id)[key] === v),
      onclick: e => { set(id, { [key]: v }); for (const x of e.currentTarget.parentElement.children) x.setAttribute('aria-pressed', String(x === e.currentTarget)); },
    }, l)));
    const rows = list.map(r => {
      const where = accountName(r.accountId) ? ` in ${accountName(r.accountId)}` : '';
      if (r.kind === 'emergency') {
        return h('div', { class: 'rv-reserve', 'data-reserve': r.id },
          h('div', { class: 'rv-name' }, h('strong', {}, r.name), h('span', { class: 'muted' }, `The plan kept ${money(r.amount)}${where}.`)),
          field('In the emergency fund now', moneyInputPlain(() => input(r.id).amount, v => set(r.id, { amount: v }), `${r.name} now`), 'Whatever you count as untouchable. From now on it rises with prices.'));
      }
      if (r.kind === 'saving') {
        return h('div', { class: 'rv-reserve', 'data-reserve': r.id },
          h('div', { class: 'rv-name' }, h('strong', {}, r.name), h('span', { class: 'muted' }, r.dueYear ? `The plan expected ${money(r.amount)} put aside${where}, towards ${money(r.target)} in ${r.dueYear}.` : 'No planned cost ahead.')),
          r.dueYear ? field('Put aside so far', moneyInputPlain(() => input(r.id).saved, v => set(r.id, { saved: v }), `${r.name} put aside so far`), 'It builds up from here to the full amount by when it is due.') : null);
      }
      const last = lastYear.find(x => x.id === r.id);
      if (!last) return null;
      return h('div', { class: 'rv-reserve', 'data-reserve': r.id },
        h('div', { class: 'rv-name' }, h('strong', {}, `${r.name} ${o.startYear}`), h('span', { class: 'muted' }, `${money(last.amount)} budgeted${last.left ? `, with ${money(last.left)} kept from the year before` : ''}${where}. The plan counted it all as spent.`)),
        field('How much did you spend?', moneyInputPlain(() => input(r.id).spent, v => set(r.id, { spent: v }), `${r.name} spent`), 'What is left is still in the account, so it is part of the balance above.'),
        h('div', { class: 'field' }, h('span', {}, 'What is left'),
          seg(r.id, 'keep', [[true, 'Keep it for next year'], [false, 'Free it up to invest']], `What to do with what is left of ${r.name}`)));
    }).filter(Boolean);
    if (!rows.length) return null;
    return h('div', { class: 'rv-reserves', id: 'rvReserves' },
      h('h3', {}, 'Money set aside'),
      h('p', { class: 'hint' }, 'How it actually went this year. This explains part of any difference in the balances above: money not spent stays in the account.'),
      rows);
  }

  function rvIncome() {
    $('#rvIntro').textContent = 'Pay, rent and other income as it is now. Enter the same kind of figure as before (take-home or before tax), per month or per year as shown.';
    const per = it => (it.freq === 'month' ? 'a month' : 'a year');
    return rvRows('income', rv.draft.plan.income, {
      tag: it => (it.kind === 'dbpension' ? (inPayment(it, rv.draft.plan) ? 'Being paid, a year' : 'Built up so far') : `${KIND_LABELS.find(k => k[0] === it.kind)[1]}, ${per(it)}`),
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
  function divergingBars(rows, baseLabel, opts = {}) {
    const max = Math.max(1, ...rows.map(r => Math.abs(r.diff)));
    const bars = h('div', { class: 'divbars', role: 'list' }, rows.map(r => {
      const pos = r.diff >= 0;
      const flat = Math.abs(r.diff) < 5; // rounding noise: on plan
      const w = flat ? 0 : Math.max(0.5, (Math.abs(r.diff) / max) * 50);
      const sign = flat ? 'On plan' : `${pos ? '+' : '−'}${fmtCompact(Math.abs(r.diff))}`;
      return h('div', { class: 'divbar' + (r.why ? ' has-why' : ''), role: 'listitem', tabindex: '0', title: r.why ? `${r.label}: ${r.why}` : `${r.label}: ${baseLabel} ${money(r.base)}, actual ${money(r.actual)}${r.type === 'debt' ? ' (owed)' : ''}` },
        h('span', { class: 'db-label' }, r.type === 'debt' ? `${r.label} (less owed = +)` : r.label, r.why ? h('small', { class: 'db-why' }, r.why) : null),
        h('span', { class: 'db-track' }, h('span', { class: 'db-mid' }), h('span', { class: `db-bar ${pos ? 'pos' : 'neg'}`, style: `${pos ? 'left' : 'right'}:50%;width:${w}%` })),
        h('span', { class: `db-val${flat ? ' flat' : ''}` }, sign));
    }));
    const signed = r => ({ text: `${r.diff >= 0 ? '+' : '−'}${money(Math.abs(r.diff))}`, cls: r.diff >= 0 ? 'pos' : 'neg' });
    const tbl = opts.why
      ? table(['', 'Difference', 'Why'], rows.map(r => ({ cells: [r.label, signed(r), r.why || ''] })))
      : table(['', baseLabel, 'Actual', 'Difference'], rows.map(r => ({ cells: [r.label, money(r.base), money(r.actual), signed(r)] })));
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
      rvExplain(),
      h('details', { class: 'more rv-bytype' }, h('summary', {}, 'By type of account'),
        h('h3', { class: 'chart-title' }, v.mode === 'prediction' ? 'What made the difference (actual minus prediction)' : v.mode === 'lastYear' ? `Change since your ${d.prev.year} check-in (no breakdown was saved with that prediction)` : 'Difference from what the plan expected'),
        divergingBars(v.rows, baseLabel)),
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

  // Why net worth is not what the plan expected on the review date, in parts that add up, with one
  // optional question (what was paid into ISAs and investments) to split markets from saving.
  function rvExplain() {
    const d = rv.draft;
    const box = h('div', { class: 'rv-explain', id: 'rvExplain' });
    const draw = () => {
      const x = RV.explain(d);
      const rows = x.parts.map(p => ({ ...p, why: p.why.replace(/\{(\w+)\}/g, (m, k) => (k in p.values ? money(p.values[k]) : m)) }));
      const ahead = x.total >= 0;
      const lead = Math.abs(x.total) < 50 ? 'Right where the plan expected.'
        : `${money(Math.abs(x.total))} ${ahead ? 'ahead of' : 'behind'} the plan’s estimate for ${fmtDate(d.date)} (${money(x.expected)})${rows[0] ? `. The biggest part: ${rows[0].label.toLowerCase()}` : ''}.`;
      setKids(box,
        h('h3', { class: 'chart-title' }, 'Why you are where you are'),
        h('p', { class: 'rv-lead' }, lead),
        rows.length ? divergingBars(rows, '', { why: true }) : null,
        h('p', { class: 'hint' }, 'The parts add up to the difference. Markets can only be split from what you put in if you say how much that was.'));
    };
    const ask = field('Paid into ISAs and investments since your last figures (optional)',
      (() => {
        const input = h('input', { type: 'text', inputmode: 'decimal', id: 'rvPaidIn', value: d.paidIn == null ? '' : plain(d.paidIn), placeholder: 'Not sure? Leave it empty', 'aria-label': 'Paid into ISAs and investments' });
        input.addEventListener('input', () => { d.paidIn = input.value.trim() === '' ? null : parseAmount(input.value); draw(); });
        return h('div', { class: 'adorn has-pre' }, h('span', { class: 'pre' }, '£'), input);
      })(),
      `Everything you put in (minus anything taken out) since ${fmtDate(E.asOfDate(d.original))}; your ISA provider shows it as contributions. The plan expected about ${money(RV.explain(d).expectedPaidIn)}. Workplace pensions are left out: they come from pay.`);
    draw();
    return h('div', { class: 'rv-explain-wrap' }, box, h('div', { class: 'fields rv-paidin' }, ask));
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
          return { cells: [g.title, was ? pct(was.probability) : '—', pct(g.probability), was ? deltaCell(Math.round(was.probability * 100), Math.round(g.probability * 100), (x, y) => x > y, (x, y) => `${Math.abs(x - y)} points`) : '—'] };
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
      schedule();
    });
    // Redraw the section once the number is finished (leaving the field or Enter), not on every
    // key: redrawing while typing would take the cursor away after the first digit.
    if (opts.rerender) input.addEventListener('change', () => { redrawWhenLeft(input, opts.rerender); schedule(); });
    if (!opts.suffix) return input;
    return h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, opts.suffix));
  }

  function selectInput(options, get, set, opts = {}) {
    return h('select', {
      'aria-label': opts.label, disabled: opts.disabled,
      onchange: e => { set(e.target.value); if (opts.rerender) redrawKeepFocus(opts.rerender); schedule(); },
    }, options.map(([v, l]) => h('option', { value: v, selected: String(get()) === String(v) }, l)));
  }

  function switchInput(label, get, set, opts = {}) {
    return h('label', { class: 'switch' }, h('input', {
      type: 'checkbox', checked: !!get(), role: 'switch',
      onchange: e => { set(e.target.checked); if (opts.rerender) renderSection(opts.rerender); if (opts.after) opts.after(); schedule(); },
    }), label);
  }

  const bind = (obj, key) => [() => obj[key], v => { obj[key] = v; }];
  // An account's owner; a name that starts with the old owner's name ("Sam ISA") follows the new
  // owner ("Alex ISA"), so a copied or suggested name is not left pointing at the wrong person.
  const ownerBind = a => [() => a.owner, v => {
    const was = people().find(x => x.id === a.owner), now = people().find(x => x.id === v);
    if (was && now && a.name.startsWith(`${was.name} `)) a.name = `${now.name}${a.name.slice(was.name.length)}`;
    a.owner = v;
  }];

  // What the NI record gives: the years by State Pension age, and the share of the forecast.
  function niText(x) {
    const y = E.spYears(x);
    if (!y.known) return 'From “Check your National Insurance record” on gov.uk. With it, Horizon works out what stopping work early does to the State Pension (the forecast assumes you keep paying NI until State Pension age). Years worked in the EU, or another country with a UK agreement, can help reach the 10-year minimum but do not add to the amount; that country may pay its own pension.';
    const sp = money(x.statePension * y.share);
    if (y.projected < R.NI_YEARS.min) return `${y.projected} years by State Pension age: under the ${R.NI_YEARS.min} needed for any State Pension.`;
    return y.missing > 0
      ? `Stopping work at ${x.retireAge} gives ${y.projected} of ${y.forecast} years, so about ${sp} a year (today’s money) instead of the forecast ${money(x.statePension)}. Voluntary NI after stopping can fill the ${y.missing} missing year${y.missing === 1 ? '' : 's'}.`
      : `${y.projected} years by State Pension age${y.voluntary ? `, ${y.voluntary} of them voluntary (paid in the plan from ${x.retireAge})` : ''}: the full forecast, ${sp} a year.`;
  }

  // The State Pension a year or a week (as letters give it); each fills in the other.
  function statePensionInput(x) {
    const year = moneyInput(() => Math.round(x.statePension * 100) / 100, v => { x.statePension = v; week.querySelector('input').value = (v / 52).toFixed(2); }, { label: 'State Pension a year' });
    const week = moneyInput(() => Math.round(x.statePension / 52 * 100) / 100, v => { x.statePension = Math.round(v * 52 * 100) / 100; year.querySelector('input').value = x.statePension.toLocaleString('en-GB'); }, { label: 'State Pension a week' });
    return h('div', { class: 'sp-pair' }, h('span', {}, year, h('small', {}, 'a year')), h('span', {}, week, h('small', {}, 'a week')));
  }

  function ownerOptions(includeJoint) {
    const o = people().map(p => [p.id, p.name]);
    if (includeJoint && people().length > 1) o.push(['joint', 'Joint']);
    return o;
  }

  function timingControl(item, which, sectionId) {
    const refKey = which === 'start' ? 'startRef' : 'endRef';
    const ageKey = which === 'start' ? 'startAge' : 'endAge';
    const yearKey = which === 'start' ? 'fromYear' : 'toYear';
    const opts = which === 'start'
      ? [['now', 'Now'], ['retire', 'At retirement'], ['age', 'At age…'], ['year', 'In year…']]
      : [['retire', 'At retirement'], ['end', 'End of plan'], ['age', 'At age…'], ['year', 'Stops in year…']];
    const sel = selectInput(opts, () => item[refKey], v => {
      item[refKey] = v;
      if (v === 'year' && !item[yearKey]) item[yearKey] = plan().startYear + (which === 'start' ? 1 : 5);
    }, { rerender: sectionId, label: which === 'start' ? 'Starts' : 'Ends' });
    if (item[refKey] === 'year') {
      const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
      const say = () => (which === 'start'
        ? (item.fromMonth > 1 ? `First paid in ${MONTHS[item.fromMonth - 1]} ${item.fromYear}: ${13 - item.fromMonth} months that year.` : `First paid in ${item.fromYear}.`)
        : (item.toMonth > 0 ? `Paid to the end of ${MONTHS[item.toMonth - 1]} ${item.toYear}: ${item.toMonth} month${item.toMonth === 1 ? '' : 's'} that year.` : `Not paid in ${item.toYear}: ${item.toYear - 1} is the last year.`));
      const note = h('small', { class: 'hint' }, say());
      const num = numInput(...bind(item, yearKey), { label: which === 'start' ? 'First year' : 'Year it stops', min: 1950, max: 2150, step: 1 });
      (num.tagName === 'INPUT' ? num : num.querySelector('input')).addEventListener('input', () => { note.textContent = say(); });
      const month = which === 'start'
        ? h('select', { 'aria-label': 'First month', onchange: e => { item.fromMonth = +e.target.value; note.textContent = say(); schedule(); } }, MONTHS.map((m, k) => h('option', { value: String(k + 1), selected: item.fromMonth === k + 1 }, m)))
        : h('select', { 'aria-label': 'Last month paid', onchange: e => { item.toMonth = +e.target.value; note.textContent = say(); schedule(); } },
          [h('option', { value: '0', selected: !(item.toMonth > 0) }, 'Not at all that year'), ...MONTHS.map((m, k) => h('option', { value: String(k + 1), selected: item.toMonth === k + 1 }, `To the end of ${m}`))]);
      return h('div', { class: 'timing-year' }, h('div', { class: 'pair' }, sel, num), month, note);
    }
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

  // Money coming in and going out, year by year (expected path, nominal; D() for the view).
  function inOutSeries() {
    const p = plan();
    const rows = model.proj.rows.slice(0, -1);
    const infl = p.assumptions.inflation / 100;
    return rows.map((r, t) => {
      const employee = Math.max(0, r.saved - (r.extraPension || 0) - r.toCash - r.toIsa - r.toGia - (r.toLisa || 0) - (r.toPension || 0) - (r.sharesKept || 0));
      // Income after its tax; tax on money taken from savings and pensions is part of what they pay.
      // Share awards kept as shares are saved, not cash to spend.
      const inn = r.earnings + r.otherIncome + r.statePension - (r.taxes - (r.withdrawTax || 0)) - employee - (r.extraPension || 0) - (r.sharesKept || 0);
      // One-off costs, including the deposit on a home bought that year.
      const oneOff = p.events.filter(e => e.kind === 'expense' && e.year === r.year).reduce((acc, e) => acc + e.amount * Math.pow(1 + infl, t), 0) + (r.homeBuy || 0);
      const listed = Math.max(0, r.spending - oneOff);
      const life = Math.min(listed, p.expenses.filter(e => (e.key || '').startsWith('life:')).reduce((acc, e) => acc + E.streamAt(e, p, t), 0));
      return { year: r.year, t, inn, everyday: listed - life, future: life, oneOff, mortgage: r.debtRegular + r.lumpOverpay, left: inn - r.spending - r.debtRegular - r.lumpOverpay };
    });
  }

  // Where every pound goes, year by year (expected path, nominal): tax, spending, the mortgage and
  // each kind of saving. Take-home pay is grossed up to estimate the tax and NI already taken from it,
  // so the stack adds up to what comes in before tax; above that line, savings pay the difference.
  function flowSeries() {
    const p = plan(), pre = model.proj.pre;
    return model.proj.rows.slice(0, -1).map((r, t) => {
      const g = r.thresholdFactor || 1;
      const payTax = p.household.ignoreTax ? 0 : pre.people.reduce((acc, P) => acc + (P.netPay[t] > 0 ? Math.max(0, R.grossFromTakeHome(P.netPay[t] / g, p.household.region) * g - P.netPay[t]) : 0), 0);
      const employee = Math.max(0, r.saved - (r.extraPension || 0) - r.toCash - r.toIsa - r.toGia - (r.toLisa || 0) - (r.toPension || 0) - (r.sharesKept || 0));
      return {
        year: r.year, t,
        // Pension contributions from outside pay (employer, tax relief) count as coming in.
        inn: r.earnings + r.otherIncome + r.statePension + payTax + (r.pensionIn - employee - (r.toPension || 0)),
        tax: r.taxes + payTax, payTax, spending: r.spending, mortgage: r.debtRegular + r.lumpOverpay, overpay: r.overpay + (r.hiDebtPay || 0),
        pension: r.pensionIn, lisa: r.toLisa || 0, isa: r.toIsa, gia: r.toGia + (r.sharesKept || 0), cash: r.toCash, fromSavings: r.withdrawals,
      };
    });
  }

  function renderInOut() {
    const box = $('#ovInOut');
    if (!box) return;
    const s = inOutSeries();
    const now = s[0];
    const xs = s.map(x => x.year);
    // Actual pounds of each year unless you choose today's money (costs then rise with prices, as in a spreadsheet).
    const todays = !!ws.settings.inOutReal;
    const D = (val, t) => (todays ? val / model.proj.pre.deflator[t] : val);
    const v = f => s.map(x => D(f(x), x.t));
    const all = ws.settings.inOutView === 'all';
    const fl = all ? flowSeries() : null;
    const fv = f => fl.map(x => D(f(x), x.t));
    const areas = all ? [
      { label: 'Tax & NI', color: '--s7', values: fv(x => x.tax) },
      { label: 'Spending', color: '--s5', values: fv(x => x.spending) },
      { label: 'Mortgage & loans', color: '--s8', values: fv(x => x.mortgage + x.overpay) },
      { label: 'Pensions', color: '--s4', values: fv(x => x.pension) },
      { label: 'ISAs', color: '--s2', values: fv(x => x.isa + x.lisa) },
      { label: 'General account', color: '--s3', values: fv(x => x.gia) },
      { label: 'Cash savings', color: '--s1', values: fv(x => x.cash) },
    ].filter(a => a.values.some(y => y > 0.5)) : [
      { label: 'Everyday spending', color: '--s5', values: v(x => x.everyday) },
      { label: 'Future costs', color: '--s7', values: v(x => x.future) },
      { label: 'One-off costs', color: '--s3', values: v(x => x.oneOff) },
      { label: 'Mortgage & loans', color: '--s8', values: v(x => x.mortgage) },
    ].filter(a => a.values.some(y => y > 0.5));
    const inn = all ? fv(x => x.inn) : v(x => x.inn);
    const p = plan();
    const markers = p.events.filter(e => e.kind === 'expense' && e.year >= xs[0] && e.year <= xs[xs.length - 1]).map(e => ({ x: e.year, label: e.name, color: '--s3' }));
    const debtEnd = s.find((x, i) => i > 0 && s[0].mortgage > 0.5 && x.mortgage <= 0.5);
    if (debtEnd) markers.push({ x: debtEnd.year, label: `No more ${debtWord()} payments`, color: '--s8' });
    for (const x of people()) { const y = p.startYear + x.retireAge - x.age; if (y <= xs[xs.length - 1]) markers.push({ x: y, label: `${people().length > 1 ? `${x.name} retires` : 'Retire'}`, color: '--muted' }); }
    const m = x => money(x / 12);
    const out0 = now.everyday + now.future + now.oneOff + now.mortgage;
    const mp = model.monthly;
    const goes = [['Lifetime ISAs', mp.lisa], ['ISAs', mp.isa], ['Pensions, with relief', mp.toPension], ['General account', mp.gia], ['Mortgage overpayments', mp.overpay], ['Cash buffer', mp.cash]].filter(x => x[1] > 0.5);
    const rows0 = model.proj.rows;
    const dEnd = rows0.findIndex((r, t) => t > 0 && rows0[0].debt > 0.5 && r.debt <= 0.5);
    const later = dEnd > 0 && dEnd < rows0.length - 1 ? rows0[dEnd] : null;
    const laterSave = later ? (later.toIsa + later.toGia + (later.toLisa || 0) + (later.toPension || 0) + later.overpay + later.toCash) / 12 / later.deflator : 0;
    const host = h('div', { class: 'chart', id: 'ovInOutChart' });
    setKids(box,
      h('div', { class: 'card-head' }, h('div', {}, h('h2', {}, 'Money in and out'),
        h('p', { class: 'sub' }, all
          ? `Where every pound goes, year by year on average: everything that comes in before tax, pension contributions included (the line), split into tax, spending, the mortgage and what is saved where (the stack). Saving rises once the mortgage is paid off; where the stack is above the line, savings pay the difference. ${fl.some(x => x.payTax > 0.5) ? 'Tax on take-home pay is estimated from the take-home figure. ' : ''}`
          : `This month, and over the years on average: what comes in after tax and pension contributions (the line) against what goes out (the stack). Above the stack is what is left to save; below it, savings pay the difference. `,
          todays ? h('strong', {}, `In today’s money: costs that only keep up with prices (${plan().assumptions.inflation}% a year) stay level.`)
            : h('strong', {}, `In the actual pounds of each year: spending rises with prices (${plan().assumptions.inflation}% a year), as in a spreadsheet.`))),
        h('div', { class: 'controls' }, h('div', { class: 'seg mini', role: 'group', 'aria-label': 'Show' },
          [['spend', 'Spending'], ['all', 'Where it all goes']].map(([val, label]) => h('button', { type: 'button', 'aria-pressed': String((all ? 'all' : 'spend') === val), 'data-view': val,
            onclick: () => { ws.settings.inOutView = val; save(); renderInOut(); } }, label))),
          h('div', { class: 'seg mini', role: 'group', 'aria-label': 'Show amounts in' },
          [[false, 'Actual £ each year'], [true, 'Today’s money']].map(([val, label]) => h('button', { type: 'button', 'aria-pressed': String(todays === val), 'data-io': val ? 'today' : 'actual',
            onclick: () => { ws.settings.inOutReal = val; save(); renderInOut(); } }, label))))),
      h('div', { class: 'io-sum' },
        h('div', { class: 'io-fig in' }, h('span', {}, 'Coming in'), h('strong', {}, m(now.inn)), h('small', {}, 'a month, after tax')),
        h('div', { class: 'io-fig out' }, h('span', {}, 'Going out'), h('strong', {}, m(out0)), h('small', {}, [now.mortgage > 0.5 ? `incl. ${m(now.mortgage)} ${debtWord() === 'mortgage' ? 'mortgage' : 'loan payments'}` : null, now.oneOff > 0.5 ? `${m(now.oneOff)} one-offs` : null].filter(Boolean).join(', ') || 'spending')),
        h('div', { class: `io-fig left ${now.left >= 0 ? 'pos' : 'neg'}` }, h('span', {}, now.left >= 0 ? 'Left to save' : 'From savings'), h('strong', {}, m(Math.abs(now.left))),
          goes.length && now.left >= 0 ? h('ul', { class: 'io-goes' }, goes.map(([k, v]) => h('li', {}, h('span', {}, k), h('b', {}, money(v))))) : h('small', {}, 'a month'),
          later && laterSave > 0.5 ? h('small', {}, `From ${later.year}, ${debtWord()} paid off: about ${money(laterSave)} a month`) : null,
          h('button', { type: 'button', class: 'linkish', onclick: () => navigate('finances/saving') }, 'Set your amounts')),
        mp.pension > 0.5 ? h('div', { class: 'io-fig pen' }, h('span', {}, 'Into pensions'), h('strong', {}, money(mp.pension)), h('small', {}, 'a month through payroll, you and your employer')) : null),
      suggestedSplitCard(),
      host,
      h('div', { class: 'legend', id: 'ovInOutLegend' }));
    const c = new Chart(host, { height: 260, label: 'Money coming in and going out by year', name: 'money-in-out' });
    c.set({
      xs, areas, markers,
      lines: [{ label: all ? 'Coming in before tax' : 'Coming in', color: '--text', values: inn }],
      tooltip: all ? i => {
        const x = fl[i];
        const saved = x.pension + x.lisa + x.isa + x.gia + x.cash + x.overpay;
        return {
          title: titleAt(i),
          rows: [
            { label: 'Coming in before tax', color: '--text', shape: 'line', text: `${money(inn[i] / 12)} a month`, strong: true },
            ...areas.filter(a => a.values[i] > 0.5).map(a => ({ label: a.label, color: a.color, text: `${money(a.values[i] / 12)} a month` })),
            saved > 0.5 ? { label: 'Saved in all', text: `${money(D(saved, x.t) / 12)} a month (${Math.round((saved / Math.max(1, x.inn)) * 100)}% of what comes in)` } : null,
            x.fromSavings > 0.5 ? { label: 'From savings', text: `${money(D(x.fromSavings, x.t) / 12)} a month` } : null,
          ].filter(Boolean),
        };
      } : i => ({
        title: titleAt(i),
        rows: [
          { label: 'Coming in', color: '--text', shape: 'line', text: `${money(inn[i] / 12)} a month`, strong: true },
          ...areas.filter(a => a.values[i] > 0.5).map(a => ({ label: a.label, color: a.color, text: `${money(a.values[i] / 12)} a month` })),
          { label: s[i].left >= 0 ? 'Left to save' : 'From savings', text: `${money(Math.abs(D(s[i].left, s[i].t)) / 12)} a month` },
          todays && i > 0 ? { label: `Going out in ${xs[i]} pounds`, text: `${money((s[i].everyday + s[i].future + s[i].oneOff + s[i].mortgage) / 12)} a month` } : null,
        ].filter(Boolean),
      }),
      table: all ? () => ({
        headers: ['Year', 'Coming in before tax', 'Tax & NI', 'Spending', 'Mortgage', 'Overpaying', 'Pensions', 'Lifetime ISAs', 'ISAs', 'General account', 'Cash', 'From savings'],
        rows: fl.map(x => [x.year, ...[x.inn, x.tax, x.spending, x.mortgage, x.overpay, x.pension, x.lisa, x.isa, x.gia, x.cash, x.fromSavings].map(val => D(val, x.t))]),
        formats: [String, ...Array(11).fill(money)],
      }) : () => ({
        headers: ['Year', 'Coming in', 'Everyday spending', 'Future costs', 'One-off costs', 'Mortgage', 'Left (− from savings)'],
        rows: s.map(x => [x.year, D(x.inn, x.t), D(x.everyday, x.t), D(x.future, x.t), D(x.oneOff, x.t), D(x.mortgage, x.t), D(x.left, x.t)]),
        formats: [String, money, money, money, money, money, money],
      }),
    });
    legend($('#ovInOutLegend'), [{ label: all ? 'Coming in before tax' : 'Coming in', color: '--text', shape: 'line' }, ...areas.map(a => ({ label: a.label, color: a.color }))], c);
  }

  // A suggested way to split what is left each month, in the usual UK order for this household:
  // an emergency fund first, then pension where it gets higher-rate relief, Lifetime ISAs, ISAs.
  // A person's income for tax this year as the projection has it: pay after salary sacrifice and
  // pension contributions, other taxable income, take-home pay grossed up, less personal pension
  // contributions. The figure the tax bands, the £100k line and the Child Benefit charge use.
  // Adjusted net income in year t, as the projection has it (after salary sacrifice, including
  // what "Keep income under £100,000" sacrifices), in that year's pounds; and the £100k line then.
  function aniAt(i, t) {
    const pre = model.proj.pre, P = pre.people[i], g = pre.g[t];
    const fromNet = P.netPay[t] > 0 ? R.grossFromTakeHome(P.netPay[t] / g, plan().household.region) * g : 0;
    return { ani: Math.max(0, P.taxable[t] + fromNet - (P.extraPot[t] || 0)), line: R.PA_TAPER_START * g };
  }
  // When the £60,000 annual allowance stops pay from coming under £100k: what is still over.
  function over100kText(x, i, t) {
    const { ani } = aniAt(i, t);
    const line = (E.stayUnderLine(plan().strategy) || R.PA_TAPER_START) * model.proj.pre.g[t];
    if (ani <= line + 100) return '';
    const g = model.proj.pre.g[t];
    return ` It only gets ${x.name} to about ${money(ani / g)} of income (today’s thresholds): the ${money(R.PENSION_ANNUAL_ALLOWANCE)} annual allowance caps what can go into a pension. Unused allowance from the last 3 years can be carried forward for a year or two (not in the plan).`;
  }

  function incomeForTax(p, x) {
    const P = model && model.proj && model.proj.pre.people[E.personIndex(p, x.id)];
    if (!P) return 0;
    const fromNet = P.netPay[0] > 0 ? R.grossFromTakeHome(P.netPay[0], p.household.region) : 0;
    return Math.max(0, P.taxable[0] + fromNet - (P.extraPot[0] || 0));
  }

  // Pay taxed at 40% or more, and what paying it into a pension saves: `over` a year from where
  // that band starts; `rates` such as "42%" or "42–45%" (the top slice can be in a higher band);
  // `costOf(m)` the take-home a month that m a month into the pension costs (income tax only).
  function higherRelief(p, x) {
    const region = p.household.region, gross = incomeForTax(p, x);
    const tax = v => R.incomeTax(Math.max(0, v), region);
    const rate = v => (tax(v + 100) - tax(v)) / 100;
    if (!gross || rate(gross) < 0.4) return null;
    let lo = 0, hi = gross;
    for (let k = 0; k < 30; k++) { const mid = (lo + hi) / 2; if (rate(mid) >= 0.4) hi = mid; else lo = mid; }
    const low = Math.round(rate(hi + 150) * 100), top = Math.round(rate(gross) * 100);
    // What the annual allowance still has room for this year, after what already goes in.
    const P = model.proj.pre.people[E.personIndex(p, x.id)];
    const room = Math.max(0, R.PENSION_ANNUAL_ALLOWANCE - P.contrib[0] - (P.extraPot[0] || 0));
    const band = Math.max(0, gross - hi);
    return {
      gross, band, room, capped: room < band - 1, over: Math.min(band, room), rates: low === top ? `${top}%` : `${low}–${top}%`,
      costOf: m => m - (tax(gross) - tax(gross - m * 12)) / 12,
      drawn: region === 'scotland' ? '21%' : '20%',
    };
  }

  // A line someone keeps their pay just under: the Child Benefit charge (with children) or the
  // £100k trap. Within £1,500 of it, the split does not push more pension (they chose the line).
  function payLine(p, x, gross) {
    const kids = ((p.life && p.life.children) || []).some(c => c.age < 18)
      || p.income.some(i => /child benefit/i.test(i.name || ''));
    const lines = [...(kids ? [[R.CHILD_BENEFIT.chargeFrom, 'where the Child Benefit charge starts']] : []), [R.PA_TAPER_START, 'where the personal allowance starts to go']];
    const hit = lines.find(([v]) => gross <= v + 1 && v - gross < 1500);
    return hit ? { value: hit[0], why: hit[1] } : null;
  }

  // The emergency step: the household's own emergency-fund goal when there is one (cash, or cash
  // and investments), else 3 months of spending and mortgage payments in the cash buffer.
  function emergencyStep(p, proj) {
    const r0 = proj.rows[0];
    const goal = p.goals.find(g => g.type === 'emergency');
    if (goal) {
      const need = E.emergencyNeed(goal, proj.pre, r0.debtRegular, 0), have = E.emergencyHave(goal, r0);
      return { need, short: Math.max(0, need - have), months: goal.months, investments: goal.counts === 'investments' };
    }
    const need = 3 * (r0.spending + r0.debtRegular) / 12;
    return { need, short: Math.max(0, need - p.strategy.cashReserve), months: 3, investments: false };
  }

  function suggestedSplit() {
    const p = plan(), r0 = model.proj.rows[0];
    let left = inOutSeries()[0].left / 12;
    if (left <= 1) return null;
    const all = left;
    const out = [], options = [];
    // Amounts under £25 a month are left for the ISAs rather than listed.
    const take = (key, label, want, note, extra) => { const x = Math.max(0, Math.min(left, want)); if (x >= 25) { out.push({ key, label, amount: x, note, ...extra }); left -= x; } };
    const em = emergencyStep(p, model.proj);
    // In cash: build it up over a year. Counting ISAs: the ISA line below builds it.
    if (em.short > 0.5 && !em.investments) take('cash', 'Emergency fund', em.short / 12, `cash until it covers ${em.months} months (${money(em.need)})`);
    for (const x of people()) {
      if (p.household.ignoreTax || x.retireAge <= x.age) continue;
      const hr = higherRelief(p, x);   // income after salary sacrifice and pension contributions
      if (!hr) continue;
      const over = hr.over / 12;                     // a month of pay taxed at 40% or more
      const cost = hr.costOf(over);                  // what putting it all in costs from take-home pay
      const line = payLine(p, x, hr.gross);
      if (line) {
        // Pay kept just under a line: more pension is an option, not the first thing to do.
        options.push(`${x.name}’s pay is at ${money(line.value)}, ${line.why}. More pension would still get ${hr.rates} relief, on up to ${money(over)} a month.`);
        continue;
      }
      // At most half of what is left, so some stays within reach before pensions can be drawn.
      const pen = Math.min(cost, all / 2);
      let a = 0, b = over;                           // what that amount of take-home puts in
      for (let k = 0; k < 30; k++) { const mid = (a + b) / 2; if (hr.costOf(mid) < pen) a = mid; else b = mid; }
      // The amount shown is take-home pay; with the relief more goes into the pension.
      take(`pension-${x.id}`, `Pension for ${x.name}`, pen, `of take-home pay puts about ${money(a)} into the pension, with ${hr.rates} relief${pen < cost - 1 ? `. Putting in all ${money(over)} a month taxed at that rate would cost ${money(cost)} of take-home` : ''}`, { person: x.id });
    }
    for (const x of people()) {
      const has = p.accounts.some(a => a.type === 'lisa' && a.owner === x.id && !a.excluded);
      if (x.age >= 18 && (x.age < R.LISA.openBefore || has) && x.age < R.LISA.payUntil) take(`lisa-${x.id}`, `Lifetime ISA for ${x.name}`, R.LISA.maxContribution / 12, `+25% bonus; for a first home, or from 60`, { person: x.id });
    }
    const names = people().map(x => x.name).join(' and ');
    take('isa', people().length > 1 ? `Stocks & shares ISAs (${names})` : 'Stocks & shares ISA', left,
      `tax-free, available any time${em.investments ? (em.short > 0.5 ? `; first builds your emergency fund (${money(em.short)} short of ${em.months} months)` : '; also your emergency fund') : ''}`);
    return { parts: out, options, all };
  }

  // Where the plan puts what is left this month: "ISAs", "ISAs and the mortgage".
  function whereItGoes() {
    const m = E.monthlyPlan(model.proj);
    const list = [[m.isa, 'ISAs'], [m.lisa, 'Lifetime ISAs'], [m.toPension, 'pensions'], [m.gia, 'a general investment account'], [m.overpay, 'mortgage overpayments'], [m.hiDebt, 'paying off debts'], [m.cash, 'cash']]
      .filter(([v]) => v >= 25).sort((x, y) => y[0] - x[0]).map(([, label]) => label);
    return list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}` : list[0] || 'cash';
  }

  function suggestedSplitCard() {
    const split = suggestedSplit();
    if (!split || !split.parts.length) return null;
    const { parts, options, all } = split;
    const tryIt = () => {
      const q = E.clonePlan(plan());
      for (const x of parts) {
        if (x.key.startsWith('pension-')) q.household.people.find(y => y.id === x.person).extraPension = Math.round(x.amount);
        if (x.key.startsWith('lisa-') && !q.accounts.some(a => a.type === 'lisa' && a.owner === x.person)) {
          const who = q.household.people.find(y => y.id === x.person);
          q.accounts.push({ id: E.uid(), name: `${who.name} Lifetime ISA`, type: 'lisa', owner: who.id, balance: 0, contribution: R.LISA.maxContribution, purpose: 'retirement' });
        }
      }
      const name = `${scenario().name}: suggested split`;
      ws.scenarios = ws.scenarios.filter(sc => sc.name !== name);
      ws.scenarios.push({ id: E.uid(), name, plan: E.normalizePlan(q) });
      save();
      renderScenarioPicker();
      navigate('scenarios');
      toast(`Added “${name}”: compare it with your plan on every goal.`);
    };
    return h('div', { class: 'io-split', id: 'ioSplit' },
      h('div', { class: 'io-split-head' }, h('strong', {}, 'Another way to split it'),
        h('small', {}, `Your plan puts the ${money(all)} a month left over into ${whereItGoes()}. The usual UK order for your household would split the same ${money(all)} like this. Rules of thumb, not advice.`)),
      h('ol', {}, parts.map(x => h('li', {}, h('span', {}, h('b', {}, x.label), h('small', {}, x.note)), h('strong', {}, `${money(x.amount)}`)))),
      options.map(t => h('p', { class: 'io-split-option muted' }, t)),
      h('button', { type: 'button', class: 'btn small', onclick: tryIt }, 'Try it as a scenario'));
  }

  // ---- Finances: each item as a plain line; edit one at a time

  const editing = new Set();
  // A newly added item: scroll it into view and put the cursor in its name.
  function showNew(id) {
    requestAnimationFrame(() => {
      const box = document.querySelector(`[data-editing="${id}"]`);
      if (!box) return;
      box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const el = box.querySelector('input[type="text"], input');
      if (el) el.focus({ preventScroll: true });
    });
  }

  function openEdit(id, sectionId) { editing.add(id); renderSection(sectionId); requestAnimationFrame(() => { const el = document.querySelector(`[data-editing="${id}"] input, [data-editing="${id}"] select`); if (el) el.focus(); }); }
  function closeEdit(id, sectionId) { editing.delete(id); renderSection(sectionId); }

  // The line shown for an item, or its editor while it is being edited.
  function viewOrEdit(id, sectionId, color, line, editor) {
    if (editing.has(id)) {
      const body = editor();
      // Remove comes last, after Done, so tabbing through the fields never lands on it first.
      const remove = body.querySelector && body.querySelector('.item-head > .icon-btn[aria-label^="Remove"], .row-main > .icon-btn[aria-label^="Remove"]');
      if (remove) { remove.textContent = 'Remove'; remove.className = 'btn small ghost danger-text'; }
      return h('div', { class: 'edit-wrap', 'data-editing': id, style: `--item-color:${cssVar(color)}` }, body,
        h('div', { class: 'edit-done' }, h('button', { type: 'button', class: 'btn small primary', onclick: () => closeEdit(id, sectionId) }, 'Done'), remove));
    }
    return h('button', { type: 'button', class: 'sum-row', 'data-item': id, style: `--item-color:${cssVar(color)}`, 'aria-label': `Edit ${line.name}`, onclick: () => openEdit(id, sectionId) },
      h('i', { class: 'key square', style: `--key:${cssVar(color)}` }),
      h('span', { class: 'sum-name' }, h('strong', {}, line.name), line.sub ? h('small', {}, line.sub) : null),
      h('span', { class: 'sum-val' }, h('strong', {}, line.value), line.valueSub ? h('small', {}, line.valueSub) : null),
      h('span', { class: 'sum-edit', 'aria-hidden': 'true' }, glyph('edit')));
  }

  // A short summary strip at the top of a Finances section; it keeps up with edits on its own.
  const summaries = new Map();
  function sectionSummary(key, figs) {
    summaries.set(key, figs);
    const box = h('div', { class: 'sec-sum', id: `sum-${key}` });
    fillSummary(box, figs);
    return box;
  }
  function fillSummary(box, figs) {
    if (!model) return;
    setKids(box, ...figs().filter(Boolean).map(([label, value, sub]) => h('div', {}, h('span', {}, label), h('strong', {}, value), sub ? h('small', {}, sub) : null)));
  }
  function updateSummaries() {
    for (const [key, figs] of summaries) { const box = $(`#sum-${key}`); if (box) fillSummary(box, figs); }
  }

  const ownerName = (p, owner) => (owner === 'joint' ? (p.household.people.length > 1 ? 'Joint' : p.household.people[0].name) : (p.household.people.find(x => x.id === owner) || {}).name || '');
  // For a check-up item about a child (key "life:school-0"): "Maya, 11–18".
  function childAges(item, p) {
    const m = /^life:(school|private|uni)-(\d+)$/.exec(item.key || '');
    const c = m && p.life && (p.life.children || [])[+m[2]];
    if (!c) return null;
    const p1 = p.household.people[0], at = age => (c.age || 0) + (age - p1.age);
    const from = item.startRef === 'now' ? c.age : at(item.startAge);
    return `${c.name || `Child ${+m[2] + 1}`}, age ${Math.max(c.age || 0, from)}–${at(item.endAge)}`;
  }

  const untilText = (item, p) => {
    const kid = childAges(item, p);
    if (kid) return kid;
    const person = p.household.people[E.personIndex(p, item.owner === 'joint' ? 'p1' : item.owner)];
    const end = item.endRef === 'retire' ? 'until retirement' : item.endRef === 'end' ? 'for good' : item.endRef === 'year' ? (item.toMonth > 0 ? `to the end of ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][item.toMonth - 1]} ${item.toYear}` : `last paid in ${item.toYear - 1}`) : `until ${person ? `${person.name.split(' ')[0]} is ` : 'age '}${item.endAge}`;
    const start = item.startRef === 'age' ? `from ${person ? `${person.name.split(' ')[0]} at ` : 'age '}${item.startAge}, ` : item.startRef === 'retire' ? 'from retirement, ' : item.startRef === 'year' ? `from ${item.fromMonth > 1 ? `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][item.fromMonth - 1]} ` : ''}${item.fromYear}, ` : '';
    return start + end;
  };

  // ------------------------------------------------------------------ saving & investing

  // Your own monthly amounts, next to what the plan does with them this year.
  function renderSaving() {
    const p = plan();
    const s = p.strategy;
    const flow = (key, text) => h('span', { class: 'hint flow', 'data-flow': key }, text || '');
    // "Everything left" or a set amount a month (today's money).
    const autoOrSet = (key, label, autoText) => {
      const set = s[key] !== null;
      return h('div', { class: 'field' }, h('span', {}, label),
        h('div', { class: 'auto-or-set' },
          h('select', { 'aria-label': `${label}: automatic or a set amount`, onchange: e => {
            s[key] = e.target.value === 'set' ? Math.round((key === 'isaMonthly' ? model.monthly.isa : model.monthly.gia) || 0) : null;
            renderSection('saving'); schedule();
          } }, h('option', { value: 'auto', selected: !set }, 'Automatic'), h('option', { value: 'set', selected: set }, 'Set amount')),
          set ? moneyInput(...bind(s, key), { label: `${label} a month` }) : null),
        flow(key), set ? null : h('span', { class: 'hint' }, autoText));
    };
    const lisas = p.accounts.filter(a => a.type === 'lisa' && !a.excluded);
    const canOpen = people().filter(x => x.age >= 18 && x.age < R.LISA.openBefore && !lisas.some(a => a.owner === x.id));
    return [
      sectionHead('saving', 'Where your money goes each month', 'What is left after spending and mortgage payments is saved in this order. Set your own amounts, or leave them automatic. Amounts are in today’s money and rise with prices.'),
      h('p', { class: 'saving-left', 'data-flow': 'surplus' }),
      h('div', { class: 'fields' },
        lisas.map(a => h('div', { class: 'field' }, h('span', {}, `${a.name} (Lifetime ISA)`),
          moneyInput(() => Math.round(a.contribution / 12), v => { a.contribution = Math.min(R.LISA.maxContribution, Math.max(0, v * 12)); }, { label: `${a.name} a month` }),
          h('span', { class: 'hint' }, `Up to ${money(R.LISA.maxContribution / 12)} a month (${money(R.LISA.maxContribution)} a year) gets the 25% bonus, until 50.`))),
        isaAmounts(p),
        allRetired() ? null : h('div', { class: 'field' }, h('span', {}, 'Once the ISAs are full'),
          switchInput('Pensions first, with tax relief', ...bind(s, 'pensionFirst'), { rerender: 'saving' }),
          flow('toPension'),
          h('span', { class: 'hint' }, s.giaMonthly !== null ? 'Off while the general account has a set amount.'
            : 'What is left goes into the pension of whoever pays the highest rate of tax and is still working (within the £60,000 annual allowance and their pay), then the general account. It can be drawn from the minimum pension age, a quarter tax-free; skipped for anyone retiring before then.')),
        p.household.ignoreTax || allRetired() ? null : h('div', { class: 'field' }, h('span', {}, 'Above £100,000'),
          selectInput([['0', 'No'], ['60000', 'Keep income under £60,000 (Child Benefit)'], ['100000', 'Keep income under £100,000']],
            () => String(E.stayUnderLine(s)), v => { s.stayUnderLine = +v; s.stayUnder100k = +v === 100000; }, { rerender: 'saving', label: 'Keep income under a line' }),
          flow('sacrificed'),
          h('span', { class: 'hint' }, 'Pay that would take someone over £100,000 is salary sacrificed into their pension instead (within the £60,000 annual allowance), where it would otherwise be taxed at over 60%. Over £100,000 Tax-Free Childcare stops and, in England, so do the 30 hours of free childcare. £60,000 is where the Child Benefit charge starts: keeping under it keeps all the Child Benefit. Needs an employer that offers salary sacrifice; take-home pay falls by what is sacrificed, less the tax saved.')),
        autoOrSet('giaMonthly', 'General investment account', s.pensionFirst ? 'Automatic: whatever is left once the ISAs and pensions are full.' : 'Automatic: whatever is left once the ISAs are full.'),
        people().filter(x => x.retireAge > x.age).map(x => field(`Extra into ${x.name}’s pension`, moneyInput(...bind(x, 'extraPension'), { label: `Extra pension for ${x.name} a month` }),
          'From take-home pay until retirement; 20% tax relief is added, and higher-rate relief is claimed back. Salary sacrifice (on the salary in Income) saves NI too.'))),
      h('p', { class: 'hint', 'data-flow': 'cash' }),
      canOpen.length ? h('div', { class: 'add-row' }, canOpen.map(x => h('button', { type: 'button', class: 'btn small', onclick: () => {
        p.accounts.push({ id: E.uid(), name: `${x.name} Lifetime ISA`, type: 'lisa', owner: x.id, balance: 0, contribution: R.LISA.maxContribution, purpose: 'retirement' });
        renderSection('accounts'); renderSection('saving'); schedule();
      } }, `+ Lifetime ISA for ${x.name}`))) : null,
    ];
  }

  // ISAs: automatic, or your own amount a month for each ISA (within each person's allowance).
  function isaAmounts(p) {
    const s = p.strategy;
    const isas = p.accounts.filter(a => a.type === 'isa' && !a.excluded);
    const set = isas.some(a => a.monthly !== null);
    const lisaOf = owner => p.accounts.filter(a => a.type === 'lisa' && a.owner === owner && !a.excluded).reduce((acc, a) => acc + a.contribution, 0);
    const toggle = h('select', { 'aria-label': 'ISAs: automatic or an amount for each', onchange: e => {
      const each = e.target.value === 'set';
      const n = Math.max(1, isas.length);
      for (const a of isas) a.monthly = each ? Math.round((model.monthly.isa || 0) / n) : null;
      s.isaMonthly = null;
      renderSection('saving'); schedule();
    } }, h('option', { value: 'auto', selected: !set }, 'Automatic'), h('option', { value: 'set', selected: set }, 'An amount for each ISA'));
    if (!isas.length) return h('div', { class: 'field' }, h('span', {}, 'ISAs'), h('span', { class: 'hint' }, 'No ISA accounts yet: add one under Portfolio. Until then the plan still saves into an ISA for you.'), h('span', { class: 'hint flow', 'data-flow': 'isaMonthly' }));
    return h('div', { class: 'field wide isa-each' }, h('span', {}, 'ISAs'),
      toggle,
      set ? h('div', { class: 'isa-rows' }, isas.map(a => {
        const room = Math.max(0, s.isaAllowance - lisaOf(a.owner)) / 12;
        return h('div', { class: 'isa-row' },
          h('span', {}, h('strong', {}, a.name), h('small', {}, `${ownerName(p, a.owner)} · up to ${money(room)} a month${lisaOf(a.owner) ? ' after the Lifetime ISA' : ''}`)),
          moneyInput(() => a.monthly || 0, v => { a.monthly = Math.max(0, v); }, { label: `${a.name} a month` }));
      })) : h('span', { class: 'hint' }, `Automatic: everything left, up to ${money(s.isaAllowance)} each a year, shared between the ISAs.`),
      h('span', { class: 'hint flow', 'data-flow': 'isaMonthly' }));
  }

  // What the plan does this year with each amount (beside the inputs).
  function updateSavingFigures() {
    if (!model) return;
    const m = model.monthly, r0 = model.proj.rows[0];
    const set = (key, text) => { for (const el of $$(`[data-flow="${key}"]`)) el.textContent = text; };
    const surplus = m.surplus;
    set('surplus', m.shortfall > 0
      ? `This year spending is ${money(m.shortfall)} a month more than comes in, so nothing is left to save.`
      : `This year about ${money(surplus)} a month is left over after spending and mortgage payments.`);
    set('isaMonthly', `This year: ${money(m.isa)} a month${(r0.sweepIsa || 0) > 0.5 ? `, plus ${money(r0.sweepIsa)} of spare cash` : ''}.`);
    set('giaMonthly', `This year: ${money(m.gia)} a month.`);
    {
      // Pensions first: this year, or the first year it starts (when the ISAs fill up).
      const rows = model.proj.rows, k = rows.findIndex(r => (r.toPension || 0) > 0.5);
      const r = k >= 0 ? rows[k] : null;
      const sk = rows.findIndex(x => (x.sacrificed || 0) > 0.5);
      const sr = sk >= 0 ? rows[sk] : null;
      set('sacrificed', !E.stayUnderLine(plan().strategy) ? '' : !sr ? `Nobody’s income reaches ${money(E.stayUnderLine(plan().strategy))} in the plan.`
        : `${sk === 0 ? 'This year' : `From ${sr.year}`}: about ${money(sr.sacrificed / 12 / (real() ? sr.deflator : 1))} a month more into pensions${sk && real() ? ' (today’s money)' : ''}, rising with pay.${people().map((x, i) => over100kText(x, i, sk)).join('')}`);
      set('toPension', !plan().strategy.pensionFirst ? '' : !r ? 'Nothing goes this way in the plan: the ISAs take it all.'
        : `${k === 0 ? 'This year' : `From ${r.year}`}: about ${money(r.toPension / 12 / (real() ? r.deflator : 1))} a month from what is left${k ? (real() ? ' (today’s money)' : '') : ''}, with tax relief on top.`);
    }
    set('cash', m.cash > 0.5 ? `${money(m.cash)} a month goes to cash this year (topping up the buffer, or what your set amounts leave over).` : '');
  }

  // Suggestions for this household, in the usual UK order.
  function savingAdvice() {
    const p = plan(), s = p.strategy, m = model.monthly, r0 = model.proj.rows[0];
    const out = [];
    const add = (title, amount, text, action) => out.push({ title, amount, text, action });
    const monthlyOut = (r0.spending + r0.debtRegular) / 12;
    const em = emergencyStep(p, model.proj);
    if (p.goals.some(g => g.type === 'emergency')) {
      // Your own emergency-fund goal: what it counts and how many months.
      const what = em.investments ? 'cash and ISAs' : 'cash';
      add('1. Emergency fund', em.short > 0.5 ? `${money(em.short)} short` : 'Covered',
        em.short > 0.5 ? `Your goal is ${em.months} months of spending and mortgage payments (${money(em.need)}) in ${what}. Build that before investing more.` : `Your ${what} cover${em.investments ? '' : 's'} the ${em.months} months your emergency-fund goal asks for (${money(em.need)}).`);
    } else {
      const held = r0.cash + (r0.cashIsa || 0);
      const months = monthlyOut > 0 ? held / monthlyOut : 0;
      const buffer = monthlyOut > 0 ? ` The plan keeps at least ${money(s.cashReserve)} (${(s.cashReserve / monthlyOut).toFixed(1)} months) as a buffer before investing.` : '';
      add('1. Emergency fund', months >= 3 ? `${months.toFixed(1)} months` : `${money(3 * monthlyOut)}–${money(6 * monthlyOut)}`,
        months >= 3 ? `Your cash (${money(held)}) covers ${months.toFixed(1)} months of spending and mortgage payments (3–6 is the usual guide).${buffer}` : `Keep 3–6 months of spending in easy-access cash before investing. Your cash (${money(held)}) covers ${months.toFixed(1)} months.${buffer}`,
        months >= 3 ? null : ['Set the buffer', () => { s.cashReserve = Math.round(3 * monthlyOut / 100) * 100; s.autoBuffer = false; renderSection('strategy'); schedule(); }]);
    }
    if (people().some(x => x.retireAge > x.age && p.income.some(i => i.kind === 'salary' && i.owner === x.id && E.incomeAfterCosts(i, p, 0) > 0))) {
      add('2. Workplace pension match', 'In full', 'Pay at least what your employer matches: their contribution is free money. Check your payslip or scheme rules.');
    }
    const lisaPeople = people().filter(x => x.age >= 18 && x.age < R.LISA.payUntil && (x.age < R.LISA.openBefore || p.accounts.some(a => a.type === 'lisa' && a.owner === x.id)));
    if (lisaPeople.length) {
      add('3. Lifetime ISA', `${money(R.LISA.maxContribution / 12)} a month each`, `${lisaPeople.map(x => x.name).join(' and ')} can get a 25% bonus (${money(R.LISA.maxContribution * R.LISA.bonus)} a year each) until 50, usable from 60${E.ownsHome(p) ? '' : ' or for a first home'}. Good if you won’t need it before 60.`,
        ['Compare with salary sacrifice', () => openComparison('sacrifice-lisa')]);
    }
    // Pension relief for anyone paying higher-rate tax: the pay above the higher-rate threshold.
    const region = p.household.region;
    for (const x of people()) {
      const pay = p.income.filter(i => i.kind === 'salary' && i.owner === x.id && E.incomeAfterCosts(i, p, 0) > 0);
      if (!pay.length || p.household.ignoreTax || x.retireAge <= x.age) continue;
      const hr = higherRelief(p, x);   // income after salary sacrifice and pension contributions
      // Under £25 a month at the higher rate is not worth a line.
      if (!hr || hr.over < 300) continue;
      const over = hr.over, line = payLine(p, x, hr.gross);
      add(`${lisaPeople.length ? 4 : 3}. Pension for ${x.name}`, line ? 'optional' : `up to ${money(over / 12)} a month`,
        `${line ? `${x.name}’s pay is kept at ${money(line.value)}, ${line.why}. Even so, ` : ''}${x.name} pays ${hr.rates} tax on the top ${money(hr.band)} of income (everything above ${money(hr.gross - hr.band)} of ${money(hr.gross)})${E.taxOf(pay[0], p) === 'uk' ? '' : ' (estimated)'}, after what already goes into pensions. ${hr.capped ? `The ${money(R.PENSION_ANNUAL_ALLOWANCE)} annual allowance has room for ${money(hr.room)} more this year (unused allowance from the last 3 years can be carried forward). Putting that` : 'Putting that'} into the pension gets the same relief now, and it is likely taxed at ${hr.drawn} or less when drawn. Salary sacrifice saves NI too.`,
        ['Compare pension or ISA', () => openComparison('pension-isa')]);
    }
    const isaRoom = s.isaAllowance * people().length;
    add(`${out.length + 1}. Stocks & shares ISAs`, `up to ${money(isaRoom / 12)} a month`, `${money(s.isaAllowance)} each a year (a Lifetime ISA counts within it), tax-free for good and available any time${em.investments ? '; your emergency fund counts them too' : ''}. This year the plan puts in ${money(m.isa + m.lisa)} a month.`);
    if (m.gia > 0.5 || r0.gia > 0.5) add(`${out.length + 1}. General investment account`, `${money(m.gia)} a month now`, 'Only once ISAs are full: gains above the allowance are taxed when you sell. Move it into ISAs each April ("Bed and ISA").');
    const debt = p.accounts.find(a => a.type === 'debt' && a.balance > 0 && !a.excluded);
    if (debt) {
      const ret = model.proj.pre.econ.ret[0] * 100;
      add('Mortgage', debt.rate >= ret - 1 ? 'Worth overpaying' : 'Invest first',
        debt.rate >= ret - 1 ? `Overpaying earns a sure ${debt.rate}%, close to the ${ret.toFixed(1)}% expected from investing.` : `Investing is expected to earn ${ret.toFixed(1)}% against the ${debt.rate}% the mortgage costs. Overpaying is the safer choice.`,
        ['Compare', () => openComparison('overpay-invest')]);
    }
    return out;
  }

  function wkSaving(body) {
    const card = wkCard(body, 'Suggested order', h('p', {}, 'The usual UK order for a household like yours. Rules of thumb, not advice.'));
    card.append(h('ol', { class: 'advice' }, savingAdvice().map(a => h('li', {},
      h('div', { class: 'adv-head' }, h('strong', {}, a.title.replace(/^\d+\.\s*/, '')), h('span', { class: 'adv-amt' }, a.amount)),
      h('p', {}, a.text),
      a.action ? h('button', { type: 'button', class: 'btn small', onclick: a.action[1] }, a.action[0]) : null))));
    // Where the money goes, year by year, until retirement.
    const rows = model.proj.rows;
    const p1 = people()[0];
    const n = Math.max(2, Math.min(rows.length - 1, Math.max(...people().map(x => x.retireAge - x.age)) + 1));
    const xs = rows.slice(0, n).map(r => r.year);
    const series = [
      { label: 'Lifetime ISAs', color: '--s7', of: r => r.toLisa || 0 },
      { label: 'ISAs', color: '--s2', of: r => r.toIsa + r.sweepIsa },
      { label: 'General investment', color: '--s3', of: r => r.toGia + r.sweepGia },
      { label: 'Extra pension', color: '--s4', of: r => r.extraPension || 0 },
      { label: 'Mortgage overpayments', color: '--s8', of: r => r.overpay + r.lumpOverpay },
      { label: 'Cash', color: '--s1', of: r => r.toCash },
    ].map(x => ({ ...x, values: rows.slice(0, n).map((r, t) => D(x.of(r), t) / 12) })).filter(x => x.values.some(v => v > 0.5));
    const c2 = wkCard(body, 'Where it goes, year by year', h('p', {}, `A month, until ${people().length > 1 ? 'you both retire' : 'you retire'}, in ${unitLabel()}. Pay rises, the mortgage ending and costs that stop all change it.`));
    const ch = chartIn(c2, 240, 'Monthly saving by where it goes', { name: 'saving-by-year' });
    ch.set({
      xs, bars: series,
      tooltip: i => ({ title: `${xs[i]} · ${p1.name} ${p1.age + i}`, rows: series.filter(x => x.values[i] > 0.5).map(x => ({ label: x.label, color: x.color, text: `${money(x.values[i])} a month` })) }),
    });
    const lg = h('div', { class: 'legend' });
    c2.append(lg);
    legend(lg, series.map(x => ({ label: x.label, color: x.color })), ch);
  }

  // ------------------------------------------------------------------ plan editor sections

  const SECTIONS = [
    { id: 'household', title: 'Household', render: renderHousehold },
    { id: 'income', title: 'Income', render: renderIncome, count: () => plan().income.length },
    { id: 'expenses', title: 'Spending', render: renderExpenses, count: () => plan().expenses.length },
    { id: 'events', title: 'One-off events', render: renderEvents, count: () => plan().events.length },
    { id: 'accounts', title: 'Accounts', render: renderAccounts, count: () => plan().accounts.length },
    { id: 'saving', title: 'Saving & investing', render: renderSaving },
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

  // Redraw a section after a finished edit without losing the field the person moved to: a
  // number is "changed" when its field is left, often by clicking the next one, and a plain
  // redraw would replace that field under the click. Wait for the click, then put the cursor
  // back in the same field (found again by its label and position).
  function redrawKeepFocus(id) {
    setTimeout(() => {
      // Visible form fields only: hidden ones and buttons change in number between redraws.
      const fields = box => [...box.querySelectorAll('input, select, textarea')].filter(x => x.getClientRects().length);
      const box = document.getElementById(`sec-${id}`);
      const el = document.activeElement;
      const k = box && el && box.contains(el) ? fields(box).indexOf(el) : -1;
      const sel = el && typeof el.selectionStart === 'number' ? [el.selectionStart, el.selectionEnd] : null;
      renderSection(id);
      if (k < 0) return;
      const again = fields(document.getElementById(`sec-${id}`))[k];
      if (!again || again.tagName !== el.tagName) return;
      again.focus({ preventScroll: true });
      if (sel) try { again.setSelectionRange(sel[0], sel[1]); } catch { /* number inputs have no selection */ }
    }, 0);
  }

  // After a typed number is finished: redraw once the person has left the card it is in, never
  // while they are typing in it or in the next field of the same card (a redraw would replace
  // the field under their cursor). Dropdowns and switches redraw at once (redrawKeepFocus).
  function redrawWhenLeft(input, id) {
    const card = input.closest('[data-editing], .item, .row-item') || document.getElementById(`sec-${id}`);
    if (!card) { renderSection(id); return; }
    let done = false;
    const go = () => { if (done) return; done = true; card.removeEventListener('focusout', out); redrawKeepFocus(id); };
    const out = e => { if (!e.relatedTarget || !card.contains(e.relatedTarget)) setTimeout(go, 0); };
    card.addEventListener('focusout', out);
    // Focus already gone elsewhere (e.g. Enter pressed, then a click outside): redraw now.
    setTimeout(() => { if (!card.contains(document.activeElement)) go(); }, 0);
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
      const a = plan().accounts.find(x => x.id === el.dataset.est);
      el.textContent = a && notYet(a, model.est.years || 0) ? `buying in ${a.buyYear}` : v === undefined ? '' : `≈ ${money(v)} today`;
    }    // A loan's payoff year follows the balance, rate and payment as they are typed.
    for (const el of $$('[data-payoff]')) {
      const a = plan().accounts.find(x => x.id === el.dataset.payoff);
      if (a) el.textContent = payoffText(a);
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
    if (opts.rerender) input.addEventListener('change', () => { redrawWhenLeft(input, opts.rerender); schedule(); });
    return h('div', { class: 'adorn has-suf' }, input, h('span', { class: 'suf' }, opts.suffix || '%'));
  }

  function renderHousehold() {
    const hh = plan().household;
    const cards = hh.people.map((p, i) => h('div', { class: 'item', style: `--item-color:${cssVar(i ? '--s2' : '--s1')}` },
      h('div', { class: 'item-head' },
        h('input', { type: 'text', class: 'name', value: p.name, 'aria-label': 'Name', oninput: e => { p.name = e.target.value; schedule(); } }),
        i > 0 ? deleteButton('Remove partner', () => removePartner()) : null),
      h('div', { class: 'fields' },
        field('Age now', (() => {
          // The State Pension age follows the year of birth: move it with the age unless it was set by hand.
          const sy = plan().startYear;
          let was = p.age;
          const input = numInput(...bind(p, 'age'), { min: 16, max: 100 });
          input.addEventListener('change', () => {
            if (p.statePensionAge === R.statePensionAge(sy - was)) p.statePensionAge = R.statePensionAge(sy - p.age);
            // Retired (retirement age = age): stays retired as the age is corrected.
            if (p.retireAge === was) p.retireAge = p.age;
            was = p.age;
            redrawWhenLeft(input, 'household');
            schedule();
          });
          return input;
        })()),
        field('Retirement age', numInput(...bind(p, 'retireAge'), { min: 16, max: 100 }))),
      more(`person-${i}`, 'More options',
        h('div', { class: 'fields' },
          field('Plan until age', numInput(...bind(p, 'endAge'), { min: 50, max: 120 })),
          field('NI qualifying years so far', optNumInput(() => p.niYears, v => {
            p.niYears = v;
            // Still the full amount nobody typed, but the years to State Pension age fall short of 35: use what they give.
            if (v !== null && v !== undefined && Math.abs(p.statePension - R.STATE_PENSION_FULL) < 1) {
              const most = Math.min(R.NI_YEARS.full, v + Math.max(0, p.statePensionAge - p.age));
              if (most < R.NI_YEARS.full) { p.statePension = most < R.NI_YEARS.min ? 0 : Math.round(R.STATE_PENSION_FULL * most / R.NI_YEARS.full); toast(`With ${most} years by ${p.statePensionAge}, the State Pension is about ${money(p.statePension)} a year, not the full ${money(R.STATE_PENSION_FULL)}: the plan now uses that. Your forecast on gov.uk gives the exact figure.`); }
            }
          }, { placeholder: 'Not sure', step: 1, suffix: 'years', label: 'NI qualifying years so far', rerender: 'household' }),
            h('span', { 'data-ni': p.id }, niText(p))),
          p.niYears !== null ? h('div', { class: 'field' }, h('span', {}, 'After stopping work'),
            switchInput('Pay voluntary NI to fill the missing years', ...bind(p, 'niVoluntary'), { rerender: 'household' }),
            h('span', { class: 'hint' }, `Class 3, about ${money(R.NI_YEARS.class3Week * 52)} a year; each year adds about ${money(R.STATE_PENSION_FULL / R.NI_YEARS.full)} a year of State Pension, for life.`)) : null,
          field('State Pension (today)', statePensionInput(p), `Full new State Pension is ${money(R.STATE_PENSION_FULL)} a year (${money(R.STATE_PENSION_FULL / 52)} a week). Type either: your letter or forecast at gov.uk/check-state-pension gives it a week.`),
          field('State Pension age', numInput(...bind(p, 'statePensionAge'), { min: 60, max: 75 }), `Born ${plan().startYear - p.age}: ${R.statePensionAge(plan().startYear - p.age)} under current law.`),
          field('Put off the State Pension', numInput(...bind(p, 'spDefer'), { min: 0, max: 10, suffix: 'years', label: 'Years to put off the State Pension', rerender: 'household' }), spDeferText(p)),
          field('Can access pension from', numInput(...bind(p, 'pensionAccessAge'), { min: 50, max: 75 }), 'Minimum pension age is 57 from April 2028.'),
          field('Student loan', selectInput([['', 'None'], ...Object.entries(R.STUDENT_LOANS).map(([k, v]) => [k, v.label])], () => p.loanPlan, v => {
            p.loanPlan = v;
            if (v && !p.loanEndYear) p.loanEndYear = plan().startYear + Math.max(1, R.STUDENT_LOANS[v].writeOff - Math.max(0, p.age - 22));
          }, { rerender: 'household', label: 'Student loan plan' }), 'Your plan is on your payslip or in your Student Loans Company account.'),
          p.loanPlan ? [
            field('Student loan owed', moneyInput(...bind(p, 'loanBalance'), { label: 'Student loan owed' }), 'From your Student Loans Company account, on the date your figures are as at.'),
            field('Written off in', numInput(...bind(p, 'loanEndYear'), { min: plan().startYear, max: plan().startYear + 45, label: 'Year the loan is written off' }), `Whatever is left is cancelled then: ${R.STUDENT_LOANS[p.loanPlan].writeOff} years after the April after you left your course (your account says).`),
            field('Own threshold (optional)', optNumInput(...bind(p, 'loanThreshold'), { placeholder: plain(R.STUDENT_LOANS[p.loanPlan].threshold), suffix: '£/yr', step: 1, label: 'Student loan threshold' }), `${R.STUDENT_LOANS[p.loanPlan].pct}% of pay above ${money(R.STUDENT_LOANS[p.loanPlan].threshold)} a year (${R.TAX_YEAR}).`),
            field('Own interest (optional)', optNumInput(...bind(p, 'loanRate'), { placeholder: `about ${+(plan().assumptions.inflation + R.STUDENT_LOANS[p.loanPlan].extra).toFixed(1)}`, step: 0.1, label: 'Student loan interest' }), 'Empty = roughly what the plan charges, from inflation.'),
            h('p', { class: 'hint calc', 'data-loan': p.id }, loanWorking(p)),
          ] : null))));
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

  // Putting off the State Pension: what it adds and how long it takes to catch up.
  function spDeferText(x) {
    const pct = R.SP_DEFER_PER_YEAR * 100;
    if (!x.spDefer) return `0 = take it at ${x.statePensionAge}. Each year put off adds about ${pct.toFixed(1)}% for life (1% every 9 weeks); it is worth it if you live long and do not need it yet.`;
    const more = x.statePension * (E.spDeferUplift(x) - 1);
    const missed = x.statePension * x.spDefer;
    return `From ${E.spStart(x)}: about ${money(x.statePension * E.spDeferUplift(x))} a year (today’s money), ${money(more)} more. The ${money(missed)} not taken is made up after about ${Math.round(missed / more)} years, at ${E.spStart(x) + Math.round(missed / more)}. Leaving it unclaimed defers it; it is not paid automatically.`;
  }

  // "£30 a month now; paid off in 2041" or "written off in 2054 with about £60,000 left".
  function loanWorking(x) {
    if (!model || !x.loanPlan) return '';
    const i = people().indexOf(x);
    const P = model.proj.pre.people[i];
    if (!P) return '';
    const y0 = plan().startYear;
    const paid = P.loanPaid[0];
    let off = -1;
    for (let t = 1; t < P.loanBal.length; t++) if (P.loanBal[t] <= 0.5) { off = t; break; }
    const end = x.loanEndYear;
    if (!plan().income.some(it => (it.kind === 'salary' || it.kind === 'self') && (it.owner === x.id || it.owner === 'joint'))) return `Repaid at ${R.STUDENT_LOANS[x.loanPlan].pct}% of pay above the threshold: add ${x.name === 'You' ? 'your' : `${x.name}’s`} pay to see how much and until when.`;
    const now = paid > 0.5 ? `About ${money(paid / 12)} a month now` : 'Nothing to repay this year (pay is under the threshold)';
    if (off >= 0 && (!end || y0 + off < end)) return `${now}; repaid in full by ${y0 + off}. Take-home pay rises then.`;
    if (!end) return `${now}; never repaid on these figures.`;
    const t = Math.min(P.loanBal.length - 1, end - y0);
    return `${now}; written off in ${end} with about ${money(D(P.loanBal[t], t))} left${real() ? ' in today’s money' : ''}, so in effect a tax on pay until then.`;
  }

  function addPartner() {
    const p1 = people()[0];
    plan().household.people.push({ id: 'p2', name: 'Partner', age: p1.age, retireAge: p1.retireAge, endAge: p1.endAge, statePension: R.STATE_PENSION_FULL, statePensionAge: p1.statePensionAge, pensionAccessAge: R.MIN_PENSION_AGE, extraPension: 0,
      loanPlan: '', loanBalance: 0, loanEndYear: 0, loanThreshold: null, loanRate: null, spDefer: 0, niYears: null, niVoluntary: false });
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
    const pair = h('div', { class: 'pair' }, moneyInput(...bind(item, 'amount'), { label: 'Amount', prefix: item.fx !== undefined && item.fx !== 1 ? '' : '£' }),
      selectInput([['month', 'a month'], ['year', 'a year']], ...bind(item, 'freq'), { label: 'Frequency', rerender: sectionId }));
    // £20,000 or more "a month" is nearly always a year's amount typed with the wrong unit.
    const yearly = () => item.freq === 'month' && item.amount >= 20000 && sectionId === 'income';
    const ask = h('span', { class: 'hint warn-hint', hidden: !yearly() }, `${money(item.amount)} a month is ${money(item.amount * 12)} a year. `,
      h('button', { type: 'button', class: 'linkish', onclick: () => { item.freq = 'year'; renderSection(sectionId); refresh(); } }, 'Did you mean a year?'));
    pair.querySelector('input').addEventListener('input', () => {
      ask.hidden = !yearly();
      if (!ask.hidden) ask.firstChild.textContent = `${money(item.amount)} a month is ${money(item.amount * 12)} a year. `;
    });
    return h('div', { class: 'amount-freq' }, pair, ask);
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

  const KIND_LABELS = [['salary', 'Salary'], ['self', 'Self-employed'], ['rental', 'Rent'], ['other', 'Other income'], ['dbpension', 'Defined benefit pension (USS, NHS, council, survivor’s…)'], ['annuity', 'Annuity']];
  const kindLabel = k => (KIND_LABELS.find(x => x[0] === k) || [k, k])[1].replace(/ \(.*\)$/, '');

  function setKind(item, v) {
    item.kind = v;
    if (v === 'self') { item.tax = 'uk'; if (item.owner === 'joint') item.owner = 'p1'; }
    if (v === 'annuity') {
      const person = people()[E.personIndex(plan(), item.owner === 'joint' ? 'p1' : item.owner)];
      if (item.owner === 'joint') item.owner = person.id;
      item.startAge = Math.max(person.age, person.retireAge, R.MIN_PENSION_AGE);
      item.freq = 'year';
      item.tax = 'uk';
      item.inflationLinked = false;
      if (!item.cost) item.cost = 100000;
      if (!item.amount) item.amount = Math.round(item.cost * 0.07);
    }
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
    const early = E.dbEarly(item, person);
    const cut = early.years > 0 ? ` × ${(early.factor * 100).toFixed(1)}% for taking it ${+early.years.toFixed(1)} year${early.years === 1 ? '' : 's'} before the Normal Pension Age of ${early.npa}` : '';
    return `(${money(item.amount)} + ${money(item.dbAccrual)} × ${Math.max(0, Math.min(person.retireAge, item.startAge) - person.age)} more years of work)${cut} = ${money(today)} a year in today's money from age ${item.startAge}, rising with prices${item.lumpMultiple > 0 ? `, plus a ${money(today * item.lumpMultiple)} lump sum` : ''}.`;
  }

  function renderDbPension(item, p) {
    const person = people()[E.personIndex(p, item.owner)];
    if (!item.dbScheme) item.dbScheme = 'other';
    const scheme = R.DB_SCHEMES[item.dbScheme] || R.DB_SCHEMES.other;
    const other = item.dbScheme === 'other';
    const npa = item.dbNpa > 0 ? item.dbNpa : scheme.age === 'spa' ? person.statePensionAge : scheme.age;
    const pay = p.income.find(i => i.kind === 'salary' && i.owner === item.owner);
    const payGross = pay ? (E.taxOf(pay, p) === 'uk' ? pay.amount * (pay.freq === 'month' ? 12 : 1) : R.grossFromTakeHome(pay.amount * (pay.freq === 'month' ? 12 : 1), p.household.region)) : 0;
    return h('div', { class: 'item', style: `--item-color:${cssVar('--s4')}` },
      h('div', { class: 'item-head' },
        h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Income name', oninput: e => { item.name = e.target.value; schedule(); } }),
        h('span', { class: 'tag' }, 'Defined benefit pension'),
        h('span', { class: 'tag', 'data-net': item.id }, incomeTag(item, p)),
        deleteButton(`Remove ${item.name}`, () => removeFrom(p.income, item, 'income'))),
      h('div', { class: 'fields' },
        h('div', { class: 'field' }, h('span', {}, 'Being paid now?'),
          switchInput('Already being paid', () => item.startAge <= person.age, v => {
            if (v) { item.startAge = person.age; item.dbAccrual = 0; item.lumpMultiple = 0; } else item.startAge = Math.max(person.age + 1, npa);
          }, { rerender: 'income' }),
          h('span', { class: 'hint' }, 'A pension you already receive, such as a council (LGPS) pension or a widow’s or survivor’s pension: just what it pays a year now.'))),
      item.startAge <= person.age ? h('div', { class: 'fields' },
        field('Whose', selectInput(ownerOptions(false), ...bind(item, 'owner'), { rerender: 'income' })),
        field('Paid now (£ a year)', moneyInput(...bind(item, 'amount'), { label: 'Pension paid now a year' }), 'Before tax, from the pension payslip or the yearly statement. It rises with prices each year, as most do.'),
        field('Tax', selectInput(taxOptions(item.kind), ...bind(item, 'tax'), { rerender: 'income' })),
        noteField(item)) : h('div', { class: 'fields' },
        field('Whose', selectInput(ownerOptions(false), () => item.owner, v => { if (v !== item.owner) { item.owner = v; item.dbSalary = 0; } }, { rerender: 'income' })),
        field('Scheme', selectInput(Object.entries(R.DB_SCHEMES).map(([k, v]) => [k, v.label]), ...bind(item, 'dbScheme'), { label: 'Scheme', rerender: 'income' }), 'Sets how much each year adds, the pension age and the cut for taking it early.'),
        field('Built up so far (£ a year)', moneyInput(...bind(item, 'amount'), { label: 'Pension built up so far' }), 'From the latest benefit statement.'),
        field('Added each year you keep working', moneyInput(...bind(item, 'dbAccrual'), { label: 'Pension added each year' }), `${scheme.label === 'Other' ? 'Most schemes add' : `${scheme.label} adds`} about 1/${scheme.accrual} of salary a year${pay ? ` (about ${money(payGross / scheme.accrual)} on ${money(payGross)})` : ''}.`),
        other ? field('Paid from age', numInput(...bind(item, 'startAge'), { min: 50, max: 75, label: 'Pension age', rerender: 'income' }), `The age your statement or letter gives the amount for. ${person.name}'s State Pension age is ${person.statePensionAge}.`) : null,
        other ? field('The scheme’s full pension age', optNumInput(...bind(item, 'dbNpa'), { placeholder: 'Same age', step: 1, label: 'Scheme pension age', rerender: 'income' }), item.dbNpa > item.startAge ? `Taken ${item.dbNpa - item.startAge} year${item.dbNpa - item.startAge === 1 ? '' : 's'} early, so the plan cuts it: about ${scheme.early[2]}% kept two years early, ${scheme.early[5]}% five years early (roughly; your scheme’s own table differs a little).` : 'Leave empty to use the amount as typed. Fill it in only if you will take the pension before the age the statement’s amount is for: the plan then cuts it for being early.') : null,
        other ? null : field('Paid from age', numInput(...bind(item, 'startAge'), { min: 50, max: 75, label: 'Pension age' }), `${person.name}'s State Pension age is ${person.statePensionAge}. Paid in full from the scheme’s Normal Pension Age (${npa}); taken earlier it is cut: about ${scheme.early[2]}% kept two years early, ${scheme.early[5]}% five years early${scheme === R.DB_SCHEMES.uss ? '' : ' (roughly; your scheme’s own table differs a little)'}.`),
        field('Tax-free lump sum', numInput(...bind(item, 'lumpMultiple'), { min: 0, max: 10, step: 0.5, suffix: '× pension', label: 'Lump sum multiple' }), scheme.lump ? `${scheme.label} pays ${scheme.lump}× the pension as cash; 0 if none.` : 'Most schemes let you swap some pension for a tax-free lump sum; 0 if you will not.'),
        field('Tax', selectInput(taxOptions(item.kind), ...bind(item, 'tax'), { rerender: 'income' })),
        noteField(item)),
      item.startAge <= person.age ? null : h('p', { class: 'hint calc', 'data-calc': item.id }, dbWorking(item, p)),
      pay && pay.pensionTo !== 'db' && (pay.employeePension > 0 || pay.employerPension > 0)
        ? h('div', { class: 'callout warn-hint db-pay' }, h('p', {}, `${poss(person.name)} pay has workplace pension contributions that build a pension pot. If they go into this scheme instead, they would be counted twice.`),
          h('button', { type: 'button', class: 'btn small', onclick: () => { for (const it of p.income.filter(i => i.kind === 'salary' && i.owner === item.owner)) it.pensionTo = 'db'; renderSection('income'); refresh(); } }, `${poss(person.name)} pension contributions go into this scheme`))
        : null,
      dbEstimator(item, p, person));
  }

  // An annuity: part of a pension pot swapped for an income for life.
  function annuityWorking(item, p) {
    const person = people()[E.personIndex(p, item.owner)];
    const rate = item.cost > 0 ? (item.amount / item.cost) * 100 : 0;
    const t = Math.max(0, item.startAge - person.age);
    const f = Math.pow(1 + p.assumptions.inflation / 100, t);
    return `At ${item.startAge} (${p.startYear + t}): about ${money(item.cost * f)} from ${person.name}’s pension pot buys ${money(item.amount * f)} a year${item.inflationLinked ? ', rising with prices' : ', fixed in pounds'}, for life: a rate of ${rate.toFixed(1)}%. Taxed as income like any pension. Net worth falls by the price when it is bought: the income is not something you own, but it cannot run out.`;
  }

  function renderAnnuity(item, p) {
    const person = people()[E.personIndex(p, item.owner)];
    return h('div', { class: 'item', style: `--item-color:${cssVar('--s4')}` },
      h('div', { class: 'item-head' },
        h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Income name', oninput: e => { item.name = e.target.value; schedule(); } }),
        h('span', { class: 'tag' }, 'Annuity'),
        deleteButton(`Remove ${item.name}`, () => removeFrom(p.income, item, 'income'))),
      h('div', { class: 'fields' },
        field('Whose', selectInput(ownerOptions(false), ...bind(item, 'owner'), { rerender: 'income' })),
        field('Pension pot spent on it', moneyInput(...bind(item, 'cost'), { label: 'Pot spent on the annuity' }), 'In today’s money. Many people take their 25% tax-free cash first and buy with the rest.'),
        field('Income a year', moneyInput(...bind(item, 'amount'), { label: 'Annuity income a year' }), 'From a quote, in today’s money. Around 7% of the pot fixed, or 5% rising with prices, at 65 (2026); more with health conditions. Shop around: you do not have to buy from your own provider.'),
        field('Bought at age', numInput(...bind(item, 'startAge'), { min: Math.max(50, person.age), max: 90, label: 'Annuity age' }), `${person.name} can use the pot from ${person.pensionAccessAge}.`),
        h('div', { class: 'field' }, h('span', {}, 'Once bought'), switchInput('Rises with prices', ...bind(item, 'inflationLinked'), { rerender: 'income' }), h('span', { class: 'hint' }, 'Fixed is higher at first; rising with prices keeps its value.')),
        field('Tax', selectInput(taxOptions('other'), ...bind(item, 'tax'), { rerender: 'income' })),
        noteField(item)),
      h('p', { class: 'hint calc', 'data-annuity': item.id }, annuityWorking(item, p)));
  }

  // "Don't know what's built up?" Estimate it from the scheme, year joined and salary.
  function dbEstimate(item) {
    return E.estimateDb({ scheme: item.dbScheme || 'other', joined: item.dbJoined || plan().startYear, salary: item.dbSalary, startYear: plan().startYear, realGrowth: 1 });
  }

  function dbEstimateText(item, person) {
    const e = dbEstimate(item);
    if (!item.dbSalary) return 'Enter the salary to see an estimate.';
    const age = e.pensionAge || person.statePensionAge;
    return `${e.years} year${e.years === 1 ? '' : 's'} so far ≈ ${money(e.builtUp)} a year of pension built up (today's money); each further year adds ≈ ${money(e.perYear)}. Normally paid from ${age}${e.lumpMultiple ? `, plus a lump sum of ${e.lumpMultiple}× the pension` : ''}.`;
  }

  function dbEstimator(item, p, person) {
    if (!item.dbScheme) item.dbScheme = 'other';
    const pay = p.income.find(i => i.kind === 'salary' && i.owner === item.owner);
    const guess = pay ? (E.taxOf(pay, p) === 'uk' ? pay.amount * (pay.freq === 'month' ? 12 : 1) : R.grossFromTakeHome(pay.amount * (pay.freq === 'month' ? 12 : 1), p.household.region)) : 0;
    if (!item.dbSalary && guess) item.dbSalary = Math.round(guess / 100) * 100;
    return more(`db-est-${item.id}`, 'Not sure what’s built up? Estimate it',
      h('div', { class: 'fields' },
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
  // How pay grows: yearly rises until an age, then a slower rate, plus promotions at given ages.
  function payProgression(item, owner) {
    const p = plan();
    const infl = p.assumptions.inflation;
    const real = item.inflationLinked ? 0 : item.growth - infl;
    const at = age => {
      const t = age - owner.age;
      if (t < 0 || t > E.horizon(p)) return null;
      return E.streamAt({ ...item, startRef: 'now', endRef: 'end' }, p, t) / Math.pow(1 + infl / 100, t);
    };
    const ages = [owner.age + 5, owner.age + 10, Math.min(owner.retireAge - 1, owner.age + 20)].filter((a, i, l) => a > owner.age && a < owner.retireAge && l.indexOf(a) === i);
    const freq = item.freq === 'month' ? 12 : 1;
    const raiseRow = r => h('div', { class: 'raise-row' },
      field('At age', numInput(() => r.age, v => { r.age = Math.round(v); }, { min: owner.age + 1, max: 80, label: 'Promotion age' })),
      field('Pay rises by', numInput(() => r.pct, v => { r.pct = v; }, { step: 1, suffix: '%', label: 'Promotion rise' })),
      h('button', { type: 'button', class: 'btn small ghost danger', 'aria-label': 'Remove this promotion', onclick: () => { item.raises = item.raises.filter(x => x !== r); renderSection('income'); schedule(); } }, 'Remove'));
    return h('div', { class: 'sub-fields pay-prog' },
      h('h3', {}, 'Pay progression'),
      h('div', { class: 'fields', style: 'margin-top:8px' },
        h('div', { class: 'field' }, h('span', {}, 'Pay rises'),
          switchInput('Only with prices', ...bind(item, 'inflationLinked'), { rerender: 'income' }),
          item.inflationLinked ? null : numInput(...bind(item, 'growth'), { step: 0.1, suffix: '%/yr', label: 'Pay rise per year' }),
          h('span', { class: 'hint' }, `Prices are assumed to rise ${infl}% a year. UK pay has grown about 1–1.5% a year more than prices over the long run, mostly before the mid-40s.`)),
        item.inflationLinked ? null : field('Rising like that until age', numInput(...bind(item, 'growthUntilAge'), { min: 0, max: 80, label: 'Pay rises until age', rerender: 'income' }), '0 = until retirement. Pay often levels off in your 40s or 50s, at the top of a pay grade.'),
        item.inflationLinked || !item.growthUntilAge ? null : field('Then rises', numInput(...bind(item, 'growthAfter'), { step: 0.1, suffix: '%/yr', label: 'Pay rise after that age' }), `${infl}% = in line with prices.`)),
      (item.raises || []).map(raiseRow),
      h('div', { class: 'add-row' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
        item.raises = (item.raises || []).concat([{ age: Math.min(owner.retireAge - 1, owner.age + 3), pct: 10 }]);
        renderSection('income'); schedule();
      } }, '+ Add a promotion or new job')),
      !item.inflationLinked && real > 2 && !item.growthUntilAge ? h('p', { class: 'hint warn-hint' }, `${item.growth}% a year is ${real.toFixed(1)} points above prices every year until ${owner.name} retires: pay grows ${(Math.pow(1 + real / 100, owner.retireAge - owner.age)).toFixed(1)}× in real terms. That is optimistic for a whole career; try a lower rate after your 40s.`) : null,
      ages.length ? h('p', { class: 'hint calc' }, `Pay in today’s money: now ${money(at(owner.age) / freq)}${freq === 12 ? ' a month' : ' a year'}; ` + ages.map(a => `at ${a}: ${money(at(a) / freq)}`).join('; ') + '.') : null);
  }

  function taxOptions(kind) {
    return kind === 'salary'
      ? [['uk', 'Before tax (work out tax & NI)'], ['none', 'Take-home (already taxed)'], ['flat', 'Flat tax rate']]
      : kind === 'self'
        ? [['uk', 'Profit before tax (income tax & Class 4 NI)'], ['none', 'After tax (already set aside)'], ['flat', 'Flat tax rate']]
        : [['none', 'No tax (gift or already taxed)'], ['uk', 'UK income tax'], ['flat', 'Flat tax rate']];
  }

  function renderIncome() {
    const p = plan();
    const ignore = p.household.ignoreTax;
    const editorOf = item => {
      if (item.kind === 'dbpension') return renderDbPension(item, p);
      if (item.kind === 'annuity') return renderAnnuity(item, p);
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
        isSalary ? payProgression(item, owner) : null,
        more(`income-${item.id}`, 'More options',
          h('div', { class: 'fields' },
            isSalary ? null : growthControl(item, 'income'),
            field(`Starts (${owner.name}'s age, or a year)`, timingControl(item, 'start', 'income')),
            field('Ends', timingControl(item, 'end', 'income')),
            item.kind !== 'rental' ? costFields : null,
            item.kind === 'salary' ? field('Bonus (a year, typical)', moneyInput(...bind(item, 'bonus'), { label: 'Bonus a year' }),
              'Before tax, in today’s money; it rises with the pay. Taxed like pay, with no pension contributions on it (unless you sacrifice it: add that to the pension instead).') : null,
            item.kind === 'salary' ? field('Share awards vesting (a year)', moneyInput(...bind(item, 'shares'), { label: 'Share awards a year' }),
              'RSUs or other shares from work, at their value when they vest, in today’s money. Taxed like pay (income tax and NI) when they vest.') : null,
            item.kind === 'salary' && item.shares > 0 ? field('The shares', selectInput([['sell', 'Sold when they vest: cash'], ...p.accounts.filter(a => a.type === 'gia').map(a => [a.id, `Kept in ${a.name}`])], ...bind(item, 'sharesTo'), { label: 'Shares kept or sold', rerender: 'income' }),
              item.sharesTo === 'sell' ? 'The money after tax joins the rest of your income.' : 'What is left after tax stays as shares in that account (add a general investment account under Accounts to keep them).') : null,
            item.kind === 'salary' && item.bonus > 0 ? field('Bonus varies by', numInput(...bind(item, 'bonusVary'), { min: 0, max: 100, step: 10, suffix: '± %', label: 'Bonus varies by' }),
              `A typical good or bad year: ±${item.bonusVary}% is about ${money(item.bonus * (1 - item.bonusVary / 100))}–${money(item.bonus * (1 + item.bonusVary / 100))}. The plan uses ${money(item.bonus)}; simulations try good and bad years.`) : null,
            item.kind === 'salary' || item.kind === 'self' || item.kind === 'other' || item.kind === 'rental'
              ? field('Varies from year to year', numInput(...bind(item, 'vary'), { min: 0, max: 60, step: 5, suffix: '± %', label: 'Varies by' }), 'For income that is up and down, like self-employed profit: a typical good or bad year, e.g. ±15% for £38,000–£52,000 around £45,000. The plan uses the average; the simulations try good and bad years.') : null,
            noteField(item)),
          item.kind !== 'rental' && hasCosts ? h('p', { class: 'hint calc', 'data-calc': item.id }, incomeWorking(item, p)) : null,
          isSalary && item.owner !== 'joint' ? h('div', { class: 'sub-fields' },
            h('h3', {}, 'Workplace pension'),
            h('div', { class: 'fields', style: 'margin-top:8px' },
              field('Pays into', selectInput([['pot', 'A pension pot (defined contribution)'], ['db', 'A defined benefit scheme (NHS, teachers, USS…)']], ...bind(item, 'pensionTo'), { rerender: 'income', label: 'Pension pays into' }),
                item.pensionTo === 'db' ? 'Taken off pay, but it builds the defined benefit pension (under Other income), not a pot.' : 'Builds the pension pot under Accounts.'),
              field('Contributions as', selectInput([['pct', '% of salary'], ['fixed', '£ per month']], ...bind(item, 'pensionMode'), { rerender: 'income' })),
              field('You pay', item.pensionMode === 'pct' ? numInput(...bind(item, 'employeePension'), { step: 0.5, suffix: '%' }) : moneyInput(...bind(item, 'employeePension'))),
              field('Employer pays', item.pensionMode === 'pct' ? numInput(...bind(item, 'employerPension'), { step: 0.5, suffix: '%' }) : moneyInput(...bind(item, 'employerPension'))),
              item.pensionTo === 'db' ? potAlongside(item) : null,
              !ignore
                ? h('div', { class: 'field' }, h('span', {}, 'Paid by'), switchInput('Salary sacrifice', ...bind(item, 'sacrifice')), h('span', { class: 'hint' }, item.tax === 'uk' ? 'Saves NI too (only on the first £2,000 a year from April 2029).' : 'Take-home pay is after your contributions; both still go into the pot. With salary sacrifice, the plan can also keep your income under £100,000.'))
                : h('p', { class: 'hint', style: 'align-self:center' }, 'Take-home pay is after your contributions; both still go into the pot.'))) : null),
        h('details', { class: 'trend' },
          h('summary', {}, 'Typical trend'),
          h('p', { class: 'hint' }, `Dashed: the expected path. Shaded: where 50% and 80% of simulations land, with ${isSalary ? 'salary and ' : ''}inflation surprises. In ${unitLabel()}, after costs.`),
          h('div', { class: 'chart mini', 'data-trend': item.id }),
          h('p', { class: 'trend-caption sub' })));
    };
    const line = item => {
      const grow = item.kind === 'annuity' ? `from ${item.startAge}, ${item.inflationLinked ? 'rising with prices' : 'fixed'}` : item.kind === 'dbpension' ? (inPayment(item, p) ? 'being paid now' : `paid from ${item.startAge}`) : item.inflationLinked ? 'rises with prices' : `rises ${item.growth}% a year${item.growthUntilAge ? ` to ${item.growthUntilAge}, then ${item.growthAfter}%` : ''}${(item.raises || []).length ? `, ${item.raises.length} promotion${item.raises.length === 1 ? '' : 's'}` : ''}`;
      const db = item.kind === 'dbpension' ? (() => { const x = people()[E.personIndex(p, item.owner)]; const t = Math.max(0, item.startAge - x.age); return E.incomeAfterCosts(item, p, t) / Math.pow(1 + p.assumptions.inflation / 100, t); })() : 0;
      return {
        name: item.name,
        sub: [kindLabel(item.kind), ownerName(p, item.owner), item.bonus > 0 ? `+ ${money(item.bonus)} bonus a year` : null, item.shares > 0 ? `+ ${money(item.shares)} share awards a year` : null, item.kind === 'dbpension' || item.kind === 'annuity' ? null : untilText(item, p), grow, noteText(item)].filter(Boolean).join(' · '),
        value: item.kind === 'dbpension' ? `${money(db)} a year` : item.kind === 'annuity' ? `${money(item.amount)} a year` : incomeValue(item, p).main,
        valueSub: item.kind === 'dbpension' || item.kind === 'annuity' ? (inPayment(item, p) ? 'now, rising with prices' : `from ${item.startAge}, today’s money`) : [item.tax === 'none' ? (item.kind === 'salary' ? 'take-home' : 'no tax') : item.tax === 'uk' ? 'before tax' : `after ${item.taxRate}% tax`, incomeValue(item, p).other].filter(Boolean).join(' · '),
      };
    };
    const items = p.income.map(item => viewOrEdit(item.id, 'income', item.kind === 'dbpension' || item.kind === 'annuity' ? '--s4' : '--s1', line(item), () => editorOf(item)));
    return [
      sectionHead('income', 'Income', 'Salaries, rent, gifts and pensions, as at the date above; each grows from there. Click one to change it.'),
      sectionSummary('income', () => [['Coming in this year', `${money(inOutSeries()[0].inn / 12)} a month`, 'after tax and pension contributions'], ['From work', `${money(p.income.filter(i => i.kind === 'salary' || i.kind === 'self').reduce((acc, i) => acc + E.incomeAfterCosts(i, p, 0), 0) / 12)} a month`, 'pay and self-employed profit, as entered'], ['Other income', `${money(p.income.filter(i => i.kind !== 'salary' && i.kind !== 'self').reduce((acc, i) => acc + E.incomeAfterCosts(i, p, 0), 0) / 12)} a month`, 'rent, gifts, pensions now']]),
      h('div', { class: 'sum-list' }, items.length ? items : h('p', { class: 'sub' }, 'No income yet.')),
      h('div', { class: 'add-row' }, KIND_LABELS.map(([kind, label]) => h('button', { type: 'button', class: 'btn small', onclick: () => {
        const item = E.normalizePlan({ ...p, income: [{ name: kind === 'dbpension' ? 'Defined benefit pension' : kind === 'salary' ? 'Salary' : label, owner: 'p1', kind, tax: kind === 'salary' ? 'uk' : 'none', amount: 0, freq: kind === 'dbpension' || kind === 'salary' ? 'year' : 'month', growth: kind === 'salary' ? 3 : 0, inflationLinked: kind !== 'salary' }] }).income[0];
        setKind(item, kind);
        p.income.push(item);
        editing.add(item.id);
        showNew(item.id);
        renderSection('income');
        refresh();
      } }, `+ ${kind === 'dbpension' ? 'Defined benefit pension' : label}`))),
    ];
  }

  function incomeTag(item, p) {
    const afterCosts = E.incomeAfterCosts(item, p, 0);
    const net = E.taxOf(item, p) === 'flat' ? afterCosts * (1 - item.taxRate / 100) : afterCosts;
    return net > 0 ? `${money(net / 12)}/month now` : notYetText(item, p);
  }

  // Why an income has nothing this year: no amount yet, or when it starts.
  function notYetText(item, p) {
    if (!(item.amount > 0)) return 'Amount still to fill in';
    const at = t => (item.kind ? E.incomeAfterCosts(item, p, t) : E.streamAt(item, p, t));   // income, or an expense
    for (let t = 1; t < 80; t++) if (at(t) > 0) return `From ${p.startYear + t}`;
    return 'Not this year';
  }

  // This year's amount in the unit it was typed in ("£135,000 a year"), and the other unit.
  function incomeValue(item, p) {
    const afterCosts = E.incomeAfterCosts(item, p, 0);
    const net = E.taxOf(item, p) === 'flat' ? afterCosts * (1 - item.taxRate / 100) : afterCosts;
    if (!(net > 0)) return { main: notYetText(item, p), other: '' };
    return item.freq === 'year' ? { main: `${money(net)} a year`, other: `${money(net / 12)} a month` } : { main: `${money(net / 12)} a month`, other: `${money(net)} a year` };
  }

  // Keep the per-income figures in step with edits without re-rendering the inputs.
  function updateIncomeFigures() {
    const p = plan();
    for (const el of $$('[data-net]')) { const it = p.income.find(i => i.id === el.dataset.net); if (it) el.textContent = incomeTag(it, p); }
    for (const el of $$('[data-calc]')) { const it = p.income.find(i => i.id === el.dataset.calc); if (it) el.textContent = it.kind === 'dbpension' ? dbWorking(it, p) : incomeWorking(it, p); }
    for (const el of $$('[data-annuity]')) { const it = p.income.find(i => i.id === el.dataset.annuity); if (it) el.textContent = annuityWorking(it, p); }
    for (const el of $$('[data-buy]')) { const a = p.accounts.find(x => x.id === el.dataset.buy); if (a) el.textContent = buyWorking(a); }
    for (const el of $$('[data-loan]')) { const x = people().find(q => q.id === el.dataset.loan); if (x) el.textContent = loanWorking(x); }
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
    const rowOf = item => {
      const amt = E.streamAt(item, p, 0);
      const moreKey = `expense-${item.id}`;
      const more = h('details', { open: openMore.has(moreKey) },
        h('summary', { class: 'btn small ghost', 'aria-label': `More options for ${item.name}` }, 'More'));
      const panel = h('div', { class: 'row-more', hidden: !openMore.has(moreKey) },
        h('div', { class: 'fields' },
          growthControl(item, 'expenses'),
          field('Starts', timingControl(item, 'start', 'expenses')),
          people().length > 1 ? field('Ages refer to', selectInput(ownerOptions(false), () => (item.owner === 'joint' ? 'p1' : item.owner), v => { item.owner = v; }, { label: 'Ages refer to' })) : null,
          noteField(item)));
      more.addEventListener('toggle', () => { panel.hidden = !more.open; if (more.open) openMore.add(moreKey); else openMore.delete(moreKey); });
      return h('div', { class: 'row-item', style: `--item-color:${cssVar('--s5')}` },
        h('div', { class: 'row-main' },
          h('div', { class: 'name-cell' },
            h('input', { type: 'text', class: 'name', value: item.name, 'aria-label': 'Expense name', oninput: e => { item.name = e.target.value; schedule(); } }),
            amt <= 0 ? h('span', { class: 'tag' }, notYetText(item, p)) : item.category ? h('span', { class: 'tag' }, item.category) : null),
          moneyInput(...bind(item, 'amount'), { label: `${item.name} amount` }),
          selectInput([['month', 'a month'], ['year', 'a year']], ...bind(item, 'freq'), { label: 'Frequency', rerender: 'expenses' }),
          timingControl(item, 'end', 'expenses'),
          more,
          deleteButton(`Remove ${item.name}`, () => removeFrom(p.expenses, item, 'expenses'))),
        panel);
    };
    const rows = p.expenses.map(item => {
      const amt = E.streamAt(item, p, 0);
      return viewOrEdit(item.id, 'expenses', (item.key || '').startsWith('life:') ? '--s7' : '--s5', {
        name: item.name,
        sub: [item.category, untilText(item, p), item.inflationLinked ? null : `rises ${item.growth}% a year`, amt <= 0 ? 'not this year' : null, noteText(item)].filter(Boolean).join(' · '),
        value: `${money(item.amount)} a ${item.freq === 'month' ? 'month' : 'year'}`,
      }, () => h('div', { class: 'rows' }, rowOf(item)));
    });

    const s = p.strategy;
    const adjust = [];
    if (s.spendNowPct !== 100) adjust.push(`scaled to ${s.spendNowPct}% before retirement`);
    if (s.retireSpending > 0) adjust.push(`replaced by ${money(s.retireSpending)} a year after retirement`);
    return [
      sectionHead('expenses', 'Spending', 'Bills paid over 10 months, like council tax: enter the year’s total as “a year”.',
        h('button', { type: 'button', class: 'btn small primary', onclick: openWizard }, 'Spending check-up'),
        h('button', { type: 'button', class: 'btn small', id: 'lifeBtn', onclick: openLifeWizard, title: 'Children, cars, home repairs, retirement travel and care: big costs that come later, added as dated spending items' }, 'Future costs'),
        h('button', { type: 'button', class: 'btn small', onclick: () => { const e = E.normalizePlan({ ...p, expenses: [{ name: 'New expense', amount: 0, freq: 'month', inflationLinked: true }] }).expenses[0]; p.expenses.push(e); editing.add(e.id); renderSection('expenses'); refresh(); showNew(e.id); } }, '+ Add expense')),
      sectionSummary('expenses', () => {
        const q = plan();
        const now2 = q.expenses.reduce((acc, e) => acc + E.streamAt(e, q, 0), 0);
        const life2 = q.expenses.filter(e => (e.key || '').startsWith('life:')).reduce((acc, e) => acc + E.streamAt(e, q, 0), 0);
        const later2 = q.expenses.filter(e => E.streamAt(e, q, 0) <= 0).length;
        return [['Spending this year', `${money(now2 / 12)} a month`, `${money(now2)} a year`], life2 > 0.5 ? ['Of which future costs', `${money(life2 / 12)} a month`, 'from Future costs'] : null, later2 ? ['Starting later', `${later2} item${later2 === 1 ? '' : 's'}`, 'not paid this year'] : null];
      }),
      h('p', { class: 'hint', style: 'margin:0 0 10px' }, `Today’s prices, rising with inflation unless an item says otherwise. Mortgage payments are under Accounts.${adjust.length ? ` Your saving strategy has this list ${adjust.join(' and ')}.` : ''} Click an item to change it.`),
      rows.length
        ? h('div', { class: 'sum-list' }, rows)
        : h('p', { class: 'sub' }, 'No spending yet. The check-up walks you through it.'),
    ];
  }

  function renderEvents() {
    const p = plan();
    const KIND = { expense: 'Spend', income: 'Receive', overpay: 'Pay off a loan' };
    const rows = p.events.slice().sort((a, b) => a.year - b.year).map(ev => viewOrEdit(ev.id, 'events', ev.kind === 'income' ? '--s3' : ev.kind === 'overpay' ? '--s8' : '--s7',
      { name: ev.name, sub: [KIND[ev.kind], noteText(ev)].filter(Boolean).join(' · '), value: `${ev.kind === 'income' ? '+' : '−'}${money(ev.amount)}`, valueSub: `in ${ev.year}, today’s money` }, () => h('div', { class: 'rows events' }, h('div', { class: 'row-item', style: `--item-color:${cssVar(ev.kind === 'income' ? '--s3' : ev.kind === 'overpay' ? '--s8' : '--s7')}` },
      h('div', { class: 'row-main' },
        h('div', { class: 'name-cell' }, h('input', { type: 'text', class: 'name', value: ev.name, 'aria-label': 'Event name', oninput: e => { ev.name = e.target.value; schedule(); } })),
        selectInput([['expense', 'Spend'], ['income', 'Receive'], ['overpay', 'Pay off a loan']], ...bind(ev, 'kind'), { rerender: 'events', label: 'Kind' }),
        ev.kind === 'overpay' && p.accounts.filter(a => a.type === 'debt').length > 1
          ? selectInput([['', 'The dearest first'], ...p.accounts.filter(a => a.type === 'debt').map(a => [a.id, a.name])], ...bind(ev, 'debtId'), { label: 'Which loan' }) : null,
        numInput(...bind(ev, 'year'), { min: p.startYear, max: p.startYear + 80, label: 'Year' }),
        moneyInput(...bind(ev, 'amount'), { label: `${ev.name} amount` }),
        deleteButton(`Remove ${ev.name}`, () => removeFrom(p.events, ev, 'events'))),
      h('div', { class: 'row-note' }, noteField(ev))))));
    return [
      sectionHead('events', 'One-off events', "A new car, a wedding, an inheritance, a lump-sum mortgage overpayment. Amounts are in today's money and rise with inflation to the year they happen.",
        h('button', { type: 'button', class: 'btn small', onclick: () => { const ev = E.normalizePlan({ ...p, events: [{ name: 'New event', kind: 'expense', year: p.startYear + 1, amount: 0 }] }).events[0]; p.events.push(ev); editing.add(ev.id); renderSection('events'); refresh(); showNew(ev.id); } }, '+ Add event')),
      rows.length
        ? h('div', { class: 'sum-list' }, rows)
        : h('p', { class: 'sub' }, 'No events.'),
    ];
  }

  const ACCOUNT_LABELS = {
    cash: 'Cash & savings', isa: 'ISA', lisa: 'Lifetime ISA', gia: 'General investment account', pension: 'Pension (workplace / SIPP)',
    bonds: 'Bonds & gilts', property: 'Property', asset: 'Other asset', debt: 'Mortgage or loan',
  };

  // Pay in a defined benefit scheme can also pay into a pot (USS: the Investment Builder, with
  // The Match of 1% + 1%). Contributions into it by the same salary sacrifice as the pay.
  function potAlongside(item) {
    const pct = item.potMode === 'pct';
    const match = () => {
      // The Match: 1% from you, 1% from the employer, added to anything else paid in.
      if (pct) { item.potEmployee = Math.round(((item.potEmployee || 0) + 1) * 100) / 100; item.potEmployer = Math.round(((item.potEmployer || 0) + 1) * 100) / 100; } else {
        const v = E.incomeAfterCosts(item, plan(), 0) / 12 * 0.01;
        item.potEmployee = Math.round(((item.potEmployee || 0) + v) * 100) / 100; item.potEmployer = Math.round(((item.potEmployer || 0) + v) * 100) / 100;
      }
      renderSection('income'); refresh();
    };
    return h('div', { class: 'field-group pot-alongside' },
      h('h4', {}, 'Also into a pension pot'),
      h('p', { class: 'hint' }, 'Extra contributions into a pot next to the scheme, such as the USS Investment Builder. They build the pension pot under Accounts.'),
      h('div', { class: 'fields' },
        field('Contributions as', selectInput([['pct', '% of salary'], ['fixed', '£ per month']], ...bind(item, 'potMode'), { rerender: 'income', label: 'Pot contributions as' })),
        field('You pay into the pot', pct ? numInput(...bind(item, 'potEmployee'), { step: 0.5, suffix: '%', label: 'You pay into the pot' }) : moneyInput(...bind(item, 'potEmployee'), { label: 'You pay into the pot' })),
        field('Employer adds', pct ? numInput(...bind(item, 'potEmployer'), { step: 0.5, suffix: '%', label: 'Employer adds to the pot' }) : moneyInput(...bind(item, 'potEmployer'), { label: 'Employer adds to the pot' })),
        h('div', { class: 'field' }, h('span', {}, 'USS'), h('button', { type: 'button', class: 'btn small', onclick: match }, 'Add The Match (1% + 1%)'))));
  }

  // "In 2030 it costs about £247,600: a £24,800 deposit from your savings and a £222,800 mortgage…"
  function buyWorking(a) {
    const p = plan();
    const t = Math.max(0, a.buyYear - p.startYear);
    const price = a.balance * Math.pow(1 + a.rate / 100, t);
    const loan = price * (1 - a.deposit / 100);
    // As the plan pays it: once a year over the term (a month is a twelfth).
    const i = a.mortRate / 100, m = a.mortYears;
    const pay = loan > 0 ? (i > 0 ? loan * i / (1 - Math.pow(1 + i, -m)) : loan / m) / 12 : 0;
    // Lenders usually lend up to about 4.5 times the household's pay before tax.
    let multiple = '';
    if (loan > 0 && model && t < model.proj.pre.N) {
      const g = model.proj.pre.g[t] || 1;
      const pay = model.proj.pre.people.reduce((acc, P) => acc + P.gross[t] + P.selfProfit[t] + (P.netPay[t] > 0 ? R.grossFromTakeHome(P.netPay[t] / g, p.household.region) * g : 0), 0);
      const x = pay > 0 ? loan / pay : Infinity;
      if (x > 4.5) multiple = ` That is ${Number.isFinite(x) ? `${x.toFixed(1)} times` : 'more than'} your pay before tax then (${money(pay)} a year); lenders usually stop at about 4.5 times, so a bigger deposit, a cheaper home or a later year may be needed.`;
    }
    // Moving from a home you own (sold that year), or buying while renting.
    const selling = p.accounts.find(x => x.type === 'property' && x !== a && !x.buyYear && x.sellYear === a.buyYear);
    const renting = !p.accounts.some(x => x.type === 'property' && x !== a && !x.excluded && !x.buyYear);
    // A Lifetime ISA saved for a first home is paid out that year.
    const lisa = p.accounts.filter(x => x.type === 'lisa' && !x.excluded && x.purpose === 'home' && E.lisaHomeYear(p, x) === a.buyYear);
    const lisaText = lisa.length ? (price > R.LISA.homePriceCap ? ` The home costs more than ${money(R.LISA.homePriceCap)}, so the Lifetime ISA cannot be used for it without losing 25%.` : ' Your Lifetime ISA, with its bonus, is paid out towards it.') : '';
    return `In ${a.buyYear} it costs about ${money(price)}:${lisaText} ${money(price - loan)} paid from ${selling ? `the sale of ${selling.name} and your savings` : 'your savings'}${loan > 0 ? ` and a ${money(loan)} mortgage, about ${money(pay)} a month for ${a.mortYears} years` : ''}.${multiple} Add stamp duty and moving costs as a one-off event${renting ? ', and end your rent that year' : ''}.`;
  }

  // A note on any item, for arrangements the plan cannot spell out (who it is with, what was agreed).
  function noteField(item) {
    return h('label', { class: 'field note-field' }, h('span', {}, 'Note'),
      h('textarea', { rows: 2, maxlength: 500, 'aria-label': 'Note', placeholder: 'Anything worth remembering: who it is with, what was agreed, why this figure', oninput: e => { item.note = e.target.value; schedule(); } }, item.note || ''));
  }
  const noteText = item => (item.note ? `“${item.note.length > 60 ? `${item.note.slice(0, 57)}…` : item.note}”` : null);

  // When a loan is paid off at its payment and today's rate, and whether that fits the years left.
  function payoffText(a) {
    if (!(a.balance > 0) || !(a.payment > 0)) return '';
    const i = a.rate / 100 / 12, m = a.payment;
    if (m <= a.balance * i) return 'This payment doesn’t cover the interest, so the loan never ends.';
    const months = i > 0 ? -Math.log(1 - (i * a.balance) / m) / Math.log(1 + i) : a.balance / m;
    const end = Math.round(plan().startYear + months / 12);
    let out = `At this payment it’s paid off in about ${end} (${Math.round(months / 12)} years, at ${a.rate}%).`;
    if (a.termYears > 0 && Math.abs(months / 12 - a.termYears) >= 1.5) {
      const n = a.termYears * 12, need = i > 0 ? (a.balance * i) / (1 - Math.pow(1 + i, -n)) : a.balance / n;
      out += ` To clear it in ${a.termYears} years the payment would be about ${money(need)} a month: check the balance, rate and payment on the statement.`;
    }
    return out;
  }

  const moveDraft = {};   // "Move to a smaller home": the year and price being typed, by home id

  function renderAccounts() {
    const p = plan();
    const items = p.accounts.map(a => {
      const main = [];
      const extra = [];
      const buying = a.type === 'property' && a.buyYear > 0;
      if (a.type === 'property') main.push(field('Do you own it?', selectInput([['now', 'I own it now'], ['later', 'Buying it later']], () => (a.buyYear > 0 ? 'later' : 'now'),
        v => { a.buyYear = v === 'later' ? plan().startYear + 3 : 0; if (v === 'later' && people().every(x => x.retireAge <= x.age)) { a.deposit = 100; a.mortYears = 10; } }, { rerender: 'accounts', label: 'Own it now or buying later' })));   // retired: bought outright, as a rule
      main.push(field(buying ? 'Price today' : a.type === 'property' || a.type === 'asset' ? 'Value' : a.type === 'debt' ? 'Amount owed' : 'Balance', moneyInput(() => a.balance, v => { a.balance = v; if (a.type !== 'gia') a.basis = v; }),
        buying ? 'What a home like it costs now; it rises with house prices until you buy.' : null));
      if (E.OWNED_TYPES.includes(a.type)) main.push(field('Whose', selectInput(ownerOptions(false), ...ownerBind(a), { rerender: 'accounts' })));
      else if (people().length > 1) extra.push(field('Whose', selectInput(ownerOptions(true), ...ownerBind(a), { label: 'Whose', rerender: 'accounts' }), 'Joint, or one person’s.'));
      if (a.type === 'lisa') {
        main.push(field('Pay in each year', moneyInput(...bind(a, 'contribution')), `Up to ${money(R.LISA.maxContribution)}; the government adds 25%. Paid from your surplus before other ISAs, until 50.`));
        // Only someone who has never owned a home can use it for one.
        if (!E.ownsHome(plan()) || a.purpose === 'home') extra.push(field('Saving for', selectInput([['retirement', 'Retirement (from 60)'], ['home', 'A first home']], ...bind(a, 'purpose'), { rerender: 'accounts' })));
        if (a.purpose === 'home') {
          const home = plan().accounts.find(x => x.type === 'property' && !x.excluded && x.buyYear >= plan().startYear);
          extra.push(field('Buying in', numInput(...bind(a, 'homeYear'), { min: 0, max: plan().startYear + 40, label: 'First home year' }),
            home ? `0 = when you buy ${home.name} (${home.buyYear}). Paid out that year towards the deposit, with no charge if the home costs up to ${money(R.LISA.homePriceCap)}.`
              : `Paid out that year with no charge if the home costs up to ${money(R.LISA.homePriceCap)}. Add the home under Accounts as “Buying it later” for the deposit and mortgage.`));
        }
        extra.push(h('p', { class: 'hint' }, `Withdrawals before 60 for anything else lose 25%, so the plan only uses it that way as a last resort. It counts within the ${money(R.ISA_ALLOWANCE)} ISA allowance and must be opened before 40.`));
      }
      if (a.type === 'pension') extra.push(h('div', { class: 'field' }, h('span', {}, 'Inherited'),
        switchInput('Inherited from someone who died before 75', ...bind(a, 'inherited'), { rerender: 'accounts' }),
        h('span', { class: 'hint' }, a.inherited ? 'Tax-free to take out, at any age, so the plan draws it before taxed pension and ISAs. (If they died at 75 or over, leave this off: it is taxed as your income.)' : 'A pension left to you by someone who died before 75 is tax-free to draw.')));
      if (a.type === 'isa') main.push(field('Held as', selectInput([['invested', 'Stocks & shares (invested)'], ['cash', 'Cash ISA']], ...bind(a, 'holding'), { rerender: 'accounts', label: 'Held as' }),
        a.holding === 'cash' ? 'Earns the cash rate, doesn’t fall, and counts as cash for an emergency fund.' : 'Grows with your investment mix; it can fall in a bad year.'));
      if (a.type === 'cash') extra.push(h('p', { class: 'hint' }, 'Premium Bonds go here too: no interest, but prizes average about the cash rate, tax-free, and you can take the money out within days.'));
      if (a.type === 'gia') extra.push(field('Amount you paid in', moneyInput(...bind(a, 'basis')), 'Used to work out capital gains.'));
      if (a.type === 'gia') extra.push(h('div', { class: 'field' }, h('span', {}, 'Holds'),
        switchInput('One company’s shares (e.g. from work)', ...bind(a, 'oneCompany'), { rerender: 'accounts' }),
        h('span', { class: 'hint' }, 'So Horizon can warn when too much rides on one company. The plan still grows it like your other investments.')));
      if (a.type === 'bonds') {
        main.push(field('Interest', numInput(...bind(a, 'rate'), { step: 0.05, suffix: '%' })));
        extra.push(field('Matures in', numInput(...bind(a, 'maturityYear'), { min: 0, max: 2100 }), a.inIsa ? '0 = never. Pays out into the ISA.' : '0 = never. Pays out into cash.'));
        extra.push(h('div', { class: 'field' }, h('span', {}, 'Wrapper'),
          switchInput('Held in an ISA', ...bind(a, 'inIsa'), { rerender: 'accounts' }),
          h('span', { class: 'hint' }, 'When it matures the money stays in the ISA, without using that year’s allowance.')));
        extra.push(field('Coupons', selectInput([['reinvest', 'Bought back into gilts'], ['payout', a.inIsa ? 'Into the ISA’s other investments' : 'Paid out as cash']], ...bind(a, 'coupons'), { rerender: 'accounts', label: 'Coupons' }),
          `About ${money(a.balance * a.rate / 100)} a year, paid in two halves. Small amounts are dear to buy gilts with (a dealing charge each time); adding them to your monthly fund purchase costs nothing extra.`));
      }
      if (a.type === 'property') {
        main.push(field('Growth', numInput(...bind(a, 'rate'), { step: 0.1, suffix: '%/yr' }), 'Average; simulations add swings.'));
        if (buying) {
          main.push(field('Buy in', numInput(...bind(a, 'buyYear'), { min: plan().startYear, max: plan().startYear + 40, label: 'Year you buy it', rerender: 'accounts' })));
          main.push(field('Deposit', numInput(...bind(a, 'deposit'), { min: 0, max: 100, step: 1, suffix: '% of price', label: 'Deposit', rerender: 'accounts' }), '100% = no mortgage (e.g. buying with the money from a sale).'));
          if (a.deposit < 100) {
            main.push(field('Mortgage rate', numInput(...bind(a, 'mortRate'), { step: 0.05, suffix: '%', label: 'Mortgage rate' })));
            main.push(field('Mortgage over', numInput(...bind(a, 'mortYears'), { min: 1, max: 40, suffix: 'years', label: 'Mortgage years' })));
          }
          main.push(h('p', { class: 'hint calc', 'data-buy': a.id }, buyWorking(a)));
          const hasGoal = plan().goals.some(g => g.icon === 'home' && g.year === a.buyYear);
          if (!hasGoal && a.deposit > 0) main.push(h('div', { class: 'add-row' }, h('button', { type: 'button', class: 'btn small', onclick: () => {
            const p = plan();
            const t = Math.max(0, a.buyYear - p.startYear);
            const price = a.balance * Math.pow(1 + a.rate / 100, t);
            const need = Math.round(price * a.deposit / 100 / 1000) * 1000;
            const g = E.normalizeGoal({ type: 'netWorth', name: `Deposit for ${a.name}`, icon: 'home', measure: 'savings', basis: 'nominal', amount: need, year: a.buyYear, confidence: 80, color: nextGoalColour() }, p.startYear, people()[0], people());
            for (const s of ws.scenarios) s.plan.goals = E.assignGoalColours(s.plan.goals.concat([{ ...g }]));
            afterScenarioChange();
            toast(`Goal added: ${money(need)} in savings by the start of ${a.buyYear}, for the deposit. Its tab shows the chance and what moves it.`);
          } }, `+ Goal: the deposit by ${a.buyYear}`)));
        }
        extra.push(field('Sell in year', numInput(...bind(a, 'sellYear'), { min: 0, max: 2100 }), '0 = keep. Sale money is saved or invested; to move, add the next home as “Buying it later” in the same year.'));
        if (!buying) {
          extra.push(h('div', { class: 'field-group pot-alongside equity-release' },
            h('h4', {}, 'Equity release (a lifetime mortgage)'),
            h('p', { class: 'hint' }, 'Money from the home while you live in it: nothing to pay back each month, but interest rolls up and is repaid when the home is sold (or from the estate). It can never be more than the home is worth. Otherwise the plan never sells the home to pay for spending: it is part of what you leave.'),
            h('div', { class: 'fields' },
              field('In year', numInput(...bind(a, 'releaseYear'), { min: 0, max: 2100, label: 'Equity release year', rerender: 'accounts' }), '0 = none.'),
              a.releaseYear ? field('Amount (today’s money)', moneyInput(...bind(a, 'releaseAmount'), { label: 'Equity release amount' }), 'Usually 20–50% of the home’s value, more the older you are.') : null,
              a.releaseYear ? field('Interest', numInput(...bind(a, 'releaseRate'), { step: 0.1, suffix: '%', label: 'Equity release interest' }), 'Fixed for life; 6–7% is typical. At 6.5% what is owed doubles in about 11 years.') : null)));
        }
        if (!buying && !a.sellYear) {
          const mv = moveDraft[a.id] || (moveDraft[a.id] = { year: plan().startYear + 10, price: Math.round(a.balance * 0.6 / 1000) * 1000 });
          extra.push(h('div', { class: 'field-group pot-alongside move-home' },
            h('h4', {}, 'Move to a smaller home'),
            h('p', { class: 'hint' }, 'Sells this home in that year and buys the next one outright from the sale, with about 5% for stamp duty and moving. The rest of the sale is saved or invested.'),
            h('div', { class: 'fields' },
              field('Move in', numInput(() => mv.year, v => { mv.year = Math.round(v); }, { min: plan().startYear + 1, max: plan().startYear + 50, label: 'Year to move' })),
              field('The smaller home costs (today)', moneyInput(() => mv.price, v => { mv.price = v; }, { label: 'Price of the smaller home' })),
              h('div', { class: 'field' }, h('span', {}, ' '), h('button', { type: 'button', class: 'btn small', onclick: () => {
                SI.downsize(plan(), a.id, mv.year, mv.price);
                delete moveDraft[a.id];
                renderSection('accounts'); refresh();
                toast(`Set up: ${a.name} is sold in ${mv.year} and a ${money(mv.price)} home (today’s price) bought outright. Change either under Accounts.`);
              } }, 'Set up the move')))));
        }
      }
      if (a.type === 'asset') {
        main.push(field('Growth', numInput(...bind(a, 'rate'), { step: 0.1, min: -50, suffix: '%/yr' }), 'Average a year; negative if it loses value (e.g. a car).'));
        extra.push(field('Sell in year', numInput(...bind(a, 'sellYear'), { min: 0, max: 2100 }), '0 = keep. The money is then saved or invested.'));
        extra.push(h('p', { class: 'hint' }, 'Something you own that is not money in an account: a business, your share of a family property, land, a car or art you will sell. It counts in net worth but not as money to spend until it is sold.'));
      }
      if (a.type === 'debt') {
        main.push(field('Interest rate', numInput(...bind(a, 'rate'), { step: 0.05, suffix: '%' })));
        main.push(field('Monthly payment', moneyInput(...bind(a, 'payment')), h('span', { 'data-payoff': a.id }, payoffText(a))));
        extra.push(field('Years left on the loan', numInput(...bind(a, 'termYears'), { min: 0, max: 40, label: 'Years left on the loan', rerender: 'accounts' }), '0 = not sure. From the statement; checked against the payment.'));
        extra.push(field('Rate fixed until', numInput(...bind(a, 'fixedUntil'), { min: 0, max: 2100, rerender: 'accounts' }), '0 = fixed for good. The new rate applies from the following year.'));
        const buy = p.accounts.find(x => x.type === 'property' && x.buyYear >= p.startYear);
        extra.push(field('Written off in', numInput(...bind(a, 'forgiveYear'), { min: 0, max: 2100, label: 'Year the loan is written off' }),
          `0 = paid back in full. E.g. family who will let you off what is left${buy ? ` when you buy ${buy.name} (${buy.buyYear})` : ''}: whatever is still owed then is cleared, at no cost to you.`));
        if (a.fixedUntil) {
          extra.push(field('Rate after the fix ends', optNumInput(...bind(a, 'rateAfterFix'), { placeholder: `Same (${a.rate}%)`, suffix: '%', step: 0.05, label: 'Rate after the fix ends' }),
            `Empty = the same rate.${MARKET ? ` Bank Rate is ${MARKET.series.bankRate.value}% (${MARKET.series.bankRate.date}).` : ''} Simulations also move it with inflation surprises.`));
          extra.push(field('When the fix ends', selectInput([['payment', 'Same payment, ends later'], ['term', 'Same end date, new payment']], ...bind(a, 'afterFix'), { label: 'When the fix ends' }),
            'Lenders usually reset the payment to keep the end date; keeping the payment shows how long it would take.'));
        }
      }
      extra.push(h('div', { class: 'field' }, h('span', {}, 'In the plan'),
        switchInput('Count this account', () => !a.excluded, v => { a.excluded = !v; }, { rerender: 'accounts' }),
        h('span', { class: 'hint' }, 'Turn off for something you want to list but not count, e.g. a home owned by family or a child’s savings.')));
      extra.push(noteField(a));
      return viewOrEdit(a.id, 'accounts', TYPE_COLOR[a.type], {
        name: a.name,
        sub: [ACCOUNT_LABELS[a.type], ownerName(p, a.owner), a.type === 'debt' ? `${a.rate}%${a.fixedUntil ? ` fixed to ${a.fixedUntil}` : ''}` : null, a.type === 'property' && a.buyYear ? `buying in ${a.buyYear}, ${a.deposit}% deposit` : null, a.excluded ? 'not counted' : null, noteText(a)].filter(Boolean).join(' · '),
        value: `${a.type === 'debt' ? '−' : ''}${money(a.balance)}`,
        valueSub: h('span', { 'data-est': a.id }),
      }, () => h('div', { class: 'item' + (a.excluded ? ' excluded' : ''), style: `--item-color:${cssVar(TYPE_COLOR[a.type])}` },
        h('div', { class: 'item-head' },
          h('input', { type: 'text', class: 'name', value: a.name, 'aria-label': 'Account name', oninput: e => { a.name = e.target.value; schedule(); } }),
          h('span', { class: 'tag' }, a.excluded ? 'Not counted' : ACCOUNT_LABELS[a.type]),
          h('span', { class: 'tag est', 'data-est': a.id, title: 'Estimated value today, moved on from this figure the way the plan expects' }),
          deleteButton(`Remove ${a.name}`, () => removeFrom(p.accounts, a, 'accounts'))),
        h('div', { class: 'fields' }, main),
        more(`account-${a.id}`, 'More options', h('div', { class: 'fields' }, extra))));
    });

    const add = type => h('button', { type: 'button', class: 'btn small', onclick: () => addAccountOf(type) }, `+ ${ACCOUNT_LABELS[type]}`);
    return [
      sectionHead('accounts', 'Accounts', `What you had and owed on ${fmtDate(asOf())}. The yearly review brings them up to date; for a quick update between reviews, use Update balances on Home.`),
      sectionSummary('accounts', () => {
        const c = plan().accounts.filter(a => !a.excluded && !notYet(a));
        const o1 = c.filter(a => a.type !== 'debt').reduce((acc, a) => acc + a.balance, 0), o2 = c.filter(a => a.type === 'debt').reduce((acc, a) => acc + a.balance, 0);
        return [['You own', money(o1), `on ${fmtDate(asOf())}`], ['You owe', money(o2), 'mortgage and loans'], ['Net worth', money(o1 - o2), `today about ${money(model.est.netWorth)}`]];
      }),
      h('div', { class: 'sum-list' }, items),
      more('accounts-add', '+ Add an account', h('div', { class: 'add-row' }, Object.keys(ACCOUNT_LABELS).map(add))),
    ];
  }

  function renderStrategy() {
    const s = plan().strategy;
    return [
      sectionHead('strategy', 'Saving strategy', 'The order money left over goes in: the cash buffer, mortgage overpayments, Lifetime ISAs, ISAs, then a general investment account.'),
      h('div', { class: 'fields' },
        field('Cash buffer to keep', moneyInput(() => s.cashReserve, v => { s.cashReserve = v; s.autoBuffer = false; }, { label: 'Cash buffer to keep' }), s.autoBuffer ? 'Three months of your spending and debt payments, until you type your own amount. Topped up first; spent last in retirement.' : 'Topped up first; spent last in retirement.'),
        field('Overpay mortgage with', numInput(...bind(s, 'overpayPct'), { min: 0, max: 100, step: 5, suffix: '%' }), 'Share of the surplus. Try a range in Scenarios.'),
        field('Overpayment limit', numInput(...bind(s, 'overpayCapPct'), { min: 0, max: 100, step: 1, suffix: '%/yr' }), 'Of the balance. 0 = no limit. Many lenders allow 10% a year.'),
        field('ISA allowance per person', moneyInput(...bind(s, 'isaAllowance')), `${money(R.ISA_ALLOWANCE)} in ${R.TAX_YEAR}.`),
        allRetired() ? null : field('Spending before retirement', numInput(...bind(s, 'spendNowPct'), { min: 0, max: 300, step: 1, suffix: '%' }), 'Of your spending list. 100% = as listed.'),
        allRetired() ? null : h('div', { class: 'field' }, h('span', {}, 'Pension tax relief'), switchInput('Claim higher-rate relief', ...bind(s, 'claimRelief')),
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
      reservesEditor(),
      h('p', { class: 'sub', style: 'margin-top:12px' }, 'In retirement, money comes from: cash above the buffer → pensions up to each person’s tax-free allowance → a big pot also at the basic rates (20%, or up to 21% in Scotland), at a pace that would last the plan → general investment account → ISAs → pension taxed at 40% or more → the cash buffer.'),
    ];
  }

  // A new pot of money set aside, in the most likely account (savings in an ISA, the rest in cash).
  function addReserveOf(kind) {
    const p = plan();
    const accts = p.accounts.filter(a => E.RESERVE_ACCOUNTS.includes(a.type) && !a.excluded);
    const evNames = [...new Set(p.events.filter(e => e.kind === 'expense').map(e => e.name))];
    const items = p.expenses.filter(e => !(e.key || '').startsWith('life:'));
    const pick = types => (accts.find(a => types.includes(a.type)) || accts[0] || {}).id || '';
    const base = { kind, accountId: pick(kind === 'saving' ? ['isa', 'gia'] : ['cash']) };
    if (kind === 'saving') Object.assign(base, { eventName: evNames[0] || '', name: evNames[0] || 'Saving up' });
    if (kind === 'budget') {
      const e = items.find(x => x.freq === 'year' && !p.reserves.some(r => r.expenseId === x.id)) || items.find(x => x.freq === 'year') || items[0];
      if (!e) { toast('Add the spending item first (Finances → Spending).'); return; }
      Object.assign(base, { expenseId: e.id, name: e.name });
    }
    p.reserves.push(E.normalizePlan({ ...p, reserves: [base] }).reserves[0]);
    renderSection('strategy');
    schedule();
  }

  // Money set aside: one row per pot, and buttons to add each kind.
  function reservesEditor() {
    const p = plan();
    const accts = p.accounts.filter(a => E.RESERVE_ACCOUNTS.includes(a.type) && !a.excluded);
    const evNames = [...new Set(p.events.filter(e => e.kind === 'expense').map(e => e.name))];
    const items = p.expenses.filter(e => !(e.key || '').startsWith('life:'));
    const now = E.reservesAt(p, model && model.est ? model.est.years || 0 : 0);
    const rerender = () => { renderSection('strategy'); schedule(); };
    const KIND = { emergency: 'Emergency fund', saving: 'Saving up for a cost', budget: 'Yearly budget' };
    const rows = p.reserves.map((r, i) => {
      const cur = now[i] || r;
      const own = [
        field('Name', h('input', { type: 'text', value: r.name, 'aria-label': 'Name', oninput: e => { r.name = e.target.value; schedule(); } })),
        field('Held in', selectInput([['', 'Choose an account'], ...accts.map(a => [a.id, a.name])], ...bind(r, 'accountId'), { rerender: 'strategy', label: 'Held in' })),
      ];
      if (r.kind === 'emergency') {
        own.push(field('Amount', moneyInput(() => (r.amount === null ? p.strategy.cashReserve : r.amount), v => { r.amount = v; }, { label: 'Emergency fund amount' }),
          `Today’s money, rising with prices. The cash buffer is ${money(p.strategy.cashReserve)}.`));
      } else if (r.kind === 'saving') {
        own.push(field('For', evNames.length
          ? selectInput(evNames.map(n => [n, n]), () => r.eventName, v => { if (!r.name || r.name === r.eventName) r.name = v; r.eventName = v; }, { rerender: 'strategy', label: 'For' })
          : h('span', { class: 'hint' }, 'Add the cost under Spending → One-off events first.')),
          field('Already put aside', moneyInput(() => r.saved || 0, v => { r.saved = v > 0 ? v : null; }, { label: 'Already put aside' }),
            'What is in the account for it today. Money already there is spoken for, so Home does not count it as free, and only the rest has to be built up.'));
      } else {
        own.push(field('For', selectInput(items.map(e => [e.id, `${e.name} (${money(e.amount * (e.freq === 'month' ? 12 : 1))} a year)`]), () => r.expenseId, v => {
          const was = items.find(e => e.id === r.expenseId), now = items.find(e => e.id === v);
          if (now && (!r.name || (was && r.name === was.name))) r.name = now.name;
          r.expenseId = v;
        }, { rerender: 'strategy', label: 'For' })),
          field('Kept from last year', moneyInput(...bind(r, 'left'), { label: 'Kept from last year' }), 'Already in the account for it, e.g. not spent last year. Filled in by the yearly review; spent this year, so not counted in net worth.'));
      }
      return h('div', { class: 'reserve-item', 'data-reserve': r.id },
        h('div', { class: 'reserve-head' }, h('strong', {}, KIND[r.kind]), h('span', { class: 'hint' }, reserveText(cur)),
          h('button', { type: 'button', class: 'btn small ghost', 'aria-label': `Remove ${r.name}`, onclick: () => { p.reserves.splice(i, 1); rerender(); } }, 'Remove')),
        h('div', { class: 'fields' }, own));
    });
    const add = addReserveOf;
    return h('div', { class: 'reserves-edit', id: 'reservesEdit' },
      h('div', { class: 'sub-fields' }, h('h3', {}, 'Money set aside')),
      h('p', { class: 'hint' }, 'Mark the part of an account that is spoken for, so Home shows what is free to use. The plan already counts what each pot pays for (the cash buffer, one-off costs and the spending list), so nothing is taken twice.'),
      rows,
      h('div', { class: 'add-row' },
        h('button', { type: 'button', class: 'btn small', onclick: () => add('emergency') }, '+ Emergency fund'),
        h('button', { type: 'button', class: 'btn small', onclick: () => add('saving') }, '+ Saving up for a cost'),
        h('button', { type: 'button', class: 'btn small', onclick: () => add('budget') }, '+ Yearly budget')));
  }

  // What "Use suggested values" would change; if nothing would, it says so instead.
  function marketSuggest() {
    const a = plan().assumptions, sg = MARKET.suggested;
    const diff = [['inflation', 'Inflation'], ['cashRate', 'Cash interest'], ['bondReturn', 'Bond returns']]
      .filter(([k]) => a[k] !== sg[k].value).map(([k, label]) => ({ k, label, from: a[k], to: sg[k].value }));
    if (!diff.length) return h('p', { class: 'hint market-same' }, glyph('good'), ' Your plan already uses these values.');
    return h('div', { class: 'add-row' },
      h('span', { class: 'hint' }, diff.map(d => `${d.label} ${d.from}% → ${d.to}%`).join(' · ')),
      h('button', { type: 'button', class: 'btn small', onclick: () => {
        const A = plan().assumptions;
        for (const d of diff) A[d.k] = d.to;
        renderSection('market'); refresh();
        toast(`Updated: ${diff.map(d => `${d.label.toLowerCase()} ${d.to}%`).join(', ')}.`);
      } }, 'Use suggested values'));
  }

  function renderMarket() {
    const a = plan().assumptions;
    const out = [sectionHead('market', 'Markets & inflation', 'Long-run averages. The main ones are below; the rest are under “More options”.')];
    if (MARKET) {
      const sg = MARKET.suggested;
      out.push(h('div', { class: 'market-card' },
        h('h3', {}, `Latest UK data (as of ${MARKET.asOf})`),
        h('ul', {}, Object.values(MARKET.series).map(sr => h('li', {}, h('span', {}, sr.label, ' ', h('a', { href: sr.source, target: '_blank', rel: 'noopener noreferrer' }, 'source')), h('strong', {}, `${sr.value}% (${sr.date})`)))),
        h('p', { class: 'sub' }, 'Today’s figures move a lot from year to year; a plan over decades needs long-run averages instead:'),
        h('div', { class: 'table-wrap' }, h('table', { class: 'data mk-table' },
          h('thead', {}, h('tr', {}, ['', 'Today', 'For your plan', 'Why'].map(t => h('th', { scope: 'col' }, t)))),
          h('tbody', {}, [
            ['Inflation', MARKET.series.cpi, sg.inflation.value, `The Bank of England aims for 2%. Over decades inflation has mostly averaged near the target, so the plan uses 2% plus a third of today’s gap above it.`],
            ['Cash interest', MARKET.series.bankRate, sg.cashRate.value, 'Easy-access savings usually pay a little below Bank Rate.'],
            ['Bond returns', MARKET.series.gilt10y || Object.values(MARKET.series)[2], sg.bondReturn.value, 'Today’s gilt yield is the best guide to what bonds return over the long run.'],
          ].map(([label, now, plan, why]) => h('tr', {}, h('th', { scope: 'row' }, label), h('td', {}, now ? `${now.value}%` : '—'), h('td', {}, h('strong', {}, `${plan}%`)), h('td', { class: 'mk-why' }, why)))))),
        h('div', { id: 'mkSuggest' }, marketSuggest())));
    }
    out.push(h('div', { class: 'fields' },
      field('Inflation', numInput(...bind(a, 'inflation'), { step: 0.1, suffix: '%/yr' })),
      field('Stock returns', numInput(...bind(a, 'stockReturn'), { step: 0.1, suffix: '%/yr' }), 'Average, before inflation.'),
      people()[0].retireAge <= people()[0].age ? null : field('In shares now', numInput(...bind(a, 'stockPctNow'), { min: 0, max: 100, step: 5, suffix: '%', label: 'Share of investments in shares now' }), 'Of your ISAs, general account and pensions; the rest is in bonds. A global tracker fund is 100% shares.'),
      field(people()[0].retireAge <= people()[0].age ? 'In shares' : 'In shares by retirement', numInput(...bind(a, 'stockPctRetire'), { min: 0, max: 100, step: 5, suffix: '%', label: 'Share of investments in shares by retirement' }),
        people()[0].retireAge <= people()[0].age ? `Of your ISAs, general account and pensions; the rest is in bonds. More shares: higher average growth, bigger swings. On average about ${(a.stockPctRetire / 100 * a.stockReturn + (1 - a.stockPctRetire / 100) * a.bondReturn).toFixed(1)}% a year, before fees.` : `The plan moves from one to the other a little each year until you retire. Fewer shares later means a crash near retirement hurts less, but growth is lower: on average about ${(a.stockPctNow / 100 * a.stockReturn + (1 - a.stockPctNow / 100) * a.bondReturn).toFixed(1)}% a year now and ${(a.stockPctRetire / 100 * a.stockReturn + (1 - a.stockPctRetire / 100) * a.bondReturn).toFixed(1)}% by retirement, before fees.`),
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
        h('li', {}, 'Not worked out: tax on dividends and savings interest, tax on rent beyond what you enter, and the tapered annual allowance for very high incomes. Inheritance tax is only estimated on what is left at the end; the Child Benefit charge is counted when the plan has an income called “Child Benefit”.')),
    ];
  }

  const renderScenarioList = () => renderSection('scenario');

  function renderScenarioSection() {
    const s = scenario();
    return [
      h('div', { class: 'fields' },
        field('Name of this scenario', h('input', { type: 'text', value: s.name, 'aria-label': 'Scenario name', oninput: e => { s.name = e.target.value || 'Untitled'; renderScenarioPicker(); save(); compareDirty = true; for (const el of $$(`[data-scenario="${s.id}"] th strong`)) el.textContent = s.name; } })),
        h('div', { class: 'field' }, h('span', {}, ' '),
          h('button', { type: 'button', class: 'btn small danger', disabled: ws.scenarios.length < 2 || s.id === ws.scenarios[0].id, title: s.id === ws.scenarios[0].id ? 'Your main plan can’t be deleted; delete the scenarios made from it instead.' : null, onclick: () => {
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
    // One round figure from the quick start: it starts as "Anything else", and each item typed comes out of it.
    const lump = plan().expenses.find(e => /^One round figure from the quick start/.test(e.note || ''));
    const other = wiz.answers.other;
    wiz.lump = lump && other && other.from === lump.id ? { amount: other.amount / (other.freq === 'month' ? 1 : 12), last: other.amount / (other.freq === 'month' ? 1 : 12) } : null;
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
    // What is owed, in its own words: a credit card or a car loan is not "your mortgage".
    const owed = p.accounts.filter(a => a.type === 'debt' && a.balance > 0 && !a.excluded);
    const mort = owed.filter(a => /mortgage/i.test(a.name)).length;
    const debtWord = !owed.length ? 'payments on what you owe' : mort === owed.length ? (mort > 1 ? 'your mortgages' : 'your mortgage') : mort ? 'your mortgage and other loan and card payments' : 'your loan and card payments';
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
      h('p', { class: 'sub' }, `Take-home this year about ${money(take / 12)} a month. Needs include ${debt > 0.5 ? `${debtWord} (${money(debt / 12)} a month), ` : ''}bills, food, transport and childcare; wants are the rest. The 50/30/20 split is a popular rule of thumb, not a rule.`),
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
    $('#wizIntro').textContent = isReview ? 'Here is your spending by category. Apply it to update the plan.' : wiz.step === 0 && wiz.lump ? `${step.intro} Your round figure of ${money(wiz.lump.amount)} a month is split as you go: each item you type comes out of “Anything else”, so nothing is counted twice.` : wiz.step === 0 && W.QUESTIONS.some(q => wiz.answers[q.key].from) ? `${step.intro} We've filled in what we could from your current spending.` : step.intro;
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
      }), ...(step.endAge ? [field(`These stop when ${people()[0].name} is (about when the youngest turns 18)`, h('input', { type: 'number', value: wiz.answers._childrenEndAge, min: people()[0].age, max: 100, oninput: e => { wiz.answers._childrenEndAge = parseInt(e.target.value, 10) || people()[0].age; } }))] : []),
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
    if (wiz.lump) {
      const o = wiz.answers.other, cur = (o.amount || 0) / (o.freq === 'month' ? 1 : 12);
      if (Math.abs(cur - wiz.lump.last) > 0.5) wiz.lump = null;   // "Anything else" was typed by hand: leave it alone
      else {
        const rest = W.QUESTIONS.filter(q => q.key !== 'other').reduce((acc, q) => { const x = wiz.answers[q.key]; return acc + (x.amount || 0) / (x.freq === 'month' ? 1 : 12); }, 0);
        o.amount = Math.max(0, Math.round(wiz.lump.amount - rest)); o.freq = 'month'; wiz.lump.last = o.amount;
      }
    }
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
    markGuide('spending');
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

  // A cost that is only counted when asked for.
  function lwAsk(key, label, hint) {
    const box = h('input', { type: 'checkbox', checked: !!lw.a[key], id: `lw-${key}` });
    box.addEventListener('change', () => {
      lw.a[key] = box.checked;
      if (box.checked && key === 'carsOn' && !(lw.a.cars > 0)) lw.a.cars = 1;
      if (box.checked && key === 'homeOn' && !(lw.a.homeCost > 0)) lw.a.homeCost = 10000;
      renderLifeWizard();
    });
    return h('label', { class: 'qs-check lw-ask' }, box, h('span', {}, h('strong', {}, label), h('small', {}, hint)));
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
        field('How many children (still at home, or ones you’ll help)?', h('input', { type: 'number', min: 0, max: 8, value: kids.length, 'aria-label': 'Number of children', oninput: e => {
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
          lwNum('privateFee', 'Private school fees (a year, each)', { money: true, hint: '0 = state school. Fees rise with prices in the plan; they often rise faster.' }),
          lwNum('privateFrom', 'Private school from the child’s age', { min: 3, max: 17, hint: 'Until 18. E.g. 11 for secondary school only.' }),
          lwNum('uniPerYear', 'University support (a year)', { money: true, hint: plan().household.region === 'scotland' ? 'Scottish students pay no tuition at Scottish universities; this is help with living costs.' : 'Tuition is paid by a student loan; this is your help with living costs (their maintenance loan is smaller when parents earn more).' }),
          lwNum('uniYears', 'Years at university', { min: 0, max: 7 }),
          lwNum('carAt17', 'Driving lessons & first car', { money: true }),
          lwNum('depositHelp', 'Help with a house deposit', { money: true }),
          lwNum('weddingHelp', 'Help with a wedding', { money: true }),
          lwNum('helpAge', 'At their age', { min: 18, max: 50 })) : null,
      ];
    } else if (step.id === 'cars') {
      content = [lwAsk('carsOn', 'Allow for replacing a car every few years', 'Leave unticked if there is no car, or if what you spend each month already covers it. The amounts below are suggestions: nothing is counted until this is ticked.'),
        !a.carsOn ? null : h('div', { class: 'fields' },
        lwNum('cars', 'Cars in the household', { min: 0, max: 4 }),
        lwNum('carCost', 'Cost of each replacement', { money: true }),
        lwNum('carEvery', 'Replace every', { min: 1, max: 30, suffix: 'years' }),
        lwNum('carNext', 'Next replacement in', { min: plan().startYear, max: plan().startYear + 30, hint: 'Stops when you are 80.' }))];
    } else if (step.id === 'home') {
      content = [lwAsk('homeOn', 'Allow for big repairs to the home every so often', 'Leave unticked if you rent, or would pay for them out of normal spending. Nothing is counted until this is ticked.'),
        !a.homeOn ? null : h('div', { class: 'fields' },
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
        lwNum('careAge', 'Possible care costs from age', { min: 0, max: 110, hint: plan().household.region === 'scotland' ? '0 = leave out. Scotland pays part of personal and nursing care.' : '0 = leave out. In England the council helps only once savings (and usually the home) are below £23,250.' }),
        lwNum('careCost', 'Care costs (a year, at today’s prices)', { money: true, hint: plan().household.region === 'scotland' ? 'A care home in Scotland is often £50,000–£80,000 a year before support.' : 'A care home in England is often £55,000–£90,000 a year, more with nursing.' }),
        lwNum('careYears', 'For how many years', { min: 0, max: 20 }),
        h('details', { class: 'care-help' }, h('summary', {}, 'Would I have to sell the house to pay for care?'),
          plan().household.region === 'scotland'
            ? h('p', { class: 'hint' }, 'In Scotland personal care (and nursing care in a nursing home) is paid by the council whatever you have: about £250 and £110 a week, which comes off the bill. For the rest (board and lodging), a means test counts savings over a limit (around £35,000; it changes each April) and, in a care home, usually the house, unless a partner or a relative over 60 still lives in it. The house isn’t counted for the first 12 weeks, and a deferred payment agreement can let the bill be paid from the house after death instead of selling it. Care at home doesn’t count the house. To see what selling it would do, try a scenario: sell the home in the year care starts.')
            : h('p', { class: 'hint' }, 'In England the council helps only once savings are under £23,250. In a care home the house is usually counted, unless a partner or a relative over 60 still lives in it. The house isn’t counted for the first 12 weeks, and a deferred payment agreement can let the bill be paid from the house after death instead of selling it. Care at home doesn’t count the house. To see what selling it would do, try a scenario: sell the home in the year care starts.')),
        lwNum('careRealGrowth', 'Care rises faster than prices by', { min: 0, max: 5, step: 0.5, suffix: '% a year', hint: 'Care is mostly wages, which tend to grow faster than prices: 1% a year is a common assumption.' }),
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
    setKids($('#lifeWiz .wiz-total'), 'Everything in this check-up so far adds ', h('strong', {}, money(s.total)), ' over your lifetime (today’s money): cars, the home, retirement and family, not just this step.');
  }

  function lifeNext() {
    if (lw.step < LW.STEPS.length) { lw.step++; renderLifeWizard(); return; }
    scenario().plan = LW.apply(plan(), lw.a);
    markGuide('life');
    $('#lifeWiz').close();
    explorerValues = null;
    renderPlan();
    refresh();
  }

  // A row of cards you swipe or step through, one or a few at a time (scroll-snap, arrows, dots).
  function carousel(slides, label, kind) {
    const n = slides.length;
    const track = h('div', { class: 'car-track', tabindex: '0', 'aria-label': label }, slides.map((s, i) => h('div', { class: 'car-slide', role: 'group', 'aria-roledescription': 'slide', 'aria-label': `${i + 1} of ${n}` }, s)));
    const goTo = i => { const el = track.children[Math.max(0, Math.min(n - 1, i))]; if (el) track.scrollTo({ left: el.offsetLeft - track.offsetLeft, behavior: 'smooth' }); };
    const at = () => { let best = 0, d = Infinity; [...track.children].forEach((el, i) => { const x = Math.abs(el.offsetLeft - track.offsetLeft - track.scrollLeft); if (x < d) { d = x; best = i; } }); return best; };
    const prev = h('button', { type: 'button', class: 'car-btn', 'aria-label': `Previous ${(label || 'item').toLowerCase().replace(/s$/, '')}`, onclick: () => goTo(at() - 1) }, '‹');
    const next = h('button', { type: 'button', class: 'car-btn', 'aria-label': `Next ${(label || 'item').toLowerCase().replace(/s$/, '')}`, onclick: () => goTo(at() + 1) }, '›');
    // Dots for a few cards; past eight, a "3 of 15" count instead.
    const many = n > 8;
    const dots = many ? h('div', { class: 'car-count', 'aria-live': 'polite' }, `1 of ${n}`)
      : h('div', { class: 'car-dots', 'aria-hidden': 'true' }, slides.map((_, i) => h('span', { class: i === 0 ? 'on' : '', onclick: () => goTo(i) })));
    let raf = 0;
    const update = () => {
      raf = 0;
      const i = at();
      if (many) dots.textContent = `${i + 1} of ${n}`;
      else [...dots.children].forEach((d, j) => d.classList.toggle('on', j === i));
      prev.disabled = track.scrollLeft < 4;
      next.disabled = track.scrollLeft + track.clientWidth >= track.scrollWidth - 4;
    };
    track.addEventListener('scroll', () => { if (!raf) raf = requestAnimationFrame(update); });
    track.addEventListener('keydown', e => { if (e.key === 'ArrowRight') { e.preventDefault(); goTo(at() + 1); } if (e.key === 'ArrowLeft') { e.preventDefault(); goTo(at() - 1); } });
    requestAnimationFrame(update);
    new ResizeObserver(update).observe(track);
    const nav = n > 1 ? h('div', { class: 'car-nav' }, prev, dots, next) : null;
    // No arrows when everything already fits.
    const fit = () => { if (nav) nav.hidden = track.scrollWidth <= track.clientWidth + 4; };
    requestAnimationFrame(fit);
    new ResizeObserver(fit).observe(track);
    return h('div', { class: `carousel${kind ? ` ${kind}` : ''}`, role: 'region', 'aria-roledescription': 'carousel', 'aria-label': label }, track, nav);
  }

  // Everything worth doing next, as one row of cards: plan checks, saving ideas and guides not done.
  function suggestionSlides() {
    const hidden = new Set(ws.dismissed);
    const out = [];
    const toneLabel = { warn: 'Needs attention', tip: 'Idea', info: 'Good to know' };
    for (const i of B.insights(plan(), model.proj)) {
      if (i.tone === 'good' || hidden.has(i.id)) continue;
      out.push({ id: i.id, tone: i.tone, icon: i.tone, eyebrow: toneLabel[i.tone], title: i.title, text: i.text,
        action: actionFits(i.action) ? [i.action.startsWith('compare:') ? 'Compare the options' : ACTION_LABEL[i.action], () => insightAction(i.action)] : null, rank: i.tone === 'warn' ? 0 : i.tone === 'tip' ? 1 : 3 });
    }
    for (const a of savingAdvice()) {
      if (!/^\d+\.\s*Pension for/.test(a.title)) continue;
      const id = `adv-${a.title.replace(/^\d+\.\s*/, '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
      if (hidden.has(id)) continue;
      out.push({ id, tone: 'tip', icon: 'pension', eyebrow: 'Saving idea', title: `${a.title.replace(/^\d+\.\s*/, '')}: ${a.amount}`, text: a.text, action: a.action, rank: 1 });
    }
    const g = ws.guides;
    // A guide a plan check already points to (e.g. Future costs) is not suggested twice.
    const pointed = new Set(B.insights(plan(), model.proj).filter(i => !hidden.has(i.id) && i.tone !== 'good').map(i => i.action).filter(Boolean));
    const guideSlide = (id, icon, title, text, open, show) => {
      if (!show || hidden.has(`guide-${id}`) || pointed.has(id)) return;
      out.push({ id: `guide-${id}`, tone: 'guide', icon, eyebrow: 'Guide · a few minutes', title, text, action: ['Open this guide', open], rank: 2 });
    };
    const due = RV.due(ws);
    {
      const n = questionsLeft();
      if (n && !hidden.has('guide-questions')) out.push({ id: 'guide-questions', tone: 'guide', icon: 'review', eyebrow: 'A few questions', title: `${n} question${n === 1 ? '' : 's'} about your plan`, text: 'How your pension is paid, where savings go once the ISAs are full, how much to hold in shares: your answers change the advice and the numbers.', action: ['Answer them', () => openGuide('questions')], rank: 0.5 });
    }
    guideSlide('review', 'review', 'Time for your yearly review', 'Swap the estimates for real numbers and see how close the plan was.', () => openReview(), due.due);
    const month = new Date().getMonth();
    const taxLeft = taxChecks().filter(c => !((g[taxGuideId()] || {}).answers || {})[c.id]).length;
    guideSlide('tax', 'review', `Before 5 April: ${taxLeft} allowance${taxLeft === 1 ? '' : 's'} to check`, 'ISAs, pension top-ups and Bed and ISA, worked out for this tax year. Unused allowances are lost.', () => openGuide('tax'), month <= 3 && taxLeft > 0);
    const prot = g.protection ? PROTECTION.filter(q => g.protection.answers[q.id] !== 'yes').length : null;
    guideSlide('protection', 'shield', prot ? `Protection: ${prot} thing${prot === 1 ? '' : 's'} to look at` : 'Protection & paperwork', 'Life cover, sick pay, wills, power of attorney and pension nominations: what protects the plan if something goes wrong.', () => openGuide('protection'), prot !== 0);
    guideSlide('retire', 'clock', 'Can you retire earlier?', 'Pick a person and an age: see the chance the money lasts, what it costs, and the alternatives.', () => openGuide('retire'), !g.retire && !allRetired());
    guideSlide('life', 'heart', 'Plan for costs that come later', 'Children, cars, home repairs, travel and care, as dated costs.', openLifeWizard, !g.life && !plan().expenses.some(e => (e.key || '').startsWith('life:')));
    guideSlide('spending', 'piggy', 'Check your spending', 'Go through what you spend, with typical UK ranges.', openWizard, !g.spending);
    return out.sort((a, b) => a.rank - b.rank);
  }

  function renderSuggestions() {
    const list = suggestionSlides();
    const hide = id => { ws.dismissed = [...new Set(ws.dismissed.concat([id]))]; save(); renderSuggestions(); };
    const hiddenCount = ws.dismissed.length;
    const slides = list.map(sg => h('article', { class: `sg-card ${sg.tone}`, 'data-insight': sg.id },
      h('div', { class: 'sg-top' }, h('span', { class: 'sg-ico' }, glyph(sg.icon)), h('span', { class: 'eyebrow' }, sg.eyebrow)),
      h('h3', {}, sg.title),
      h('p', {}, sg.text),
      h('div', { class: 'sg-actions' },
        sg.action ? h('button', { type: 'button', class: 'btn small primary', onclick: sg.action[1] }, sg.action[0]) : null,
        h('button', { type: 'button', class: 'linkish', 'aria-label': `Hide: ${sg.title}`, onclick: () => hide(sg.id) }, sg.tone === 'guide' ? 'Not now' : 'Already sorted'))));
    setKids($('#ovInsights'),
      h('div', { class: 'do-head' }, h('h3', {}, 'Worth a look'),
        h('p', { class: 'sub' }, `${list.length ? `${list.length} suggestion${list.length === 1 ? '' : 's'} and guides, most important first.` : 'Nothing to look at right now.'} Rules of thumb for ${R.TAX_YEAR}, not financial advice.`)),
      list.length ? carousel(slides, 'Suggestions') : null,
      h('div', { class: 'sg-foot' },
        more('home-guides', 'All guides', h('div', { id: 'ovGuides' })),
        hiddenCount ? h('button', { type: 'button', class: 'linkish', onclick: () => { ws.dismissed = []; save(); renderSuggestions(); } }, `Show ${hiddenCount} hidden`) : null));
    renderGuides();
  }

  // ------------------------------------------------------------------ guides: step-by-step check-ups

  // Remember that a guide was done (and its answers) for the hub on Home.
  function markGuide(id, answers) {
    ws.guides[id] = { date: today(), answers: answers || (ws.guides[id] && ws.guides[id].answers) || {} };
    save();
  }

  let guide = null;   // { def, step, s }

  function openGuide(id, opts = {}) {
    const def = GUIDES[id];
    guide = { id, def, step: 0, s: def.init(opts) };
    renderGuide();
    const dlg = $('#guideDlg');
    if (!dlg.open) dlg.showModal();
  }

  function renderGuide() {
    const { def, s } = guide;
    const steps = def.steps(s);
    const st = steps[guide.step];
    $('#gdStep').textContent = steps.length > 1 ? `${def.name} · step ${guide.step + 1} of ${steps.length}` : def.name;
    $('#gdTitle').textContent = st.title;
    $('#gdIntro').textContent = typeof st.intro === 'function' ? st.intro(s) : st.intro || '';
    $('#gdBar').style.width = `${((guide.step + 1) / steps.length) * 100}%`;
    setKids($('#gdBody'), ...[].concat(st.render(s)));
    setKids($('#gdTotal'), st.note ? st.note(s) : null);
    $('#gdBack').hidden = guide.step === 0;
    $('#gdNext').textContent = guide.step === steps.length - 1 ? def.finishLabel || 'Done' : 'Next';
  }

  function guideNext() {
    const steps = guide.def.steps(guide.s);
    if (guide.step < steps.length - 1) { guide.step++; renderGuide(); $('#gdBody').scrollTop = 0; return; }
    const msg = guide.def.finish(guide.s);
    $('#guideDlg').close();
    renderPlan();
    refresh();
    if (msg) toast(msg);
  }


  // ---- Questions about your plan: the details that change the advice, asked one at a time.
  // Each question knows when it applies, what the plan has now, what is usually recommended, and
  // how to apply an answer. Answers are kept in ws.guides.questions.answers.
  function planQuestions() {
    const p = plan();
    const proj = model.proj;
    const ps = people();
    const out = [];
    const taxOn = !p.household.ignoreTax;
    const mainPay = x => p.income.filter(i => i.kind === 'salary' && i.owner === x.id).sort((a, b) => E.incomeAfterCosts(b, p, 0) - E.incomeAfterCosts(a, p, 0))[0];
    const ani = B.moneyThisYear(p, proj).people;
    const working = ps.filter(x => x.retireAge > x.age && mainPay(x));
    for (const x of working) {
      const pay = mainPay(x);
      if (taxOn) out.push({
        id: `pension-how-${x.id}`, title: `How does ${x.name} pay into the workplace pension?`,
        why: 'It decides whether the full tax relief arrives on its own, and whether NI is saved too. A payslip shows it: a lower salary line means salary sacrifice; the pension coming off before tax means “net pay”; a statement saying “basic rate relief added” means relief at source.',
        current: pay.sacrifice ? 'sacrifice' : null,
        options: [
          { value: 'sacrifice', label: 'Salary sacrifice', text: 'A lower salary, paid in by the employer: relief is automatic and NI is saved too.', recommended: true },
          { value: 'netpay', label: 'Taken off before tax', text: 'Relief is automatic. Ask whether salary sacrifice is offered: it also saves NI.' },
          { value: 'ras', label: 'From take-home pay', text: 'The provider adds 20%; anyone paying more than 20% claims the rest from HMRC each year (self-assessment).' },
          { value: 'none', label: 'Not paying in', text: 'Joining usually brings an employer contribution: free money.' },
        ],
        apply: (q, v) => { for (const i of q.income.filter(i => i.kind === 'salary' && i.owner === x.id)) i.sacrifice = v === 'sacrifice'; if (v === 'ras') q.strategy.claimRelief = true; },
      });
      // A defined benefit scheme (USS...) is worked out from salary and years, not amounts a month.
      if (!p.income.some(i => i.kind === 'dbpension' && i.owner === x.id)) out.push({
        id: `pension-amounts-${x.id}`, kind: 'amounts', title: `How much goes into ${x.name}’s pension each month?`,
        why: 'Both figures are on the payslip. Many employers add more if you pay more (a “match”): paying at least enough to get all of it is usually the first thing to do.',
        fields: [['employeePension', `${x.name} pays`], ['employerPension', 'The employer adds']],
        pct: pay.pensionMode === 'pct',
        current: { employeePension: pay.employeePension, employerPension: pay.employerPension },
        apply: (q, v) => { const it = q.income.find(i => i.id === pay.id); if (it) { it.employeePension = Math.max(0, +v.employeePension || 0); it.employerPension = Math.max(0, +v.employerPension || 0); } },
      });
    }
    const lineNow = E.stayUnderLine(p.strategy);
    const highEarner = ani.some(a => a.ani > 70000) || lineNow === 100000;
    if (taxOn && working.length && highEarner && lineNow !== R.CHILD_BENEFIT.chargeFrom) out.push({
      id: 'under100k', title: 'Would you salary sacrifice pay above £100,000 into your pension?',
      why: 'Between £100,000 and £125,140 the personal allowance is taken away, so that pay is taxed at over 60% (69.5% in Scotland, with NI), Tax-Free Childcare stops and, in England, the 30 hours of free childcare too. Sacrificing it into the pension keeps nearly all of it, up to the £60,000 a year that can go into a pension.',
      current: E.stayUnderLine(p.strategy) === 100000 ? 'yes' : null,
      options: [
        { value: 'yes', label: 'Yes, stay under £100,000', text: ani.some(a => a.ani > R.PA_TAPER_START + R.PENSION_ANNUAL_ALLOWANCE) ? 'The plan raises the sacrifice each year, as far as the £60,000 pension allowance goes: with income this high it brings it down but not under the line.' : 'The plan raises the sacrifice each year so income stays just under the line.', recommended: true },
        { value: 'no', label: 'No', text: 'The pay is taken as salary and taxed.' },
      ],
      apply: (q, v) => { q.strategy.stayUnder100k = v === 'yes'; q.strategy.stayUnderLine = v === 'yes' ? 100000 : 0; },
    });
    const giaLater = proj.rows.some((r, t) => t < proj.pre.N && r.toGia > 100);
    const topRate = Math.max(0, ...ani.map(a => (a.ani > 0 ? R.incomeTax(a.ani + 100, p.household.region) - R.incomeTax(a.ani, p.household.region) : 0)));
    if (taxOn && working.length && (giaLater || p.strategy.pensionFirst)) out.push({
      id: 'after-isa', title: 'Once both ISAs are full, where should extra savings go?',
      why: `The plan fills the ISAs first (${money(p.strategy.isaAllowance)} each a year). What is left can go into a general account (available any time, but dividends and gains are taxed) or into pensions with tax relief (locked until the minimum pension age).`,
      current: p.strategy.pensionFirst ? 'pension' : 'gia',
      options: [
        { value: 'pension', label: 'Pensions first', text: `Relief at the top rate (${Math.round(topRate)}% here), a quarter tax-free when drawn, within ${money(R.PENSION_ANNUAL_ALLOWANCE)} a year each.`, recommended: topRate >= 40 },
        { value: 'gia', label: 'General investment account', text: 'Reachable at any time, for anything; taxed above small allowances.', recommended: topRate < 40 },
      ],
      apply: (q, v) => { q.strategy.pensionFirst = v === 'pension'; },
    });
    {
      const a = p.assumptions;
      const sp = Math.max(...ps.map(x => E.spStart(x) - x.age));
      const k = Math.min(proj.pre.N - 1, Math.max(1, sp));
      const cover = proj.rows[k] && proj.rows[k].spending > 0 ? proj.rows[k].nonWork / proj.rows[k].spending : 0;
      // Already retired: one mix for the money being drawn, more careful than while working.
      const retired = ps.every(x => x.retireAge <= x.age);
      const mixes = retired ? { more: [80, 80], middle: [60, 60], careful: [40, 40] } : { growth: [100, 80], balanced: [100, 60], cautious: [70, 40] };
      const cur = Object.keys(mixes).find(m => mixes[m][0] === a.stockPctNow && mixes[m][1] === a.stockPctRetire) || null;
      if (retired) out.push({
        id: 'mix', title: 'How much of your investments should be in shares?',
        why: `Shares grow more over long periods but can fall by a third in a bad year, and money being drawn can’t wait years to recover. Retired, most people keep around half in shares and the rest in bonds, gilts or cash.${cover >= 0.8 ? ` Your pensions and other income cover about ${Math.round(cover * 100)}% of your spending, so your savings can take a little more risk.` : ''}`,
        current: cur,
        options: [
          { value: 'more', label: '80% in shares', text: 'More growth, for money you won’t need for 10 years or more.', recommended: cover >= 1 },
          { value: 'middle', label: '60% in shares', text: 'The common middle way in retirement.', recommended: cover < 1 },
          { value: 'careful', label: '40% in shares', text: 'Smaller falls, slower growth.' },
        ],
        apply: (q, v) => { if (mixes[v]) [q.assumptions.stockPctNow, q.assumptions.stockPctRetire] = mixes[v]; },
      });
      else out.push({
        id: 'mix', title: 'How much of your investments should be in shares?',
        why: `Shares grow more over long periods but can fall by a third in a bad year; bonds and gilts move less. The usual approach is mostly shares while retirement is far off, then more bonds as it nears.${cover >= 0.8 ? ` From ${proj.rows[k].year} your pensions and other income cover about ${Math.round(Math.min(1, cover) * 100)}% of spending, so you can afford more in shares than most.` : ''}`,
        current: cur,
        options: [
          { value: 'growth', label: '100% now, 80% at retirement', text: 'Most growth; bigger swings, also in retirement.', recommended: cover >= 0.8 },
          { value: 'balanced', label: '100% now, 60% at retirement', text: 'The common middle way.', recommended: cover < 0.8 },
          { value: 'cautious', label: '70% now, 40% at retirement', text: 'Smaller falls, slower growth.' },
        ],
        apply: (q, v) => { if (mixes[v]) [q.assumptions.stockPctNow, q.assumptions.stockPctRetire] = mixes[v]; },
      });
    }
    const gilts = p.accounts.filter(x => x.type === 'bonds' && !x.excluded && x.balance > 0);
    if (gilts.length) {
      const c = gilts.reduce((acc, x) => acc + x.balance * x.rate / 100, 0);
      out.push({
        id: 'coupons', title: 'What should happen to the gilt coupons?',
        why: `Your gilts pay about ${money(c)} a year, in two halves. Buying more gilts costs a dealing charge each time, which is a lot on small amounts.`,
        current: gilts.every(x => x.coupons === 'payout') ? 'payout' : gilts.every(x => x.coupons !== 'payout') ? 'reinvest' : null,
        options: [
          { value: 'payout', label: 'Into my monthly fund purchase', text: 'No extra charge; they are invested with the rest.', recommended: c < 2500 },
          { value: 'reinvest', label: 'Buy more gilts', text: 'Keeps the money in gilts; best done once a year in one go.', recommended: c >= 2500 },
        ],
        apply: (q, v) => { for (const x of q.accounts.filter(y => y.type === 'bonds')) x.coupons = v; },
      });
    }
    const canLisa = ps.filter(x => x.age >= 18 && x.age < R.LISA.openBefore && !p.accounts.some(a => a.type === 'lisa' && a.owner === x.id));
    if (canLisa.length) out.push({
      id: 'lisa', title: `Open Lifetime ISAs before ${canLisa.map(x => x.name).join(' and ')} turn${canLisa.length > 1 ? '' : 's'} 40?`,
      why: `Up to ${money(R.LISA.maxContribution)} a year each (part of the ISA allowance) gets a 25% bonus until 50, usable from 60${E.ownsHome(p) ? '' : ' or for a first home'}. It must be opened before 40, even with £1, to keep the option.`,
      current: null,
      options: [
        { value: 'add', label: `Yes, ${money(R.LISA.maxContribution / 12)} a month each`, text: 'Out of what now goes into the ISAs.', recommended: true },
        { value: 'open', label: 'Open them, pay in later', text: 'Keeps the option open with £1.' },
        { value: 'no', label: 'No', text: 'Money that must be reachable before 60 is better in a normal ISA.' },
      ],
      apply: (q, v) => {
        if (v === 'no') return;
        for (const x of canLisa) q.accounts.push({ id: E.uid(), name: `${x.name} Lifetime ISA`, type: 'lisa', owner: x.id, balance: 0, contribution: v === 'add' ? R.LISA.maxContribution : 0, purpose: 'retirement' });
      },
    });
    // Money set aside: where the emergency fund is, where money for repeated costs builds up,
    // and which yearly costs to follow as a budget.
    const holders = p.accounts.filter(a => ['cash', 'isa', 'gia'].includes(a.type) && !a.excluded);
    const setReserve = (q, match, v, r) => {
      const old = (q.reserves || []).find(match);
      q.reserves = (q.reserves || []).filter(x => !match(x));
      if (v !== 'none') q.reserves.push({ ...(old || {}), ...r, accountId: v });
    };
    if (holders.length) {
      const em = p.reserves.find(r => r.kind === 'emergency');
      const firstCash = holders.find(a => a.type === 'cash');
      out.push({
        id: 'reserve-emergency', title: 'Where do you keep your emergency fund?',
        why: `Money for the unexpected (losing a job, a boiler, the car): usually 3–6 months of spending, in easy-access cash. The plan keeps the cash buffer (${money(p.strategy.cashReserve)}) aside; Home then marks it as set aside in that account, so you know it is not for spending or investing.`,
        current: em ? em.accountId || null : null,
        options: holders.map(a => ({ value: a.id, label: a.name, text: a.type === 'cash' || a.holding === 'cash' ? 'Reachable at once, and it doesn’t fall.' : 'Invested: it can fall just when it is needed, and takes a few days to sell.', recommended: a === firstCash }))
          .concat([{ value: 'none', label: 'I don’t keep one', text: 'Worth building one before investing more.' }]),
        apply: (q, v) => setReserve(q, r => r.kind === 'emergency', v, { kind: 'emergency', name: 'Emergency fund' }),
      });
      const costs = p.events.filter(e => e.kind === 'expense' && e.year > p.startYear);
      for (const name of [...new Set(costs.map(e => e.name))].filter(n => costs.filter(e => e.name === n).length >= 2)) {
        const evs = costs.filter(e => e.name === name).sort((a, b) => a.year - b.year);
        const cur = p.reserves.find(r => r.kind === 'saving' && r.eventName === name);
        const far = evs[0].year - p.startYear >= 3;
        const rec = holders.find(a => (far ? ['isa', 'gia'] : ['cash']).includes(a.type)) || holders[0];
        out.push({
          id: `reserve-saving-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, title: `Where does the money for “${name}” build up?`,
          why: `The plan has ${money(evs[0].amount)} for it in ${evs[0].year}, then again every ${evs[1].year - evs[0].year} years (today’s money). Putting a little aside each year means it is there when needed; Home shows how much of the account is for it, so it isn’t spent on something else.`,
          current: cur ? cur.accountId || null : null,
          options: holders.map(a => ({ value: a.id, label: a.name, text: a.type === 'cash' ? 'Safe; earns interest.' : 'Invested until needed: grows more, can dip.', recommended: a === rec }))
            .concat([{ value: 'none', label: 'Not set aside', text: 'Paid from that year’s money when it comes.' }]),
          apply: (q, v) => setReserve(q, r => r.kind === 'saving' && r.eventName === name, v, { kind: 'saving', name, eventName: name }),
        });
      }
      const cashes = holders.filter(a => a.type === 'cash');
      for (const e of p.expenses.filter(x => x.freq === 'year' && x.amount >= 1000 && !(x.key || '').startsWith('life:'))) {
        const cur = p.reserves.find(r => r.kind === 'budget' && r.expenseId === e.id);
        out.push({
          id: `reserve-budget-${e.id}`, title: `Follow “${e.name}” as a yearly budget?`,
          why: `The plan counts ${money(e.amount)} a year as spent. In practice it sits in the bank until it is, and some years not all of it goes, so balances differ from the plan. As a budget, Home shows it as available until spent, and each yearly review asks how much is left: kept for the year after, or freed up to invest.`,
          current: cur ? cur.accountId || null : null,
          options: (cashes.length ? cashes : holders).map((a, i) => ({ value: a.id, label: `Yes, in ${a.name}`, text: 'Shown there as set aside until spent.', recommended: i === 0 }))
            .concat([{ value: 'none', label: 'No', text: 'It stays part of the spending list only.' }]),
          apply: (q, v) => setReserve(q, r => r.kind === 'budget' && r.expenseId === e.id, v, { kind: 'budget', name: e.name, expenseId: e.id }),
        });
      }
    }
    for (const db of p.income.filter(i => i.kind === 'dbpension' && i.dbScheme === 'uss')) {
      const x = ps.find(y => y.id === db.owner);
      if (!x || x.retireAge <= x.age) continue;
      out.push({
        id: `uss-match-${x.id}`, title: `Does ${x.name} take the USS match?`,
        why: 'Paying an extra 1% of salary into the USS Investment Builder makes the employer add 1% too. It is chosen in My USS.',
        current: null,
        options: [
          { value: 'yes', label: 'Yes, already', text: 'Nothing to do.' },
          { value: 'will', label: 'Not yet, I will', text: 'Worth doing: it is free money.', recommended: true },
          { value: 'no', label: 'No', text: 'The suggestion stays on Home.' },
        ],
        apply: (q, v) => { if (v !== 'no') ws.dismissed = [...new Set(ws.dismissed.concat([`uss-match-${x.id}`]))]; },
      });
    }
    return out;
  }
  const questionsLeft = () => { const a = (ws.guides.questions || {}).answers || {}; return model ? planQuestions().filter(q => !(q.id in a)).length : 0; };

  function questionStep(q) {
    return {
      title: q.title,
      intro: q.why,
      render: s => {
        if (q.kind === 'amounts') {
          const v = s.a[q.id] || (s.a[q.id] = { ...q.current });
          return h('div', { class: 'fields' }, q.fields.map(([k, label]) => h('label', { class: 'field' }, h('span', {}, `${label}${q.pct ? ' (% of salary)' : ' (a month)'}`),
            q.pct ? h('div', { class: 'adorn has-suf' }, h('input', { type: 'number', step: 0.5, min: 0, value: v[k], 'aria-label': label, oninput: e => { v[k] = parseFloat(e.target.value) || 0; } }), h('span', { class: 'suf' }, '%'))
              : moneyInputPlain(() => v[k], x => { v[k] = x; }, label))));
        }
        const pick = s.a[q.id] !== undefined ? s.a[q.id] : q.current;
        return h('div', { class: 'spend-options q-options', role: 'group', 'aria-label': q.title }, q.options.map(o => h('button', {
          type: 'button', class: 'spend-option', 'aria-pressed': String(pick === o.value), 'data-q': `${q.id}:${o.value}`,
          onclick: e => { s.a[q.id] = o.value; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); },
        }, h('strong', {}, o.label), o.recommended ? h('span', { class: 'q-rec' }, 'Recommended') : null, h('span', { class: 'txt' }, o.text))));
      },
      note: () => h('span', { class: 'muted' }, 'Skip any you’re not sure about: Next leaves it as it is.'),
    };
  }

  // ---- "Can I retire at …?": one person, one age, and when to take a defined benefit pension

  // A copy of the plan where `who` stops work at `age` and takes their DB pensions then
  // (reduced) or at the scheme's Normal Pension Age (full).
  function retireVariant(base, who, age, dbWhen) {
    const p = E.clonePlan(base);
    const x = p.household.people.find(y => y.id === who);
    for (const g of p.goals) if (g.type === 'retire' && E.retiree(p, g).id === who && g.age === x.retireAge) g.age = age;
    x.retireAge = age;
    for (const db of p.income.filter(i => i.kind === 'dbpension' && i.owner === who)) {
      const npa = E.dbEarly(db, x).npa || db.startAge;
      db.startAge = dbWhen === 'stop' ? Math.min(npa, Math.max(age, x.pensionAccessAge)) : npa;
    }
    return E.normalizePlan(p);
  }

  // What a plan looks like for one person's retirement: chance the money lasts, savings, DB pension.
  function retireOutcome(q, who) {
    const proj = E.project(q);
    const x = q.household.people.find(y => y.id === who);
    const rows = proj.rows;
    const real = (v, t) => v / rows[t].deflator;
    const tr = Math.max(0, Math.min(rows.length - 1, x.retireAge - x.age));
    const t0 = Math.max(0, Math.min(rows.length - 1, Math.min(...q.household.people.map(y => y.retireAge - y.age))));
    const after = rows.slice(t0).map((r, i) => real(r.liquid, t0 + i));
    const db = q.income.filter(i => i.kind === 'dbpension' && i.owner === who).map(i => {
      const t = Math.max(0, i.startAge - x.age);
      const v = E.incomeAfterCosts(i, q, Math.min(t, rows.length - 1)) / Math.pow(1 + q.assumptions.inflation / 100, t);
      return { name: i.name, from: i.startAge, a: v, lump: v * i.lumpMultiple, factor: E.dbEarly(i, x).factor };
    });
    return {
      chance: E.successRate(q, 600, ws.settings.seed),
      atRetire: real(rows[tr].liquid, tr), lowest: Math.min(...after), end: real(rows[rows.length - 1].liquid, rows.length - 1),
      db, age: x.retireAge, year: q.startYear + x.retireAge - x.age,
    };
  }

  function verdict(chance) {
    const conf = ws.settings.confidence / 100;
    if (chance >= conf) return { tone: 'good', text: 'Yes' };
    if (chance >= 0.7) return { tone: 'warn', text: 'Possibly, with some risk' };
    return { tone: 'bad', text: 'Not as the plan stands' };
  }

  const GUIDES = {
    retire: {
      name: 'Can I retire at…?',
      finishLabel: 'Finish',
      init: opts => {
        const p = plan();
        const x = people().find(y => y.id === opts.who) || nextRetiree(p);
        const db = p.income.find(i => i.kind === 'dbpension' && i.owner === x.id);
        const npa = db ? E.dbEarly(db, x).npa || db.startAge : null;
        return { who: x.id, age: opts.age || x.retireAge, dbWhen: db && db.startAge < npa ? 'stop' : 'npa', rows: null, keep: 'look', key: null };
      },
      steps: () => [
        {
          title: 'Who, and when?',
          intro: 'Pick a person and the age they would stop work. Everything else in your plan stays as it is.',
          render: s => {
            const p = plan();
            const x = people().find(y => y.id === s.who);
            const dbs = p.income.filter(i => i.kind === 'dbpension' && i.owner === s.who);
            return [
              people().length > 1 ? h('div', { class: 'field' }, h('span', {}, 'Who'), h('div', { class: 'idea-chips' }, people().map(y => h('button', {
                type: 'button', class: 'idea-chip', 'aria-pressed': String(y.id === s.who), 'data-who': y.id,
                onclick: () => { s.who = y.id; s.age = y.retireAge; s.rows = null; renderGuide(); },
              }, y.name)))) : null,
              field(`${x.name} stops work at`, h('div', { class: 'adorn has-suf' },
                h('input', { type: 'number', value: s.age, min: x.age + 1, max: 80, 'aria-label': 'Retirement age', oninput: e => { s.age = Math.round(+e.target.value) || s.age; s.rows = null; } }),
                h('span', { class: 'suf' }, 'years')), `Planned now: ${x.retireAge}. Workplace and personal pensions can be drawn from ${x.pensionAccessAge}; State Pension from ${x.statePensionAge}.`),
              dbs.length ? h('div', { class: 'field' }, h('span', {}, `When to take ${dbs.map(d => d.name).join(' and ')}`),
                h('div', { class: 'gd-choices' },
                  [['stop', 'When I stop work (or from the earliest age it can be paid)', 'Paid sooner, but cut for every year before its Normal Pension Age.'],
                    ['npa', 'At its Normal Pension Age, in full', 'Nothing from it until then: savings bridge the gap.']].map(([v, t, sub]) => h('label', { class: 'radio-card' },
                    h('input', { type: 'radio', name: 'gdDb', value: v, checked: s.dbWhen === v, onchange: () => { s.dbWhen = v; s.rows = null; } }),
                    h('span', {}, h('strong', {}, t), h('small', {}, sub)))))) : null,
            ];
          },
        },
        {
          title: 'What happens',
          intro: s => `${people().find(y => y.id === s.who).name} stopping work at ${s.age}, next to the plan as it is and to working longer. Chance the money lasts across ${600} simulated futures; money in today’s pounds.`,
          render: s => {
            const box = h('div', { id: 'gdRetire' }, h('p', { class: 'sub working' }, 'Working it out…'));
            setTimeout(() => computeRetireGuide(s, box), 30);
            return box;
          },
        },
        {
          title: 'Keep it?',
          intro: 'Change your plan, keep it as a scenario to compare, or just leave it as something you looked at.',
          render: s => h('div', { class: 'gd-choices' },
            [['plan', `Update my plan: ${people().find(y => y.id === s.who).name} retires at ${s.age}`, 'Your goals and every chart use it from now on.'],
              ['scenario', 'Save it as a scenario', 'Your plan stays as it is; compare them in Scenarios.'],
              ['look', 'Just looking', 'Nothing changes.']].map(([v, t, sub]) => h('label', { class: 'radio-card' },
              h('input', { type: 'radio', name: 'gdKeep', value: v, checked: s.keep === v, onchange: () => { s.keep = v; } }),
              h('span', {}, h('strong', {}, t), h('small', {}, sub))))),
        },
      ],
      finish: s => {
        const x = people().find(y => y.id === s.who);
        const q = retireVariant(plan(), s.who, s.age, s.dbWhen);
        markGuide('retire', { [s.who]: String(s.age) });
        if (s.keep === 'plan') { scenario().plan = q; return `${x.name} now retires at ${s.age} in your plan.`; }
        if (s.keep === 'scenario') {
          const name = `${scenario().name}: ${x.name} retires at ${s.age}`;
          ws.scenarios.push({ id: E.uid(), name, plan: q });
          save();
          renderScenarioPicker();
          return `Saved “${name}”. Compare it in Scenarios.`;
        }
        return null;
      },
    },

    tax: {
      name: 'Tax year-end check',
      finishLabel: 'Save',
      init: () => ({ year: taxYearEnd(), done: { ...((ws.guides[taxGuideId()] || {}).answers || {}) } }),
      steps: () => [{
        title: 'Before the tax year ends',
        intro: s => `Allowances that reset on 6 April ${s.year} and are lost if unused, worked out from your plan for this tax year (${R.TAX_YEAR}). Tick what you have done.`,
        render: s => h('ul', { class: 'checklist' }, taxChecks().map(c => h('li', { class: s.done[c.id] ? 'done' : '' },
          h('label', {}, h('input', { type: 'checkbox', checked: !!s.done[c.id], onchange: e => { if (e.target.checked) s.done[c.id] = 'done'; else delete s.done[c.id]; e.target.closest('li').classList.toggle('done', e.target.checked); } }),
            h('span', {}, h('strong', {}, c.title), c.amount ? h('span', { class: 'ck-amt' }, c.amount) : null, h('small', {}, c.text)))))),
        note: s => h('span', { class: 'muted' }, `Deadline: 5 April ${s.year}`),
      }],
      finish: s => { markGuide(taxGuideId(), s.done); const n = taxChecks().filter(c => !s.done[c.id]).length; return n ? `Saved. ${n} still to do before 5 April.` : 'All done for this tax year.'; },
    },

    questions: {
      name: 'Questions about your plan',
      finishLabel: 'Save answers',
      // Questions not answered yet come first.
      init: () => { const a = { ...((ws.guides.questions || {}).answers || {}) }; const qs = planQuestions(); return { qs: qs.filter(q => !(q.id in a)).concat(qs.filter(q => q.id in a)), a }; },
      steps: s => s.qs.map(questionStep),
      finish: s => {
        const before = plan();
        const q = E.clonePlan(before);
        let n = 0;
        // Going past a question that already had an answer in the plan keeps (and records) it.
        for (const x of s.qs) if (s.a[x.id] === undefined && x.current !== null && x.current !== undefined) s.a[x.id] = x.current;
        for (const x of s.qs) if (s.a[x.id] !== undefined && s.a[x.id] !== null) { x.apply(q, s.a[x.id]); n++; }
        scenario().plan = E.normalizePlan(q);
        const changes = planChanges(before, scenario().plan);
        markGuide('questions', s.a);
        const where = ws.activeId === ws.scenarios[0].id ? '' : ` in the scenario “${scenario().name}” (open now)`;
        return n ? `Saved ${n} answer${n === 1 ? '' : 's'}${where}${changes.length ? `: ${changes.slice(0, 3).join('; ')}${changes.length > 3 ? '…' : ''}` : '; the plan already matched'}.` : null;
      },
    },

    estate: {
      name: 'What you leave behind',
      finishLabel: 'Done',
      init: () => ({ added: {} }),
      steps: () => [
        {
          title: 'What the plan leaves',
          intro: () => { const ih = B.inheritance(plan(), model.proj); return `At the end of the plan (${ih.year}), on average returns. In today’s money, so it compares with the tax allowances; in ${ih.year} pounds the estate is about ${money(ih.nominal)}.`; },
          render: () => {
            const ih = B.inheritance(plan(), model.proj);
            const row = (label, v, cls) => h('tr', { class: cls || '' }, h('th', { scope: 'row' }, label), h('td', {}, v < 0 ? `−${money(-v)}` : money(v)));
            return [
              h('div', { class: 'table-wrap' }, h('table', { class: 'data gd-table' }, h('tbody', {},
                row('Savings and investments', ih.parts.savings), row('Pensions (counted from April 2027)', ih.parts.pensions), row('Homes', ih.parts.homes),
                ih.parts.debts < -0.5 ? row('Debts', ih.parts.debts) : null,
                row('Estate', ih.estate, 'total'),
                row(`Tax-free allowances${ih.n > 1 ? ' (both of you)' : ''}`, -ih.free),
                row('Inheritance tax at 40%', -ih.tax, 'total'),
                row('Passed on', ih.left, 'total')))),
              h('p', { class: 'hint' }, `Allowances: ${money(R.IHT.nilRate)} each, plus ${money(R.IHT.residence)} each when a home goes to children or grandchildren, which shrinks by £1 for every £2 over ${money(R.IHT.taperFrom)}${ih.home < R.IHT.residence * ih.n ? (ih.home > 0.5 ? ` (here ${money(ih.home)} is left of it)` : ' (here none of it is left)') : ''}. Between spouses nothing is due, and unused allowances pass to the survivor. Rough: the rules may change, and allowances are frozen until 2030.`),
            ];
          },
        },
        {
          title: 'Ways to pass on more',
          intro: 'Try one as a scenario to see what it does to your goals; nothing changes in your plan until you choose.',
          render: s => {
            const p = plan();
            const idea = id => SI.ideasFor(p).find(x => x.id === id);
            const tryBtn = id => {
              const it = idea(id);
              if (!it) return null;
              return h('button', { type: 'button', class: 'btn small', disabled: !!s.added[id], onclick: e => {
                ws.scenarios.push({ id: E.uid(), name: ideaName(it), plan: SI.variantOf(it, p) });
                s.added[id] = true; save(); renderScenarioPicker();
                e.currentTarget.disabled = true; e.currentTarget.textContent = 'Added to Scenarios';
              } }, s.added[id] ? 'Added to Scenarios' : 'Try it as a scenario');
            };
            const kids = ((p.life && p.life.children) || []).filter(c => c.age < 18);
            const items = [
              ['Give from surplus income', 'Regular gifts out of income (not savings) are free of inheritance tax straight away, with no limit, if they don’t lower your standard of living. Keep a note of them.', tryBtn('gifts')],
              ['Help with a first home', 'A larger gift is free of tax if you live 7 more years (less tax from year 3). Helping in your 60s, when it matters most to them, usually beats leaving it at 95.', tryBtn('first-home')],
              ['Enjoy more of it', 'The simplest way: spend more in retirement. The goals show how much room there is.', tryBtn('spend-more')],
              kids.length ? ['Junior ISAs and pensions', `Up to ${money(R.JUNIOR_ISA_ALLOWANCE)} a year per child in a Junior ISA, and up to £2,880 a year into a child’s pension (the government adds 20%). Free of tax as gifts from income or within ${money(R.IHT.annualGift)} a year each.`, null] : null,
              ['Small gifts every year', `${money(R.IHT.annualGift)} a year each (and last year’s if unused), £250 a person to anyone, and wedding gifts are always free.`, null],
              ['Wills, nominations and cover in trust', 'Up-to-date wills, pension nominations and life cover written in trust keep money out of the estate and quick to reach. See Protection & paperwork.', h('button', { type: 'button', class: 'btn small ghost', onclick: () => { $('#guideDlg').close(); openGuide('protection'); } }, 'Open')],
            ].filter(Boolean);
            return h('ol', { class: 'advice' }, items.map(([title, text, btn]) => h('li', {},
              h('div', { class: 'adv-head' }, h('strong', {}, title), btn), h('p', {}, text))));
          },
          note: () => h('span', { class: 'muted' }, 'General guidance, not advice: a solicitor or adviser can help with trusts and larger gifts.'),
        },
      ],
      finish: () => { markGuide('estate'); return null; },
    },

    protection: {
      name: 'Protection & paperwork',
      finishLabel: 'Save',
      init: () => ({ a: { ...((ws.guides.protection || {}).answers || {}) } }),
      steps: () => [
        {
          title: 'What do you have in place?',
          intro: 'The things that protect the plan if something goes wrong. Answer for the household; “not sure” is fine.',
          render: s => h('div', { class: 'prot-qs' }, PROTECTION.map(q => h('div', { class: 'prot-q' },
            h('div', {}, h('strong', {}, q.q()), h('small', {}, q.why())),
            h('div', { class: 'seg', role: 'group', 'aria-label': q.q() }, [['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']].map(([v, l]) => h('button', {
              type: 'button', 'aria-pressed': String(s.a[q.id] === v), 'data-answer': `${q.id}:${v}`,
              onclick: e => { s.a[q.id] = v; for (const b of e.currentTarget.parentElement.children) b.setAttribute('aria-pressed', String(b === e.currentTarget)); },
            }, l)))))),
        },
        {
          title: 'What to look at',
          intro: 'For everything you don’t have yet, or aren’t sure about. General guidance, not advice: a regulated adviser or solicitor can help with the detail.',
          render: s => {
            const todo = PROTECTION.filter(q => s.a[q.id] !== 'yes');
            return todo.length ? h('ol', { class: 'advice' }, todo.map(q => h('li', {},
              h('div', { class: 'adv-head' }, h('strong', {}, q.title), q.amount ? h('span', { class: 'adv-amt' }, q.amount()) : null),
              h('p', {}, q.tip())))) : h('p', {}, 'All in place. Look again when something changes: a new child, a house move, or a new job.');
          },
        },
      ],
      finish: s => { markGuide('protection', s.a); return null; },
    },
  };

  async function computeRetireGuide(s, box) {
    const p = plan();
    const x = people().find(y => y.id === s.who);
    const key = `${JSON.stringify(p)}|${s.who}|${s.age}|${s.dbWhen}`;
    if (s.key !== key || !s.rows) {
      const npaOf = () => { const db = p.income.find(i => i.kind === 'dbpension' && i.owner === s.who); return db ? E.dbEarly(db, x).npa || db.startAge : null; };
      const npa = npaOf();
      const opts = [
        { name: 'Your plan now', plan: p },
        { name: `Stop at ${s.age}${npa ? (s.dbWhen === 'stop' ? ', pension taken early' : `, pension at ${npa}`) : ''}`, plan: retireVariant(p, s.who, s.age, s.dbWhen), choice: true },
      ];
      if (npa) opts.push({ name: `Stop at ${s.age}, pension ${s.dbWhen === 'stop' ? `at ${npa} in full` : 'taken early'}`, plan: retireVariant(p, s.who, s.age, s.dbWhen === 'stop' ? 'npa' : 'stop') });
      const later = Math.max(npa || 0, x.statePensionAge);
      if (later > s.age) opts.push({ name: `Work until ${later}`, plan: retireVariant(p, s.who, later, 'npa') });
      const seen = new Set();
      s.rows = [];
      for (const o of opts) {
        const k = JSON.stringify(o.plan);
        if (seen.has(k) && !o.choice) continue;
        seen.add(k);
        await new Promise(r => setTimeout(r, 0));
        if (!box.isConnected) return;
        s.rows.push({ ...o, out: retireOutcome(o.plan, s.who) });
      }
      s.key = key;
    }
    const mine = s.rows.find(r => r.choice);
    const v = verdict(mine.out.chance);
    const q = mine.plan;
    const xq = q.household.people.find(y => y.id === s.who);
    setKids(box,
      h('div', { class: `gd-verdict ${v.tone}` }, glyph(v.tone === 'good' ? 'good' : 'warn'),
        h('div', {}, h('strong', {}, `${v.text}: ${pct(mine.out.chance)} chance the money lasts`),
          h('p', {}, `${x.name} stops work in ${mine.out.year} at ${s.age}. Savings, investments and pensions then: about ${fmtCompact(mine.out.atRetire)}; the lowest they get afterwards: ${fmtCompact(mine.out.lowest)}; left at the end of the plan: ${fmtCompact(mine.out.end)}.`))),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data gd-table' },
        h('thead', {}, h('tr', {}, ['', 'Chance the money lasts', 'Savings when they stop', 'Lowest after', 'Left at the end', ...(mine.out.db.length ? ['Defined benefit pension'] : [])].map(t => h('th', { scope: 'col' }, t)))),
        h('tbody', {}, s.rows.map(r => h('tr', { class: r.choice ? 'open' : '' },
          h('th', { scope: 'row' }, r.name),
          h('td', {}, pct(r.out.chance)), h('td', {}, fmtCompact(r.out.atRetire)), h('td', {}, fmtCompact(r.out.lowest)), h('td', {}, fmtCompact(r.out.end)),
          mine.out.db.length ? h('td', {}, r.out.db.map(d => `${money(d.a)} a year from ${d.from}${d.factor < 1 ? ` (${(d.factor * 100).toFixed(1)}%)` : ''}${d.lump ? ` + ${money(d.lump)} lump sum` : ''}`).join('; ')) : null))))),
      h('h3', {}, 'What it means'),
      h('ul', { class: 'tradeoffs-flat' }, retireConsequences(q, xq).map(t => h('li', {}, t))));
  }

  // The checks for this tax year, worked out from the plan.
  const taxYearEnd = () => { const d = new Date(); return d.getMonth() > 3 || (d.getMonth() === 3 && d.getDate() > 5) ? d.getFullYear() + 1 : d.getFullYear(); };
  const taxGuideId = () => `tax-${taxYearEnd()}`;

  function taxChecks() {
    const p = plan(), r0 = model.proj.rows[0], s = p.strategy;
    const out = [];
    const add = (id, title, text, amount) => out.push({ id, title, text, amount });
    const ps = people();
    const isaEach = (r0.toIsa + r0.sweepIsa + (r0.toLisa || 0)) / ps.length;
    for (const x of ps) add(`isa-${x.id}`, `${x.name}’s ISA allowance`, `The plan puts about ${money(isaEach)} into ISAs for ${x.name} this tax year, of ${money(s.isaAllowance)}. Unused allowance is lost on 5 April.`, `${money(Math.max(0, s.isaAllowance - isaEach))} left`);
    for (const a of p.accounts.filter(a => a.type === 'lisa' && !a.excluded)) {
      const x = ps.find(y => y.id === a.owner);
      if (x && x.age < R.LISA.payUntil) add(`lisa-${a.id}`, `${a.name}: the full ${money(R.LISA.maxContribution)}`, `Pay it in by 5 April for the ${money(R.LISA.maxContribution * R.LISA.bonus)} government bonus.`);
    }
    const region = p.household.region;
    for (const x of ps) {
      const pay = p.income.filter(i => i.kind === 'salary' && i.owner === x.id && E.incomeAfterCosts(i, p, 0) > 0);
      const gross = incomeForTax(p, x);   // after salary sacrifice and pension contributions
      if (!gross || p.household.ignoreTax) continue;
      const rate = R.incomeTax(gross + 100, region) - R.incomeTax(gross, region);
      if (rate >= 40) add(`pension-${x.id}`, `${x.name}: pension top-up at ${Math.round(rate)}% relief`, `${x.name} pays ${Math.round(rate)}% on the top of their pay (estimated). A pension contribution before 5 April gets that relief; unused allowance from the last 3 years can be carried forward (up to ${money(R.PENSION_ANNUAL_ALLOWANCE)} a year). ${pay.some(i => i.sacrifice) ? 'By salary sacrifice the relief is automatic (and saves NI): ask payroll to sacrifice more before April.' : 'Paid from take-home pay (relief at source), claim relief above 20% in the self-assessment return.'}`);
      if (gross > R.PA_TAPER_START && gross < R.PA_TAPER_START + 2 * R.PERSONAL_ALLOWANCE) add(`taper-${x.id}`, `${x.name}: the £100k tax trap`, `Pay between ${money(R.PA_TAPER_START)} and ${money(R.PA_TAPER_START + 2 * R.PERSONAL_ALLOWANCE)} loses the personal allowance (over 60% tax). Pension contributions bring adjusted net income back down.`);
      const kids = ((p.life && p.life.children) || []).filter(c => c.age < 18);
      if (kids.length && gross > R.CHILD_BENEFIT.chargeFrom && gross < R.CHILD_BENEFIT.chargeTo) add(`hicbc-${x.id}`, `${x.name}: Child Benefit charge`, `Income between ${money(R.CHILD_BENEFIT.chargeFrom)} and ${money(R.CHILD_BENEFIT.chargeTo)} claws back Child Benefit. Pension contributions lower the income it is measured on.`);
    }
    if (r0.gia > 0.5) add('bed-isa', 'Bed and ISA', `Move money from the general investment account (${money(r0.gia)}) into ISA allowance you have left. Gains up to ${money(R.CGT.annualExempt)} a year each are tax-free, so selling a little each year keeps the tax bill down.`);
    const kids = ((p.life && p.life.children) || []).filter(c => c.age < 18);
    if (kids.length) add('jisa', 'Junior ISA', `Up to ${money(R.JUNIOR_ISA_ALLOWANCE)} a year per child, tax-free until 18.`);
    add('payslip', 'Tax codes and payslips', 'Check each tax code is right (gov.uk personal tax account) and keep your P60s, which arrive by 31 May.');
    return out;
  }

  const PROTECTION = [
    { id: 'life', title: 'Life insurance', q: () => 'Life insurance for each of you?', why: () => 'Pays out if one of you dies, so the other can keep the home and the plan.',
      amount: () => { const r = lifeCoverNeed(); return `about ${fmtCompact(r.low)}–${fmtCompact(r.high)} each`; },
      tip: () => { const r = lifeCoverNeed(); return `A common way to size it: clear the mortgage (${money(r.mortgage)}) and cover ${r.years} years of living costs (${money(r.spend)} a year) until ${r.kids ? 'the youngest is 21' : 'the other can adjust'}. Level or decreasing term cover is usually cheap at your ages; written in trust it is paid quickly and stays outside the estate. Check any death-in-service cover from work first (often 2–4× salary).`; } },
    { id: 'income', title: 'Income protection', q: () => 'Income protection or good sick pay?', why: () => 'Replaces part of your pay if illness stops you working for months or years.',
      tip: () => 'Check your employers’ sick pay first (many universities pay months at full pay). Income protection then pays 50–70% of pay after a waiting period that matches when sick pay ends, until you can work again or retire.' },
    { id: 'will', title: 'Wills', q: () => 'Up-to-date wills for both of you?', why: () => 'Say who inherits and who looks after children.',
      tip: () => (plan().household.region === 'scotland'
        ? 'In Scotland, without a will the law decides who inherits, and a spouse or civil partner may not get everything. Children can claim “legal rights” either way. A solicitor’s wills for a couple usually cost a few hundred pounds; name guardians for your child too.'
        : 'Without a will the intestacy rules decide who inherits, and an unmarried partner gets nothing. Name guardians for your children too. A solicitor’s wills for a couple usually cost a few hundred pounds.') },
    { id: 'poa', title: 'Power of attorney', q: () => (plan().household.region === 'scotland' ? 'Power of attorney (continuing and welfare)?' : 'Lasting powers of attorney?'), why: () => 'Lets someone you trust manage money and decisions if you can’t.',
      tip: () => (plan().household.region === 'scotland'
        ? 'A continuing (money) and welfare power of attorney, registered with the Office of the Public Guardian (Scotland). Without one, your partner would need a court order to manage your accounts.'
        : 'Lasting powers of attorney for property & finance and for health & welfare, registered with the Office of the Public Guardian. Without them, your partner would need a court order.') },
    { id: 'nominations', title: 'Pension nominations', q: () => 'Told each pension scheme who should get it?', why: () => 'Pensions usually pass outside your will, by the scheme’s choice.',
      tip: () => 'Fill in an expression of wish (nomination) form for every pension, including workplace schemes like USS, and update it after big changes. Pensions are usually outside your estate for inheritance tax.' },
    { id: 'records', title: 'A list of accounts', q: () => 'Could your partner find every account?', why: () => 'Saves months of searching at the worst time.',
      tip: () => 'Keep a short list of accounts, pensions, policies and who to call, somewhere your partner knows. Horizon’s Data → Save to a file is one copy; a printed page in a safe place is another.' },
  ];

  // A rough life cover need: the mortgage plus some years of the household's spending.
  function lifeCoverNeed() {
    const p = plan(), r0 = model.proj.rows[0];
    const mortgage = p.accounts.filter(a => a.type === 'debt' && !a.excluded).reduce((acc, a) => acc + a.balance, 0);
    const kids = ((p.life && p.life.children) || []).map(c => c.age);
    const years = kids.length ? Math.max(3, 21 - Math.min(...kids)) : 5;
    const spend = r0.spending;
    return { mortgage, years, spend, kids: kids.length, low: mortgage + years * spend * 0.5, high: mortgage + years * spend };
  }

  // The hub on Home: every guide, with what is done.
  function renderGuides() {
    const p = plan();
    const g = ws.guides;
    const when = id => (g[id] && g[id].date ? `Done ${fmtDate(g[id].date)}` : null);
    const prot = g.protection ? PROTECTION.filter(q => g.protection.answers[q.id] !== 'yes').length : null;
    const taxDone = g[taxGuideId()] ? Object.keys(g[taxGuideId()].answers).length : 0;
    const taxAll = taxChecks().length;
    const due = RV.due(ws);
    const tiles = [
      { id: 'spending', icon: 'piggy', title: 'Spending check-up', text: 'Go through what you spend, with typical UK ranges.', status: when('spending'), open: openWizard },
      { id: 'life', icon: 'heart', title: 'Future costs', text: 'Children, cars, home repairs, travel and care: dated costs to come.', status: when('life') || (p.expenses.some(e => (e.key || '').startsWith('life:')) ? 'Added' : null), open: openLifeWizard },
      { id: 'retire-plan', icon: 'retire', title: 'Retirement plan', text: 'When you stop, what you spend, State Pensions.', status: p.goals.some(x => x.type === 'retire') ? 'Set up' : null, open: () => { const r = p.goals.find(x => x.type === 'retire'); return r ? openGoalWizard(r) : openGoalWizard(null, 'retire'); } },
      { id: 'retire', icon: 'clock', title: 'Can I retire at…?', text: 'One person, one age: what happens, what it costs, and the alternatives.', status: when('retire'), open: () => openGuide('retire') },
      { id: 'saving', icon: 'layers', title: 'Saving & investing', text: 'How much to put where each month, in the usual UK order.', status: null, open: () => navigate('finances/saving') },
      { id: 'tax', icon: 'review', title: 'Tax year-end check', text: `Allowances to use before 5 April ${taxYearEnd()}.`, status: taxDone ? `${taxDone} of ${taxAll} done` : null, open: () => openGuide('tax') },
      { id: 'questions', icon: 'review', title: 'Questions about your plan', text: 'Pensions, tax, investments: the details that change the advice.', status: (() => { const n = questionsLeft(); return n ? `${n} to answer` : g.questions ? 'All answered' : null; })(), warn: questionsLeft() > 0, open: () => openGuide('questions') },
      { id: 'estate', icon: 'home', title: 'What you leave behind', text: 'Inheritance tax on what the plan leaves, and ways to pass more on.', status: when('estate'), open: () => openGuide('estate') },
      { id: 'protection', icon: 'shield', title: 'Protection & paperwork', text: 'Life cover, sick pay, wills, power of attorney, pension nominations.', status: prot === null ? null : prot ? `${prot} to look at` : 'All in place', warn: prot > 0, open: () => openGuide('protection') },
      { id: 'review', icon: 'review', title: 'Yearly review', text: 'Swap estimates for real numbers once a year.', status: due.due ? 'Due now' : ws.checkins.length ? `Last ${fmtDate(ws.checkins[ws.checkins.length - 1].date)}` : null, warn: due.due, open: () => openReview() },
    ];
    const box = $('#ovGuides');
    if (!box) return;
    setKids(box,
      h('div', { class: 'guide-grid' }, tiles.map(t => h('button', { type: 'button', class: `guide-tile${t.status ? ' done' : ''}${t.warn ? ' warn' : ''}`, 'data-guide': t.id, onclick: t.open },
        h('span', { class: 'gt-ico' }, glyph(t.icon)),
        h('span', { class: 'gt-txt' }, h('strong', {}, t.title), h('small', {}, t.text)),
        h('span', { class: 'gt-status' }, t.status || 'Start')))));
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
        tab('scenarios', 'Scenarios'),
        h('button', { type: 'button', class: 'tab-plan', id: 'tabDossier', title: 'What to expect and what to do each year: read it, print it or save it as a PDF', onclick: openDossier }, glyph('review'), 'Plan, year by year')));
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
    // The guide's "only this part" view follows the page: off elsewhere, back on the step's own page.
    if (moved && setupStep !== null) setTimeout(applySetupFocus, 0);
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
        'Adjust for inflation'),
        showToSelect());
    }
  }

  // How far ahead the charts go. The plan itself always runs to the end age.
  function showToSelect() {
    const p1 = people()[0];
    const ages = [70, 80, 85, 90].filter(a => a > p1.age + 5 && a < p1.endAge);
    const opts = [...ages.map(a => [a, `Up to age ${a} (${plan().startYear + a - p1.age})`]), [0, `Whole plan, to ${p1.endAge} (${plan().startYear + p1.endAge - p1.age})`]];
    const cur = opts.some(o => o[0] === ws.settings.showTo) ? ws.settings.showTo : 0;
    return h('label', { class: 'show-to', title: `Charts stop here. The plan still runs to ${p1.endAge}, so the chances that money lasts are unchanged.` },
      h('span', { class: 'sr-only' }, 'Show charts'),
      h('select', { 'aria-label': 'Show charts up to', onchange: e => { ws.settings.showTo = +e.target.value; save(); renderResults(); } },
        opts.map(([v, label]) => h('option', { value: String(v), selected: v === cur }, label))));
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
    // Still the example, or the guide was left part-way: offer to carry on.
    const su = ws.guides.setup && ws.guides.setup.answers;
    const isExample = people().some(x => x.name === 'Alex') && plan().accounts.some(a => /^Alex /.test(a.name));
    if (setupStep === null && !(su && su.done) && (isExample || su)) {
      if (!su || su.quick === 'yes') {
        out.unshift(su
          ? { id: 'setup', icon: 'review', tone: 'accent', title: 'Make your plan more exact', text: 'Your plan uses round figures and typical values from the quick start. The guide goes through each part in turn: pensions and the State Pension, spending item by item, costs to come.', actions: [['Open the guide', () => openSetup()]] }
          : { id: 'setup', icon: 'review', tone: 'accent', title: 'Start your own plan', text: 'This is an example household. A few plain questions, about 5 minutes, and these pages show your own money.', actions: [['Start my plan', openQuickStart]] });
      } else out.unshift({ id: 'setup', icon: 'review', tone: 'accent', title: su ? 'Carry on setting up your plan' : 'Set up your own plan',
        text: su ? `You stopped at step ${Number(su.step) + 1} of ${SETUP_STEPS.length}: ${SETUP_STEPS[Number(su.step)] ? SETUP_STEPS[Number(su.step)].title.toLowerCase() : ''}.` : 'This is an example household. A guide goes through your own plan one part at a time, with what each figure means.',
        actions: [[su ? 'Carry on' : 'Start the guide', () => openSetup()]] });
    }
    return out;
  }

  function renderNotifications() {
    const banner = $('#exampleBanner');
    if (banner) banner.hidden = !isExamplePlan();
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
        : h('p', { class: 'sub' }, 'Nothing needs doing. Horizon will remind you when your figures are a month old and when the yearly review comes round.'),
      list.length ? h('p', { class: 'notify-foot' }, 'Also at the top of Home’s to-do list.') : null);
    // The same, at the top of Home's to-do list.
    const needs = $('#ovNeeds');
    if (needs) setKids(needs, list.length ? h('ul', { class: 'needs-list' }, list.map(n => h('li', { class: `needs-item ${n.tone}`, 'data-notify': n.id },
      h('span', { class: 'ins-ico' }, glyph(n.icon)),
      h('div', {}, h('span', { class: 'eyebrow' }, n.tone === 'warn' ? 'Check' : 'Needs you'), h('strong', {}, n.title), h('p', {}, n.text)),
      n.actions.length ? h('div', { class: 'needs-actions' }, n.actions.map(([label, fn], i) => h('button', { type: 'button', class: `btn small${i === 0 ? ' primary' : ''}`, onclick: fn }, label))) : null))) : null);
  }

  function renderScenarioPicker() {
    const sel = $('#scenarioSelect');
    setKids(sel, ws.scenarios.map(s => h('option', { value: s.id, selected: s.id === ws.activeId }, s.name)));
    const pill = $('#scenarioPill');
    pill.hidden = ws.scenarios.length < 2;
    setKids(pill, h('span', { class: 'rv-k' }, 'Scenario'), h('strong', {}, scenario().name));
    pill.title = 'Showing this scenario. Switch or compare in Scenarios.';
    // Not the main plan: a banner across the page says so, with the way back.
    const banner = $('#scenBanner'), main = ws.scenarios[0];
    banner.hidden = ws.activeId === main.id;
    setKids(banner, banner.hidden ? [] : [
      h('span', {}, 'You’re looking at the scenario ', h('strong', {}, `“${scenario().name}”`), '. Changes you make here stay in it.'),
      h('button', { type: 'button', class: 'btn small', id: 'backToMain', onclick: () => { ws.activeId = main.id; afterScenarioChange(); } }, `Back to ${main.name}`),
      h('button', { type: 'button', class: 'linkish', onclick: () => navigate('scenarios') }, 'Compare scenarios')]);
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

  // Charts over time stop when the first person reaches the "Show up to" age, but never before
  // a goal's year or a one-off event (care, a sale), so what the plan is about stays in view.
  function applyShowTo() {
    const to = ws.settings.showTo, p = plan(), p1 = people()[0];
    if (!to || to >= p1.endAge) { Chart.until = null; return; }
    const goalYear = g => (g.type === 'retire' ? p.startYear + g.age - (people().find(x => x.id === g.owner) || p1).age : g.year || 0);
    const latest = Math.max(0, ...p.goals.map(goalYear), ...p.events.map(e => e.year || 0));
    const end = p.startYear + (p1.endAge - p1.age);
    const until = Math.max(p.startYear + (to - p1.age), latest);
    Chart.until = until >= end ? null : until;
  }

  function renderResults() {
    tipCache.model = null;
    applyShowTo();
    renderTabs();
    renderView();
    if (route.tab === 'finances' && moneyPage === 'income') updateIncomeTrends();
    updateIncomeFigures();
    updateAccountFigures();
    updateSavingFigures();
    updateSummaries();
    if (MARKET && $('#mkSuggest')) setKids($('#mkSuggest'), marketSuggest());
    renderSavedNote();
    renderNotifications();
    renderScenarioPicker();
    scheduleDrivers();
    // Suggestion markers follow the new projection (new pages are decorated as they are drawn).
    if (document.querySelector('.tip-btn, [data-info]')) redecorate();
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

  // ------------------------------------------------------------------ get started: setting up a plan
  // A panel beside the real pages that walks someone new through their plan, one part at a time:
  // it asks a few questions (each with an "i"), adds the right kind of item with one click and opens
  // it, and says which fields to fill in and what they mean. Everything is typed into the normal
  // editors, so the guide can be closed and picked up again at any point.

  const firstVisit = (() => { try { return !localStorage.getItem(STORE); } catch { return false; } })();
  let setupStep = null;   // index into SETUP_STEPS while the panel is open

  // Adding items, as the buttons on each page do (and opening them to fill in).
  function addAccountOf(type, extra = {}) {
    const p = plan();
    const acc = E.normalizePlan({ ...p, accounts: [{ name: ACCOUNT_LABELS[type], type, owner: E.OWNED_TYPES.includes(type) ? 'p1' : 'joint', balance: 0, ...extra }] }).accounts[0];
    p.accounts.push(acc);
    editing.add(acc.id);
    showNew(acc.id);
    explorerValues = null;
    renderSection('accounts');
    refresh();
    return acc;
  }
  function addIncomeOf(kind, extra = {}) {
    const p = plan();
    const item = E.normalizePlan({ ...p, income: [{ name: kind === 'dbpension' ? 'Defined benefit pension' : kind === 'salary' ? 'Salary' : kindLabel(kind), owner: 'p1', kind, tax: kind === 'salary' ? 'uk' : 'none', amount: 0, freq: kind === 'dbpension' || kind === 'salary' ? 'year' : 'month', growth: kind === 'salary' ? 3 : 0, inflationLinked: kind !== 'salary', ...extra }] }).income[0];
    setKind(item, kind);
    if (extra.owner) item.owner = extra.owner;
    p.income.push(item);
    editing.add(item.id);
    showNew(item.id);
    renderSection('income');
    refresh();
    return item;
  }
  function addExpenseItem(extra = {}) {
    const p = plan();
    const e = E.normalizePlan({ ...p, expenses: [{ name: 'New expense', amount: 0, freq: 'month', inflationLinked: true, ...extra }] }).expenses[0];
    p.expenses.push(e);
    editing.add(e.id);
    showNew(e.id);
    renderSection('expenses');
    refresh();
    return e;
  }
  function addEventItem() {
    const p = plan();
    const ev = E.normalizePlan({ ...p, events: [{ name: 'New event', kind: 'expense', year: p.startYear + 1, amount: 0 }] }).events[0];
    p.events.push(ev);
    editing.add(ev.id);
    showNew(ev.id);
    renderSection('events');
    refresh();
    return ev;
  }

  // A term with its "i": the title and plain-English text shown when it is clicked.
  const sInfo = (title, text) => { const b = infoBtn({ title, text: () => text }); b.classList.add('keep'); return b; };
  // One thing to fill in: the label as it appears on the page, and what it means.
  const sField = (label, text, note) => h('li', { class: 'st-field' }, h('span', {}, h('strong', {}, label), sInfo(label, text)), note ? h('small', {}, note) : null);
  const sFields = (...items) => h('ul', { class: 'st-fields' }, items.filter(Boolean));
  // A question with its "i" and choices; picking one runs it and redraws the panel.
  function sAsk(question, why, choices) {
    return h('div', { class: 'st-ask' },
      h('p', { class: 'st-q' }, h('strong', {}, question), sInfo(question, why)),
      h('div', { class: 'st-choices' }, choices.map(([label, sub, pick, on]) => h('button', {
        type: 'button', class: 'st-choice', 'aria-pressed': String(!!on),
        // Redraw where it was: a choice must not jump the panel back to the top.
        onclick: () => { const b = $('#setupBody'), top = b ? b.scrollTop : 0; pick(); renderSetup(); const nb = $('#setupBody'); if (nb) nb.scrollTop = top; },
      }, h('strong', {}, label), sub ? h('small', {}, sub) : null))));
  }
  // Buttons that add an item and open it on the page.
  // An item of the same kind and name that is still empty is opened again, not added twice.
  function guideAdd(fn) {
    const p = plan();
    const lists = [['accounts', p.accounts], ['income', p.income], ['expenses', p.expenses], ['events', p.events]];
    const before = new Set(lists.flatMap(([, l]) => l.map(x => x.id)));
    fn();
    for (const [sec, list] of lists) {
      const fresh = list.find(x => !before.has(x.id));
      if (!fresh) continue;
      const twin = list.find(x => before.has(x.id) && (x.type || x.kind) === (fresh.type || fresh.kind) && x.name === fresh.name && (x.owner || '') === (fresh.owner || '') && !(x.balance > 0) && !(x.amount > 0));
      if (!twin) return;
      list.splice(list.indexOf(fresh), 1);
      editing.delete(fresh.id);
      editing.add(twin.id);
      showNew(twin.id);
      renderSection(sec);
      refresh();
      toast(`“${twin.name}” is already there, waiting to be filled in.`);
      return;
    }
  }
  const sAdd = (label, fn) => h('button', { type: 'button', class: 'btn small', onclick: () => { guideAdd(fn); renderSetup(); setTimeout(() => { const el = document.querySelector('.edit-wrap:last-of-type, [data-editing]'); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }, 60); } }, label);
  const sAdds = (...btns) => h('div', { class: 'st-adds' }, btns);
  const sText = (...t) => h('p', { class: 'st-text' }, ...t);
  const sHave = (items) => {
    const list = items.filter(Boolean);
    return list.length ? h('div', { class: 'st-have' }, h('span', { class: 'eyebrow' }, 'In your plan so far'), h('ul', {}, list.map(x => h('li', {}, glyph('good'), x)))) : null;
  };
  const namesOf = list => list.map(x => x.name).join(', ');
  const poss = n => (n === 'You' ? 'Your' : `${n}’s`);
  const accountsOf = (...types) => plan().accounts.filter(a => types.includes(a.type));
  const personPay = x => plan().income.filter(i => i.kind === 'salary' && i.owner === x.id);
  const openMoreOptions = sel => { for (const d of $$(`${sel} details.more`)) if (!d.open) d.querySelector('summary').click(); };
  // Answers kept with the guide: where you are in life, and how you live (own, rent, with family).
  const sAnswer = key => ((ws.guides.setup && ws.guides.setup.answers) || {})[key] || '';
  // Already retired: nobody has pay to stop, so retirement is now; savings held for drawing on
  // start at 60% in shares (unless the mix was already changed from the default).
  function setRetiredNow() {
    const p = plan();
    for (const x of p.household.people) x.retireAge = x.age;
    for (const g of p.goals.filter(g => g.type === 'retire')) g.age = E.retiree(p, g).age;
    if (p.assumptions.stockPctNow === 90 && p.assumptions.stockPctRetire === 60) { p.assumptions.stockPctNow = 60; p.assumptions.stockPctRetire = 60; }
    renderPlan();
    refresh();
  }
  const setAnswer = (key, v) => { const g = ws.guides.setup || { date: today(), answers: {} }; g.answers = { ...g.answers, [key]: v }; ws.guides.setup = g; save(); };
  const stage = () => sAnswer('stage');
  // A tip for where you are in life, shown in a soft box.
  const sTip = (...t) => h('div', { class: 'st-tip' }, glyph('tip'), h('p', {}, ...t));
  // Adding a one-off event, an expense or other items already filled in, then opened to check.
  const addEventOf = extra => { const ev = addEventItem(); Object.assign(ev, extra); renderSection('events'); refresh(); return ev; };
  const addCostOf = extra => addExpenseItem(extra);
  const yearsFrom = n => plan().startYear + n;
  const firstHome = () => plan().accounts.find(a => a.type === 'property' && a.buyYear > 0);

  // Ideas for situations that do not follow the usual rules, with how to put each in.
  const goSpend = () => navigate('finances/spending');
  const goIncome = () => navigate('finances/income');
  const goAccounts = () => navigate('finances/portfolio');
  const OWN_GROUPS = [
    { title: 'Family arrangements', stages: ['starting', 'building', 'nearing', 'retired'], items: [
      { title: 'Help from family towards a deposit', how: 'A gift is a one-off amount received in the year it is given, in today’s money. Gifts are not taxed for you; if the giver dies within 7 years, inheritance tax may apply on their side. If it is really a loan, add it as one instead.',
        add: [['Gift for the deposit', () => { goSpend(); addEventOf({ name: 'Gift from family for the deposit', kind: 'income', year: firstHome() ? firstHome().buyYear : yearsFrom(2), note: 'From family; a gift, not a loan' }); }]] },
      { title: 'Borrowing from family', how: 'A loan like any other: what you owe, the interest (often 0%) and what you pay back each month. If you only repay when you can, put the payment you expect; the note can say what was agreed.',
        add: [['Loan from family', () => { goAccounts(); addAccountOf('debt', { name: 'Loan from family', rate: 0, note: 'No interest; we pay back what we can' }); }]] },
      { title: 'Lending to family, or money owed to you', how: 'Money you expect back is a one-off amount received in a year (or other income for a few years, if it comes back monthly). Not sure it will come back? Leave it out, or try it in a copy of the plan.',
        add: [['Paid back in one go', () => { goSpend(); addEventOf({ name: 'Money paid back by family', kind: 'income', year: yearsFrom(3), note: 'Lent in …' }); }], ['Paid back monthly', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Money paid back by family', tax: 'none', endRef: 'year', toYear: yearsFrom(3) }); }]] },
      { title: 'Supporting a parent or relative', how: 'Regular help is spending, until a year or an age. Paying for care later? The Future costs check-up has care in later life. Help sent abroad is the same: put it in pounds.',
        add: [['Help for a relative', () => { goSpend(); addCostOf({ name: 'Help for a relative', amount: 0, freq: 'month', endRef: 'year', toYear: yearsFrom(10) }); }]] },
      { title: 'Family helping with your costs', how: 'Regular money from family is other income with no tax, until a year. A parent paying part of your rent or mortgage is the same.',
        add: [['Help from family', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Help from family', tax: 'none', endRef: 'year', toYear: yearsFrom(3) }); }]] },
      { title: 'Child maintenance, paid or received', how: 'Received: other income with no tax (child maintenance is not taxed), until the year it stops. Paid: spending until that year.',
        add: [['Maintenance received', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Child maintenance received', tax: 'none', endRef: 'year', toYear: yearsFrom(10) }); }], ['Maintenance paid', () => { goSpend(); addCostOf({ name: 'Child maintenance paid', amount: 0, freq: 'month', endRef: 'year', toYear: yearsFrom(10) }); }]] },
      { title: 'Spending that drops when the children leave home', how: 'Split out what the children cost (food, clothes, clubs, a bigger share of bills) as its own spending item, ending in the year the youngest turns 18 or leaves. The rest of your spending carries on. The Future costs check-up adds school, university and help later on.',
        add: [['Children’s share of spending', () => {
          goSpend();
          const kids = ((plan().life || {}).children || []).map(c => c.age);
          addCostOf({ name: 'Children’s share of spending', amount: 0, freq: 'month', endRef: 'year', toYear: yearsFrom(kids.length ? Math.max(1, 18 - Math.min(...kids)) : 10), note: 'Ends when the youngest turns 18' });
        }]] },
      { title: 'Another adult at home', how: 'Horizon plans for one or two people. An adult child or a parent living with you fits as money in and out: what they pay you towards the house is other income with no tax, and what you pay for them is spending, each until a year. Their own savings and pensions stay out of your plan.',
        add: [['They pay towards the house', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Keep from family at home', tax: 'none', endRef: 'year', toYear: yearsFrom(3) }); }], ['We pay for them', () => { goSpend(); addCostOf({ name: 'Costs for family at home', amount: 0, freq: 'month', endRef: 'year', toYear: yearsFrom(3) }); }]] },
      { title: 'A child’s savings you look after', how: 'A Junior ISA or savings in a child’s name are theirs, so list them without counting them: add the account and, under More options, turn off “Count this account”.',
        add: [['Child’s savings (not counted)', () => { goAccounts(); addAccountOf('cash', { name: 'Child’s savings', excluded: true, note: 'In the child’s name' }); }]] },
      { title: 'An inheritance you may get', how: 'A one-off amount received in a year, in today’s money (after any inheritance tax). Because it is uncertain, most people leave it out of their plan and try it in a copy (Scenarios → Duplicate).',
        add: [['Inheritance', () => { goSpend(); addEventOf({ name: 'Inheritance', kind: 'income', year: yearsFrom(15), note: 'Uncertain' }); }]] },
    ] },
    { title: 'Work, benefits and tax', stages: ['starting', 'building'], items: [
      { title: 'Self-employed, freelance or a side business', how: 'Your yearly profit as Self-employed income. As profit before tax, Horizon works out income tax and Class 4 National Insurance; or choose “after tax” if you set it aside yourself. Under More options, choose when it starts and ends.',
        add: [['Self-employed profit', () => { goIncome(); addIncomeOf('self', { owner: people()[0].id, name: 'Self-employed profit', tax: 'uk', freq: 'year', endRef: 'retire' }); }]] },
      { title: 'Income that is not taxed, or taxed in another way', how: 'Every income has its own tax: UK income tax, no tax (already taxed, a gift, a tax-free allowance like Rent a Room up to £7,500), or a flat rate you choose (e.g. tax taken abroad). Amounts in another currency can carry an exchange rate.',
        add: [['Income with no tax', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Income (no tax)', tax: 'none', endRef: 'end' }); }], ['Income from abroad', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Income from abroad', tax: 'flat', taxRate: 20, fx: 1, endRef: 'end' }); }]] },
      { title: 'Benefits', how: 'Child Benefit: other income with no tax, until the year your youngest is 16 (or 20 in education); above £60,000 of income it is clawed back, all of it from £80,000 (the plan takes that charge off the higher earner). Carer’s Allowance and most others: other income with UK income tax. Over State Pension age, Attendance Allowance (Pension Age Disability Payment in Scotland) helps with the extra costs of an illness or disability: not means-tested and not taxed, at a lower or higher weekly rate; add it from the age you expect to claim.',
        add: [['Child Benefit', () => { goIncome(); addIncomeOf('other', { owner: 'joint', name: 'Child Benefit', tax: 'none', amount: Math.round(R.CHILD_BENEFIT.eldest), freq: 'year', endRef: 'year', toYear: yearsFrom(16) }); }], ['Carer’s Allowance', () => { goIncome(); addIncomeOf('other', { owner: people()[0].id, name: 'Carer’s Allowance', tax: 'uk', freq: 'year', endRef: 'year', toYear: yearsFrom(5) }); }],
          ['Attendance Allowance', () => { goIncome(); const x = people().reduce((a, b) => (b.age > a.age ? b : a)); addIncomeOf('other', { owner: x.id, name: plan().household.region === 'scotland' ? 'Pension Age Disability Payment' : 'Attendance Allowance', tax: 'none', amount: Math.round(R.ATTENDANCE_ALLOWANCE.lower * 52), freq: 'year', inflationLinked: true, startRef: 'age', startAge: Math.max(x.age, x.statePensionAge, 80), endRef: 'end' }); }]] },
      { title: 'A lodger', how: 'Rent from a lodger is tax-free up to £7,500 a year under Rent a Room: add it as Rent with no tax. Above that, choose UK income tax.',
        add: [['Lodger', () => { goIncome(); addIncomeOf('rental', { owner: 'joint', name: 'Lodger', tax: 'none', endRef: 'year', toYear: yearsFrom(3) }); }]] },
      { title: 'Living abroad, or UK tax does not apply', how: 'On Finances → Assumptions, under Household, turn off “Work out UK tax”: every amount is then taken as already taxed. Incomes can still carry their own flat tax rate.',
        add: [['Switch off UK tax', () => { plan().household.ignoreTax = true; renderPlan(); refresh(); toast('UK tax is off: amounts are taken as already taxed. Turn it back on under Finances → Assumptions → Household.'); }]] },
    ] },
    { title: 'Home and property', stages: ['starting', 'nearing'], items: [
      { title: 'Buying a first home', how: 'Add the home as “Buying it later”: the year, today’s price, the deposit and the mortgage. In that year the deposit comes from your savings (a Lifetime ISA for a first home is paid out then) and the mortgage starts. End your rent in that year and add stamp duty and moving costs as a one-off.',
        add: [['A home I’ll buy later', () => { goAccounts(); addAccountOf('property', { name: 'First home', buyYear: yearsFrom(4), balance: 250000, rate: 3, deposit: 10, mortRate: 4.5, mortYears: 30 }); }], ['Stamp duty & moving', () => { goSpend(); addEventOf({ name: 'Stamp duty and moving costs', kind: 'expense', year: firstHome() ? firstHome().buyYear : yearsFrom(4), amount: 5000 }); }]] },
      { title: 'Shared ownership, or owning part of a home', how: 'Enter the share you own as the property (its value, not the whole home’s), the mortgage on that share, and the rent on the rest as spending. A home owned with family: just your share, with a note of who owns the rest.' },
      { title: 'Moving or downsizing', how: 'On the home you have, set “Sell in year” (More options); add the next home as “Buying it later” in the same year. A 100% deposit means no mortgage: the difference is saved or invested.',
        add: [['The next home', () => { goAccounts(); addAccountOf('property', { name: 'Next home', buyYear: yearsFrom(8), balance: 250000, rate: 3, deposit: 100 }); }]] },
      { title: 'A home abroad, or one you let out', how: 'Add it as a property (its value in pounds), and its rent as Rent income with the exchange rate, costs and the tax where it is let.' },
    ] },
    { title: 'Other things you own', stages: ['building', 'nearing', 'retired'], items: [
      { title: 'A business, land, a car or art you will sell', how: 'An “Other asset”: its value now, how fast it grows (or loses value) and, if you plan to, the year you sell it. It counts in net worth, and the money is saved or invested once sold.',
        add: [['Other asset', () => { goAccounts(); addAccountOf('asset', { name: 'Business', rate: 2 }); }]] },
      { title: 'Shares from work, crypto, gold', how: 'Anything you could sell quickly is an investment: a general investment account (gains can be taxed), with what you paid for it under More options. A very risky holding? Consider a lower growth, or leave it out and treat it as a bonus.',
        add: [['General investment account', () => { goAccounts(); addAccountOf('gia', { name: 'Other investments' }); }]] },
      { title: 'Something that does not fit anywhere', how: 'Break it into money in, money out and one-offs, with the years they happen. A note on each item says what it really is, so the plan still makes sense to you next year.' },
    ] },
  ];

  const SETUP_STEPS = [
    {
      id: 'start', title: 'Set up your own plan', route: 'home',
      render: () => {
        const p = plan();
        const isExample = p.household.people.some(x => x.name === 'Alex') && p.accounts.some(a => /^Alex /.test(a.name));
        return [
          sText('Horizon shows where your money is heading: what you will have, whether your goals are on track and what to do each month. This guide goes through your plan one part at a time: about 10 minutes for the basics, and the rest is optional. You can close it whenever you like and carry on later (Data → Set up my plan).'),
          h('div', { class: 'st-have' }, h('span', { class: 'eyebrow' }, 'Have these to hand'), h('ul', {}, [
            'Bank and savings balances', 'ISA, investment and pension balances (apps or statements)', 'Payslips, or what lands in your account each month',
            'Mortgage statement: balance, rate, monthly payment, when the fixed rate ends', 'Your State Pension forecast (gov.uk/check-state-pension)', 'A rough idea of what you spend',
          ].map(x => h('li', {}, x)))),
          isExample ? sAsk('Start from a blank plan?', 'Horizon opens with an example household (Alex and Sam) so you can look around. Starting blank clears it, so everything you see afterwards is yours. Nothing leaves this computer: the plan is kept in this browser, and you can save it to a file at the end.', [
            ['Yes, start my own plan', 'Clears the example', () => startBlankPlan(), false],
            ['Not yet, keep the example', 'These are not your figures. You can start blank later', () => {}, false],
          ]) : sText(p.accounts.length || p.income.length ? 'Your plan is already here: the steps below go through each part, so you can check or fill in what is missing.' : 'A blank plan, ready for your own figures: the steps below go through each part in turn.'),
          h('div', { class: 'st-ask' },
            h('p', { class: 'st-q' }, h('strong', {}, 'Your figures are as at'), sInfo('Your figures are as at', 'The date the balances you are about to type in are from: usually today. Everything Horizon predicts moves on from this date, and each yearly review moves it on again. If you copy figures from a statement or a spreadsheet made on another day, use that day.')),
            h('input', { type: 'date', value: p.asOf || today(), 'aria-label': 'Figures as at', onchange: e => { if (E.isDate(e.target.value)) { plan().asOf = e.target.value; plan().startYear = +e.target.value.slice(0, 4); renderPlan(); refresh(); } } })),
          sAsk('Where are you in life?', 'So the guide can point out what matters most for you: a student loan and a first home when you are starting out; pensions, the State Pension and when to stop when retirement is close. Nothing is hidden: every step is still there, and you can change this answer at any time.', [
            ['Just starting out', 'First jobs, renting or living with family', () => setAnswer('stage', 'starting'), stage() === 'starting'],
            ['Building up', 'Working, maybe a mortgage or children', () => setAnswer('stage', 'building'), stage() === 'building'],
            ['Retirement in sight', 'About 15 years or less to go', () => setAnswer('stage', 'nearing'), stage() === 'nearing'],
            ['Already retired', 'Living on pensions and savings', () => { setAnswer('stage', 'retired'); setRetiredNow(); }, stage() === 'retired'],
          ]),
          sAsk('Where do you live?', 'Scotland has its own income tax bands (19% to 48%); England, Wales and Northern Ireland share the UK bands (20% to 45%). National Insurance, capital gains tax and pensions are the same everywhere.', [
            ['Scotland', null, () => { plan().household.region = 'scotland'; plan().household.ignoreTax = false; renderPlan(); refresh(); }, p.household.region === 'scotland'],
            ['England, Wales or NI', null, () => { plan().household.region = 'ruk'; plan().household.ignoreTax = false; renderPlan(); refresh(); }, p.household.region === 'ruk'],
            ['Abroad, or UK tax does not apply', 'Amounts are taken as already taxed', () => { plan().household.ignoreTax = true; renderPlan(); refresh(); }, p.household.ignoreTax],
          ]),
          sText('Not everything has to fit a box. Family arrangements, work that is not a normal job, income taxed abroad: step 11, “Your own situation”, shows how to put each in, and any item can carry a note.'),
        ];
      },
    },
    {
      id: 'people', title: 'Who is the plan for?', route: 'finances/assumptions', target: '#sec-household',
      render: () => {
        const ps = people();
        return [
          sAsk('Just you, or you and a partner?', 'A plan for two counts both incomes, both pensions and both State Pensions, and lets accounts be joint. If you share money with a partner, plan together: retirement only works if it works for both of you.', [
            ['Just me', null, () => { if (people().length > 1) removePartner(); }, ps.length === 1],
            ['Me and a partner', null, () => { if (people().length < 2) addPartner(); }, ps.length > 1],
          ]),
          sText('On the page, for each person:'),
          sFields(
            sField('Name', 'Just to label things: “Sam’s pension”, “Alex retires at 60”.', 'The name at the top of each person’s card, with a pencil: click it and type.'),
            sField('Age now', 'Age today, in whole years. Everything is worked out year by year from here.'),
            stage() === 'retired' ? sField('Retirement age', 'Already set to your age now, as you are retired: Horizon plans from pensions and savings straight away. Change your age and it follows.', 'Set to your age now, as you are retired.')
              : sField('Retirement age', 'When pay stops. It does not need to be right: Horizon shows how likely it is to work, and you can try other ages later.'),
          ),
          sText('Then open ', h('strong', {}, 'More options'), ' under each person:'),
          sFields(
            sField('Plan until age', 'How long the money needs to last. 95 is a cautious choice: about 1 in 4 people now in their 60s reach it.'),
            sField('State Pension (today)', `What the State Pension will pay you, in today’s money: a year or a week, whichever your letter gives. Get your forecast at gov.uk/check-state-pension: it depends on your years of National Insurance (35 years for the full ${money(R.STATE_PENSION_FULL)} a year). Enter the yearly figure.`),
            sField('State Pension age', 'When it starts. Set by your date of birth: 66 now, rising to 67 and 68. Your forecast says yours.'),
            sField('Can access pension from', 'The earliest age you can take money from a workplace or personal pension. 57 for most people from April 2028; some older schemes allow 55.'),
          ),
          sField('Student loan', 'Also under More options. Repaid through your payslip: 9% of pay above a threshold (6% for a postgraduate loan), until it is paid off or written off. Choose your plan, what you owe and the year it is written off: Horizon works out the repayments, and when it ends your take-home pay rises.', stage() === 'starting' || stage() === 'building' ? 'Your plan, balance and write-off year are in your Student Loans Company account.' : null),
          stage() === 'nearing' || stage() === 'retired' ? sField('Put off the State Pension', `Also under More options. If you do not need it yet, putting it off adds about ${(R.SP_DEFER_PER_YEAR * 100).toFixed(1)}% a year for life. It takes about 17 years of the higher amount to catch up, so it pays if you are healthy and have other income meanwhile.`) : null,
          stage() === 'retired' ? sTip('Pensions you already receive go under Income, as an amount a year now. The State Pension can be typed a week, as on your letter.') : null,
          stage() === 'nearing' ? sTip('With retirement in sight, the State Pension forecast matters most: get yours (and your partner’s) at gov.uk/check-state-pension. If there are gaps in your National Insurance record, the forecast says whether buying extra years is worth it.') : null,
          stage() === 'starting' ? sTip('Starting out: put the age you would like to stop work (it can be far off; 67 or 68 is the State Pension age for you). The point is to see what today’s choices do.') : null,
          h('div', { class: 'st-adds' }, h('button', { type: 'button', class: 'btn small', onclick: () => openMoreOptions('#sec-household') }, 'Open “More options”')),
          sHave([`${ps.length === 1 ? 'Just' : 'Two people:'} ${namesOf(ps)}`, ...ps.filter(x => x.loanPlan).map(x => `${x.name}: student loan, ${money(x.loanBalance)} owed`)]),
        ];
      },
    },
    {
      id: 'pay', title: 'Your pay', route: 'finances/income', target: '#sec-income',
      render: () => [
        sText(stage() === 'retired' ? 'Retired: skip this step, unless someone still works a little (add it here; under More options, choose when it ends).' : 'Add each person’s pay from work. Skip anyone not working.'),
        sAdds(...people().map(x => sAdd(`+ ${poss(x.name)} pay`, () => addIncomeOf('salary', { owner: x.id, name: `${x.name === 'You' ? 'My' : poss(x.name)} pay`, endRef: 'retire' })))),
        sAdds(sAdd('+ Self-employed or freelance', () => addIncomeOf('self', { owner: people()[0].id, name: 'Self-employed profit', tax: 'uk', freq: 'year', endRef: 'retire' }))),
        sText('Then fill in, on the page:'),
        sFields(
          sField('Amount', 'Per month or per year: choose next to the amount.'),
          sField('Tax', 'Easiest is take-home: what lands in your bank account after tax, National Insurance and pension (your payslip’s “net pay”). Or enter the salary before tax and Horizon works out tax and NI. Take-home is simpler and matches your bank; before tax lets Horizon test tax-saving ideas exactly.'),
          sField('Pay rises', 'How much pay goes up each year on average, including inflation. 3–3.5% is typical while your career is progressing. “Rising like that until age” and “Then rises” let it level off later (e.g. 3.5% until 50, then 2.5%, in line with prices).'),
          sField('Workplace pension', 'Under More options: what you and your employer pay into your pension each month, from your payslip. As a % of salary or £ a month. Leave at 0 if you have none.'),
          sField('Salary sacrifice', 'If your payslip shows the pension coming off before tax as “salary sacrifice” (or “SMART”), switch it on: you pay no tax or NI on it. Your employer can tell you.'),
          sField('Self-employed', 'Your yearly profit (takings less business costs). As “profit before tax”, Horizon works out income tax and Class 4 National Insurance (6%, and 2% above £50,270). If you already set the tax aside, choose “after tax”. Uneven years? Use an average, or one item per period with the years under More options.'),
        ),
        stage() === 'starting' ? sTip('First job? Your employer must offer a workplace pension (auto-enrolment): usually 5% from you and 3% from them, on pay above £6,240. Staying in is almost always worth it: the employer’s share and tax relief are free money.') : null,
        stage() === 'nearing' ? sTip('Planning to cut down before stopping? Add a second pay item, e.g. “Part-time work”, starting at retirement and ending at an age (under More options).') : null,
        sHave(people().map(x => (personPay(x).length ? `${x.name}: ${personPay(x).map(i => `${money(i.amount)} a ${i.freq}`).join(', ')}` : null))),
      ],
    },
    {
      id: 'other-income', title: 'Other income', route: 'finances/income', target: '#sec-income',
      render: () => {
        const other = plan().income.filter(i => i.kind !== 'salary');
        return [
          sText('Anything else coming in now or later. Skip what you do not have.'),
          stage() === 'nearing' || stage() === 'retired' ? sTip('Pensions that pay a set income (NHS, teachers, civil service, USS, older “final salary” schemes) go here as a defined benefit pension; pots of money go with the accounts. An annuity you have bought already: add it as Other income, rising with prices or not, for good (one you may buy later is with the pension pots).') : null,
          sAdds(sAdd('+ Rent', () => addIncomeOf('rental', { owner: 'joint', name: 'Rent', tax: 'uk', endRef: 'end' })),
            sAdd('+ Defined benefit pension', () => addIncomeOf('dbpension', { owner: people()[people().length - 1].id })),
            sAdd('+ Other income', () => addIncomeOf('other', { owner: 'joint', endRef: 'end' }))),
          sFields(
            sField('Rent', 'From a property you let out. Under it: the exchange rate if it is paid in another currency (e.g. 0.84 for euros), costs as a % (management, repairs, empty months) and how it is taxed (a flat rate if it is taxed abroad).'),
            sField('Defined benefit pension', 'A pension that pays a set income for life, worked out from your salary and years in the scheme: USS for universities, the NHS, teachers’, civil service and other “final salary” or “career average” schemes. Enter what is built up so far (your yearly statement says), or use “Not sure what’s built up? Estimate it” with the year you joined and your salary.'),
            sField('Other income', 'Anything else: a gift each year, a part-time job in retirement, maintenance. Choose when it starts and ends under More options.'),
          ),
          sHave([other.length ? `${other.length} other income${other.length === 1 ? '' : 's'}: ${namesOf(other)}` : null]),
        ];
      },
    },
    {
      id: 'cash', title: 'Bank and savings', route: 'finances/portfolio', target: '#sec-accounts',
      render: () => [
        sText('Money in current accounts and savings accounts. One line per account, or one line for all of it: the plan treats cash the same.'),
        sAdds(sAdd('+ Cash & savings', () => addAccountOf('cash', { name: 'Bank account' }))),
        sFields(
          sField('Balance', 'What is in it today. The date your figures are as at is at the top of the page; the yearly review brings them up to date.'),
          sField('Count this account', 'Under More options. Turn off to list something without counting it, e.g. money that is not really yours.'),
        ),
        sHave(accountsOf('cash').map(a => `${a.name}: ${money(a.balance)}`)),
      ],
    },
    {
      id: 'investments', title: 'ISAs and investments', route: 'finances/portfolio', target: '#sec-accounts',
      render: () => [
        sText('Each ISA or investment account, with who it belongs to.'),
        sAdds(sAdd('+ ISA', () => addAccountOf('isa', { owner: 'p1', name: people()[0].name === 'You' ? 'My ISA' : `${people()[0].name} ISA` })),
          sAdd('+ Lifetime ISA', () => addAccountOf('lisa')),
          sAdd('+ General investment account', () => addAccountOf('gia')),
          sAdd('+ Bonds & gilts', () => addAccountOf('bonds'))),
        sFields(
          sField('ISA', `A stocks & shares or cash ISA: no tax on growth or withdrawals. Each person can pay in ${money(R.ISA_ALLOWANCE)} a year. Choose whose it is under “Whose”.`),
          sField('Lifetime ISA', 'For under-40s: the government adds 25% to up to £4,000 a year, for a first home or for after 60. Taking it out for anything else loses 25%.'),
          sField('General investment account', 'Investments outside an ISA or pension: gains and dividends can be taxed. Enter the amount you paid in under More options, to work out capital gains.'),
          sField('Bonds & gilts', 'Bonds or UK government gilts held directly: their interest rate (the “coupon”), the year they mature, whether they are held in an ISA (More options), and what happens to the coupons.'),
        ),
        stage() === 'starting' ? sTip(`Under 40 and saving for a first home? A Lifetime ISA adds 25% (up to ${money(R.LISA.maxContribution * R.LISA.bonus)} a year) towards a home costing up to ${money(R.LISA.homePriceCap)}. Under its More options choose “A first home” and the year: Horizon pays it out then, towards the deposit.`) : null,
        sHave(accountsOf('isa', 'lisa', 'gia', 'bonds').map(a => `${a.name}: ${money(a.balance)}`)),
      ],
    },
    {
      id: 'pensions', title: 'Pension pots', route: 'finances/portfolio', target: '#sec-accounts',
      render: () => [
        sText('Workplace and personal pensions that build up a pot of money (defined contribution, SIPPs). Pensions that pay a set income go under Other income instead.'),
        sAdds(...people().map(x => sAdd(`+ ${poss(x.name)} pension`, () => addAccountOf('pension', { owner: x.id, name: x.name === 'You' ? 'My pension' : `${x.name} pension` })))),
        stage() === 'nearing' || stage() === 'retired' ? sAdds(sAdd('+ Buy an annuity with part of a pot', () => { navigate('finances/income'); addIncomeOf('annuity', { owner: people()[0].id, name: 'Annuity' }); })) : null,
        sFields(
          stage() === 'nearing' || stage() === 'retired' ? sField('Annuity', 'Swapping part of a pension pot for an income for life, so it cannot run out. Enter the part of the pot, the income a quote gives (about 7% of the pot fixed, or 5% rising with prices, at 65) and the age. The rest of the pot stays invested and is drawn as needed.') : null,
          sField('Balance', 'The pot’s value today, from the provider’s app or latest statement. Add up several pots, or add one line each.'),
          sField('Whose', 'Each pension belongs to one person: it is taxed as their income when drawn.'),
          sField('Count this account', 'Under More options. Turn off for a pot you want listed but not counted yet, e.g. one with nothing in it.'),
        ),
        stage() === 'nearing' || stage() === 'retired' ? sTip(`Tax-free cash: Horizon takes a quarter of each pension withdrawal tax-free (up to ${money(R.LUMP_SUM_ALLOWANCE)} each over a lifetime) and taxes the rest as income, which usually pays less tax than taking it all at once. Old pots you have lost track of: the government’s Pension Tracing Service can find them.`) : null,
        sHave([...accountsOf('pension').map(a => `${a.name}: ${money(a.balance)}${a.excluded ? ' (not counted)' : ''}`),
          ...plan().income.filter(i => i.kind === 'annuity').map(i => `${i.name}: ${money(i.cost)} of the pot for ${money(i.amount)} a year from ${i.startAge}`)]),
      ],
    },
    {
      id: 'home', title: 'Your home and mortgage', route: 'finances/portfolio', target: '#sec-accounts',
      render: () => [
        sAsk('Where do you live now?', 'Owning, renting and living with family are planned differently. If you own, your home and mortgage go here. If you rent or live with family, what you pay is spending, and a home you hope to buy can be added here with the year, so the plan saves the deposit and starts the mortgage then.', [
          ['A home we own', 'With or without a mortgage', () => setAnswer('home', 'own'), sAnswer('home') === 'own'],
          ['Renting', null, () => setAnswer('home', 'rent'), sAnswer('home') === 'rent'],
          ['With family', 'Rent-free, or paying keep', () => setAnswer('home', 'family'), sAnswer('home') === 'family'],
          ['Something else', 'Shared ownership, a home that goes with a job…', () => setAnswer('home', 'other'), sAnswer('home') === 'other'],
        ]),
        sAnswer('home') === 'rent' ? sAdds(sAdd('+ Rent (in spending)', () => { navigate('finances/spending'); addCostOf({ name: 'Rent', amount: 0, freq: 'month' }); })) : null,
        sAnswer('home') === 'family' ? sAdds(sAdd('+ Keep paid to family (in spending)', () => { navigate('finances/spending'); addCostOf({ name: 'Keep paid to family', amount: 0, freq: 'month', note: 'What we agreed to pay towards the house' }); })) : null,
        sAnswer('home') === 'other' ? sText('Shared ownership: add the share you own as the property and its value, the mortgage on that share, and the rent on the rest in spending. A home that goes with a job or belongs to family: nothing to add here; put what you pay in spending, and note when it might change.') : null,
        sAnswer('home') && sAnswer('home') !== 'own'
          ? sAdds(sAdd('+ A home I’ll buy later', () => {
            const home = addAccountOf('property', { name: 'First home', buyYear: yearsFrom(4), balance: 250000, rate: 3, deposit: 10, mortRate: 4.5, mortYears: 30 });
            // Rent (or keep) stops the year the home is bought; otherwise the plan pays both for good.
            const rents = plan().expenses.filter(e => /^(rent|keep paid to family)$/i.test(e.name) && e.endRef === 'end');
            for (const e of rents) { e.endRef = 'year'; e.toYear = home.buyYear; e.toMonth = 0; }
            if (rents.length) { renderSection('expenses'); refresh(); toast(`${rents.map(e => e.name).join(' and ')} now ends in ${home.buyYear}, when the home is bought. If you change the year you buy, change it in Spending too.`); }
          }), sAdd('+ Loan, credit card or overdraft', () => addAccountOf('debt', { name: 'Loan or credit card' })))
          : sAdds(sAdd('+ Property', () => addAccountOf('property', { name: 'Home' })), sAdd('+ Mortgage', () => addAccountOf('debt', { name: 'Mortgage' })), sAdd('+ Loan, credit card or overdraft', () => addAccountOf('debt', { name: 'Loan or credit card' })), sAdd('+ A home I’ll buy later', () => addAccountOf('property', { name: 'Next home', buyYear: yearsFrom(5), balance: 300000, rate: 3, deposit: 10, mortRate: 4.5, mortYears: 25 }))),
        sFields(
          sField('A home I’ll buy later', 'Choose “Buying it later” and the year. Enter what a similar home costs today, the deposit as a % of the price and the mortgage you expect. In that year the deposit comes out of your savings, the home is counted and the mortgage starts. End your rent that year (Ends → In year…) and add stamp duty and moving costs as a one-off event.', firstHome() ? `${firstHome().name}: ${buyWorking(firstHome())}` : null),
          stage() === 'nearing' || stage() === 'retired' ? sField('Downsizing', 'On your home, under More options, set “Sell in year”. Then add the smaller home as “A home I’ll buy later” in the same year with a 100% deposit: the difference is saved or invested.') : null,
        ),
        sAnswer('home') && sAnswer('home') !== 'own' ? null : sFields(
          sField('Value', 'What it would sell for today, roughly (a recent valuation or similar homes nearby).'),
          sField('Growth', 'How much it rises in value a year on average. UK house prices have risen about 3–4% a year over the long run, roughly 1% above inflation.'),
          sField('Amount owed', 'From your latest mortgage statement or app.'),
          sField('Interest rate', 'The rate you pay now.'),
          sField('Monthly payment', 'What leaves your account each month for the mortgage.'),
          sField('Rate fixed until', 'Under More options: the year your fixed deal ends. After it, choose “Same end date, new payment” if you will remortgage onto a new deal, as most people do.'),
        ),
        sHave(accountsOf('property', 'debt').map(a => (a.type === 'property' && a.buyYear ? `${a.name}: buying in ${a.buyYear}, about ${money(a.balance)} today` : `${a.name}: ${a.type === 'debt' ? '−' : ''}${money(a.balance)}`))),
      ],
    },
    {
      id: 'spending', title: 'What you spend', route: 'finances/spending', target: '#sec-expenses',
      render: () => {
        const p = plan();
        const now = p.expenses.reduce((acc, e) => acc + E.streamAt(e, p, 0), 0);
        return [
          sText('Everything you spend except the mortgage (that is with the accounts). Two ways:'),
          sAdds(h('button', { type: 'button', class: 'btn small primary', onclick: openWizard }, 'Spending check-up'), sAdd('+ Add one item', () => addExpenseItem())),
          firstHome() && p.expenses.some(e => /rent/i.test(e.name) && e.endRef !== 'year') ? sTip(`Buying in ${firstHome().buyYear}? Open your rent and set Ends → In year… ${firstHome().buyYear}, so it stops when the mortgage starts.`) : null,
          stage() === 'retired' || stage() === 'nearing' ? sTip('In retirement, work costs (commuting, lunches) stop and the mortgage may be paid off, while travel and hobbies often rise. You can set one yearly figure for retirement later, under How you save.') : null,
          sFields(
            sField('Spending check-up', 'Goes through the usual categories (home, food, transport, children, holidays…) with typical UK amounts, so nothing is forgotten.'),
            sField('One item at a time', 'Type the name and amount, a month or a year. Copying your own list, e.g. from a spreadsheet or your bank app, works well.'),
            sField('a month / a year', 'Holidays, repairs and other yearly costs as a yearly amount; bills as a monthly one.'),
            sField('Ends', 'When it stops: at retirement, at an age (e.g. childcare until a child starts school), in a given year (e.g. rent until you buy), or at the end of the plan. Under More: when it starts, whose age it follows, and a note.'),
          ),
          sHave([p.expenses.length ? `${p.expenses.length} items: ${money(now / 12)} a month (${money(now)} a year)` : null]),
        ];
      },
    },
    {
      id: 'later', title: 'Costs that come later', route: 'finances/spending', target: '#sec-events',
      render: () => {
        const p = plan();
        return [
          sText('Big costs years from now are easy to forget and change the picture a lot.'),
          sAdds(h('button', { type: 'button', class: 'btn small primary', onclick: openLifeWizard }, 'Future costs'), sAdd('+ One-off event', () => addEventItem())),
          sFields(
            sField('Future costs', 'Children (school, university, a wedding), cars, home repairs every few years, care in later life and helping family, with typical UK amounts. It adds them as spending items and one-off events you can change.'),
            sField('One-off event', 'A single cost or windfall in a given year: a new kitchen, an inheritance, a lump sum off the mortgage. In today’s money; it rises with prices to that year.'),
          ),
          sHave([p.events.length ? `${p.events.length} one-off events` : null, p.expenses.some(e => (e.key || '').startsWith('life:')) ? `${p.expenses.filter(e => (e.key || '').startsWith('life:')).length} future costs in spending` : null]),
        ];
      },
    },
    {
      id: 'own', title: 'Your own situation', route: 'finances/spending',
      render: () => [
        sText('Real life does not always follow the rules. Horizon only needs to know money coming in, money going out, one-offs, and what you own and owe, so almost anything fits one of those. Each idea below adds an item filled in for you to change; a note on it keeps the story. Open the ones that apply.'),
        ...OWN_GROUPS.slice().sort((x, y) => (y.stages.includes(stage()) ? 1 : 0) - (x.stages.includes(stage()) ? 1 : 0)).map(g => h('details', { class: 'st-group', open: g.stages.includes(stage()) || null },
          h('summary', {}, h('strong', {}, g.title), h('small', {}, ` ${g.items.length} ideas`)),
          h('div', { class: 'st-recipes' }, g.items.map(r => h('div', { class: 'st-recipe' },
            h('p', { class: 'st-q' }, h('strong', {}, r.title), sInfo(r.title, r.how)),
            r.add ? sAdds(...r.add.map(([label, fn]) => sAdd(`+ ${label}`, fn))) : null))))),
        sTip('Not sure it will happen (an inheritance, a pay rise, help from family)? Leave it out of your plan and try it in a copy instead: Scenarios → Duplicate. Your plan then stays on the safe side.'),
      ],
    },
    {
      id: 'set-aside', title: 'Money set aside', route: 'finances/saving', target: '#reservesEdit',
      render: () => {
        const rs = plan().reserves;
        const KIND = { emergency: 'Emergency fund', saving: 'Saving up', budget: 'Yearly budget' };
        return [
          sText('Mark the part of an account that is already spoken for, so Home shows what is free to use. Nothing is counted twice.'),
          sAdds(sAdd('+ Emergency fund', () => addReserveOf('emergency')), sAdd('+ Saving up for a cost', () => addReserveOf('saving')), sAdd('+ Yearly budget', () => addReserveOf('budget'))),
          sFields(
            sField('Emergency fund', 'Money kept for the unexpected (losing a job, a big repair): usually 3–6 months of spending, in an easy-access account. Not to be spent or invested. It still counts in net worth.'),
            sField('Saving up for a cost', 'Money building up for a cost that comes back, like home repairs every few years. It stays invested until it is needed, but it is spoken for, so it is not counted in net worth.'),
            sField('Yearly budget', 'A yearly spending item, like holidays, that sits in the bank until spent. The plan counts it as spent; each yearly review asks how much is left.'),
            sField('Held in', 'Which account the money is in.'),
          ),
          sHave(rs.map(r => `${KIND[r.kind]}: ${r.name}`)),
        ];
      },
    },
    {
      id: 'saving', title: 'How you save', route: 'finances/saving', target: '#sec-strategy',
      render: () => [
        sText('What happens to money left over each month. The suggestions on the page are a good start; the main settings:'),
        sFields(
          sField('Cash buffer to keep', 'Cash kept in the bank before anything is invested: usually the same as the emergency fund.'),
          sField('Spending in retirement (a year)', 'What you expect to spend a year once retired, in today’s money. 0 keeps your spending list. A common rule: your list now, without the mortgage and work costs, plus a margin.'),
          sField('Pensions first, with tax relief', 'On the Saving & investing card above: once ISAs are full, put the rest into a pension (tax relief on the way in, locked until 57) instead of a general account.'),
          sField('Keep income under £100,000', 'Between £100,000 and £125,140 the tax-free allowance is withdrawn, so tax reaches over 60%. Paying the part above £100,000 into the pension avoids it.'),
          sField('Invest cash above the buffer', 'Money above the buffer (a gilt that matures, a windfall) is invested each year instead of sitting in cash.'),
        ),
      ],
    },
    {
      id: 'assumptions', title: 'Markets and inflation', route: 'finances/assumptions', target: '#sec-market',
      render: () => [
        sText('Long-run averages the plan uses. The defaults are sensible; change them only if you see things differently.'),
        sFields(
          sField('Inflation', 'How fast prices rise on average. The Bank of England aims for 2%; 2.5% is a little cautious.'),
          sField('Stock returns', 'Average yearly growth of shares, before inflation. 7% is close to the long-run average for global shares.'),
          sField('In shares now', 'Share of your investments in shares (a global tracker fund is 100%); the rest in bonds.'),
          sField('In shares by retirement', 'Many people move towards bonds as retirement nears, so a crash just before hurts less. 60% is a common mix.'),
          sField('Fund & platform fees', 'What your investment platform and funds charge a year, together. E.g. 0.14% for a cheap global tracker with a low platform fee.'),
          sField('Tax thresholds frozen until', 'Under More options. Tax bands are frozen until 2031 under current law, then rise with inflation.'),
        ),
      ],
    },
    {
      id: 'goals', title: 'Your goals', route: 'home', target: '#ovGoalsCard',
      render: () => {
        const gs = plan().goals;
        return [
          sText('What you are aiming for. Horizon shows the chance of each and what moves it.'),
          sAdds(h('button', { type: 'button', class: 'btn small primary', onclick: () => openGoalWizard(null) }, '+ Add a goal')),
          sFields(
            sField('Retire at an age', 'For each person: can you stop working then and keep spending what you plan to, until the end of the plan?'),
            sField('Reach an amount', 'E.g. £1 million by a year. Choose what counts: everything, everything except pensions, or savings only.'),
            sField('Mortgage-free by', 'The year the mortgage is paid off.'),
            sField('Emergency fund', 'Enough set aside to cover some months of spending.'),
          ),
          stage() === 'starting' ? sTip('Saving for a deposit? Add “Reach an amount” and choose savings only (cash and ISAs), by the year you want to buy.') : null,
          sHave(gs.map(g => E.autoTitle(g, plan()))),
        ];
      },
    },
    {
      id: 'questions', title: 'A few questions', route: 'home',
      render: () => [
        sText('Some details change the advice: how your pension is paid, where savings go once the ISAs are full, how much to hold in shares. They are asked one at a time, with what is usually recommended.'),
        sAdds(h('button', { type: 'button', class: 'btn small primary', onclick: () => openGuide('questions') }, 'Answer the questions')),
        sHave([(() => { const n = questionsLeft(); return n ? `${n} still to answer` : 'All answered'; })()]),
      ],
    },
    {
      id: 'save', title: 'Save a copy', route: 'home',
      render: () => [
        sText('Your plan is kept in this browser only. Save it to a file and keep it somewhere safe: it is how you open it on another computer, and a backup if the browser is cleared.'),
        sAdds(h('button', { type: 'button', class: 'btn small primary', onclick: exportFile }, 'Save to a file')),
        sFields(
          sField('Each year', 'Each autumn, the yearly review swaps the estimates for your real balances and shows how close the plan was. Home reminds you.'),
          sField('In between', 'Update a few balances whenever you like (Home → Update balances): the plan moves on from them.'),
        ),
        sText('That is everything. Home now shows where you are heading, and the plan is written out year by year to read, print and follow.'),
        sAdds(h('button', { type: 'button', class: 'btn small primary', id: 'setupDossier', onclick: openDossier }, 'Open the plan, year by year')),
      ],
    },
  ];

  // ------------------------------------------------------------------ quick start
  // A first plan from a few plain questions, one topic to a screen, answered in the dialog itself.
  // Round figures and typical values; the full guide and the pages refine it afterwards.
  let qs = null;
  const isExamplePlan = () => people().some(x => x.name === 'Alex') && plan().accounts.some(a => /^Alex /.test(a.name));
  const hasOwnPlan = () => !isExamplePlan() && (plan().accounts.length > 0 || plan().income.length > 0 || plan().expenses.length > 0);

  function openQuickStart() {
    qs = { step: 0, a: QS.blank(plan().household.region), err: '', saved: null, spendMode: '' };
    const dlg = $('#quickDlg');
    if (!dlg.open) dlg.showModal();
    renderQuick();
  }
  function closeQuickStart() { const dlg = $('#quickDlg'); if (dlg.open) dlg.close(); qs = null; }

  const qsCtx = () => ({ startYear: E.currentYear(), asOf: today() });
  const qsWho = () => QS.peopleOf(qs.a);
  const qsName = i => QS.nameOf(qs.a.people[i], i);
  // "you" / "Sam", "your" / "Sam’s", "do you" / "does Sam", for questions about one person.
  const qsYou = i => (i === 0 ? 'you' : qsName(i));
  const qsYour = i => (i === 0 ? 'your' : `${qsName(i)}’s`);
  const qsDo = i => (i === 0 ? 'do you' : `does ${qsName(i)}`);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  // Inputs that only store the answer: nothing is worked out until the end.
  function qsText(get, set, label, placeholder) {
    const i = h('input', { type: 'text', class: 'qs-input', value: get() || '', placeholder: placeholder || '', 'aria-label': label, autocomplete: 'off' });
    i.addEventListener('input', () => set(i.value));
    return i;
  }
  function qsNum(get, set, label, opts = {}) {
    const i = h('input', { type: 'text', inputmode: 'numeric', class: 'qs-input', value: get() ? String(get()) : '', placeholder: opts.placeholder || '', 'aria-label': label, autocomplete: 'off', style: 'max-width: 120px' });
    i.addEventListener('input', () => { set(parseFloat(i.value.replace(/[^0-9.]/g, '')) || 0); if (opts.after) opts.after(); });
    return opts.suffix ? h('div', { class: 'qs-money' }, i, h('small', {}, opts.suffix)) : i;
  }
  function qsMoney(get, set, label, opts = {}) {
    const i = h('input', { type: 'text', inputmode: 'decimal', class: 'qs-input', value: get() ? plain(get()) : '', placeholder: '0', 'aria-label': label, autocomplete: 'off' });
    i.addEventListener('input', () => { set(parseAmount(i.value) || 0); if (opts.after) opts.after(); });
    return h('div', { class: 'qs-money' }, h('span', {}, '£'), i, opts.suffix ? h('small', {}, opts.suffix) : null);
  }
  const qsQ = (label, control, hint) => h('div', { class: 'qs-q' }, h('span', { class: 'qs-label' }, label), control, hint ? h('span', { class: 'qs-hint' }, hint) : null);
  const qsChoices = (options, current, pick, two) => h('div', { class: `qs-choices${two ? ' two' : ''}` }, options.map(([value, label, sub]) => h('button', {
    type: 'button', class: 'qs-choice', 'aria-pressed': String(current === value), onclick: () => { pick(value); renderQuick(true); },
  }, h('strong', {}, label), sub ? h('small', {}, sub) : null)));
  const qsNote = (text, tone) => h('p', { class: `qs-note${tone ? ` ${tone}` : ''}` }, text);

  // The screens, in order. Each: a title, what it shows, and (optionally) what must be right to go on.
  function quickSteps() {
    const a = qs.a, ctx = qsCtx(), out = [];
    out.push({
      id: 'welcome', title: 'Will my money be OK?', bare: true,
      render: () => [
        h('p', { class: 'qs-lead' }, 'Answer a few questions about your money. Horizon then shows whether you are on track, when you could stop working, and what to do each month.'),
        h('ul', { class: 'qs-list' },
          h('li', {}, glyph('clock'), h('span', {}, h('strong', {}, 'About 5 minutes. '), 'Round figures are fine. You can correct anything afterwards.')),
          h('li', {}, glyph('good'), h('span', {}, h('strong', {}, 'Private. '), 'Nothing leaves this computer: no account, no sign-up. Your plan is kept in this browser.')),
          h('li', {}, glyph('info'), h('span', {}, h('strong', {}, 'Not sure of an answer? '), 'Each question says what to do. A sensible guess is better than stopping.'))),
        hasOwnPlan() ? qsNote('You already have a plan here. Finishing these questions replaces it, so save it to a file first (Data, then “Save to a file”) if you want to keep it.', 'warn') : null,
        h('div', { class: 'qs-start' },
          h('button', { type: 'button', class: 'btn primary', id: 'qsStart', onclick: () => { qs.step = 1; renderQuick(); } }, 'Start'),
          isExamplePlan() ? h('button', { type: 'button', class: 'qs-link', onclick: closeQuickStart }, 'Look around an example household first') : null),
      ],
    });
    out.push({
      id: 'you', title: 'First, about you',
      render: () => [
        qsQ('Who is this plan for?', qsChoices([[false, 'Just me'], [true, 'Me and a partner', 'Money you share or plan together']], a.partner, v => { a.partner = v; }, true)),
        h('div', { class: a.partner ? 'qs-person' : 'qs-q' },
          h('div', { class: 'qs-row' },
            qsQ('Your first name', qsText(() => a.people[0].name, v => { a.people[0].name = v; }, 'Your first name'), 'Optional. It makes the pages easier to read.'),
            qsQ('Your age', qsNum(() => a.people[0].age, v => { a.people[0].age = v; }, 'Your age')))),
        a.partner ? h('div', { class: 'qs-person' },
          h('div', { class: 'qs-row' },
            qsQ('Your partner’s first name', qsText(() => a.people[1].name, v => { a.people[1].name = v; }, 'Partner’s first name')),
            qsQ('Their age', qsNum(() => a.people[1].age, v => { a.people[1].age = v; }, 'Partner’s age')))) : null,
        qsQ('Where do you live?', qsChoices([['scotland', 'Scotland'], ['ruk', 'England, Wales or Northern Ireland']], a.region, v => { a.region = v; }, true), 'Income tax is different in Scotland.'),
      ],
      check: () => (qsWho().every(x => x.age >= 16 && x.age <= 100) ? '' : `Please type ${a.partner ? 'both ages' : 'your age'} (a number from 16 to 100).`),
    });
    qsWho().forEach((x, i) => {
      const spa = QS.spaOf(x, ctx.startYear);
      out.push({
        id: `pay${i}`, title: i === 0 ? (a.partner ? 'Your own pay' : 'Your pay') : `${qsName(i)}’s pay`,
        render: () => [
          qsQ(i === 0 ? 'How do you know your pay?' : `How do you know ${qsName(i)}’s pay?`, qsChoices([
            ['takehome', 'What lands in the bank each month', 'After tax and everything else has come off'],
            ['salary', 'A yearly salary', 'Before tax, as on a contract or job advert'],
            ['hourly', 'By the hour', 'An hourly rate and usual hours'],
            ['self', i === 0 ? 'I work for myself' : 'Works for themselves', 'Self-employed, or paid through your own company'],
            ['none', 'Not working, or retired'],
          ], x.pay, v => { x.pay = v; x.amount = 0; })),
          x.pay === 'self' ? qsQ(`About how much ${qsDo(i)} make in a year, before tax?`, qsMoney(() => x.amount, v => { x.amount = v; }, 'Made in a year before tax', { suffix: 'a year' }), 'What is left after business costs. With your own company: the salary and the dividends taken in a year, added together. If it goes up and down, use a typical year. Horizon works out the tax as for self-employment, which is close for dividends but not exact.') : null,
          x.pay === 'takehome' ? qsQ('How much lands in the bank in a normal month?', qsMoney(() => x.amount, v => { x.amount = v; }, 'Take-home pay a month', { suffix: 'a month' }), 'Look at a recent bank statement or payslip (“net pay”). If it varies, use a typical month.') : null,
          x.pay === 'salary' ? qsQ('What is the yearly salary, before tax?', qsMoney(() => x.amount, v => { x.amount = v; }, 'Salary a year', { suffix: 'a year' }), 'Include regular overtime. Horizon works out the tax and National Insurance.') : null,
          x.pay === 'hourly' ? h('div', { class: 'qs-row' },
            qsQ('Hourly rate', qsMoney(() => x.hourly, v => { x.hourly = v; }, 'Hourly rate', { suffix: 'an hour' })),
            qsQ('Hours in a normal week', qsNum(() => x.hours, v => { x.hours = v; }, 'Hours a week', { suffix: 'hours' }))) : null,
          x.pay === 'hourly' ? h('span', { class: 'qs-hint' }, 'Horizon turns this into a yearly figure and works out the tax. Extra shifts: add them to the hours if they are regular.') : null,
          x.pay === 'none' ? qsQ(`Pensions ${qsYou(i)} ${i === 0 ? 'are' : 'is'} paid now, if any`, qsMoney(() => x.pensionNow, v => { x.pensionNow = v; }, 'Pensions paid now a month', { suffix: 'a month' }), `What arrives in the bank from work or private pensions. Leave out the State Pension: Horizon adds that itself from age ${spa}. Leave empty if none.`) : null,
          QS.works(x) ? qsQ(`At what age would ${qsYou(i)} like to stop working?`, qsNum(() => x.retireAge || spa, v => { x.retireAge = v; }, 'Age to stop working'), `Not sure? Leave it at ${spa}, when the State Pension starts for ${qsYou(i)}. You can try other ages afterwards and see what each does.`) : null,
        ],
        check: () => (!x.pay ? 'Please choose one of the options.' : QS.works(x) && !(x.pay === 'hourly' ? x.hourly > 0 && x.hours > 0 : x.amount > 0) ? 'Please type the amount. A round figure is fine.' : ''),
      });
      out.push({
        id: `pension${i}`, title: i === 0 ? 'Your pension' : `${qsName(i)}’s pension`,
        render: () => [
          QS.employed(x) ? qsQ(`Does money come off ${qsYour(i)} pay for a pension at work?`, qsChoices([['yes', 'Yes'], ['no', 'No'], ['unsure', 'Not sure']], x.workPension, v => { x.workPension = v; }, false),
            'Most employees are put into one automatically.') : null,
          x.pay === 'self' ? qsQ(`How much ${qsDo(i)} pay into a pension each month, if anything?`, qsMoney(() => x.ownPension, v => { x.ownPension = v; }, 'Own pension payments a month', { suffix: 'a month' }),
            `Working for ${i === 0 ? 'yourself' : 'themselves'}, nothing goes into a pension unless ${qsYou(i)} ${i === 0 ? 'pay' : 'pays'} it in. What leaves the bank account in a normal month; the tax relief is added on top. Leave empty if nothing: the plan will then say what paying in would cost and build.`) : null,
          QS.employed(x) && x.workPension === 'yes' ? h('div', { class: 'qs-q' }, h('span', { class: 'qs-label' }, 'What kind of pension is it?'),
            qsChoices([['', 'An ordinary workplace pension', 'A pot of money with a company such as Nest, Aviva or Scottish Widows. Most jobs.']], x.scheme || '', v => { x.scheme = v; }),
            h('span', { class: 'qs-hint' }, 'Or one of these, which build a yearly pension for life and not a pot:'),
            qsChoices(Object.entries(QS.SCHEMES).map(([k, s]) => [k, s.label]), x.scheme || '', v => { x.scheme = v; }, true)) : null,
          QS.employed(x) && x.workPension === 'yes' && QS.SCHEMES[x.scheme] ? (() => {
            const est = h('span', { class: 'qs-hint' });
            const show = () => {
              const ok = x.joined >= 1960 && x.joined <= ctx.startYear, e = ok ? QS.schemeEstimate(x, a.region, ctx.startYear) : null;
              est.textContent = e && e.builtUp > 0.5 ? `About ${money(e.builtUp)} a year of pension built up so far (${e.years} year${e.years === 1 ? '' : 's'}), and about ${money(e.perYear)} more for each further year. A rough figure from ${qsYour(i)} pay now; the yearly benefit statement has the exact one, and you can put it in afterwards.`
                : 'Horizon works out roughly what is built up from this and the pay. The yearly benefit statement has the exact figure: you can put it in afterwards.';
            };
            show();
            return [qsQ(`In which year did ${qsYou(i)} join it?`, qsNum(() => x.joined, v => { x.joined = v; }, 'Year joined the scheme', { placeholder: 'e.g. 2008', after: show }), null), est,
              qsNote(`Horizon assumes about ${QS.SCHEMES[x.scheme].member}% of pay comes off for it, and that the pension is taken when work stops (it is smaller if that is before the scheme’s pension age).`, 'good')];
          })() : null,
          QS.employed(x) && (x.workPension === 'unsure' || (x.workPension === 'yes' && !QS.SCHEMES[x.scheme])) ? h('div', { class: 'qs-row' },
            qsQ(i === 0 ? 'You pay in' : `${qsName(i)} pays in`, qsNum(() => (x.eePct === null ? QS.AUTO_ENROL.employee : x.eePct), v => { x.eePct = v; }, 'Own pension contribution, % of pay', { suffix: '% of pay' })),
            qsQ('The employer pays in', qsNum(() => (x.erPct === null ? QS.AUTO_ENROL.employer : x.erPct), v => { x.erPct = v; }, 'Employer pension contribution, % of pay', { suffix: '% of pay' }))) : null,
          QS.employed(x) && (x.workPension === 'unsure' || (x.workPension === 'yes' && !QS.SCHEMES[x.scheme])) ? h('span', { class: 'qs-hint' }, `On the payslip or the pension letter. Not sure? Leave them: ${QS.AUTO_ENROL.employee}% and ${QS.AUTO_ENROL.employer}% are the usual amounts.`) : null,
          qsQ(QS.schemeOf(x) ? `Roughly how much is in any other pension pots of ${i === 0 ? 'yours' : `${qsName(i)}’s`}?` : `Roughly how much is in ${qsYour(i)} pensions so far?`, qsMoney(() => x.pot, v => { x.pot = v; }, 'Pension pots so far'), 'All pension pots added together: this job and old ones. It is on the yearly statement or the provider’s app. Not sure? Leave it empty for now and add it when you find out; the answer will be on the cautious side.'),
          qsQ(`Any pension that will pay ${qsYou(i)} a set amount a year?`, qsMoney(() => x.fixedPension, v => { x.fixedPension = v; }, 'Pension paying a set amount', { suffix: 'a year' }), 'From an old job, or the council, NHS, teachers’ or civil service scheme: the letter or yearly statement says “£X a year from age Y”. Add them together if there is more than one. Leave empty if none, or if you have lost the paperwork (gov.uk/find-pension-contact-details can trace it).'),
          qsQ('If so, paid from what age?', qsNum(() => x.fixedAge || spa, v => { x.fixedAge = v; }, 'Age the set pension starts'), `As the letter says. Not sure? Leave it at ${spa}.`),
          (x.age || 0) < spa ? qsQ(`Years of National Insurance on ${qsYour(i)} State Pension forecast`, qsNum(() => x.niYears, v => { x.niYears = v; }, 'National Insurance years so far', { suffix: 'years' }), 'At gov.uk/check-state-pension (“full years”). 35 give a full State Pension; working years still to come are added. Leave empty if you do not know: Horizon then assumes a full one.') : null,
        ],
        check: () => (QS.employed(x) && !x.workPension ? 'Please choose Yes, No or Not sure.'
          : QS.employed(x) && x.workPension === 'yes' && QS.SCHEMES[x.scheme] && !(x.joined >= 1960 && x.joined <= ctx.startYear) ? `Please type the year ${qsYou(i)} joined the scheme (for example 2008).` : ''),
      });
    });
    out.push({
      id: 'savings', title: 'Savings, and other money coming in',
      render: () => [
        qsQ('How much is in bank and savings accounts?', qsMoney(() => a.cash, v => { a.cash = v; }, 'Bank and savings'), 'All accounts added together, including Premium Bonds. If you are usually overdrawn, leave this empty: the overdraft goes in with debts.'),
        qsQ('Anything in ISAs or other investments?', qsMoney(() => a.investments, v => { a.investments = v; }, 'ISAs and investments'), 'Stocks and shares ISAs, funds, shares. Leave empty if none or not sure what this is.'),
        qsQ('Any money coming in each month because of children?', qsMoney(() => a.childMoney, v => { a.childMoney = v; }, 'Money for children', { suffix: 'a month' }), 'Child Benefit, maintenance from the other parent, the child part of Universal Credit. Leave empty if none.'),
        qsQ('If so, how old is the youngest child?', qsNum(() => a.youngest, v => { a.youngest = v; }, 'Age of the youngest child'), 'That money is counted until the youngest turns 18, then it stops.'),
        qsQ('Any other money coming in each month?', qsMoney(() => a.otherIncome, v => { a.otherIncome = v; }, 'Other money coming in', { suffix: 'a month' }), 'The rest of Universal Credit, money from a lodger or a grown-up child, help from family. Counted for good; you can give it an end date afterwards. Leave empty if none.'),
      ],
    });
    out.push({
      id: 'home', title: 'Your home',
      render: () => [
        qsQ('Where do you live?', qsChoices([
          ['mortgage', `A home ${a.partner ? 'we' : 'I'} own, with a mortgage`],
          ['own', `A home ${a.partner ? 'we' : 'I'} own outright`, 'No mortgage left'],
          ['rent', 'Renting'],
          ['family', 'With family or friends'],
        ], a.home, v => { a.home = v; })),
        a.home === 'mortgage' || a.home === 'own' ? qsQ('About what is the home worth?', qsMoney(() => a.homeValue, v => { a.homeValue = v; }, 'Home value'), 'What similar homes nearby have sold for. A rough figure is fine.') : null,
        a.home === 'mortgage' ? qsQ('How much is left on the mortgage?', qsMoney(() => a.mortgage, v => { a.mortgage = v; }, 'Mortgage left'), 'On the yearly mortgage statement or the lender’s app.') : null,
        a.home === 'mortgage' ? qsQ('What is the mortgage payment?', qsMoney(() => a.mortgagePay, v => { a.mortgagePay = v; }, 'Mortgage payment a month', { suffix: 'a month' }), `Horizon assumes an interest rate of ${QS.MORTGAGE_RATE}%. You can put your own rate in afterwards.`) : null,
        a.home === 'rent' ? qsQ('How much is the rent?', qsMoney(() => a.rent, v => { a.rent = v; }, 'Rent a month', { suffix: 'a month' }), 'Your share, if you split it.') : null,
        a.home === 'family' ? qsQ('Do you pay anything towards the house?', qsMoney(() => a.rent, v => { a.rent = v; }, 'Keep a month', { suffix: 'a month' }), 'Keep or digs. Leave empty if nothing.') : null,
        (() => {
          const box = h('input', { type: 'checkbox', checked: !!a.let, id: 'qsLet' });
          box.addEventListener('change', () => { a.let = box.checked; renderQuick(true); });
          return h('label', { class: 'qs-check' }, box, h('span', {}, h('strong', {}, `${a.partner ? 'We' : 'I'} also own a property that is rented out`), h('small', {}, 'A flat or house with a tenant in it.')));
        })(),
        a.let ? h('div', { class: 'qs-person' },
          h('div', { class: 'qs-row' },
            qsQ('What is it worth?', qsMoney(() => a.letValue, v => { a.letValue = v; }, 'Rented-out property value')),
            qsQ('Rent that comes in', qsMoney(() => a.letRent, v => { a.letRent = v; }, 'Rent received a month', { suffix: 'a month' }))),
          h('div', { class: 'qs-row' },
            qsQ('Mortgage left on it', qsMoney(() => a.letMortgage, v => { a.letMortgage = v; }, 'Mortgage left on the rented-out property')),
            qsQ('Its mortgage payment', qsMoney(() => a.letPay, v => { a.letPay = v; }, 'Mortgage payment on the rented-out property', { suffix: 'a month' }))),
          h('span', { class: 'qs-hint' }, 'Rent after the letting agent’s fee, if there is one. Leave the mortgage boxes empty if none. If the payment only covers the interest, Horizon keeps the amount owed level; tax on the rent is worked out for you.')) : null,
      ],
      check: () => (!a.home ? 'Please choose one of the four options.' : a.let && !(a.letValue > 0) ? 'Please type roughly what the rented-out property is worth, or untick that box.' : ''),
    });
    out.push({
      id: 'debts', title: 'Anything you owe',
      render: () => [
        h('p', { class: 'qs-lead' }, `Credit cards, loans, car finance, an overdraft, buy now pay later, money owed to family. ${a.home === 'mortgage' || (a.let && a.letMortgage > 0) ? `Not the mortgage${a.home === 'mortgage' && a.let && a.letMortgage > 0 ? 's: they are' : ': that is'} already in. ` : ''}Nothing owed? Just continue.`),
        ...a.debts.map((d, k) => h('div', { class: 'qs-debt' },
          h('label', {}, 'What is it?', (() => { const s = h('select', { 'aria-label': 'Kind of debt' }, Object.entries(QS.DEBTS).map(([v, o]) => h('option', { value: v }, o.label))); s.value = d.kind; s.addEventListener('change', () => { d.kind = s.value; }); return s; })()),
          h('label', {}, 'Owed now', qsMoney(() => d.owed, v => { d.owed = v; }, 'Amount owed')),
          h('label', {}, 'Paid a month', qsMoney(() => d.pay, v => { d.pay = v; }, 'Paid a month')),
          h('button', { type: 'button', class: 'btn ghost icon-btn', 'aria-label': 'Remove this debt', onclick: () => { a.debts.splice(k, 1); renderQuick(true); } }, '✕'))),
        h('div', {}, h('button', { type: 'button', class: 'btn', id: 'qsAddDebt', onclick: () => { a.debts.push({ kind: 'card', owed: 0, pay: 0 }); renderQuick(true); } }, a.debts.length ? '+ Add another' : '+ Add something I owe')),
        a.debts.length ? qsNote('Not sure of the interest rate? You do not need it: Horizon uses a typical rate for each kind, and you can correct it afterwards. For an overdraft, or if you do not know the payment, leave “Paid a month” empty.') : null,
        ...qsWho().map((x, i) => QS.works(x) ? (() => {
          const box = h('input', { type: 'checkbox', checked: !!x.loan });
          box.addEventListener('change', () => { x.loan = box.checked; renderQuick(true); });
          const plan = QS.loanPlanFor(x.age || 40, a.region, ctx.startYear);
          return h('div', { class: 'qs-q' },
            h('label', { class: 'qs-check' }, box, h('span', {}, h('strong', {}, i === 0 ? 'A student loan comes off my pay' : `A student loan comes off ${qsName(i)}’s pay`), h('small', {}, 'It is repaid through pay, 9% of what is earned above a threshold, and written off after 25 to 40 years.'))),
            x.loan ? qsQ('Roughly how much is left to repay?', qsMoney(() => x.loanOwed, v => { x.loanOwed = v; }, i === 0 ? 'Student loan left' : `${qsName(i)}’s student loan left`), `On the yearly statement or at gov.uk/sign-in-to-manage-your-student-loan-balance. Not sure? Leave it empty: Horizon uses a typical ${money(QS.LOAN_TYPICAL[plan])} and the rules for ${R.STUDENT_LOANS[plan].label.replace(/ \(.*/, '')}, the usual one for your age and where you live.`) : null);
        })() : null),
      ],
    });
    out.push({
      id: 'spending', title: 'What you spend',
      render: () => {
        const base = Math.round(QS.leftover(QS.build({ ...a, spending: 0 }, ctx)));
        const housing = a.home === 'mortgage' ? 'the mortgage' : a.home === 'rent' ? 'rent' : a.home === 'family' && a.rent > 0 ? 'keep' : '';
        const counted = [housing, a.debts.some(d => d.pay > 0) ? 'debt payments' : ''].filter(Boolean).join(' and ');
        const result = h('div', { id: 'qsLeft' });
        const show = () => {
          if (qs.spendMode === 'saved') a.spending = Math.max(0, Math.round((base - (qs.saved || 0)) / 10) * 10);
          const left = base - a.spending;
          setKids(result, !a.spending && qs.spendMode !== 'saved' ? null
            : qs.spendMode === 'saved' ? qsNote(`That means about ${money(a.spending)} a month goes on everything else. Horizon will use that.`, 'good')
              : left < -20 ? qsNote(`That is about ${money(-left)} a month more than comes in. If you are not running up debt or spending savings by that much, the figure is too high.`, 'warn')
                : left > base * 0.35 && left > 150 ? qsNote(`That would leave about ${money(left)} a month unspent. If your bank balance does not grow by about that much each month, this figure is too low, and the answers will look better than they are.`, 'warn')
                  : qsNote(`That leaves about ${money(Math.max(0, left))} a month to save.`, 'good'));
        };
        show();
        return [
          h('p', { class: 'qs-lead' }, `After tax${counted ? `, ${counted}` : ''} and pension, about ${money(Math.max(0, base))} a month is left. How much of it gets spent?`),
          qsQ('How would you rather answer?', qsChoices([
            ['spend', 'I know roughly what I spend a month'],
            ['saved', 'I know roughly what is left at the end of the month', 'Easier for most people'],
          ], qs.spendMode, v => { qs.spendMode = v; })),
          qs.spendMode === 'spend' ? qsQ('What do you spend in a normal month on everything else?', qsMoney(() => a.spending, v => { a.spending = v; }, 'Spending a month', { suffix: 'a month', after: show }),
            `Food, gas and electricity, council tax, phone and internet, transport, clothes, going out, holidays, presents, children.${counted ? ` Not ${counted}: already counted.` : ''}`) : null,
          qs.spendMode === 'saved' ? qsQ('In a normal month, how much is left over to save?', qsMoney(() => qs.saved, v => { qs.saved = v; }, 'Left over a month', { suffix: 'a month', after: show }),
            'What you actually manage to put away, or how much your bank balance goes up. If nothing is left, or you end the month overdrawn, leave this empty.') : null,
          result,
        ];
      },
      check: () => (!qs.spendMode ? 'Please choose one of the two ways to answer.' : qs.spendMode === 'spend' && !(a.spending > 0) ? 'Please type roughly what you spend a month.' : ''),
    });
    out.push({
      id: 'goals', title: 'What would you like to know?', last: true,
      render: () => {
        const g = a.goals, first = a.people[0];
        const check = (key, label, sub) => { const box = h('input', { type: 'checkbox', checked: !!g[key] }); box.addEventListener('change', () => { g[key] = box.checked; renderQuick(true); }); return h('label', { class: 'qs-check' }, box, h('span', {}, h('strong', {}, label), h('small', {}, sub))); };
        return [
          h('p', { class: 'qs-lead' }, 'Tick what matters to you. Each becomes a goal that Horizon tracks, with a plain answer.'),
          check('retire', QS.works(first) ? `Can I stop working at ${first.retireAge || QS.spaOf(first, ctx.startYear)}?` : 'Will my money last?', 'Whether the money lasts for the rest of your life.'),
          check('emergency', 'Do I have enough set aside for emergencies?', 'Three months of spending in cash, for a lost job or a broken boiler.'),
          a.home === 'rent' || a.home === 'family' ? check('buy', a.partner ? 'Could we buy a home?' : 'Could I buy a home?', 'Horizon works out the deposit and the mortgage, stops the rent that year, and shows what it does to everything else.') : null,
          g.buy && (a.home === 'rent' || a.home === 'family') ? h('div', { class: 'qs-person' },
            h('div', { class: 'qs-row' },
              qsQ('What does that kind of home cost today?', qsMoney(() => g.buyPrice, v => { g.buyPrice = v; }, 'Home price today'), 'Look at what similar homes nearby sell for. Horizon assumes a 10% deposit and a 30-year mortgage.'),
              qsQ('In which year?', qsNum(() => g.buyYear || ctx.startYear + 5, v => { g.buyYear = v; }, 'Year to buy')))) : null,
          check('save', 'Can I save up for something big?', 'A car, a wedding, a trip.'),
          g.save ? h('div', { class: 'qs-person' },
            qsQ('What for?', qsText(() => g.saveName, v => { g.saveName = v; }, 'Saving for')),
            h('div', { class: 'qs-row' },
              qsQ('How much?', qsMoney(() => g.saveAmount, v => { g.saveAmount = v; }, 'Amount to save'), 'In today’s prices. A first-home deposit is often 10% of the price.'),
              qsQ('By which year?', qsNum(() => g.saveYear || ctx.startYear + 5, v => { g.saveYear = v; }, 'Year')))) : null,
        ];
      },
      check: () => (a.goals.buy && (a.home === 'rent' || a.home === 'family') && !(a.goals.buyPrice > 0) ? 'Please type roughly what the home would cost, or untick that box.' : a.goals.save && !(a.goals.saveAmount > 0) ? 'Please type how much you want to save up, or untick that box.' : ''),
    });
    return out;
  }

  function renderQuick(keepScroll) {
    if (!qs) return;
    const steps = quickSteps();
    qs.step = Math.max(0, Math.min(steps.length - 1, qs.step));
    const s = steps[qs.step];
    const body = $('#qsBody'), top = body.scrollTop;
    $('#qsStep').textContent = s.bare ? '' : `Step ${qs.step} of ${steps.length - 1}`;
    $('#qsBar').style.width = `${Math.round((qs.step / (steps.length - 1)) * 100)}%`;
    setKids(body, h('h2', { id: 'qsTitle' }, s.title), qs.err ? h('p', { class: 'qs-err', role: 'alert' }, qs.err) : null, s.render());
    $('#qsFoot').hidden = !!s.bare;
    $('#qsNext').textContent = s.last ? 'Show me my plan' : 'Continue';
    body.scrollTop = keepScroll ? top : 0;
    if (s.bare) { const start = $('#qsStart'); if (start) start.focus(); }
    if (!keepScroll && !s.bare) { const first = body.querySelector('input:not([type=checkbox]), button.qs-choice'); if (first && first.tagName === 'INPUT' && !matchMedia('(max-width: 560px)').matches) first.focus(); }
  }

  function quickNext() {
    const steps = quickSteps(), s = steps[qs.step];
    qs.err = s.check ? s.check() : '';
    if (qs.err) { renderQuick(); return; }
    if (!s.last) { qs.step += 1; renderQuick(); return; }
    if (hasOwnPlan() && !confirm('This replaces the plan that is here now. Carry on?')) return;
    const id = E.uid();
    const built = QS.build(qs.a, qsCtx());
    ws = E.normalizeWorkspace({ scenarios: [{ id, name: 'My plan', plan: built }], activeId: id, checkins: [], settings: ws.settings, guides: { setup: { date: today(), answers: { step: 0, quick: 'yes' } } } });
    closeQuickStart();
    if (setupStep !== null) closeSetup();
    afterImport();
    navigate('home');
    window.scrollTo(0, 0);
    toast('Your plan is ready. This page says how you are doing; “Plan, year by year” at the top writes out what to do each year. Everything can be changed under Finances.');
  }

  // ------------------------------------------------------------------ the dossier
  // The whole plan as a document: what to expect and what to do, year by year. Read on screen,
  // printed, or saved as a PDF with the browser's own print (nothing leaves this computer).
  let docYears = 0;   // 0 = every year
  function dossierDoc() {
    const p = plan();
    const steps = todoItems().filter(s => !s.fromDoc).map(s => ({ when: s.when, title: s.title, text: s.text }));
    const sc = ws.scenarios.find(s => s.id === ws.activeId);
    return DS.build(p, model.proj, model.mc, model.goals, { steps, years: docYears < 0 ? 1 : docYears || undefined, scenario: ws.scenarios.length > 1 && sc ? sc.name : '' });
  }

  function openDossier() {
    if (setupStep !== null) closeSetup();
    const N = model.proj.rows.length - 1, ps = people();
    const toRetire = Math.max(...ps.map(x => x.retireAge - x.age), 0) + 5;
    const opts = [[-1, 'Only what to do now and next year (a page or two)'], [0, `Every year, to ${plan().startYear + N - 1} (${N} years)`], [Math.min(N, Math.max(5, toRetire)), `Until five years after stopping work (${Math.min(N, Math.max(5, toRetire))} years)`], [Math.min(N, 10), 'The next ten years'], [Math.min(N, 5), 'The next five years']];
    const sel = $('#docYears');
    setKids(sel, opts.filter(([v], i, a) => a.findIndex(o => o[0] === v) === i).map(([v, label]) => h('option', { value: String(v) }, label)));
    sel.value = String(docYears);
    if (sel.selectedIndex < 0) { docYears = 0; sel.value = '0'; }
    document.body.classList.add('dossier-open');
    $('#dossier').hidden = false;
    renderDossier();
    window.scrollTo(0, 0);
  }
  function closeDossier() {
    document.body.classList.remove('dossier-open');
    $('#dossier').hidden = true;
    setKids($('#docBody'));
    window.scrollTo(0, 0);
  }

  // Colours follow the thing, as on the live charts: cash is always the same blue, and so on.
  const DOC_COLOR = { cash: '--s1', isa: '--s2', gia: '--s3', pension: '--s4', bonds: '--s5', property: '--s6', debt: '--s8',
    income: '--s1', statePension: '--s3', drawn: '--s4', spending: '--s5', tax: '--s6', saved: '--s2' };
  let docWidth = 0;   // the width the dossier's charts were last drawn for

  function renderDossier() {
    const d = dossierDoc(), g = DS.gbp, pic = d.pictures;
    // Charts are drawn for the width of the text column, so their labels stay readable on any screen.
    const body = $('#docBody'), cs = getComputedStyle(body);
    const W = Math.max(240, Math.min(768, Math.round(body.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))));
    docWidth = W;
    const keys = items => h('div', { class: 'doc-keys' }, items.map(it => h('span', {}, h('i', { class: `key ${it.shape || 'square'}`, style: `--key:var(${it.color})` }), it.label)));
    const figure = (title, svg, items, note) => {
      const box = h('div', { class: 'doc-plot' });
      box.innerHTML = svg;
      return h('figure', { class: 'doc-fig' }, h('figcaption', {}, title), box, items && items.length ? keys(items) : null, note ? h('p', { class: 'doc-explain' }, note) : null);
    };
    const tipOf = (xs, series) => i => `${xs[i]}\n${series.filter(s => Math.abs(s.values[i]) > 0.5).map(s => `${s.label}: ${g(Math.abs(s.values[i]))}`).join('\n')}`;
    const coloured = list => list.map(s => ({ ...s, color: DOC_COLOR[s.id] || '--s7' }));
    const marks = pic.markers.map(m => ({ x: m.year, label: m.label }));
    // One bar cut into its parts, with each part's amount and share written underneath.
    const bar = (parts, monthly) => {
      const total = parts.reduce((a, x) => a + x.value, 0);
      if (!(total > 0.5)) return null;
      return h('div', { class: 'doc-bar-fig' },
        h('div', { class: 'doc-barline', role: 'img', 'aria-label': parts.map(x => `${x.label} ${Math.round((x.value / total) * 100)}%`).join(', ') },
          parts.map(x => h('i', { style: `width:${(x.value / total) * 100}%;background:var(${DOC_COLOR[x.id] || '--s7'})`, title: `${x.label}: ${g(x.value)}` }))),
        h('ul', { class: 'doc-barkeys' }, parts.map(x => h('li', {}, h('i', { class: 'key square', style: `--key:var(${DOC_COLOR[x.id] || '--s7'})` }), h('span', {}, x.label),
          h('b', {}, monthly ? `${g(x.value / 12)} a month` : g(x.value)), h('em', {}, `${Math.round((x.value / total) * 100)}%`)))));
    };
    const worthSeries = coloured(pic.kinds);
    const netLine = { label: 'Net worth', color: '--text', values: pic.net };
    const fan = pic.range ? [
      { lower: pic.range.p10, upper: pic.range.p90, color: '--band', alpha: 0.14 },
      { lower: pic.range.p25, upper: pic.range.p75, color: '--band', alpha: 0.26 },
    ] : [];
    const fanLines = pic.range ? [{ label: 'The middle future', color: '--s1', values: pic.range.p50 }, { label: 'On average returns', color: '--text-2', values: pic.net, dash: [6, 4] }] : [];
    const fanKeys = [{ label: 'The middle future', color: '--s1', shape: 'line' }, { label: 'On average returns (the figures in this document)', color: '--text-2', shape: 'dash' }, { label: 'Half of futures', color: '--band', shape: 'band' }, { label: '8 in 10 futures', color: '--band', shape: 'band' }];
    const pictures = h('section', { class: 'doc-section', id: 'doc-pictures' }, h('h2', {}, 'The plan in pictures'),
      h('p', { class: 'doc-sub' }, 'The whole plan at a glance, before the detail. Amounts are in the pounds of each year, on average returns; the last chart shows how far real markets could push it either way.'),
      figure('What you own and owe, year by year',
        SV.plot({ width: W, height: 280, xs: pic.years, areas: worthSeries, lines: [netLine], markers: marks, label: 'What you own and owe, year by year', tip: tipOf(pic.years, [...worthSeries, netLine]) }),
        [...worthSeries.map(s => ({ label: s.label, color: s.color })), { label: 'Net worth (what you own minus what you owe)', color: '--text', shape: 'line' }],
        'Balances at the start of each year. What is owed is drawn below the line; the black line is what is left once it is taken off.'),
      (() => { const fl = coloured(pic.flows); return figure('Money in and money out, each year',
        SV.plot({ width: W, height: 280, xs: pic.flowYears, bars: fl, markers: marks, label: 'Money in and money out, each year', tip: tipOf(pic.flowYears, fl) }),
        fl.map(s => ({ label: s.label, color: s.color })),
        'Above the line is what comes in; below it is where it goes. While you work, pay covers everything and the rest is saved. Later, savings and pensions fill the gap.'); })(),
      pic.pensions.length ? (() => { const ps = pic.pensions.map((s, i) => ({ ...s, color: ['--s4', '--s7'][i % 2] })); return figure('Pension pots',
        SV.plot({ width: W, height: 220, xs: pic.years, lines: ps, markers: marks, label: 'Pension pots by year', tip: tipOf(pic.years, ps) }),
        ps.map(s => ({ label: s.label, color: s.color, shape: 'line' })), 'They grow while contributions go in, then fall as they pay for retirement.'); })() : null,
      pic.debts.length && pic.debtYears > 1 ? (() => { const xs = pic.years.slice(0, pic.debtYears), ds = pic.debts.map((s, i) => ({ ...s, values: s.values.slice(0, pic.debtYears), color: ['--s8', '--s7', '--s5', '--s3'][i % 4] })); return figure('What is still owed',
        SV.plot({ width: W, height: 220, xs, lines: ds, label: 'What is still owed, by year', tip: tipOf(xs, ds) }),
        ds.map(s => ({ label: s.label, color: s.color, shape: 'line' })), 'Each mortgage or loan, down to nothing.'); })() : null,
      pic.range ? figure('How far off it could be: net worth across the futures tried',
        SV.plot({ width: W, height: 260, xs: pic.years, bands: fan, lines: fanLines, markers: marks, label: 'The range of net worth across the futures tried',
          tip: i => `${pic.years[i]}\nA bad run: ${g(pic.range.p10[i])}\nThe middle: ${g(pic.range.p50[i])}\nA good run: ${g(pic.range.p90[i])}\nOn average returns: ${g(pic.net[i])}` }),
        fanKeys, 'The darker band holds half of the futures tried and the lighter one eight in ten. The table at the end of the document gives the figures.') : null);
    const who = d.meta.people.map(x => `${x.name === 'You' ? 'You' : x.name}, ${x.age}`).join(' and ');
    const table = (group, monthly) => h('table', { class: `lines${monthly ? '' : ' no-month'}` },
      h('thead', {}, h('tr', {}, h('th', {}, ''), h('th', { class: 'num' }, group.id === 'end' || group.id === 'debt' ? 'At the end' : 'In the year'), h('th', { class: 'num' }, monthly ? 'A month' : ''), h('th', {}, ''))),
      h('tbody', {},
        group.lines.map(l => h('tr', { class: l.strong ? 'strong' : null }, h('td', {}, l.label), h('td', { class: 'num' }, g(l.value)), h('td', { class: 'num' }, monthly ? g(l.value / 12) : ''), h('td', { class: 'note' }, l.note))),
        group.total ? h('tr', { class: 'total' }, h('td', {}, group.total.label), h('td', { class: 'num' }, g(group.total.value)), h('td', { class: 'num' }, monthly ? g(group.total.value / 12) : ''), h('td', { class: 'note' }, monthly && / a month$/.test(group.total.note) ? '' : group.total.note)) : null));
    const MONTHLY = { in: true, off: true, out: true, save: true, draw: true, pension: false, debt: false, end: false };
    const yearSection = y => h('section', { class: 'doc-year', id: `doc-${y.year}` },
      h('h2', {}, String(y.year), h('small', {}, `${planYearSpan(d.meta.asOf, y.t) ? `${fmtDate(planYearSpan(d.meta.asOf, y.t).from)} to ${fmtDate(planYearSpan(d.meta.asOf, y.t).to)} · ` : ''}${y.ages.map(a => `${a.name === 'You' ? 'You' : a.name} ${a.age}`).join(' · ')} · ${y.phase === 'working' ? 'working' : y.phase === 'part' ? 'one of you working' : 'retired'}`)),
      h('p', { class: 'doc-headline' }, y.headline),
      y.net ? h('p', { class: 'doc-sub' }, `By ${planYearSpan(d.meta.asOf, y.t) ? fmtDate(planYearSpan(d.meta.asOf, y.t).to) : 'the end of the year'}, net worth is about ${g(y.net.value)} (${g(y.net.real)} in today’s money) on average returns${y.net.low !== null && y.net.high !== null ? `; in a bad run of markets about ${g(y.net.low)}, in a good run about ${g(y.net.high)}` : ''}.`) : null,
      y.changes.length ? h('div', { class: 'doc-box new' }, h('h3', {}, y.t === 0 ? 'Worth knowing this year' : 'New this year'), h('ul', {}, y.changes.map(c => h('li', {}, c)))) : null,
      y.todo.length ? h('div', { class: 'doc-box todo' }, h('h3', {}, 'To do this year'), h('ul', {}, y.todo.map(s => h('li', {}, h('strong', {}, s.title), s.text ? ` ${s.text}` : '')))) : null,
      y.split.length ? h('div', { class: 'doc-glance' },
        h('h3', {}, 'The year at a glance'),
        h('p', { class: 'doc-explain' }, `Where the year’s money goes${y.drawn > 0.5 ? `. ${g(y.drawn)} of it comes out of savings and pensions` : ''}.`),
        bar(y.split, true),
        pic.range || pic.net.length > 2 ? [
          h('p', { class: 'doc-explain' }, `Where ${y.year} sits on the plan: net worth at the end of the year and in the years around it${pic.range ? ', with the range across the futures tried (8 in 10 fall inside the band)' : ''}.`),
          (() => { const box = h('div', { class: 'doc-plot' }); // Ten years back and fifteen on: the whole plan on one scale would flatten the early years.
            const from = Math.max(0, y.t + 1 - 10), to = Math.min(pic.years.length, Math.max(y.t + 1 + 16, from + 26)), cut = v => v.slice(from, to);
            box.innerHTML = SV.plot({ width: W, height: 130, xs: cut(pic.years), bands: fan.slice(0, 1).map(f => ({ ...f, lower: cut(f.lower), upper: cut(f.upper) })), lines: [{ label: 'Net worth', color: '--s1', values: cut(pic.net) }], here: y.t + 1 - from, label: `Net worth around ${y.year}, with the year marked` }); return box; })(),
        ] : null) : null,
      y.groups.map(gr => [h('h3', {}, gr.title), h('p', { class: 'doc-explain' }, gr.explain), table(gr, MONTHLY[gr.id]),
        gr.id === 'end' && y.holdings.length > 1 ? [h('p', { class: 'doc-explain' }, `What you own at the end of ${y.year}, by kind${y.owed > 0.5 ? ` (before taking off the ${g(y.owed)} still owed)` : ''}.`), bar(y.holdings, false)] : null]));
    const decades = [];
    for (const y of d.years) if (y.t === 0 || y.year % 5 === 0) decades.push(y.year);
    const only = docYears < 0;   // just the sheet to act on
    const doList = items => h('ul', {}, items.map(s => h('li', {}, h('strong', {}, s.title), s.text ? ` ${s.text}` : '')));
    const sh = d.sheet;
    const sheet = h('section', { class: 'doc-section', id: 'doc-do' }, h('h2', {}, 'What to do: now and next year'),
      h('p', { class: 'doc-sub' }, only ? 'The short version, to keep in sight. The full plan, with every year’s figures, is under “Years written out” at the top.' : 'The short version, to keep in sight. Each year’s page further on has the figures behind it.'),
      sh.now.length ? h('div', { class: 'doc-box todo' }, h('h3', {}, 'Now'), h('p', { class: 'doc-explain' }, 'Set these up this month; most then run by themselves.'), doList(sh.now)) : null,
      sh.tax.length ? h('div', { class: 'doc-box todo' }, h('h3', {}, 'Before the tax year ends'), doList(sh.tax)) : null,
      sh.next ? h('div', { class: 'doc-box todo' }, h('h3', {}, planYearSpan(d.meta.asOf, 1) ? `Next year (${sh.next.year}: from ${fmtDate(planYearSpan(d.meta.asOf, 1).from)})` : `Next year (${sh.next.year})`),
        sh.next.todo.length ? doList(sh.next.todo) : h('p', {}, 'Nothing new to set up: carry on as this year.'),
        sh.next.changes.length ? [h('p', { class: 'doc-explain' }, 'What is different next year:'), h('ul', {}, sh.next.changes.map(c => h('li', {}, c)))] : null) : null,
      d.everyYear.length ? h('div', { class: 'doc-box new' }, h('h3', {}, 'Every year'), doList(d.everyYear)) : null);
    if (only) {
      setKids($('#docBody'),
        h('section', { class: 'doc-cover' },
          h('h1', {}, d.meta.title.replace('plan, year by year', 'plan: what to do')),
          h('p', { class: 'doc-sub' }, `${who}. Figures as at ${fmtDate(d.meta.asOf)}; written out on ${fmtDate(today())}${d.meta.scenario ? `; scenario “${d.meta.scenario}”` : ''}.`)),
        h('section', { class: 'doc-section', id: 'doc-short' }, h('h2', {}, 'In short'),
          d.short.length ? h('ul', { class: 'doc-short' }, d.short.map(s => h('li', { class: s.status }, h('strong', {}, s.title), h('br', {}), s.text, s.status === 'good' ? null : h('div', { class: 'ways', 'data-ways': s.id }))))
            : h('p', {}, 'No goals have been set, so there is no verdict to give.')),
        sheet,
        d.dates.length ? h('section', { id: 'doc-dates' }, h('h2', {}, 'Dates that matter'),
          h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Year'), h('th', {}, d.meta.people.length > 1 ? 'Ages' : 'Age'), h('th', {}, 'What happens'))),
            h('tbody', {}, d.dates.map(x => h('tr', {}, h('td', {}, String(x.year)), h('td', {}, x.ages.join(' and ')), h('td', {}, x.label)))))) : null,
        h('p', { class: 'doc-note' }, 'Horizon is a planning model, not financial advice. The figures are estimates on average returns; real years will differ. Check anything important on gov.uk or with a regulated adviser before acting on it.'));
      fillWays();
      return;
    }
    setKids($('#docBody'),
      h('section', { class: 'doc-cover' },
        h('h1', {}, d.meta.title),
        h('p', { class: 'doc-sub' }, `${who}. Figures as at ${fmtDate(d.meta.asOf)}; written out on ${fmtDate(today())}${d.meta.scenario ? `; scenario “${d.meta.scenario}”` : ''}.`),
        h('p', {}, `This is the plan in full, from ${d.meta.startYear} to ${d.meta.endYear}: what should come in and go out each year, what to do with what is left, what each account should hold, and what changes along the way. It says the same as the Horizon pages, written out so it can be read, checked and kept.`),
        d.meta.successRate !== null ? h('p', {}, `Across the futures tried (different markets, inflation and pay), the money lasts to the end of the plan in ${Math.round(d.meta.successRate * 100)} of 100.`) : null,
        h('h3', {}, 'What is in here'),
        h('ol', { class: 'doc-toc' },
          h('li', {}, h('a', { href: '#doc-short' }, 'In short')),
          h('li', {}, h('a', { href: '#doc-do' }, 'What to do: now and next year')),
          h('li', {}, h('a', { href: '#doc-pictures' }, 'The plan in pictures')),
          h('li', {}, h('a', { href: '#doc-read' }, 'How to read a year')),
          h('li', {}, h('a', { href: '#doc-assume' }, 'What the plan assumes')),
          h('li', {}, h('a', { href: '#doc-dates' }, 'Dates that matter')),
          d.everyYear.length ? h('li', {}, h('a', { href: '#doc-every' }, 'Every year')) : null,
          h('li', {}, h('a', { href: `#doc-${d.years[0].year}` }, `Year by year, ${d.years[0].year} to ${d.years[d.years.length - 1].year}`)),
          d.range.length ? h('li', {}, h('a', { href: '#doc-range' }, 'How far off it could be')) : null,
          h('li', {}, h('a', { href: '#doc-words' }, 'What the words mean'))),
        h('div', { class: 'doc-years-nav' }, 'Jump to: ', decades.map(y => h('a', { href: `#doc-${y}` }, String(y)))),
        h('p', { class: 'doc-note' }, 'Horizon is a planning model, not financial advice. The figures are estimates on average returns under the assumptions listed; real years will differ. Tax rules are those of the current tax year and will change. Check anything important on gov.uk or with a regulated adviser before acting on it.')),
      h('section', { class: 'doc-section', id: 'doc-short' }, h('h2', {}, 'In short'),
        d.short.length ? h('ul', { class: 'doc-short' }, d.short.map(s => h('li', { class: s.status }, h('strong', {}, s.title), h('br', {}), s.text, s.status === 'good' ? null : h('div', { class: 'ways', 'data-ways': s.id }))))
          : h('p', {}, 'No goals have been set, so there is no verdict to give. The year-by-year figures below still show where the plan leads.')),
      sheet,
      pictures,
      h('section', { class: 'doc-section', id: 'doc-read' }, h('h2', {}, 'How to read a year'),
        h('p', {}, 'Every year has the same parts, in the order the money moves:'),
        h('ol', {},
          h('li', {}, h('strong', {}, 'The year at a glance. '), 'One bar showing where the year’s money goes, and a small chart marking the year on the whole plan.'),
          h('li', {}, h('strong', {}, 'Money coming in. '), 'Pay, pensions and other income, each on its own line, with how much it went up.'),
          h('li', {}, h('strong', {}, 'What comes off first. '), 'Tax, National Insurance and your own pension contributions. What remains is what reaches your bank.'),
          h('li', {}, h('strong', {}, 'Money going out. '), 'Spending, one-off costs, and mortgage and loan payments.'),
          h('li', {}, h('strong', {}, 'What is left, and where to put it. '), 'How much a month goes to each account. In years when income does not cover spending, this part says what to take from where instead.'),
          h('li', {}, h('strong', {}, 'Pensions, and mortgage and loans. '), 'What goes in, what is owed, and when each debt ends.'),
          h('li', {}, h('strong', {}, 'Where you should be at the end of the year. '), 'Each kind of account and net worth. At the yearly review, compare your real balances with this.')),
        h('p', {}, '“New this year” lists what is different from the year before, and “To do this year” lists anything that needs you to act. All amounts are in the pounds of that year, so they rise with prices; today’s money is given where it helps to compare.'),
        planYearSpan(d.meta.asOf) ? h('p', { class: 'doc-yearnote' }, h('strong', {}, `Each year here starts on ${fmtDate(d.meta.asOf).replace(/ \d{4}$/, '')}. `), `Your figures are as at ${fmtDate(d.meta.asOf)}, so “${d.meta.startYear}” means ${fmtDate(planYearSpan(d.meta.asOf).from)} to ${fmtDate(planYearSpan(d.meta.asOf).to)}, and every later year runs the same way. “The end of the year” is the day before the next one starts: the day to compare your real balances with the plan.`) : null),
      h('section', { id: 'doc-assume' }, h('h2', {}, 'What the plan assumes'),
        h('p', { class: 'doc-sub' }, 'Everything that follows rests on these. Change one in Horizon and the whole document changes with it.'),
        h('table', { class: 'doc-kv' }, h('tbody', {}, d.assumptions.map(a => h('tr', {}, h('td', {}, h('strong', {}, a.label)), h('td', {}, a.value), h('td', { class: 'note' }, a.why)))))),
      h('section', { id: 'doc-dates' }, h('h2', {}, 'Dates that matter'),
        d.dates.length ? h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Year'), h('th', {}, d.meta.people.length > 1 ? 'Ages' : 'Age'), h('th', {}, 'What happens'))),
          h('tbody', {}, d.dates.map(x => h('tr', {}, h('td', {}, h('a', { href: `#doc-${x.year}` }, String(x.year))), h('td', {}, x.ages.join(' and ')), h('td', {}, x.label)))))
          : h('p', {}, 'No dated events in the plan yet.')),
      d.everyYear.length ? h('section', { id: 'doc-every' }, h('h2', {}, 'Every year'),
        h('ul', {}, d.everyYear.map(s => h('li', {}, h('strong', {}, s.title), s.text ? ` ${s.text}` : '')))) : null,
      d.years.map(yearSection),
      d.range.length ? h('section', { class: 'doc-section', id: 'doc-range' }, h('h2', {}, 'How far off it could be'),
        h('p', {}, 'The year-by-year figures use average returns. Real markets do not: this is net worth at a few points across the futures tried. A bad run is the outcome only 1 future in 10 falls below; a good run, the one only 1 in 10 beats.'),
        h('div', { class: 'doc-scroll' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'Year'), h('th', {}, d.meta.people.length > 1 ? 'Ages' : 'Age'), h('th', { class: 'num' }, 'A bad run'), h('th', { class: 'num' }, 'The middle'), h('th', { class: 'num' }, 'A good run'), h('th', { class: 'num' }, 'On average returns'))),
          h('tbody', {}, d.range.map(x => h('tr', {}, h('td', {}, String(x.year)), h('td', {}, x.ages.join(' and ')), h('td', { class: 'num' }, g(x.low)), h('td', { class: 'num' }, g(x.mid)), h('td', { class: 'num' }, g(x.high)), h('td', { class: 'num' }, g(x.expected))))))),
        h('p', { class: 'doc-sub' }, 'In the pounds of each year. “On average returns” is higher than “the middle” because a few very good futures pull the average up; the middle is the better guide to what to expect.')) : null,
      h('section', { class: 'doc-section', id: 'doc-words' }, h('h2', {}, 'What the words mean'),
        h('dl', {}, d.glossary.map(x => h('div', {}, h('dt', {}, x.term), h('dd', {}, x.text))))));
    fillWays();
  }

  function startBlankPlan() {
    const id = E.uid();
    const blank = E.normalizePlan({ startYear: E.currentYear(), asOf: today(), household: { region: plan().household.region || 'scotland', people: [{ name: 'You', age: 35, retireAge: 65 }] }, accounts: [], income: [], expenses: [], events: [], goals: [], strategy: { autoBuffer: true, cashReserve: 0 } });
    ws = E.normalizeWorkspace({ scenarios: [{ id, name: 'My plan', plan: blank }], activeId: id, checkins: [], settings: ws.settings, guides: { setup: ws.guides.setup || { date: today(), answers: {} } } });
    afterImport();
  }

  function setupPanel() {
    let el = $('#setupPanel');
    if (!el) {
      el = h('aside', { id: 'setupPanel', class: 'setup-panel', 'aria-label': 'Get started', hidden: true });
      document.body.append(el);
    }
    return el;
  }

  function openSetup(step) {
    const saved = ws.guides.setup && ws.guides.setup.answers ? Number(ws.guides.setup.answers.step) : 0;
    setupStep = Math.max(0, Math.min(SETUP_STEPS.length - 1, step ?? (Number.isFinite(saved) ? saved : 0)));
    document.body.classList.add('setup-open');
    goSetupStep(setupStep);
  }

  function closeSetup() {
    setupStep = null;
    // Closed on purpose: it doesn't come back on the next visit.
    if (ws.guides.setup && ws.guides.setup.answers) { const { open, ...rest } = ws.guides.setup.answers; ws.guides.setup = { ...ws.guides.setup, answers: rest }; save(); }
    document.body.classList.remove('setup-open');
    for (const el of $$('.setup-focus')) el.classList.remove('setup-focus');
    applySetupFocus();
    setupPanel().hidden = true;
    renderNotifications();
  }

  // While a step of the guide is open, the page shows only the part that step is about: everything
  // beside it (charts, other sections, the page's own menus) is put away until the step changes.
  let setupWhole = false;   // "show the whole page" was asked for
  function applySetupFocus() {
    for (const el of $$('.setup-away')) el.classList.remove('setup-away');
    for (const el of $$('.setup-path')) el.classList.remove('setup-path');
    document.body.classList.remove('setup-only');
    if (setupStep === null || setupWhole) return;
    const st = SETUP_STEPS[setupStep], t = st.target && $(st.target), main = $('main');
    if (!t || !main || !main.contains(t)) return;
    // Only on the step's own page (a button in the guide can lead to another), and never while
    // something outside that part is open to be filled in.
    if (route.tab + (route.sub && route.tab === 'finances' ? `/${route.sub}` : '') !== st.route) return;
    if ($$('[data-editing]', main).some(el => !t.contains(el))) return;
    document.body.classList.add('setup-only');
    for (let el = t; el && el !== main; el = el.parentElement) {
      if (el !== t) el.classList.add('setup-path');
      // The page's own menu stays, so it is always possible to walk away from the step.
      for (const sib of el.parentElement.children) if (sib !== el && sib.id !== 'moneyNav' && !sib.querySelector('#moneyNav')) sib.classList.add('setup-away');
    }
  }

  function goSetupStep(i) {
    setupStep = i;
    const st = SETUP_STEPS[i];
    const was = (ws.guides.setup && ws.guides.setup.answers) || {};
    ws.guides.setup = { date: today(), answers: { ...was, step: String(i), open: 'yes', ...(i === SETUP_STEPS.length - 1 || was.done ? { done: 'yes' } : {}) } };
    save();
    if (st.route && route.tab + (route.sub && route.tab === 'finances' ? `/${route.sub}` : '') !== st.route) navigate(st.route);
    renderSetup();
    setTimeout(() => {
      for (const el of $$('.setup-focus')) el.classList.remove('setup-focus');
      const t = st.target && $(st.target);
      if (t) t.classList.add('setup-focus');
      applySetupFocus();
      if (t) t.scrollIntoView({ block: 'start', behavior: setupWhole ? 'smooth' : 'auto' });
      if (t && !setupWhole) window.scrollTo(0, 0);
    }, 80);
  }

  function renderSetup() {
    if (setupStep === null) return;
    const el = setupPanel();
    const st = SETUP_STEPS[setupStep];
    const n = SETUP_STEPS.length;
    setTimeout(applySetupFocus, 120);
    el.hidden = false;
    setKids(el,
      h('div', { class: 'st-head' },
        h('div', {}, h('span', { class: 'eyebrow' }, `Get started · step ${setupStep + 1} of ${n}`), h('h2', { id: 'setupTitle' }, st.title)),
        h('button', { type: 'button', class: 'btn ghost icon-btn small', 'aria-label': 'Close the guide (carry on later)', title: 'Close (carry on later from Data → Set up my plan)', onclick: closeSetup }, '✕')),
      h('div', { class: 'st-bar' }, h('i', { style: `width:${((setupStep + 1) / n) * 100}%` })),
      h('div', { class: 'st-body', id: 'setupBody' }, st.render(),
        st.target ? h('p', { class: 'st-whole' }, setupWhole ? 'The whole page is showing. ' : 'The page beside this guide shows only the part this step is about. ',
          h('button', { type: 'button', class: 'linkish', id: 'setupWhole', onclick: () => { setupWhole = !setupWhole; applySetupFocus(); renderSetup(); } }, setupWhole ? 'Show only this part' : 'Show the whole page')) : null),
      h('div', { class: 'st-foot' },
        h('button', { type: 'button', class: 'btn small', id: 'setupBack', disabled: setupStep === 0, onclick: () => goSetupStep(setupStep - 1) }, 'Back'),
        h('select', { class: 'st-jump', 'aria-label': 'Go to a step', onchange: e => goSetupStep(Number(e.target.value)) },
          SETUP_STEPS.map((s, k) => h('option', { value: String(k), selected: k === setupStep }, `${k + 1}. ${s.title}`))),
        setupStep < n - 1
          ? h('button', { type: 'button', class: 'btn small primary', id: 'setupNext', onclick: () => goSetupStep(setupStep + 1) }, 'Next step')
          : h('button', { type: 'button', class: 'btn small primary', id: 'setupNext', onclick: () => { closeSetup(); toast('Your plan is set up. Home shows where you are heading and what to do.'); } }, 'Finish')));
  }

  // Keep the panel's "so far" lists in step with edits on the page.
  function refreshSetup() {
    if (setupStep === null) return;
    const body = $('#setupBody');
    if (!body || body.contains(document.activeElement)) return;
    const scroll = body.scrollTop;
    renderSetup();
    const nb = $('#setupBody');
    if (nb) nb.scrollTop = scroll;
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
      const base = s.name.replace(/ \(copy( \d+)?\)$/, '');
      let copyName = `${base} (copy)`;
      for (let k = 2; ws.scenarios.some(x => x.name === copyName); k++) copyName = `${base} (copy ${k})`;
      ws.scenarios.push({ id, name: copyName, plan: E.clonePlan(s.plan) });
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
    $('#setupBtn').addEventListener('click', () => { $('#dataMenu').open = false; openSetup(); });
    $('#quickBtn').addEventListener('click', () => { $('#dataMenu').open = false; openQuickStart(); });
    $('#dossierBtn').addEventListener('click', () => { $('#dataMenu').open = false; openDossier(); });
    $('#docClose').addEventListener('click', closeDossier);
    $('#docPrint').addEventListener('click', () => window.print());
    $('#docYears').addEventListener('change', e => { docYears = parseInt(e.target.value, 10) || 0; renderDossier(); window.scrollTo(0, 0); });
    // The dossier's charts are drawn for one width: draw them again when the window changes much.
    let docResize = 0;
    window.addEventListener('resize', () => {
      if ($('#dossier').hidden) return;
      clearTimeout(docResize);
      docResize = setTimeout(() => {
        const b = $('#docBody'), c = getComputedStyle(b);
        const w = Math.max(240, Math.min(768, Math.round(b.clientWidth - parseFloat(c.paddingLeft) - parseFloat(c.paddingRight))));
        if (!$('#dossier').hidden && Math.abs(w - docWidth) > 24) { const y = window.scrollY; renderDossier(); window.scrollTo(0, y); }
      }, 200);
    });
    $('#exampleStart').addEventListener('click', openQuickStart);
    $('#qsClose').addEventListener('click', closeQuickStart);
    $('#qsBack').addEventListener('click', () => { qs.err = ''; qs.step -= 1; renderQuick(); });
    $('#qsNext').addEventListener('click', quickNext);
    $('#quickDlg').addEventListener('close', () => { qs = null; });
    // Enter moves on (a form's default would close the dialog).
    $('#qsForm').addEventListener('submit', e => { e.preventDefault(); if (qs && !$('#qsFoot').hidden) quickNext(); });
    // Scrolling the page with the pointer over a number box must not change the number in it.
    document.addEventListener('wheel', () => { const a = document.activeElement; if (a && a.tagName === 'INPUT' && a.type === 'number') a.blur(); }, { passive: true });
    // A box holding 0: typing replaces it (otherwise 1400 reads "01400").
    document.addEventListener('focusin', e => { const a = e.target; if (a && a.tagName === 'INPUT' && a.value === '0' && typeof a.select === 'function') { try { a.select(); } catch { /* not selectable */ } } });
    $('#blankBtn').addEventListener('click', () => {
      $('#dataMenu').open = false;
      if (!confirm('Start a blank plan? This replaces everything in Horizon. Save to a file first if you want to keep your data.')) return;
      const id = E.uid();
      const blank = E.normalizePlan({ startYear: E.currentYear(), asOf: today(), household: { region: plan().household.region || 'scotland', people: [{ name: 'You', age: 35, retireAge: 65 }] }, accounts: [], income: [], expenses: [], events: [], goals: [], strategy: { autoBuffer: true, cashReserve: 0 } });
      ws = E.normalizeWorkspace({ scenarios: [{ id, name: 'My plan', plan: blank }], activeId: id, checkins: [], settings: ws.settings });
      afterImport();
      navigate('finances/assumptions');
      toast(`A blank plan, with figures as at today. It starts with one person aged 35 who stops work at 65, on ${plan().household.region === 'scotland' ? 'Scottish' : 'English, Welsh and Northern Irish'} tax rules: change those first, here. Then add accounts, income and spending; then goals on Home.`);
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
    $('#gdNext').addEventListener('click', guideNext);
    $('#ovAddGoal').addEventListener('click', () => openGoalWizard());
    $('#gdBack').addEventListener('click', () => { if (guide && guide.step > 0) { guide.step--; renderGuide(); } });
    $('#gdClose').addEventListener('click', () => $('#guideDlg').close());
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
  if (infoObserver) infoObserver.observe(document.body, { childList: true, subtree: true });
  decorate(document.body);
  // The first time Horizon opens in this browser: offer the guide to set up your own plan.
  // First visit, or the guide was open when the page was left (a reload carries on where it was).
  const guideWasOpen = ws.guides.setup && ws.guides.setup.answers && ws.guides.setup.answers.open === 'yes';
  // A first visit starts with the few plain questions; the full guide reopens where it was left.
  if (!/[?&]nosetup\b/.test(location.search)) { if (firstVisit) openQuickStart(); else if (guideWasOpen) openSetup(); }

  // Exposed for automated tests only.
  window.__horizon = { get ws() { return ws; }, get model() { return model; }, get route() { return route; }, refresh, showTab, navigate, openReview, openUpdate, openSetup, openDossier, closeDossier };
})();
