'use strict';

// The yearly review: roll the plan to a new year, prefill what the plan expected,
// let the user enter what actually happened, compare with last year's prediction,
// then carry the new numbers into every scenario and record a check-in.
// Pure functions (no DOM), so they can be tested in Node.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine') : root.Engine;

  const TYPES = ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt'];
  const TYPE_LABELS = {
    cash: 'Cash', isa: 'ISAs', gia: 'General investment', pension: 'Pensions',
    bonds: 'Bonds & gilts', property: 'Property', debt: 'Mortgage & loans',
  };
  const MARKET_FIELDS = ['inflation', 'cashRate', 'bondReturn'];

  // A review is for the calendar year it happens in (the October review updates this
  // year's numbers and sets up the months ahead); never earlier than the plan's year.
  function suggestedYear(plan, today = new Date()) {
    return Math.max(plan.startYear, today.getFullYear());
  }

  const grow = (rate, years) => Math.pow(1 + rate / 100, years);

  // Move a plan forward `years`, growing every "today's money" amount the way the plan
  // expects (salaries by their growth, spending with inflation, and so on).
  // Balances are left as they were; see expectedBalances().
  function rollPlan(plan, years) {
    const p = E.rollForward(plan, years);
    if (years <= 0) return p;
    const a = p.assumptions;
    const infl = grow(a.inflation, years);
    const itemGrowth = it => (it.inflationLinked ? infl : grow(it.growth, years));
    const before = plan.household.people;
    for (const it of p.income) {
      const g = itemGrowth(it);
      if (it.kind === 'dbpension') {
        const person = before[E.personIndex(plan, it.owner)];
        const worked = Math.max(0, Math.min(years, person.retireAge - person.age));
        it.amount = (it.amount + it.dbAccrual * worked) * infl;
        it.dbAccrual *= infl;
      } else {
        it.amount *= g;
        if (it.pensionMode === 'fixed') { it.employeePension *= g; it.employerPension *= g; }
      }
      it.fixedCosts *= infl;
    }
    for (const e of p.expenses) e.amount *= itemGrowth(e);
    for (const ev of p.events) ev.amount *= infl;
    for (const person of p.household.people) {
      person.statePension *= infl * grow(a.statePensionRealGrowth, years);
      person.extraPension *= infl;
    }
    p.strategy.cashReserve *= infl;
    p.strategy.retireSpending *= infl;
    for (const g of p.goals) if (g.basis === 'real' && g.type !== 'debtFree' && g.type !== 'retire') g.amount *= infl;
    return round(p);
  }

  // Keep pounds tidy after growing (whole pounds for big amounts, pence for small).
  function round(p) {
    const r = v => (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100);
    for (const it of p.income) { it.amount = r(it.amount); it.dbAccrual = r(it.dbAccrual); it.fixedCosts = r(it.fixedCosts); it.employeePension = r(it.employeePension); it.employerPension = r(it.employerPension); }
    for (const e of p.expenses) e.amount = r(e.amount);
    for (const ev of p.events) ev.amount = r(ev.amount);
    for (const person of p.household.people) { person.statePension = r(person.statePension); person.extraPension = r(person.extraPension); }
    p.strategy.cashReserve = r(p.strategy.cashReserve);
    p.strategy.retireSpending = r(p.strategy.retireSpending);
    return p;
  }

  // What the plan expects each account to hold `years` from now on average returns.
  // Each account takes its share of its type's projected total.
  function expectedBalances(plan, years) {
    const proj = E.project(plan);
    const t = Math.min(years, proj.pre.N);
    const row = proj.rows[t];
    const out = {};
    // Lifetime ISAs are part of the ISA total in a projection.
    const typeOf = a => (a.type === 'lisa' ? 'isa' : a.type);
    for (const type of TYPES) {
      const counted = plan.accounts.filter(a => typeOf(a) === type && !a.excluded);
      const total = counted.reduce((s, a) => s + a.balance, 0);
      for (const a of counted) {
        const share = total > 0 ? a.balance / total : 1 / counted.length;
        out[a.id] = Math.max(0, row[type] * share);
      }
    }
    for (const a of plan.accounts.filter(x => x.excluded)) {
      out[a.id] = a.type === 'property' ? a.balance * grow(a.rate, years) : a.balance;
    }
    // Money the plan expects in a type with no account yet (e.g. a first general investment account).
    const missing = TYPES.filter(type => row[type] > 0.5 && !plan.accounts.some(a => typeOf(a) === type && !a.excluded));
    return { byId: out, missing: missing.map(type => ({ type, value: row[type] })), row };
  }

  // Values by type, as a check-in records them.
  function byType(plan) {
    const r = E.project(plan).rows[0];
    const out = {};
    for (const k of TYPES) out[k] = r[k];
    out.netWorth = r.netWorth;
    return out;
  }

  // The check-in this review is measured against: the latest earlier one that predicted this year.
  function previousCheckin(checkins, year) {
    return checkins.slice().sort((a, b) => a.date.localeCompare(b.date)).reverse()
      .find(c => c.year < year && c.predicted.years.includes(year)) || null;
  }

  // What the previous check-in predicted for `year`, by type when it recorded that.
  function predictedFor(checkin, year) {
    if (!checkin) return null;
    const k = checkin.predicted.years.indexOf(year);
    if (k < 0) return null;
    const out = { netWorth: checkin.predicted.netWorth[k], byType: null, from: checkin.year, date: checkin.date };
    const bt = checkin.predicted.byType;
    if (bt && TYPES.every(t => Array.isArray(bt[t]) && bt[t].length > k)) {
      out.byType = {};
      for (const t of TYPES) out.byType[t] = bt[t][k];
    }
    return out;
  }

  // Start a review of the active scenario for `year`.
  function start(ws, opts = {}) {
    const scen = ws.scenarios.find(s => s.id === ws.activeId) || ws.scenarios[0];
    const original = E.clonePlan(scen.plan);
    const year = Math.max(original.startYear, opts.year || suggestedYear(original, opts.today));
    const years = year - original.startYear;
    const plan = rollPlan(original, years);
    const exp = expectedBalances(original, years);
    for (const a of plan.accounts) if (exp.byId[a.id] !== undefined) a.balance = Math.round(exp.byId[a.id]);
    for (const m of exp.missing) {
      plan.accounts.push(E.normalizePlan({ ...plan, accounts: [{ name: TYPE_LABELS[m.type], type: m.type, owner: 'p1', balance: Math.round(m.value), basis: Math.round(m.value) }] }).accounts[0]);
    }
    const snap = list => Object.fromEntries(list.map(x => [x.id, x.type ? x.balance : x.amount]));
    const prev = previousCheckin(ws.checkins || [], year);
    return {
      year, years, scenarioId: scen.id, scenarioName: scen.name,
      original, plan,
      expectedPlan: E.clonePlan(plan),
      last: { accounts: snap(original.accounts), income: snap(original.income), expenses: snap(original.expenses) },
      expected: { accounts: snap(plan.accounts), income: snap(plan.income), expenses: snap(plan.expenses) },
      touched: { accounts: {}, income: {}, expenses: {} },
      prev,
      predicted: predictedFor(prev, year),
      actualSpending: 0,
      market: Object.fromEntries(MARKET_FIELDS.map(f => [f, { current: original.assumptions[f], next: original.assumptions[f] }])),
    };
  }

  function setValue(draft, kind, id, value) {
    const list = kind === 'accounts' ? draft.plan.accounts : kind === 'income' ? draft.plan.income : draft.plan.expenses;
    const item = list.find(x => x.id === id);
    if (!item) return;
    if (kind === 'accounts') item.balance = Math.max(0, value); else item.amount = Math.max(0, value);
    draft.touched[kind][id] = true;
  }

  function progress(draft, kind) {
    const list = kind === 'accounts' ? draft.plan.accounts : kind === 'income' ? draft.plan.income : draft.plan.expenses;
    return { done: list.filter(x => draft.touched[kind][x.id]).length, total: list.length };
  }

  // How this year compares with the prediction (or, without one by type, with last year).
  function variance(draft) {
    const actual = byType(draft.plan);
    const pred = draft.predicted;
    const mode = pred && pred.byType ? 'prediction' : draft.prev ? 'lastYear' : 'plan';
    let base;
    if (mode === 'prediction') base = { ...pred.byType, netWorth: pred.netWorth };
    else if (mode === 'lastYear') base = { ...draft.prev.actual };
    else base = byType(draft.expectedPlan);
    const rows = TYPES.map(t => {
      const sign = t === 'debt' ? -1 : 1;
      return { type: t, label: TYPE_LABELS[t], base: base[t] || 0, actual: actual[t], diff: sign * (actual[t] - (base[t] || 0)) };
    }).filter(r => Math.abs(r.base) > 0.5 || Math.abs(r.actual) > 0.5);
    const total = { base: pred ? pred.netWorth : base.netWorth, actual: actual.netWorth };
    total.diff = total.actual - total.base;
    total.pct = total.base ? total.diff / Math.abs(total.base) : null;
    return { mode, rows, total, actual };
  }

  // Find the item in another scenario that matches one in the reviewed plan.
  function match(list, item, typed) {
    return list.find(x => x.id === item.id) ||
      list.find(x => x.name === item.name && (!typed || x.type === item.type)) || null;
  }

  // Apply the review: every selected scenario moves to the review year and gets the new
  // balances, incomes and spending; market assumptions change where a scenario shared
  // the reviewed scenario's old value. Records a check-in. Returns a new workspace.
  function apply(ws, draft, opts = {}) {
    const out = JSON.parse(JSON.stringify(ws));
    const selected = new Set(opts.scenarioIds || out.scenarios.map(s => s.id));
    const market = opts.market || {};
    for (const s of out.scenarios) {
      if (!selected.has(s.id)) continue;
      let p;
      if (s.id === draft.scenarioId) {
        p = E.clonePlan(draft.plan);
      } else {
        p = rollPlan(s.plan, draft.year - s.plan.startYear);
        for (const a of draft.plan.accounts) {
          const m = match(p.accounts, a, true);
          if (m) {
            m.balance = a.balance;
            if (a.type === 'debt') { m.rate = a.rate; m.payment = a.payment; m.fixedUntil = a.fixedUntil; }
            if (a.type === 'gia') m.basis = a.basis;
          } else if (!draft.original.accounts.some(x => x.id === a.id)) {
            p.accounts.push(E.clonePlan(a));
          }
        }
        for (const it of draft.plan.income) { const m = match(p.income, it); if (m) m.amount = it.amount; }
        for (const e of draft.plan.expenses) { const m = match(p.expenses, e); if (m) m.amount = e.amount; }
      }
      for (const f of MARKET_FIELDS) {
        if (!market[f]) continue;
        const was = draft.market[f].current;
        if (s.id === draft.scenarioId || s.plan.assumptions[f] === was) p.assumptions[f] = draft.market[f].next;
      }
      s.plan = E.normalizePlan(p);
    }
    const active = out.scenarios.find(s => s.id === draft.scenarioId);
    const c = E.makeCheckin(active.plan, active.name, opts.date);
    if (draft.actualSpending > 0) c.actual.spending = draft.actualSpending;
    c.goals = (opts.goals || []).map(g => ({ title: g.title, probability: g.probability, expectedYear: g.expectedYear ?? null }));
    if (opts.note) c.note = opts.note;
    out.checkins = (out.checkins || []).filter(x => x.year !== draft.year).concat([E.normalizeCheckin(c)])
      .sort((a, b) => a.date.localeCompare(b.date));
    out.activeId = draft.scenarioId;
    out.lastReview = c.date;
    return out;
  }

  // Is a review due? From October until this year's review is done, or whenever the
  // plan has fallen more than a year behind the calendar.
  function due(ws, today = new Date()) {
    const scen = ws.scenarios.find(s => s.id === ws.activeId) || ws.scenarios[0];
    const y = today.getFullYear();
    const year = suggestedYear(scen.plan, today);
    if (scen.plan.startYear < y - 1) return { due: true, year, reason: 'behind' };
    const reviewed = (ws.checkins || []).some(c => c.date >= `${y}-09-01`);
    if (today.getMonth() >= 9 && !reviewed) return { due: true, year, reason: 'october' };
    return { due: false, next: reviewed || today.getMonth() >= 9 ? y + 1 : y };
  }

  const api = { TYPES, TYPE_LABELS, MARKET_FIELDS, suggestedYear, rollPlan, expectedBalances, byType, previousCheckin, predictedFor, start, setValue, progress, variance, apply, due };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Review = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
