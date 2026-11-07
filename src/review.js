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
    // Student loans: what the plan expects to be left after the repayments and interest.
    const loans = plan.household.people.some(x => x.loanPlan) ? E.precompute(plan).people : null;
    p.household.people.forEach((person, i) => {
      person.statePension *= infl * grow(a.statePensionRealGrowth, years);
      person.extraPension *= infl;
      if (loans && person.loanPlan) {
        const bal = loans[i].loanBal, k = Math.min(bal.length - 2, Math.floor(years)), x = years - k;
        person.loanBalance = Math.max(0, bal[k] + (bal[k + 1] - bal[k]) * x);
      }
    });
    p.strategy.cashReserve *= infl;
    p.strategy.retireSpending *= infl;
    // A new year: budgets start again (the review says what is kept); fixed emergency funds rise with prices.
    for (const r of p.reserves || []) {
      if (r.kind === 'budget') r.left = 0;
      if (r.kind === 'emergency' && r.amount !== null) r.amount *= infl;
    }
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

  // ISAs and Lifetime ISAs: the projection's totals split by following each account: it grows at
  // the ISA return, receives its own amount a month (or an even share when automatic), and gives
  // up its share of withdrawals. Lifetime ISAs share the Lifetime ISA total by balance.
  function isaShares(plan, proj, f, row, out) {
    const at = (key, t) => proj.rows[t][key] || 0;
    const lisas = plan.accounts.filter(a => a.type === 'lisa' && !a.excluded);
    const isas = plan.accounts.filter(a => a.type === 'isa' && !a.excluded);
    const k = Math.min(proj.pre.N - 1, Math.floor(f)), x = f - k;
    const lisaTotal = at('lisa', k) + (at('lisa', k + 1) - at('lisa', k)) * x;
    const lb = lisas.reduce((s, a) => s + a.balance, 0);
    for (const a of lisas) out[a.id] = Math.max(0, lisaTotal * (lb > 0 ? a.balance / lb : 1 / lisas.length));
    if (!isas.length) return;
    const set = isas.some(a => a.monthly !== null);
    const weight = isas.map(a => (set ? (a.monthly || 0) : 1));
    const wSum = weight.reduce((s, v) => s + v, 0);
    let bal = isas.map(a => a.balance);
    const path = [bal.slice()];
    for (let t = 0; t <= k && t < proj.rows.length - 1; t++) {
      const r = proj.rows[t];
      const base = Math.max(1, r.isa - (r.lisa || 0));
      const rate = (r.gIsa - (r.lisa || 0) * (r.gIsa / Math.max(1, r.isa))) / base;
      const paidIn = r.toIsa + r.sweepIsa + r.bondsToIsa;
      const total = bal.reduce((s, v) => s + v, 0);
      bal = bal.map((v, i) => Math.max(0, v * (1 + rate) + paidIn * (wSum > 0 ? weight[i] / wSum : 1 / isas.length) - r.wIsa * (total > 0 ? v / total : 1 / isas.length)));
      path.push(bal.slice());
    }
    const lo = path[Math.min(k, path.length - 1)], hi = path[Math.min(k + 1, path.length - 1)];
    const mix = lo.map((v, i) => v + (hi[i] - v) * x);
    const mixSum = mix.reduce((s, v) => s + v, 0);
    const isaTotal = Math.max(0, row.isa - lisaTotal);
    isas.forEach((a, i) => { out[a.id] = mixSum > 0 ? isaTotal * (mix[i] / mixSum) : isaTotal / isas.length; });
  }

  // Lifetime ISAs are part of the ISA total in a projection; other assets are with property.
  const typeOf = a => (a.type === 'lisa' ? 'isa' : a.type === 'asset' ? 'property' : a.type);
  // A home to be bought later is not owned `f` years after the figures date.
  const notYet = (plan, a, f) => a.type === 'property' && a.buyYear >= plan.startYear && f < a.buyYear - plan.startYear;

  // What the plan expects each account to hold `years` (may be a fraction) after its figures
  // date, on average returns. Each account takes its share of its type's projected total;
  // between two years the values are interpolated.
  function expectedBalances(plan, years, proj = E.project(plan)) {
    const N = proj.pre.N;
    const f = Math.min(Math.max(0, years), N);
    const k = Math.min(N - 1, Math.floor(f)), x = f - k;
    const row = {};
    for (const type of TYPES) row[type] = proj.rows[k][type] + (proj.rows[k + 1][type] - proj.rows[k][type]) * x;
    const out = {};
    isaShares(plan, proj, f, row, out);
    for (const type of TYPES) {
      if (type === 'isa') continue;
      const counted = plan.accounts.filter(a => typeOf(a) === type && !a.excluded && !notYet(plan, a, f));
      const total = counted.reduce((s, a) => s + a.balance, 0);
      for (const a of counted) {
        const share = total > 0 ? a.balance / total : 1 / counted.length;
        out[a.id] = Math.max(0, row[type] * share);
      }
    }
    // Not counted, or a home not bought yet: its own value, moved on at its growth rate.
    for (const a of plan.accounts.filter(x => x.excluded || notYet(plan, x, f))) {
      out[a.id] = a.type === 'property' || a.type === 'asset' ? a.balance * grow(a.rate, f) : a.balance;
    }
    // Money the plan expects in a type with no account yet (e.g. a first general investment account).
    const missing = TYPES.filter(type => row[type] > 0.5 && !plan.accounts.some(a => typeOf(a) === type && !a.excluded && !notYet(plan, a, f)));
    return { byId: out, missing: missing.map(type => ({ type, value: row[type] })), row };
  }

  // Years from one date to another, counting whole anniversaries (15 Oct to 15 Oct is
  // exactly 1) and the fraction of the year after the last one. 0 if `to` is earlier.
  function yearsBetween(from, to) {
    const a = new Date(`${from}T00:00:00Z`), b = new Date(`${to}T00:00:00Z`);
    if (!(b > a)) return 0;
    const at = y => Date.UTC(a.getUTCFullYear() + y, a.getUTCMonth(), a.getUTCDate());
    let y = b.getUTCFullYear() - a.getUTCFullYear();
    if (at(y) > b) y--;
    return y + (b - at(y)) / (at(y + 1) - at(y));
  }

  // Every account's estimated value on `date`: what the plan expects since its figures date,
  // or, when a balance was read since then, that reading moved on the way the plan expects.
  // `source` says which: 'figures' (the date itself), 'estimate', 'updated' (read that day)
  // or 'updatedEstimate' (read earlier, moved on to `date`).
  function estimateAt(plan, date, proj = E.project(plan)) {
    const asOf = E.asOfDate(plan);
    const f = yearsBetween(asOf, date);
    const exp = expectedBalances(plan, f, proj);
    const byId = {}, source = {}, reading = {};
    for (const a of plan.accounts) {
      let v = exp.byId[a.id] !== undefined ? exp.byId[a.id] : a.balance;
      let src = f < 1 / 365 ? 'figures' : 'estimate';
      const L = a.latest;
      if (L && L.date >= asOf && L.date <= date) {
        const e0 = expectedBalances(plan, yearsBetween(asOf, L.date), proj).byId[a.id];
        const base = e0 !== undefined ? e0 : a.balance;
        v = base > 1 ? L.value * (v / base) : L.value + (v - base);
        src = L.date === date ? 'updated' : 'updatedEstimate';
        reading[a.id] = L;
      }
      byId[a.id] = Math.max(0, v);
      source[a.id] = src;
    }
    const byType = Object.fromEntries(TYPES.map(t => [t, 0]));
    for (const a of plan.accounts) if (!a.excluded && !notYet(plan, a, f)) byType[typeOf(a)] += byId[a.id];
    for (const m of exp.missing) byType[m.type] += m.value;
    // Money set aside to be spent (savings for a cost, budgets): still in its account, not in net worth.
    const locked = E.reservesAt(plan, f).filter(r => r.kind !== 'emergency').reduce((s, r) => s + r.held, 0);
    const netWorth = TYPES.reduce((s, t) => s + (t === 'debt' ? -byType[t] : byType[t]), 0) - locked;
    return { date, asOf, years: f, byId, expected: exp.byId, source, reading, byType, netWorth, locked, missing: exp.missing };
  }

  // Values by type, as a check-in records them.
  function byType(plan) {
    const r = E.project(plan).rows[0];
    const out = {};
    for (const k of TYPES) out[k] = r[k];
    out.netWorth = r.netWorth;
    out.locked = r.locked || 0;
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

  // Start a review of the active scenario for `year`, with balances as at `date` (default
  // today). Every balance starts as the plan's estimate for that date, or a reading taken
  // since, ready to be corrected.
  function start(ws, opts = {}) {
    const scen = ws.scenarios.find(s => s.id === ws.activeId) || ws.scenarios[0];
    const original = E.clonePlan(scen.plan);
    const date = E.isDate(opts.date) ? opts.date : E.todayISO(opts.today);
    const year = Math.max(original.startYear, opts.year || suggestedYear(original, opts.today));
    const years = year - original.startYear;
    const plan = rollPlan(original, years);
    plan.asOf = date;
    for (const a of plan.accounts) a.latest = null;
    const est = estimateAt(original, date);
    for (const m of est.missing) {
      plan.accounts.push(E.normalizePlan({ ...plan, accounts: [{ name: TYPE_LABELS[m.type], type: m.type, owner: 'p1', balance: Math.round(m.value), basis: Math.round(m.value) }] }).accounts[0]);
    }
    const snap = list => Object.fromEntries(list.map(x => [x.id, x.type ? x.balance : x.amount]));
    const prev = previousCheckin(ws.checkins || [], year);
    const draft = {
      year, years, date, scenarioId: scen.id, scenarioName: scen.name,
      original, plan,
      expectedPlan: E.clonePlan(plan),
      last: { accounts: snap(original.accounts), income: snap(original.income), expenses: snap(original.expenses) },
      expected: { accounts: {}, income: snap(plan.income), expenses: snap(plan.expenses) },
      readings: {},
      touched: { accounts: {}, income: {}, expenses: {}, reserves: {} },
      // Money set aside as it went (see setReserve): what is typed in the review for each pot.
      reserveInputs: {},
      // Paid into ISAs and investments since the figures date (null = not asked); see explain().
      paidIn: null,
      prev,
      predicted: predictedFor(prev, year),
      actualSpending: 0,
      market: Object.fromEntries(MARKET_FIELDS.map(f => [f, { current: original.assumptions[f], next: original.assumptions[f] }])),
    };
    applyEstimates(draft, est);
    // Budgets of the year just ended: all spent unless the review says otherwise.
    if (years > 0) for (const r of E.reservesAt(original, 0)) if (r.kind === 'budget') draft.reserveInputs[r.id] = { spent: Math.round(r.amount), keep: true };
    return draft;
  }

  // Fill in the balances not yet entered from an estimate. "Expected" is the plan's own
  // estimate; a balance read during the year (moved on to the review date) is used as the
  // starting value and counts as entered.
  function applyEstimates(draft, est) {
    // Pots set aside, as the plan expects them on the date: the emergency fund and what has been
    // put aside for each cost (the new figures date is the review date).
    for (const r of E.reservesAt(draft.original, est.years)) {
      if (r.kind === 'budget' || draft.touched.reserves[r.id]) continue;
      if (r.kind === 'saving') {
        for (const p of [draft.plan, draft.expectedPlan]) {
          const m = (p.reserves || []).find(x => x.id === r.id);
          if (m) m.saved = r.dueYear ? Math.round(r.held) : null;
        }
      }
      draft.reserveInputs[r.id] = r.kind === 'saving' ? { saved: Math.round(r.held) } : { amount: Math.round(r.amount) };
    }
    for (const a of draft.plan.accounts) {
      const added = !draft.original.accounts.some(x => x.id === a.id);
      const m = added ? est.missing.find(x => x.type === a.type) : null;
      const exp = added ? (m ? m.value : a.balance) : est.expected[a.id];
      if (exp === undefined) continue;
      draft.expected.accounts[a.id] = Math.round(exp);
      const e = draft.expectedPlan.accounts.find(x => x.id === a.id);
      if (e) e.balance = Math.round(exp);
      if (draft.touched.accounts[a.id] && !draft.readings[a.id]) continue;
      const reading = est.reading[a.id];
      a.balance = Math.round(reading ? est.byId[a.id] : exp);
      if (reading) { draft.readings[a.id] = reading; draft.touched.accounts[a.id] = true; } else delete draft.readings[a.id];
    }
  }

  // Change the date the balances are as at: anything not entered by hand is re-estimated.
  function setDate(draft, date) {
    if (!E.isDate(date)) return draft;
    draft.date = date;
    draft.plan.asOf = date;
    draft.expectedPlan.asOf = date;
    applyEstimates(draft, estimateAt(draft.original, date));
    return draft;
  }

  function setValue(draft, kind, id, value) {
    const list = kind === 'accounts' ? draft.plan.accounts : kind === 'income' ? draft.plan.income : draft.plan.expenses;
    const item = list.find(x => x.id === id);
    if (!item) return;
    if (kind === 'accounts') { item.balance = Math.max(0, value); if (draft.readings) delete draft.readings[id]; } else item.amount = Math.max(0, value);
    draft.touched[kind][id] = true;
  }

  function progress(draft, kind) {
    const list = kind === 'accounts' ? draft.plan.accounts : kind === 'income' ? draft.plan.income : draft.plan.expenses;
    return { done: list.filter(x => draft.touched[kind][x.id]).length, total: list.length };
  }

  // What the review says about a pot set aside: the emergency fund now ({amount}), what has been
  // put aside for a cost ({saved}), or how much of last year's budget was spent and whether to keep
  // the rest for this year ({spent, keep}). Applied to the reviewed plan straight away.
  function setReserve(draft, id, values) {
    const r = (draft.plan.reserves || []).find(x => x.id === id);
    if (!r) return;
    const st = draft.reserveInputs[id] = { ...(draft.reserveInputs[id] || {}), ...values };
    draft.touched.reserves[id] = true;
    if (r.kind === 'emergency') r.amount = Math.max(0, st.amount || 0);
    else if (r.kind === 'saving') r.saved = Math.max(0, st.saved || 0);
    else {
      const last = draft.years > 0 ? E.reservesAt(draft.original, 0).find(x => x.id === id) : null;
      r.left = st.keep && last ? Math.max(0, last.amount - (st.spent || 0)) : 0;
    }
  }

  // What the plan expected to be paid into ISAs and other investments (net of anything taken
  // out) from the figures date to `years` later.
  function expectedPaidIn(plan, years, proj = E.project(plan)) {
    const f = Math.min(Math.max(0, years), proj.pre.N);
    let sum = 0;
    for (let k = 0; k < Math.ceil(f); k++) {
      const r = proj.rows[k];
      const v = r.toIsa + r.toGia + (r.toLisa || 0) + r.sweepIsa + r.sweepGia - r.wIsa - r.wGia - (r.wLisa || 0);
      sum += v * Math.min(1, f - k);
    }
    return sum;
  }

  // Why net worth differs from what the plan expected on the review date, in parts that add up
  // to the difference: markets, money put in, home value, the mortgage, pensions, budgets not
  // spent, money kept set aside, and cash with everything else (the rest). Amounts in pounds;
  // `why` texts leave the pounds to `values` so the page can format them.
  function explain(draft) {
    const A = byType(draft.plan), X = byType(draft.expectedPlan);
    const f = yearsBetween(E.asOfDate(draft.original), draft.date);
    const parts = [];
    const add = (key, label, diff, why, values) => parts.push({ key, label, diff, why, values: values || {} });
    const d = t => A[t] - X[t];
    const inv = d('isa') + d('gia') + d('bonds');
    const expIn = expectedPaidIn(draft.original, f);
    if (Number.isFinite(draft.paidIn)) {
      const more = draft.paidIn - expIn;
      add('paidIn', more >= 0 ? 'Put in more' : 'Put in less', more, 'You paid in {paid}; the plan expected about {expected}.', { paid: draft.paidIn, expected: expIn });
      add('markets', 'Markets', inv - more, inv - more >= 0 ? 'ISAs and investments grew more than the plan assumes.' : 'ISAs and investments grew less than the plan assumes.');
    } else {
      add('investments', 'ISAs & investments', inv, 'Markets, and how much you put in: say what you paid in to split the two.');
    }
    add('pension', 'Pensions', d('pension'), 'Mostly markets: pension contributions come from pay.');
    add('property', 'Home value', d('property'), d('property') >= 0 ? 'Worth more than the plan assumed.' : 'Worth less than the plan assumed.');
    add('debt', d('debt') <= 0 ? 'Mortgage: owe less' : 'Mortgage: owe more', -d('debt'), 'Overpayments, a new rate or a different payment.');
    // Budgets of the year just ended: what was not spent is still in the bank.
    const last = draft.years > 0 ? E.reservesAt(draft.original, 0).filter(r => r.kind === 'budget') : [];
    const notSpent = last.map(r => ({ name: r.name, v: r.amount - ((draft.reserveInputs[r.id] || {}).spent ?? r.amount) }))
      .filter(x => Math.abs(x.v) >= 0.5);
    const budgets = notSpent.reduce((s, x) => s + x.v, 0);
    if (notSpent.length) add('budgets', budgets >= 0 ? 'Budgets not all spent' : 'Budgets overspent', budgets,
      budgets >= 0 ? `${notSpent.map(x => x.name).join(' and ')}: still in the bank.` : `More than budgeted on ${notSpent.map(x => x.name).join(' and ')}.`);
    const lockedMore = A.locked - X.locked;
    add('setAside', lockedMore >= 0 ? 'Kept to spend' : 'Less set aside to spend', -lockedMore, lockedMore >= 0 ? 'Set aside for costs ahead, so not counted in net worth.' : 'Less set aside for costs ahead than the plan expected, so more of it counts.');
    const total = A.netWorth - X.netWorth;
    // Cash is what is left: pay and spending different from the plan, and money moved around.
    const rest = total - parts.reduce((s, p) => s + p.diff, 0);
    add('cash', 'Cash & everything else', rest, 'Pay and spending different from the plan, and money moved between accounts.');
    const shown = parts.filter(p => Math.abs(p.diff) >= 50).sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
    const small = parts.filter(p => Math.abs(p.diff) < 50).reduce((s, p) => s + p.diff, 0);
    if (Math.abs(small) >= 0.5) shown.push({ key: 'small', label: 'Small differences', diff: small, why: 'Each under £50.', values: {} });
    return { expected: X.netWorth, actual: A.netWorth, total, parts: shown, expectedPaidIn: expIn };
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
        for (const r of draft.plan.reserves || []) {
          const m = (p.reserves || []).find(x => x.id === r.id) || (p.reserves || []).find(x => x.kind === r.kind && x.name === r.name);
          if (!m) continue;
          if (r.kind === 'budget') m.left = r.left;
          else if (r.kind === 'saving') m.saved = r.saved;
          else if (r.kind === 'emergency') m.amount = r.amount;
        }
        p.asOf = draft.date || p.asOf;
        for (const a of p.accounts) a.latest = null;   // the review's figures replace any readings
      }
      for (const f of MARKET_FIELDS) {
        if (!market[f]) continue;
        const was = draft.market[f].current;
        if (s.id === draft.scenarioId || s.plan.assumptions[f] === was) p.assumptions[f] = draft.market[f].next;
      }
      s.plan = E.normalizePlan(p);
    }
    const active = out.scenarios.find(s => s.id === draft.scenarioId);
    const c = E.makeCheckin(active.plan, active.name, opts.date || draft.date);
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

  // Record balances read during the year (e.g. from a banking app) in every scenario that has
  // the same account. `values` maps account id → balance. Returns a new workspace.
  function recordReadings(ws, values, date) {
    const out = JSON.parse(JSON.stringify(ws));
    const active = out.scenarios.find(s => s.id === out.activeId) || out.scenarios[0];
    for (const [id, value] of Object.entries(values)) {
      const a = active.plan.accounts.find(x => x.id === id);
      if (!a) continue;
      for (const s of out.scenarios) {
        const m = s === active ? a : match(s.plan.accounts, a, true);
        if (m) m.latest = { value: Math.max(0, value), date };
      }
    }
    return out;
  }

  const api = { TYPES, TYPE_LABELS, MARKET_FIELDS, notYet, typeOf, suggestedYear, rollPlan, expectedBalances, estimateAt, yearsBetween, byType, previousCheckin, predictedFor, start, setDate, setValue, setReserve, progress, variance, explain, expectedPaidIn, apply, recordReadings, due };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Review = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
