'use strict';

// Horizon planning engine (UK). Pure functions, no DOM: runs in the browser as
// window.Engine and under Node for tests.
//
// Conventions
// - Amounts the user types are in TODAY'S money. Each grows at its own rate from now;
//   inflation-linked items grow with prices.
// - Year t is calendar year startYear + t. Balances are recorded at the START of each
//   year (N + 1 entries); flows happen during the year.
// - The "economy" for a run is a set of year-by-year paths: prices, salary surprises,
//   house-price surprises, interest-rate shifts and portfolio returns. The projection uses
//   the expected economy; Monte Carlo draws random ones.
// - Within a year: assets grow, maturities and sales land, pension contributions are
//   added, debts are paid, then the surplus is allocated (cash buffer > mortgage
//   overpayment > ISA > general investment account) or the deficit is withdrawn
//   (cash > pension within the personal allowance > GIA > ISA > pension > cash buffer).

(function (root) {
  const R = typeof module !== 'undefined' && module.exports ? require('./uk-rules.js') : root.UKRules;

  // ---------------------------------------------------------------- constants

  const ACCOUNT_TYPES = ['cash', 'isa', 'lisa', 'gia', 'pension', 'bonds', 'property', 'debt'];
  const OWNED_TYPES = ['isa', 'lisa', 'pension'];
  const GOAL_TYPES = ['netWorth', 'debtFree', 'retire', 'passiveIncome', 'emergency'];
  const INCOME_KINDS = ['salary', 'rental', 'other', 'dbpension'];
  const TAX_TREATMENTS = ['uk', 'none', 'flat'];
  const BASIC_RELIEF = 0.2; // relief at source added to personal pension contributions

  const FLOW_KEYS = [
    'earnings', 'otherIncome', 'statePension', 'withdrawals',
    'spending', 'taxes', 'debtPay', 'saved', 'unfunded',
    'wCash', 'wGia', 'wIsa', 'wPension', 'toIsa', 'toGia', 'toCash', 'overpay', 'pensionIn',
    'cgt', 'gCash', 'gIsa', 'gGia', 'gPension', 'gBonds', 'gProperty',
    'debtInterest', 'debtRegular', 'lumpOverpay', 'bondsMatured', 'bondsToIsa', 'propSold', 'extraPension', 'flatTax',
    'sweepIsa', 'sweepGia', 'nonWork',
    'toLisa', 'lisaBonus', 'wLisa', 'lisaHome', 'lisaCharge', 'pensionRelief', 'toPension', 'sacrificed',
  ];

  const GOAL_MEASURES = {
    all: 'Net worth (everything)',
    noPension: 'Net worth excluding pensions',
    liquid: 'Liquid assets (cash, ISA, GIA, bonds, pensions)',
    savings: 'Savings & investments (cash, ISA, GIA, bonds)',
  };

  // ---------------------------------------------------------------- defaults

  let idCounter = 0;
  function uid() {
    idCounter = (idCounter + 1) % 1e6;
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 6) + idCounter.toString(36);
  }

  function currentYear() {
    return new Date().getFullYear();
  }

  // Dates are ISO strings (YYYY-MM-DD), in local time.
  const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
  function todayISO(d = new Date()) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  const isDate = v => typeof v === 'string' && ISO_DATE.test(v) && !Number.isNaN(Date.parse(v));

  // The date a plan's figures describe (balances, pay and spending as they were then).
  // Year 0 of the projection starts on this date. Older plans without one start on 1 January.
  function asOfDate(plan) {
    return isDate(plan.asOf) ? plan.asOf : `${plan.startYear}-01-01`;
  }

  function defaultAssumptions() {
    return {
      inflation: 2.5,
      stockReturn: 7,
      stockVolatility: 16,
      bondReturn: 4.5,
      bondVolatility: 6,
      stockPctNow: 90,
      stockPctRetire: 60,
      cashRate: 3.5,
      thresholdFreezeUntil: R.FREEZE_UNTIL,
      statePensionRealGrowth: 0,
      fees: 0,                    // fund and platform fees, % a year, taken from investment and pension returns
      crashYear: 0,               // optional one-off market fall in this year (0 = none)
      crashPct: -30,              // ... its size for shares, %
      investReturn: null,         // optional fixed average return for ISAs and GIA (%); null = stock/bond mix
      pensionReturn: null,        // optional fixed average return for pensions (%); null = stock/bond mix
      // What else varies in simulations
      varyInflation: true,
      inflationVolatility: 1.5,   // percentage points, year to year
      inflationPersistence: 0.6,  // how much of a surprise carries into next year
      varyHouses: true,
      houseVolatility: 8,
      varySalaries: true,
      salaryVolatility: 2,
      varyRates: true,
      rateSensitivity: 0.8,       // interest rates move this much per point of inflation surprise
    };
  }

  function defaultStrategy() {
    return {
      cashReserve: 15000,
      overpayPct: 0,
      overpayCapPct: 10,
      isaAllowance: R.ISA_ALLOWANCE,
      sweepCash: true,       // invest cash above the buffer each year (e.g. matured gilts)
      spendNowPct: 100,      // scales spending before retirement
      retireSpending: 0,     // £/year in retirement (today's money); 0 = use the spending list
      slowDownAge: 0,        // from this age (first person) spending is scaled by slowDownPct; 0 = never
      slowDownPct: 100,
      claimRelief: true,     // claim higher-rate relief on personal pension contributions (self-assessment)
      // Once the ISAs are full, what is left goes into the pensions of people still working (with tax
      // relief at their top rate) before the general account: highest rate first, within the annual
      // allowance and their pay. Not for anyone retiring before they can draw a pension.
      pensionFirst: false,
      // Salary sacrifice whatever would take someone's income over £100,000 (where the personal
      // allowance starts to go), into their pension, within the annual allowance.
      stayUnder100k: false,
      // Your own amounts a month (today's money); null = automatic (everything left, in order).
      // Whatever your amounts leave over stays in cash.
      isaMonthly: null,
      giaMonthly: null,
    };
  }

  function defaultGoals(startYear, p1) {
    return [
      { id: uid(), type: 'netWorth', amount: 1000000, measure: 'all', basis: 'nominal', year: startYear + 10, age: p1.retireAge, confidence: 80 },
      { id: uid(), type: 'debtFree', amount: 0, measure: 'all', basis: 'nominal', year: startYear + 15, age: p1.retireAge, confidence: 80 },
      { id: uid(), type: 'retire', amount: 0, measure: 'all', basis: 'nominal', year: startYear + (p1.retireAge - p1.age), age: p1.retireAge, confidence: 85 },
    ];
  }

  // The most recent 1 September (the example's figures date, so Home shows a few months of estimates).
  function lastSeptember(d = new Date()) {
    return `${d.getMonth() >= 8 ? d.getFullYear() : d.getFullYear() - 1}-09-01`;
  }

  // A fictional example household. Never put real personal data in here: this repo is public.
  function defaultPlan(startYear) {
    const asOf = startYear ? `${startYear}-09-01` : lastSeptember();
    return normalizePlan(rawDefaultPlan(startYear || +asOf.slice(0, 4), asOf));
  }

  function rawDefaultPlan(startYear, asOf) {
    const p1 = { id: 'p1', name: 'Alex', age: 38, retireAge: 55, endAge: 95, statePension: R.STATE_PENSION_FULL, statePensionAge: 68, pensionAccessAge: R.MIN_PENSION_AGE, extraPension: 0 };
    const p2 = { id: 'p2', name: 'Sam', age: 36, retireAge: 55, endAge: 95, statePension: R.STATE_PENSION_FULL, statePensionAge: 68, pensionAccessAge: R.MIN_PENSION_AGE, extraPension: 0 };
    return {
      startYear,
      asOf,
      household: { region: 'scotland', ignoreTax: false, people: [p1, p2] },
      accounts: [
        { id: uid(), name: 'Current & savings', type: 'cash', owner: 'joint', balance: 18000 },
        { id: uid(), name: 'Alex stocks & shares ISA', type: 'isa', owner: 'p1', balance: 22000 },
        { id: uid(), name: 'Sam stocks & shares ISA', type: 'isa', owner: 'p2', balance: 14000 },
        { id: uid(), name: 'General investment account', type: 'gia', owner: 'joint', balance: 6000, basis: 5000 },
        { id: uid(), name: 'Alex workplace pension', type: 'pension', owner: 'p1', balance: 65000 },
        { id: uid(), name: 'Sam workplace pension', type: 'pension', owner: 'p2', balance: 30000 },
        { id: uid(), name: 'Gilts', type: 'bonds', owner: 'joint', balance: 10000, rate: 4.2, maturityYear: startYear + 4 },
        { id: uid(), name: 'Home', type: 'property', owner: 'joint', balance: 320000, rate: 3, sellYear: 0 },
        { id: uid(), name: 'Mortgage', type: 'debt', owner: 'joint', balance: 210000, rate: 4.4, payment: 1250, fixedUntil: startYear + 2 },
      ],
      income: [
        { id: uid(), name: 'Alex salary', owner: 'p1', kind: 'salary', tax: 'uk', amount: 62000, freq: 'year', growth: 3, inflationLinked: false, startRef: 'now', startAge: 38, endRef: 'retire', endAge: 55, pensionMode: 'pct', employeePension: 5, employerPension: 5, sacrifice: true },
        { id: uid(), name: 'Sam take-home pay', owner: 'p2', kind: 'salary', tax: 'none', amount: 2300, freq: 'month', growth: 3, inflationLinked: false, startRef: 'now', startAge: 36, endRef: 'retire', endAge: 55, pensionMode: 'fixed', employeePension: 250, employerPension: 200, sacrifice: false },
        { id: uid(), name: 'Rental flat', owner: 'joint', kind: 'rental', tax: 'flat', taxRate: 20, costPct: 15, amount: 850, freq: 'month', growth: 2, inflationLinked: false, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95, pensionMode: 'pct', employeePension: 0, employerPension: 0, sacrifice: false },
      ],
      expenses: [
        { id: uid(), name: 'Groceries', owner: 'joint', amount: 650, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95 },
        { id: uid(), name: 'Council tax', owner: 'joint', amount: 210, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95 },
        { id: uid(), name: 'Energy', owner: 'joint', amount: 180, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95 },
        { id: uid(), name: 'Insurance & subscriptions', owner: 'joint', amount: 120, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95 },
        { id: uid(), name: 'Everything else', owner: 'joint', amount: 1900, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'end', endAge: 95 },
        { id: uid(), name: 'Childcare', owner: 'joint', amount: 450, freq: 'month', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'age', endAge: 46 },
        { id: uid(), name: 'Holidays', owner: 'joint', amount: 8000, freq: 'year', inflationLinked: true, growth: 0, startRef: 'now', startAge: 38, endRef: 'age', endAge: 80 },
      ],
      events: [
        { id: uid(), name: 'Replace car', kind: 'expense', year: startYear + 3, amount: 18000 },
        { id: uid(), name: 'Kitchen renovation', kind: 'expense', year: startYear + 6, amount: 25000 },
      ],
      strategy: defaultStrategy(),
      assumptions: defaultAssumptions(),
      goals: defaultGoals(startYear, p1),
    };
  }

  function defaultWorkspace() {
    const id = uid();
    return {
      version: 6,
      activeId: id,
      scenarios: [{ id, name: 'Base plan', plan: defaultPlan() }],
      checkins: [],
      dismissed: [],
      guides: {},
      // Actual pounds of each year by default (as in a spreadsheet: spending visibly rises with prices).
      settings: { realDollars: false, runs: 1000, seed: 42, theme: 'light', confidence: 90, lastSaved: null, showTo: 85, inOutReal: false, inOutView: 'spend' },
    };
  }

  // ---------------------------------------------------------------- normalisation

  const num = (v, d = 0) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : d;
  };
  const oneOf = (v, list, d) => (list.includes(v) ? v : d);
  const str = (v, d) => (typeof v === 'string' ? v : d);
  const arr = v => (Array.isArray(v) ? v.filter(x => x && typeof x === 'object') : []);

  // Copies known keys from src, coercing to the type of each default.
  function fill(src, defs) {
    const out = { ...defs };
    if (!src || typeof src !== 'object') return out;
    for (const k of Object.keys(defs)) {
      if (src[k] === undefined) continue;
      if (defs[k] === null) out[k] = src[k] === null || src[k] === '' || !Number.isFinite(+src[k]) ? null : +src[k];
      else out[k] = typeof defs[k] === 'boolean' ? !!src[k] : num(src[k], defs[k]);
    }
    return out;
  }

  function normalizePerson(p, i, startYear) {
    const age = Math.round(num(p.age, 40));
    return {
      id: i === 0 ? 'p1' : 'p2',
      name: str(p.name, i === 0 ? 'You' : 'Partner'),
      age,
      retireAge: Math.round(num(p.retireAge, 60)),
      endAge: Math.round(num(p.endAge, 95)),
      statePension: Math.max(0, num(p.statePension, R.STATE_PENSION_FULL)),
      statePensionAge: Math.round(num(p.statePensionAge, R.statePensionAge(startYear - age))),
      pensionAccessAge: Math.round(num(p.pensionAccessAge, R.MIN_PENSION_AGE)),
      extraPension: Math.max(0, num(p.extraPension)),
    };
  }

  function normalizeTiming(item, defStart, defEnd) {
    return {
      startRef: oneOf(item.startRef, ['now', 'retire', 'age'], defStart),
      startAge: Math.round(num(item.startAge, 0)),
      endRef: oneOf(item.endRef, ['retire', 'end', 'age'], defEnd),
      endAge: Math.round(num(item.endAge, 0)),
    };
  }

  const GOAL_ICONS = ['retire', 'shield', 'debt', 'goal', 'piggy', 'sp', 'star', 'home', 'cap', 'gift', 'heart'];
  const DEFAULT_GOAL_ICON = { retire: 'retire', emergency: 'shield', debtFree: 'debt', netWorth: 'goal', passiveIncome: 'sp' };

  // Each goal keeps its own colour: new goals take the first palette slot not in use.
  function assignGoalColours(goals) {
    const used = new Set(goals.map(g => g.color).filter(c => c >= 0));
    for (const g of goals) {
      if (g.color >= 0) continue;
      let c = 0;
      while (used.has(c) && c < 8) c++;
      g.color = c < 8 ? c : goals.indexOf(g) % 8;
      used.add(g.color);
    }
    return goals;
  }

  function normalizeGoal(g, startYear, p1, people = [p1]) {
    const type = oneOf(g.type, GOAL_TYPES, 'netWorth');
    // A retirement goal is about one person retiring (the first person unless it says otherwise).
    const owner = type === 'retire' ? oneOf(g.owner, people.map(x => x.id), p1.id) : null;
    const who = people.find(x => x.id === owner) || p1;
    const colour = Math.round(num(g.color, -1));
    return {
      id: str(g.id, uid()),
      name: str(g.name, '').trim().slice(0, 60),          // optional own name, e.g. "House deposit"
      color: colour >= 0 && colour < 8 ? colour : -1,     // palette slot, fixed once given (see normalizePlan)
      icon: oneOf(g.icon, GOAL_ICONS, g.measure === 'savings' && type === 'netWorth' ? 'piggy' : DEFAULT_GOAL_ICON[type]),
      type: oneOf(g.type, GOAL_TYPES, 'netWorth'),
      // Only amount goals have an amount; a retirement goal's year follows its age (see evaluateGoals).
      amount: type === 'netWorth' || type === 'passiveIncome' ? Math.max(0, num(g.amount, 1000000)) : 0,
      measure: oneOf(g.measure, Object.keys(GOAL_MEASURES), 'all'),
      basis: oneOf(g.basis, ['nominal', 'real'], 'nominal'),
      year: type === 'retire' ? startYear + Math.round(num(g.age, who.retireAge)) - who.age : Math.round(num(g.year, startYear + 10)),
      age: Math.round(num(g.age, who.retireAge)),
      owner,
      confidence: Math.min(99, Math.max(50, num(g.confidence, 80))),
      withdrawalRate: Math.min(10, Math.max(1, num(g.withdrawalRate, 4))),
      includePensions: g.includePensions !== undefined ? !!g.includePensions : true,
      months: Math.min(24, Math.max(1, Math.round(num(g.months, 6)))),
      counts: oneOf(g.counts, ['cash', 'investments'], 'cash'),   // emergency fund: cash only, or cash + ISAs, GIA and bonds
    };
  }

  const RESERVE_KINDS = ['emergency', 'saving', 'budget'];
  const RESERVE_ACCOUNTS = ['cash', 'isa', 'gia', 'bonds'];

  function normalizePlan(p) {
    p = p && typeof p === 'object' ? p : {};
    const startYear = Math.round(num(p.startYear, currentYear()));
    const hh = p.household || {};
    let people = arr(hh.people).slice(0, 2).map((x, i) => normalizePerson(x, i, startYear));
    if (!people.length) people = [normalizePerson({}, 0, startYear)];
    const ids = people.map(x => x.id);
    const owner = (v, fallback) => (v === 'joint' || ids.includes(v) ? v : fallback);

    const accounts = arr(p.accounts).map(a => {
      const type = oneOf(a.type, ACCOUNT_TYPES, 'cash');
      const own = owner(a.owner, OWNED_TYPES.includes(type) ? 'p1' : 'joint');
      return {
        id: str(a.id, uid()),
        name: str(a.name, 'Account'),
        type,
        owner: OWNED_TYPES.includes(type) && own === 'joint' ? 'p1' : own,
        balance: Math.max(0, num(a.balance)),
        // What was paid in (for capital gains): only a general investment account needs it.
        basis: type === 'gia' ? Math.max(0, num(a.basis, num(a.balance))) : Math.max(0, num(a.balance)),
        rate: num(a.rate),
        payment: Math.max(0, num(a.payment)),
        maturityYear: Math.round(num(a.maturityYear, 0)),
        sellYear: Math.round(num(a.sellYear, 0)),
        fixedUntil: Math.round(num(a.fixedUntil, 0)),
        // When a fixed rate ends: the new rate (null = same as now) and whether the monthly
        // payment stays the same (the end date moves) or is reset to keep the end date.
        rateAfterFix: a.rateAfterFix === null || a.rateAfterFix === undefined || a.rateAfterFix === '' || !Number.isFinite(+a.rateAfterFix) ? null : +a.rateAfterFix,
        afterFix: oneOf(a.afterFix, ['payment', 'term'], 'payment'),
        excluded: !!a.excluded,
        inIsa: type === 'bonds' && !!a.inIsa,   // gilts held inside an ISA: maturing money stays in the ISA
        // Coupons: bought back into the gilt (as if reinvested at its rate), or paid out: into the
        // ISA's other investments when held in one, else into cash.
        ...(type === 'bonds' ? { coupons: oneOf(a.coupons, ['reinvest', 'payout'], 'reinvest') } : {}),
        // Lifetime ISA: yearly payment (up to £4,000), and whether it is for retirement or a first home
        contribution: Math.min(R.LISA.maxContribution, Math.max(0, num(a.contribution, type === 'lisa' ? R.LISA.maxContribution : 0))),
        purpose: oneOf(a.purpose, ['retirement', 'home'], 'retirement'),
        // An ISA's own amount a month (today's money); null = automatic.
        monthly: type === 'isa' && a.monthly !== null && a.monthly !== undefined && a.monthly !== '' && Number.isFinite(+a.monthly) ? Math.max(0, +a.monthly) : null,
        homeYear: Math.round(num(a.homeYear, 0)),
        // A balance read since the plan's figures date (e.g. from a banking app). It shows on
        // the home page and feeds the next yearly review; the projection keeps the figures.
        latest: a.latest && typeof a.latest === 'object' && isDate(a.latest.date) && Number.isFinite(+a.latest.value)
          ? { value: Math.max(0, +a.latest.value), date: a.latest.date } : null,
      };
    });

    const income = arr(p.income).map(i => ({
      id: str(i.id, uid()),
      name: str(i.name, 'Income'),
      owner: owner(i.owner, 'p1'),
      // Older files used kind 'taxfree' and basis 'net' for already-taxed income.
      kind: i.kind === 'taxfree' ? 'other' : oneOf(i.kind, INCOME_KINDS, 'salary'),
      tax: oneOf(i.tax, TAX_TREATMENTS, i.kind === 'taxfree' || i.basis === 'net' ? 'none' : 'uk'),
      taxRate: Math.min(100, Math.max(0, num(i.taxRate))),
      fx: num(i.fx, 1) > 0 ? num(i.fx, 1) : 1,
      costPct: Math.min(100, Math.max(0, num(i.costPct))),
      fixedCosts: Math.max(0, num(i.fixedCosts)),
      dbAccrual: Math.max(0, num(i.dbAccrual)),        // defined benefit: pension added per year worked (£/yr, today)
      lumpMultiple: Math.max(0, num(i.lumpMultiple)),  // defined benefit: automatic tax-free lump sum, × the pension
      dbScheme: str(i.dbScheme, ''),                    // defined benefit estimate: scheme, year joined, salary now
      dbJoined: Math.round(num(i.dbJoined, 0)),
      dbSalary: Math.max(0, num(i.dbSalary)),
      amount: Math.max(0, num(i.amount)),
      freq: oneOf(i.freq, ['month', 'year'], 'year'),
      // A defined benefit pension rises with prices once paid (see dbPensionAt), whatever is stored.
      growth: i.kind === 'dbpension' ? 0 : num(i.growth),
      // Pay progression: `growth` until this age (0 = all along), then `growthAfter`; promotions add a step.
      growthUntilAge: Math.max(0, Math.round(num(i.growthUntilAge, 0))),
      growthAfter: i.kind === 'dbpension' ? 0 : Math.round(num(i.growthUntilAge, 0)) > 0 ? num(i.growthAfter, num(i.growth)) : num(i.growth),
      raises: arr(i.raises).filter(r => r && Number.isFinite(+r.age) && Number.isFinite(+r.pct)).slice(0, 10)
        .map(r => ({ age: Math.round(+r.age), pct: Math.max(-90, Math.min(500, +r.pct)) })).sort((a, b) => a.age - b.age),
      inflationLinked: i.kind === 'dbpension' ? true : !!i.inflationLinked,
      ...normalizeTiming(i, 'now', 'retire'),
      pensionMode: oneOf(i.pensionMode, ['pct', 'fixed'], 'pct'),
      employeePension: Math.max(0, num(i.employeePension)),
      employerPension: Math.max(0, num(i.employerPension)),
      sacrifice: !!i.sacrifice,
    }));

    const expenses = arr(p.expenses).map(e => ({
      id: str(e.id, uid()),
      name: str(e.name, 'Expense'),
      key: str(e.key, ''),
      category: str(e.category, ''),
      owner: owner(e.owner, 'joint'),
      amount: Math.max(0, num(e.amount)),
      freq: oneOf(e.freq, ['month', 'year'], 'month'),
      inflationLinked: e.inflationLinked !== undefined ? !!e.inflationLinked : true,
      growth: num(e.growth),
      ...normalizeTiming(e, 'now', 'end'),
    }));

    const events = arr(p.events).map(e => ({
      id: str(e.id, uid()),
      name: str(e.name, 'Event'),
      kind: oneOf(e.kind, ['expense', 'income', 'overpay'], 'expense'),
      year: Math.round(num(e.year, startYear + 1)),
      amount: Math.max(0, num(e.amount)),
    }));

    // Money set aside inside an account: an emergency fund, savings building up for a known cost
    // (e.g. home repairs every few years), or a yearly budget (e.g. holidays) that stays in the
    // account until it is spent. The projection already counts what they pay for; these only mark
    // which part of a balance is spoken for.
    const reserves = arr(p.reserves).filter(r => r && typeof r === 'object').slice(0, 20).map(r => {
      const kind = oneOf(r.kind, RESERVE_KINDS, 'emergency');
      const acc = accounts.find(a => a.id === r.accountId && RESERVE_ACCOUNTS.includes(a.type));
      return {
        id: str(r.id, uid()),
        name: str(r.name, kind === 'emergency' ? 'Emergency fund' : kind === 'budget' ? 'Yearly budget' : 'Saving up'),
        kind,
        accountId: acc ? acc.id : '',
        // Emergency fund: today's money (null = the cash buffer setting).
        amount: kind === 'emergency' && r.amount !== null && r.amount !== undefined && r.amount !== '' && Number.isFinite(+r.amount) ? Math.max(0, +r.amount) : null,
        // Saving up: for the planned costs with this name. Budget: for this spending item.
        eventName: kind === 'saving' ? str(r.eventName, '') : '',
        expenseId: kind === 'budget' ? str(r.expenseId, '') : '',
        // Budget: what was left of last year's, kept for it (pounds, as at the figures date).
        left: kind === 'budget' ? Math.max(0, num(r.left)) : 0,
        // Saving up: what was already put aside on the figures date (null = nothing yet).
        saved: kind === 'saving' && r.saved !== null && r.saved !== undefined && r.saved !== '' && Number.isFinite(+r.saved) ? Math.max(0, +r.saved) : null,
      };
    }).filter(r => r.kind !== 'budget' || expenses.some(e => e.id === r.expenseId));

    let goals;
    if (Array.isArray(p.goals)) goals = arr(p.goals).map(g => normalizeGoal(g, startYear, people[0], people));
    else if (p.goal && typeof p.goal === 'object') goals = [normalizeGoal({ ...p.goal, type: 'netWorth', year: startYear + 10 }, startYear, people[0])];
    else goals = defaultGoals(startYear, people[0]).map(g => normalizeGoal(g, startYear, people[0]));
    assignGoalColours(goals);

    return {
      startYear,
      asOf: isDate(p.asOf) ? p.asOf : null,   // filled in by normalizeWorkspace when missing
      household: { region: oneOf(hh.region, ['scotland', 'ruk'], 'scotland'), ignoreTax: !!hh.ignoreTax, people },
      accounts, income, expenses, events, reserves,
      strategy: fill(p.strategy, defaultStrategy()),
      assumptions: fill(p.assumptions, defaultAssumptions()),
      goals,
      life: cleanLife(p.life),
    };
  }

  // Life check-up answers: kept as given, but only plain data.
  function cleanLife(life) {
    if (!life || typeof life !== 'object' || Array.isArray(life)) return null;
    const out = {};
    for (const [k, v] of Object.entries(life)) {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
      else if (k === 'children' && Array.isArray(v)) {
        out.children = v.filter(c => c && typeof c === 'object').slice(0, 8)
          .map(c => ({ name: str(c.name, ''), age: Math.max(0, Math.round(num(c.age))) }));
      }
    }
    return out;
  }

  function normalizeCheckin(c) {
    const pred = c.predicted && typeof c.predicted === 'object' ? c.predicted : {};
    const nums = v => (Array.isArray(v) ? v.map(x => num(x)) : []);
    const actual = {};
    for (const k of ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt', 'netWorth', 'liquid', 'spending']) {
      actual[k] = num(c.actual && c.actual[k]);
    }
    return {
      id: str(c.id, uid()),
      date: str(c.date, new Date().toISOString().slice(0, 10)),
      year: Math.round(num(c.year, currentYear())),
      scenarioName: str(c.scenarioName, ''),
      note: str(c.note, ''),
      actual,
      predicted: { years: nums(pred.years), netWorth: nums(pred.netWorth), liquid: nums(pred.liquid), ...byType(pred.byType) },
      monthlyInvest: num(c.monthlyInvest),
      goals: arr(c.goals).slice(0, 20).map(g => ({
        title: str(g.title, 'Goal'), probability: Math.min(1, Math.max(0, num(g.probability))),
        expectedYear: g.expectedYear == null ? null : Math.round(num(g.expectedYear)),
      })),
    };
    function byType(bt) {
      if (!bt || typeof bt !== 'object') return {};
      const out = {};
      for (const k of ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt']) out[k] = nums(bt[k]);
      return { byType: out };
    }
  }

  // What each guide remembers: when it was last done, and short text answers
  // (e.g. { protection: { date: '2026-11-06', answers: { will: 'no' } } }).
  function cleanGuides(g) {
    const out = {};
    if (!g || typeof g !== 'object') return out;
    for (const [id, v] of Object.entries(g)) {
      if (!/^[a-z0-9-]{1,40}$/.test(id) || !v || typeof v !== 'object') continue;
      const answers = {};
      for (const [k, a] of Object.entries(v.answers || {})) {
        if (!/^[a-z0-9:-]{1,60}$/i.test(k)) continue;
        if (typeof a === 'string') answers[k] = a.slice(0, 40);
        // A few amounts (e.g. pension contributions), numbers only.
        else if (a && typeof a === 'object' && !Array.isArray(a)) {
          const o = {};
          for (const [f, x] of Object.entries(a).slice(0, 6)) if (/^[a-z]{1,30}$/i.test(f) && Number.isFinite(+x)) o[f] = +x;
          answers[k] = o;
        }
      }
      out[id] = { date: isDate(v.date) ? v.date : null, answers };
    }
    return out;
  }

  function normalizeWorkspace(w) {
    if (!w || typeof w !== 'object') return defaultWorkspace();
    if (!Array.isArray(w.scenarios) && (w.household || w.accounts)) {
      const id = uid();
      const plan = normalizePlan(w);
      if (!plan.asOf) plan.asOf = plan.startYear === currentYear() ? todayISO() : `${plan.startYear}-01-01`;
      return { ...defaultWorkspace(), activeId: id, scenarios: [{ id, name: 'Imported plan', plan }] };
    }
    const scenarios = arr(w.scenarios).map((s, i) => ({
      id: str(s.id, uid()), name: str(s.name, `Scenario ${i + 1}`), plan: normalizePlan(s.plan),
    }));
    if (!scenarios.length) return defaultWorkspace();
    const ds = defaultWorkspace().settings;
    const st = w.settings || {};
    const checkins = arr(w.checkins).map(normalizeCheckin).sort((a, b) => a.date.localeCompare(b.date));
    // Plans saved before figures had a date: the check-in recorded for that year, else today
    // for this year's plan, else 1 January.
    // Version 6: the untouched example (Alex & Sam, never reviewed) moves its figures to the
    // most recent 1 September, so it shows a few months of estimates like a fresh copy does.
    if (num(w.version, 0) < 6 && !checkins.length) {
      for (const s of scenarios) {
        const names = s.plan.household.people.map(x => x.name).join('&');
        if (s.name === 'Base plan' && names === 'Alex&Sam') { s.plan.asOf = lastSeptember(); s.plan.startYear = +s.plan.asOf.slice(0, 4); }
      }
    }
    for (const s of scenarios) {
      if (s.plan.asOf) continue;
      const c = checkins.filter(x => x.year === s.plan.startYear && isDate(x.date)).pop();
      s.plan.asOf = c ? c.date : s.plan.startYear === currentYear() ? todayISO() : `${s.plan.startYear}-01-01`;
    }
    return {
      version: 6,
      activeId: scenarios.some(s => s.id === w.activeId) ? w.activeId : scenarios[0].id,
      scenarios,
      checkins,
      dismissed: Array.isArray(w.dismissed) ? [...new Set(w.dismissed.filter(x => typeof x === 'string'))] : [],
      guides: cleanGuides(w.guides),
      settings: {
        realDollars: st.realDollars !== undefined ? !!st.realDollars : ds.realDollars,
        runs: Math.min(20000, Math.max(100, Math.round(num(st.runs, ds.runs)))),
        seed: Math.round(num(st.seed, ds.seed)),
        // Light by default; plans saved before version 5 on "automatic" switch to light.
        theme: (num(w.version, 0) < 5 && st.theme === 'auto') ? 'light' : oneOf(st.theme, ['auto', 'light', 'dark'], 'light'),
        confidence: Math.min(99, Math.max(50, num(st.confidence, ds.confidence))),
        lastSaved: isDate(st.lastSaved) ? st.lastSaved : null,   // when the plan was last saved to a file
        // Charts over time stop when the first person reaches this age (0 = the whole plan).
        showTo: st.showTo === 0 ? 0 : Math.min(120, Math.max(50, Math.round(num(st.showTo, ds.showTo)))),
        inOutReal: !!st.inOutReal,   // Home "Money in and out": today's money (true) or actual pounds (false)
        inOutView: oneOf(st.inOutView, ['spend', 'all'], 'spend'),   // Money in and out: spending, or where it all goes
      },
    };
  }

  function validatePlan(p) {
    const out = [];
    for (const a of p.accounts.filter(x => x.type === 'lisa')) {
      const owner = p.household.people[personIndex(p, a.owner)];
      if (a.balance <= 0 && owner.age >= R.LISA.openBefore) out.push(`“${a.name}”: a Lifetime ISA has to be opened before 40, so ${owner.name} cannot start paying in now.`);
      if (a.purpose === 'home' && a.homeYear && a.homeYear < p.startYear) out.push(`“${a.name}”: the first-home year has passed.`);
    }
    for (const person of p.household.people) {
      if (person.endAge <= person.age) out.push(`${person.name}: “plan until age” must be after current age.`);
      if (person.retireAge < person.age) out.push(`${person.name} is treated as already retired (retirement age is before current age).`);
    }
    const a = p.assumptions;
    if (a.stockPctNow > 100 || a.stockPctRetire > 100) out.push('Stock allocation cannot exceed 100%.');
    for (const d of p.accounts.filter(x => x.type === 'debt' && x.balance > 0)) {
      if (d.payment * 12 <= d.balance * d.rate / 100) out.push(`“${d.name}” payments do not cover the interest, so it never shrinks.`);
    }
    const pre = precompute(p);
    p.household.people.forEach((person, i) => {
      if (pre.people[i].contrib[0] + pre.people[i].extraPot[0] > R.PENSION_ANNUAL_ALLOWANCE) {
        out.push(`${person.name}'s pension contributions exceed the £60,000 annual allowance; the excess would be taxed.`);
      }
    });
    return out;
  }

  // ---------------------------------------------------------------- timing helpers

  function personIndex(plan, owner) {
    const i = plan.household.people.findIndex(x => x.id === owner);
    return i < 0 ? 0 : i;
  }

  // [start, end) ages of the owner during which a stream is active.
  function streamWindow(item, person) {
    const start = item.startRef === 'now' ? -Infinity : item.startRef === 'retire' ? person.retireAge : item.startAge;
    const end = item.endRef === 'retire' ? person.retireAge : item.endRef === 'end' ? Infinity : item.endAge;
    return [start, end];
  }

  const annual = item => item.amount * (item.freq === 'month' ? 12 : 1);

  function ownerOf(plan, item) {
    return plan.household.people[personIndex(plan, item.owner === 'joint' ? 'p1' : item.owner)];
  }

  function isActive(item, plan, t) {
    const person = ownerOf(plan, item);
    const age = person.age + t;
    const [start, end] = streamWindow(item, person);
    return age >= start && age < end;
  }

  // Growth multiplier of a stream between now and year t in a given economy.
  // Inflation-linked: the price index. Otherwise: its own rate, adjusted by the inflation
  // surprise (and, for salaries, the salary surprise).
  function growthFactor(item, plan, t, econ) {
    if (item.inflationLinked) return econ.price[t] * promotions(item, plan, t);
    const f = progression(item, plan, t) * econ.surprise[t];
    return item.kind === 'salary' ? f * econ.wage[t] : f;
  }

  // Growth multiplier in the expected economy (no surprises).
  function expectedGrowth(item, plan, t) {
    if (item.inflationLinked) return Math.pow(1 + plan.assumptions.inflation / 100, t) * promotions(item, plan, t);
    return progression(item, plan, t);
  }

  // What each pot of money set aside holds `years` after the figures date (fractions allowed),
  // in the pounds of then, on the plan's assumptions:
  // - emergency: the amount (or the cash buffer), raised with prices each plan year;
  // - saving: builds up evenly towards the next planned cost with its name (taken as due halfway
  //   through that plan year), from the previous one or from what was put aside by the figures date;
  // - budget: this plan year's amount of the spending item, available until spent (it comes in
  //   from take-home pay during the year), plus what was left of last year's and kept for it.
  // `held` is the part already in the account (all of it, except a budget's new year's money).
  function reservesAt(plan, years = 0) {
    const yrs = Math.max(0, years);
    const price = t => Math.pow(1 + plan.assumptions.inflation / 100, Math.max(0, t));
    const t = Math.floor(yrs);
    return (plan.reserves || []).map(r => {
      const base = { id: r.id, name: r.name, kind: r.kind, accountId: r.accountId };
      if (r.kind === 'emergency') {
        // Raised once a year, like the cash buffer the plan keeps.
        const v = (r.amount ?? plan.strategy.cashReserve) * price(t);
        return { ...base, amount: v, held: v };
      }
      if (r.kind === 'saving') {
        const evs = plan.events.filter(e => e.kind === 'expense' && e.name === r.eventName)
          .map(e => ({ at: e.year - plan.startYear + 0.5, year: e.year, amount: e.amount * price(e.year - plan.startYear) }))
          .filter(e => e.at > 0).sort((a, b) => a.at - b.at);
        const next = evs.find(e => e.at > yrs);
        if (!next) return { ...base, amount: 0, held: 0, target: 0, dueYear: null, perYear: 0 };
        const prev = evs.filter(e => e.at <= yrs).pop();
        const from = prev ? prev.at : 0;
        // Before the first cost: from what was already put aside on the figures date.
        const start = prev ? 0 : Math.min(next.amount, r.saved || 0);
        const share = Math.min(1, Math.max(0, (yrs - from) / (next.at - from)));
        const v = start + (next.amount - start) * share;
        return { ...base, amount: v, held: v, target: next.amount, dueYear: next.year, perYear: (next.amount - start) / (next.at - from) };
      }
      const e = plan.expenses.find(x => x.id === r.expenseId);
      const yearly = e && isActive(e, plan, t) ? annual(e) * expectedGrowth(e, plan, t) : 0;
      const left = t === 0 ? r.left : 0;
      return { ...base, amount: yearly + left, held: left, yearly, left, year: plan.startYear + t, expenseName: e ? e.name : r.name };
    });
  }

  // Rises at `growth` a year until `growthUntilAge`, then at `growthAfter`, plus any promotions.
  function progression(item, plan, t) {
    const until = item.growthUntilAge > 0 ? Math.max(0, item.growthUntilAge - ownerOf(plan, item).age) : Infinity;
    const t1 = Math.min(t, until), t2 = Math.max(0, t - until);
    return Math.pow(1 + item.growth / 100, t1) * Math.pow(1 + (item.growthAfter ?? item.growth) / 100, t2) * promotions(item, plan, t);
  }

  // One-off steps (a promotion or a new job) at an age, from the year after now.
  function promotions(item, plan, t) {
    if (!item.raises || !item.raises.length) return 1;
    const age = ownerOf(plan, item).age;
    let f = 1;
    for (const r of item.raises) if (r.age > age && age + t >= r.age) f *= 1 + r.pct / 100;
    return f;
  }

  // Nominal amount of an income or expense stream in year t (expected economy by default).
  function streamAt(item, plan, t, econ) {
    if (!isActive(item, plan, t)) return 0;
    return annual(item) * (econ ? growthFactor(item, plan, t, econ) : expectedGrowth(item, plan, t));
  }

  // Pension contributions (employee, employer) for a salary in year t, nominal.
  function pensionContrib(item, salary, plan, t, econ) {
    if (item.kind !== 'salary' || salary <= 0) return [0, 0];
    if (item.pensionMode === 'pct') return [salary * item.employeePension / 100, salary * item.employerPension / 100];
    const g = econ ? growthFactor(item, plan, t, econ) : expectedGrowth(item, plan, t);
    return [item.employeePension * 12 * g, item.employerPension * 12 * g];
  }

  // Tax functions for a plan: UK rules, or all zero when the household switches tax off.
  const NO_TAX = {
    incomeTax: () => 0, nationalInsurance: () => 0, capitalGainsTax: () => 0,
    personalAllowance: (inc, g) => R.personalAllowance(inc, g),
  };
  const taxRules = plan => (plan.household.ignoreTax ? NO_TAX : R);

  // Defined benefit pension (e.g. USS): what is built up so far plus what each further year of
  // work adds, paid from the scheme's pension age and rising with prices.
  function dbPensionAt(item, plan, t, econ) {
    const person = ownerOf(plan, item);
    const age = person.age + t;
    if (age < item.startAge) return 0;
    const years = Math.max(0, Math.min(person.retireAge, item.startAge) - person.age);
    const price = econ ? econ.price[t] : Math.pow(1 + plan.assumptions.inflation / 100, t);
    return (item.amount + item.dbAccrual * years) * price * dbEarly(item, person).factor;
  }

  // A defined benefit pension taken before the scheme's Normal Pension Age is reduced (USS
  // publishes its factors; other schemes are not reduced here). Years early, and the share kept.
  function dbEarly(item, person) {
    const s = R.DB_SCHEMES[item.dbScheme];
    if (!s || !s.early) return { npa: null, years: 0, factor: 1 };
    const npa = s.age === 'spa' ? person.statePensionAge : s.age;
    const years = Math.max(0, npa - item.startAge);
    const i = Math.min(s.early.length - 1, Math.floor(years));
    const j = Math.min(s.early.length - 1, i + 1);
    const pctKept = s.early[i] + (s.early[j] - s.early[i]) * (years - Math.floor(years));
    return { npa, years, factor: pctKept / 100 };
  }

  // Income after currency conversion and costs, in pounds, for year t.
  function incomeAfterCosts(item, plan, t, econ) {
    if (item.kind === 'dbpension') return dbPensionAt(item, plan, t, econ);
    if (!isActive(item, plan, t)) return 0;
    const g = econ ? growthFactor(item, plan, t, econ) : expectedGrowth(item, plan, t);
    const price = econ ? econ.price[t] : Math.pow(1 + plan.assumptions.inflation / 100, t);
    const gross = annual(item) * g * item.fx;
    return Math.max(0, gross * (1 - item.costPct / 100) - item.fixedCosts * price);
  }

  // How an income stream is taxed, after the household-wide switch.
  const taxOf = (item, plan) => (plan.household.ignoreTax && item.tax === 'uk' ? 'none' : item.tax);

  function frozenYears(plan) {
    return Math.max(0, plan.assumptions.thresholdFreezeUntil - plan.startYear);
  }

  // Tax thresholds stay put while frozen, then rise with prices.
  function thresholdFactorFrom(plan, t, price) {
    const F = frozenYears(plan);
    return t <= F ? 1 : price[t] / price[Math.min(F, price.length - 1)];
  }

  function thresholdFactor(plan, t) {
    return Math.pow(1 + plan.assumptions.inflation / 100, Math.max(0, t - frozenYears(plan)));
  }

  function stockWeight(plan, t) {
    const p1 = plan.household.people[0];
    const a = plan.assumptions;
    const now = a.stockPctNow / 100, ret = a.stockPctRetire / 100;
    const years = p1.retireAge - p1.age;
    const w = t >= years || years <= 0 ? ret : now + (ret - now) * t / years;
    return Math.max(0, Math.min(1, w));
  }

  function horizon(plan) {
    return Math.max(1, ...plan.household.people.map(p => p.endAge - p.age));
  }

  // ---------------------------------------------------------------- economy

  function newEcon(N) {
    return {
      N,
      price: new Float64Array(N + 1),     // price index, 1 today
      surprise: new Float64Array(N + 1),  // price / expected price
      wage: new Float64Array(N + 1),      // salary surprise multiplier
      infl: new Float64Array(N),          // inflation during year t
      house: new Float64Array(N),         // added to every property's growth rate in year t
      rateShift: new Float64Array(N),     // added to variable interest rates in year t
      ret: new Float64Array(N),           // portfolio return in year t
      mean: new Float64Array(N),          // expected portfolio return in year t (for return overrides)
      stockW: new Float64Array(N + 1),
    };
  }

  function expectedEcon(plan, N = horizon(plan)) {
    const a = plan.assumptions;
    const mu = a.inflation / 100;
    const e = newEcon(N);
    for (let t = 0; t <= N; t++) {
      e.price[t] = Math.pow(1 + mu, t);
      e.surprise[t] = 1;
      e.wage[t] = 1;
      e.stockW[t] = stockWeight(plan, t);
    }
    for (let t = 0; t < N; t++) {
      e.infl[t] = mu;
      e.ret[t] = (e.stockW[t] * a.stockReturn + (1 - e.stockW[t]) * a.bondReturn) / 100;
      e.mean[t] = e.ret[t];
      e.ret[t] += crashAt(plan, t, e.stockW[t]);
    }
    return e;
  }

  // A scenario's one-off market fall: shares drop by crashPct in crashYear (on top of the usual returns).
  function crashAt(plan, t, stockW) {
    const a = plan.assumptions;
    return a.crashYear && plan.startYear + t === a.crashYear ? stockW * a.crashPct / 100 : 0;
  }

  function lognormal(mean, sd) {
    const v = Math.log(1 + Math.pow(sd / (1 + mean), 2));
    return { mu: Math.log(1 + mean) - v / 2, sigma: Math.sqrt(v) };
  }

  // One random economy. Inflation follows an AR(1) process around its assumption; salaries,
  // house prices and interest rates move with inflation surprises plus their own noise.
  function makeRandomEcon(plan, N, normal) {
    const a = plan.assumptions;
    const mu = a.inflation / 100;
    const st = lognormal(a.stockReturn / 100, Math.max(0, a.stockVolatility / 100));
    const bd = lognormal(a.bondReturn / 100, Math.max(0, a.bondVolatility / 100));
    const sdPi = a.varyInflation ? a.inflationVolatility / 100 : 0;
    const phi = Math.max(0, Math.min(0.95, a.inflationPersistence));
    const sdW = a.varySalaries ? a.salaryVolatility / 100 : 0;
    const sdH = a.varyHouses ? a.houseVolatility / 100 : 0;
    const link = a.varyRates ? a.rateSensitivity : 0;
    const e = newEcon(N);
    for (let t = 0; t <= N; t++) e.stockW[t] = stockWeight(plan, t);
    for (let t = 0; t < N; t++) e.mean[t] = (e.stockW[t] * a.stockReturn + (1 - e.stockW[t]) * a.bondReturn) / 100;
    return function draw() {
      let pi = mu;
      e.price[0] = 1; e.surprise[0] = 1; e.wage[0] = 1;
      for (let t = 0; t < N; t++) {
        const zs = normal(), zb = normal();
        const rs = Math.exp(st.mu + st.sigma * zs) - 1;
        const rb = Math.exp(bd.mu + bd.sigma * zb) - 1;
        e.ret[t] = e.stockW[t] * rs + (1 - e.stockW[t]) * rb + crashAt(plan, t, e.stockW[t]);
        if (sdPi > 0) pi = Math.max(-0.02, mu + phi * (pi - mu) + sdPi * normal());
        e.infl[t] = pi;
        const dev = pi - mu;
        e.price[t + 1] = e.price[t] * (1 + pi);
        e.surprise[t + 1] = e.price[t + 1] / Math.pow(1 + mu, t + 1);
        e.wage[t + 1] = sdW > 0 ? e.wage[t] * Math.max(0.5, 1 + sdW * normal()) : 1;
        e.house[t] = dev + (sdH > 0 ? sdH * normal() : 0);
        e.rateShift[t] = link * dev;
      }
      return e;
    };
  }

  // ---------------------------------------------------------------- precompute

  // Everything that does not depend on investment balances, for one economy.
  function precompute(plan, econ) {
    const { household, strategy: s, assumptions: a } = plan;
    const people = household.people;
    const N = horizon(plan);
    econ = econ || expectedEcon(plan, N);
    const zeros = () => new Float64Array(N + 1);
    const p1 = people[0];
    const T = taxRules(plan);
    const pre = {
      N, econ,
      years: [], deflator: econ.price, g: zeros(), price: econ.price,
      ages: people.map(() => []),
      taxFree: zeros(), flatTax: zeros(), expenses: zeros(), eventsIn: zeros(), eventsOut: zeros(), eventsOverpay: zeros(),
      keepCash: zeros(),   // money set aside in cash on top of the buffer (today's money), e.g. repairs building up
      people: people.map(() => ({
        gross: zeros(),        // gross salary paid in cash (before employee contributions)
        netPay: zeros(),       // take-home pay entered as net
        employee: zeros(),     // employee contributions deducted from gross pay
        ee: zeros(),           // the person's own workplace contributions (any kind of pay)
        contrib: zeros(),      // workplace contributions into the pot (employee + employer)
        extraOut: zeros(),     // extra personal contributions paid from take-home pay
        extraPot: zeros(),     // ... and what lands in the pot after basic-rate relief
        taxable: zeros(),      // income for income tax before withdrawals
        other: zeros(),        // other taxable income
        statePension: zeros(),
        baseIT: zeros(),       // income tax before withdrawals
        ni: zeros(),
        baseTax: zeros(),      // income tax + NI before withdrawals
        relief: zeros(),       // higher-rate relief on personal pension contributions (reduces income tax)
        sacrificed: zeros(),   // pay sacrificed into the pension to stay under £100,000
        payInc: zeros(),       // income tax is measured on (take-home pay grossed up), for "pensions first"
        earned: zeros(),       // pay before tax: the most that can get relief in a year
      })),
    };

    for (let t = 0; t <= N; t++) {
      pre.years.push(plan.startYear + t);
      pre.g[t] = thresholdFactorFrom(plan, t, econ.price);
      people.forEach((p, i) => pre.ages[i].push(p.age + t));
    }

    for (let t = 0; t < N; t++) {
      const g = pre.g[t];
      const price = econ.price[t];
      const niable = people.map(() => 0);
      for (const item of plan.income) {
        const v = incomeAfterCosts(item, plan, t, econ);
        if (v <= 0) continue;
        const tax = taxOf(item, plan);
        const P = item.owner === 'joint' ? null : pre.people[personIndex(plan, item.owner)];
        if (item.kind === 'dbpension' && item.lumpMultiple > 0 && ownerOf(plan, item).age + t === item.startAge) {
          pre.eventsIn[t] += item.lumpMultiple * v; // tax-free lump sum in the first year
        }
        if (item.kind === 'salary' && P) {
          const [ee, er] = pensionContrib(item, v, plan, t, econ);
          P.contrib[t] += ee + er;
          P.ee[t] += ee;
          if (tax === 'uk') {
            P.gross[t] += v;
            P.employee[t] += ee;
            // Salary sacrifice avoids NI on the sacrificed amount (capped at £2,000 from April 2029).
            const niFree = !item.sacrifice ? 0 : plan.startYear + t >= R.SACRIFICE_NI_CAP_FROM ? Math.min(ee, R.SACRIFICE_NI_CAP) : ee;
            niable[personIndex(plan, item.owner)] += v - niFree;
          } else {
            // Take-home pay: contributions are assumed to come out before it is paid.
            P.netPay[t] += v;
            if (tax === 'flat') pre.flatTax[t] += v * item.taxRate / 100;
          }
          continue;
        }
        if (tax === 'uk') {
          // Taxable non-salary income; joint income is split equally.
          if (P) P.other[t] += v;
          else for (const Q of pre.people) Q.other[t] += v / people.length;
          continue;
        }
        pre.taxFree[t] += v;
        if (tax === 'flat') pre.flatTax[t] += v * item.taxRate / 100;
      }

      // Take-home pay back to gross, with the year's thresholds.
      const grossUp = net => (net > 0 ? R.grossFromTakeHome(net / g, household.region) * g : 0);
      people.forEach((p, i) => {
        const P = pre.people[i];
        const age = p.age + t;
        if (age >= p.statePensionAge) {
          P.statePension[t] = p.statePension * price * Math.pow(1 + a.statePensionRealGrowth / 100, t);
        }
        if (p.extraPension > 0 && age < p.retireAge) {
          P.extraOut[t] = p.extraPension * 12 * price;
          P.extraPot[t] = P.extraOut[t] / (1 - BASIC_RELIEF);
        }
        // Stay under £100,000: sacrifice the pay above it (take-home pay falls by what that pay would
        // have left after tax, and NI while sacrifice still saves it).
        if (s.stayUnder100k && !household.ignoreTax && age < p.retireAge) {
          const fromNet = grossUp(P.netPay[t]);
          const ani = P.gross[t] - P.employee[t] + P.other[t] + P.statePension[t] + fromNet - P.extraPot[t];
          const room = Math.max(0, R.PENSION_ANNUAL_ALLOWANCE - P.contrib[t] - P.extraPot[t]);
          const E = Math.min(room, Math.max(0, ani - R.PA_TAPER_START * g));
          const niSaved = plan.startYear + t < R.SACRIFICE_NI_CAP_FROM;
          if (E > 0.5 && P.netPay[t] > 0 && fromNet >= E) {
            const taxCut = T.incomeTax(fromNet, household.region, g) - T.incomeTax(fromNet - E, household.region, g);
            const niCut = niSaved ? T.nationalInsurance(fromNet, g) - T.nationalInsurance(fromNet - E, g) : 0;
            P.netPay[t] = Math.max(0, P.netPay[t] - (E - taxCut - niCut));
            P.contrib[t] += E;
            P.sacrificed[t] = E;
          } else if (E > 0.5 && P.gross[t] - P.employee[t] >= E) {
            P.employee[t] += E;
            if (niSaved) niable[i] = Math.max(0, niable[i] - E);
            P.contrib[t] += E;
            P.sacrificed[t] = E;
          }
        }
        P.taxable[t] = P.gross[t] - P.employee[t] + P.other[t] + P.statePension[t];
        P.ni[t] = age < p.statePensionAge ? T.nationalInsurance(niable[i], g) : 0;
        P.baseIT[t] = T.incomeTax(P.taxable[t], household.region, g);
        // Relief above the basic 20% on personal contributions, claimed through self-assessment:
        // the tax saved by taking the gross contribution off taxable income, less the 20% already
        // added to the pot. Take-home pay is grossed up to estimate the tax paid on it.
        if (P.extraPot[t] > 0 && s.claimRelief && !household.ignoreTax) {
          const inc = P.taxable[t] + grossUp(P.netPay[t]);
          const saved = T.incomeTax(inc, household.region, g) - T.incomeTax(Math.max(0, inc - P.extraPot[t]), household.region, g);
          P.relief[t] = Math.max(0, saved - BASIC_RELIEF * P.extraPot[t]);
          P.baseIT[t] -= P.relief[t];
        }
        P.baseTax[t] = P.baseIT[t] + P.ni[t];
        if (s.pensionFirst && !household.ignoreTax && age < p.retireAge && p.retireAge >= p.pensionAccessAge && (P.gross[t] > 0 || P.netPay[t] > 0)) {
          const grossed = grossUp(P.netPay[t]);
          P.payInc[t] = P.taxable[t] + grossed - P.extraPot[t];
          P.earned[t] = P.gross[t] + grossed;
        }
      });

      const retired = p1.age + t >= p1.retireAge;
      if (retired && s.retireSpending > 0) {
        // The retirement amount replaces the regular list; check-up items (care, travel...) still apply.
        let extra = 0;
        for (const e of plan.expenses) if ((e.key || '').startsWith('life:') && isActive(e, plan, t)) extra += annual(e) * growthFactor(e, plan, t, econ);
        pre.expenses[t] = s.retireSpending * price + extra;
      } else {
        let total = 0;
        for (const e of plan.expenses) if (isActive(e, plan, t)) total += annual(e) * growthFactor(e, plan, t, econ);
        pre.expenses[t] = retired ? total : total * s.spendNowPct / 100;
      }
      if (s.slowDownAge > 0 && p1.age + t >= s.slowDownAge) pre.expenses[t] *= s.slowDownPct / 100;
      // Savings building up for a cost in a cash account stay in cash (on top of the buffer) until paid.
      {
        const held = reservesAt(plan, t + 1).filter(r => r.kind === 'saving' && (plan.accounts.find(a => a.id === r.accountId) || {}).type === 'cash')
          .reduce((acc, r) => acc + r.held, 0);
        pre.keepCash[t] = held / Math.pow(1 + plan.assumptions.inflation / 100, t);
      }
      // Last year's budget money kept for this year (e.g. holidays not taken yet) is spent too.
      if (t === 0) for (const r of plan.reserves || []) if (r.kind === 'budget') pre.eventsOut[0] += r.left;
      for (const e of plan.events) {
        if (e.year !== plan.startYear + t) continue;
        const v = e.amount * price;
        if (e.kind === 'income') pre.eventsIn[t] += v;
        else if (e.kind === 'overpay') pre.eventsOverpay[t] += v;
        else pre.eventsOut[t] += v;
      }
    }
    // Money set aside to be spent (building up for a planned cost like repairs every few years, or
    // what is left of a yearly budget like holidays) stays in its account but is not counted in net
    // worth, as it is already spoken for. Only the emergency fund, not meant to be spent, still counts.
    pre.locked = new Float64Array(N + 1);
    if ((plan.reserves || []).some(r => r.kind !== 'emergency')) {
      for (let t = 0; t <= N; t++) {
        const held = reservesAt(plan, t).filter(r => r.kind !== 'emergency').reduce((acc, r) => acc + r.held, 0);
        pre.locked[t] = held / Math.pow(1 + plan.assumptions.inflation / 100, t) * pre.price[t];
      }
    }
    return pre;
  }

  // ---------------------------------------------------------------- simulation

  function newPath(N, detail, nPeople = 2) {
    const out = {};
    for (const k of ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt', 'short', 'locked']) out[k] = new Float64Array(N + 1);
    if (detail) {
      for (const k of FLOW_KEYS) out[k] = new Float64Array(N + 1);
      out.persons = Array.from({ length: nPeople }, () => ({
        taxable: new Float64Array(N + 1), incomeTax: new Float64Array(N + 1), ni: new Float64Array(N + 1),
        pensionDrawn: new Float64Array(N + 1), pensionTaxFree: new Float64Array(N + 1), allowance: new Float64Array(N + 1),
        pension: new Float64Array(N + 1), relief: new Float64Array(N + 1),
      }));
      out.debts = [];
      out.lisa = new Float64Array(N + 1);   // Lifetime ISAs (also counted in isa)
    }
    return out;
  }

  // Fixed point of W = need + tax(W). Converges because marginal rates are below 100%.
  function grossUp(need, tax, cap) {
    let W = need;
    for (let k = 0; k < 80; k++) {
      const next = need + tax(W);
      if (Math.abs(next - W) < 0.005) { W = next; break; }
      W = next;
    }
    return Math.min(W, cap);
  }

  // Yearly payment that clears `bal` over the months left at the old rate and payment.
  function renewalPayment(bal, oldRate, oldPay, newRate) {
    const i0 = oldRate / 12, m0 = oldPay / 12;
    if (m0 <= bal * i0) return oldPay; // never paid off at the old terms: keep the payment
    const n = i0 > 0 ? -Math.log(1 - (i0 * bal) / m0) / Math.log(1 + i0) : bal / m0;
    const i1 = newRate / 12;
    const m1 = i1 > 0 ? (bal * i1) / (1 - Math.pow(1 + i1, -n)) : bal / n;
    return m1 * 12;
  }

  // Estimate of a defined benefit pension from the scheme, the year joined and salary now.
  // Each year worked adds salary / accrual rate (career average, revalued with prices, so in
  // today's money); earlier salaries are assumed `realGrowth`% a year lower than today's.
  function estimateDb(opts) {
    const s = R.DB_SCHEMES[opts.scheme] || R.DB_SCHEMES.other;
    const accrual = opts.accrual || s.accrual;
    const share = opts.partTime === undefined ? 1 : opts.partTime / 100;
    const salary = (opts.salary || 0) * share;
    const years = Math.max(0, (opts.startYear || currentYear()) - (opts.joined || opts.startYear));
    const g = (opts.realGrowth === undefined ? 1 : opts.realGrowth) / 100;
    let builtUp = 0;
    for (let k = 1; k <= years; k++) builtUp += salary / accrual / Math.pow(1 + g, k);
    return {
      years, builtUp, perYear: salary / accrual, lumpMultiple: s.lump,
      pensionAge: s.age === 'spa' ? null : s.age, scheme: s,
    };
  }

  // Cash needed for an emergency-fund goal in year t: months of regular spending and debt payments.
  // What an emergency-fund goal counts: cash, or cash plus investments that can be sold within days.
  function emergencyHave(goal, b) {
    return goal.counts === 'investments' ? b.cash + b.isa + b.gia + b.bonds : b.cash;
  }

  function emergencyNeed(goal, pre, debtPayYear, t) {
    const tt = Math.min(t, pre.N - 1);
    return goal.months * (pre.expenses[tt] + debtPayYear) / 12;
  }

  // Walks one economy through the plan.
  function runPath(plan, pre, out) {
    const { household, strategy: s, assumptions: a } = plan;
    const people = household.people;
    const region = household.region;
    const n = people.length;
    const N = pre.N;
    const econ = pre.econ;
    const detail = !!out.earnings;
    const cr = a.cashRate / 100;
    const T = taxRules(plan);
    const invOverride = a.investReturn === null ? null : a.investReturn / 100;
    const penOverride = a.pensionReturn === null ? null : a.pensionReturn / 100;
    const fee = (a.fees || 0) / 100;

    let cash = 0, isa = 0, gia = 0, basis = 0, short = 0;
    const pension = people.map(() => 0);
    const lsaLeft = people.map(() => R.LUMP_SUM_ALLOWANCE);
    const bonds = [], props = [], debts = [], lisas = [];
    // Your own amount for each ISA, totalled per person (null when the ISAs are automatic).
    const isaSet = plan.accounts.some(x => x.type === 'isa' && !x.excluded && x.monthly !== null)
      ? people.map((_, i) => plan.accounts.filter(x => x.type === 'isa' && !x.excluded && personIndex(plan, x.owner) === i).reduce((acc, x) => acc + (x.monthly || 0) * 12, 0))
      : null;
    for (const x of plan.accounts) {
      if (x.excluded) continue;
      if (x.type === 'cash') cash += x.balance;
      else if (x.type === 'isa') isa += x.balance;
      else if (x.type === 'gia') { gia += x.balance; basis += Math.min(x.basis, x.balance); }
      else if (x.type === 'pension') pension[personIndex(plan, x.owner)] += x.balance;
      else if (x.type === 'lisa') {
        const owner = personIndex(plan, x.owner);
        lisas.push({
          bal: x.balance, owner, pay: Math.min(x.contribution, R.LISA.maxContribution),
          // Can pay in only if it is already open or the owner is still under 40.
          canOpen: x.balance > 0 || people[owner].age < R.LISA.openBefore,
          home: x.purpose === 'home' && x.homeYear ? x.homeYear - plan.startYear : Infinity,
        });
      }
      else if (x.type === 'bonds') bonds.push({ bal: x.balance, rate: x.rate / 100, t: x.maturityYear ? x.maturityYear - plan.startYear : Infinity, inIsa: x.inIsa, payout: x.coupons === 'payout' });
      else if (x.type === 'property') props.push({ val: x.balance, rate: x.rate / 100, t: x.sellYear ? x.sellYear - plan.startYear : Infinity });
      else if (x.type === 'debt') {
        debts.push({
          id: x.id, bal: x.balance, rate: x.rate / 100, pay: x.payment * 12,
          // A fix "until 2027" runs through 2027; the new rate applies from the next year.
          varFrom: x.fixedUntil ? x.fixedUntil - plan.startYear + 1 : Infinity,
          after: x.rateAfterFix === null ? x.rate / 100 : x.rateAfterFix / 100,
          keepTerm: x.afterFix === 'term',
        });
      }
    }
    debts.sort((d1, d2) => d2.rate - d1.rate); // overpay the most expensive first
    if (detail) out.debts = debts.map(d => ({ id: d.id, bal: new Float64Array(N + 1), rate: new Float64Array(N + 1) }));

    const sum = xs => xs.reduce((acc, v) => acc + v, 0);
    const record = t => {
      const lisaBal = lisas.reduce((acc, l) => acc + l.bal, 0);
      if (out.lisa) out.lisa[t] = lisaBal;
      out.cash[t] = cash; out.isa[t] = isa + lisaBal; out.gia[t] = gia; out.pension[t] = sum(pension);
      out.bonds[t] = bonds.reduce((acc, b) => acc + b.bal, 0);
      out.property[t] = props.reduce((acc, p) => acc + p.val, 0);
      out.debt[t] = debts.reduce((acc, d) => acc + d.bal, 0);
      out.short[t] = short;
      out.locked[t] = pre.locked[t];
      if (detail) {
        for (let i = 0; i < n; i++) out.persons[i].pension[t] = pension[i];
        debts.forEach((d, k) => { out.debts[k].bal[t] = d.bal; });
      }
    };

    for (let t = 0; t <= N; t++) {
      record(t);
      if (t === N) break;

      const g = pre.g[t], f = econ.price[t], r = econ.ret[t], dr = econ.rateShift[t];
      const cashTarget = (s.cashReserve + pre.keepCash[t]) * f;

      // 1. Growth
      const cashRate = Math.max(0, cr + dr);
      // Optional fixed average returns keep each run's market surprise but move its centre.
      const rInv = (invOverride === null ? r : r - econ.mean[t] + invOverride) - fee;
      const rPen = (penOverride === null ? r : r - econ.mean[t] + penOverride) - fee;
      // gIsa reports ISA growth including Lifetime ISAs; each balance grows once.
      let gIsa = isa * rInv;
      isa += gIsa;
      for (const l of lisas) { const x = l.bal * rInv; l.bal += x; gIsa += x; }
      // A Lifetime ISA saved for a first home is paid out in the year of the purchase.
      let lisaHome = 0;
      for (const l of lisas) if (t === l.home && l.bal > 0) { cash += l.bal; lisaHome += l.bal; l.bal = 0; }
      const gCash = cash * cashRate, gGia = gia * rInv;
      cash += gCash; gia += gGia;
      let gPension = 0;
      for (let i = 0; i < n; i++) { const x = pension[i] * rPen; pension[i] += x; gPension += x; }
      let gBonds = 0, bondsMatured = 0, bondsToIsa = 0;
      for (const b of bonds) {
        const x = b.bal * b.rate;
        gBonds += x;
        if (b.payout && b.bal > 0) {
          // Paid out: into the ISA's investments (no allowance used), or cash.
          if (b.inIsa) { isa += x; bondsToIsa += x; } else { cash += x; bondsMatured += x; }
          gBonds -= x;
        } else b.bal += x;
        if (t + 1 >= b.t && b.bal > 0) {
          // Inside an ISA the money stays sheltered without using the year's allowance.
          if (b.inIsa) { isa += b.bal; bondsToIsa += b.bal; } else { cash += b.bal; bondsMatured += b.bal; }
          b.bal = 0;
        }
      }
      let gProperty = 0, propSold = 0;
      for (const p of props) {
        const x = p.val * Math.max(-0.5, p.rate + econ.house[t]);
        p.val += x;
        gProperty += x;
        if (t === p.t && p.val > 0) { propSold += p.val; p.val = 0; }
      }

      // 2. Pension contributions
      let pensionIn = 0, extraOut = 0;
      for (let i = 0; i < n; i++) {
        const P = pre.people[i];
        const x = P.contrib[t] + P.extraPot[t];
        pension[i] += x;
        pensionIn += x;
        extraOut += P.extraOut[t];
      }

      // 3. Debts: interest, regular payments, then any lump-sum overpayment
      let debtRegular = 0, debtInterest = 0, lumpOverpay = 0;
      const debtStart = debts.map(d => d.bal);
      debts.forEach((d, k) => {
        const rate = t >= d.varFrom ? Math.max(0, d.after + dr) : d.rate;
        // On renewal, optionally reset the payment so the mortgage still ends when it would have;
        // after that it is reset whenever the rate moves (a new deal), keeping the same end date.
        if (d.keepTerm && t >= d.varFrom && d.bal > 0) {
          const was = t === d.varFrom ? d.rate : d.last;
          if (Math.abs(rate - was) > 1e-9) d.pay = renewalPayment(d.bal, was, d.pay, rate);
        }
        d.last = rate;
        if (detail) out.debts[k].rate[t] = rate;
        const interest = d.bal * rate;
        const p = Math.min(d.pay, d.bal + interest);
        d.bal = d.bal + interest - p;
        debtRegular += p;
        debtInterest += interest;
      });
      let lump = pre.eventsOverpay[t];
      for (const d of debts) {
        if (lump <= 0) break;
        const x = Math.min(lump, d.bal);
        d.bal -= x;
        lump -= x;
        lumpOverpay += x;
      }

      // 4. Net cash flow after the year's base taxes
      let baseTax = pre.flatTax[t], earnings = 0, employee = 0, other = 0, statePension = 0;
      const income = people.map((_, i) => pre.people[i].taxable[t]);
      for (let i = 0; i < n; i++) {
        const P = pre.people[i];
        baseTax += P.baseTax[t];
        earnings += P.gross[t] + P.netPay[t];
        employee += P.employee[t];
        other += P.other[t];
        statePension += P.statePension[t];
      }
      other += pre.taxFree[t] + pre.eventsIn[t] + propSold;
      const net = earnings - employee - extraOut + other + statePension - baseTax
        - pre.expenses[t] - pre.eventsOut[t] - debtRegular - lumpOverpay;

      let extraTax = 0, cgt = 0, unfunded = 0, sweepIsa = 0, sweepGia = 0;
      let toCash = 0, overpay = 0, toIsa = 0, toGia = 0, toLisa = 0, lisaBonus = 0, wLisa = 0, lisaCharge = 0, toPension = 0;
      let wCash = 0, wGia = 0, wIsa = 0, wPension = 0;
      const drawn = people.map(() => 0), taxFreeTaken = people.map(() => 0);
      let gains = 0;

      if (net >= 0) {
        let left = net;
        toCash = Math.max(0, Math.min(left, cashTarget - cash));
        cash += toCash;
        left -= toCash;
        let budget = left * s.overpayPct / 100;
        debts.forEach((d, k) => {
          if (budget <= 0 || d.bal <= 0) return;
          const cap = s.overpayCapPct > 0 ? debtStart[k] * s.overpayCapPct / 100 : Infinity;
          const x = Math.min(budget, d.bal, cap);
          d.bal -= x;
          budget -= x;
          overpay += x;
        });
        left -= overpay;
        // Lifetime ISAs first: the 25% bonus beats everything else. They share the ISA allowance.
        let allowance = s.isaAllowance * g * n;
        const lisaPaid = people.map(() => 0);
        for (const l of lisas) {
          const age = people[l.owner].age + t;
          if (!l.canOpen || age < 18 || age >= R.LISA.payUntil || t >= l.home || left <= 0) continue;
          const x = Math.min(left, l.pay, allowance);
          l.bal += x * (1 + R.LISA.bonus);
          toLisa += x;
          lisaBonus += x * R.LISA.bonus;
          left -= x;
          allowance -= x;
          lisaPaid[l.owner] += x;
        }
        // Each person's own ISA amounts, within what is left of their allowance after a Lifetime ISA.
        const capIsa = isaSet ? isaSet.reduce((acc, v, i) => acc + Math.min(v * f, Math.max(0, s.isaAllowance * g - lisaPaid[i])), 0)
          : s.isaMonthly === null ? Infinity : Math.max(0, s.isaMonthly) * 12 * f;
        const capGia = s.giaMonthly === null ? Infinity : Math.max(0, s.giaMonthly) * 12 * f;
        toIsa = Math.min(left, allowance, capIsa);
        isa += toIsa;
        // Pensions first: £1,000 of contribution at a time, at the relief it gets, highest rate first.
        if (s.pensionFirst && s.giaMonthly === null) {
          const room = people.map((_, i) => {
            const P = pre.people[i];
            return P.earned[t] > 0 ? Math.max(0, Math.min(R.PENSION_ANNUAL_ALLOWANCE, P.earned[t]) - P.contrib[t] - P.extraPot[t]) : 0;
          });
          const inc = people.map((_, i) => pre.people[i].payInc[t]);
          const rate = i => Math.min(0.7, (T.incomeTax(inc[i], region, g) - T.incomeTax(Math.max(0, inc[i] - 1000), region, g)) / 1000);
          for (let k = 0; k < 200; k++) {
            let best = -1, bestRate = 0.195;
            for (let i = 0; i < n; i++) if (room[i] > 1) { const m = rate(i); if (m > bestRate) { best = i; bestRate = m; } }
            const spare = left - toIsa - toPension;
            if (best < 0 || spare < 1) break;
            const gross = Math.min(1000, room[best], spare / (1 - bestRate));
            const cost = gross * (1 - bestRate);
            pension[best] += gross;
            pensionIn += gross;
            toPension += cost;
            room[best] -= gross;
            inc[best] -= gross;
          }
        }
        toGia = Math.min(left - toIsa - toPension, capGia);
        gia += toGia;
        basis += toGia;
        const rest = left - toIsa - toPension - toGia;   // left over by your own amounts: kept as cash
        if (rest > 0) { cash += rest; toCash += rest; }
        // Cash above the buffer (e.g. matured gilts) is invested too, within your own amounts.
        const excess = cash - cashTarget;
        if (s.sweepCash && excess > 0.5) {
          sweepIsa = Math.min(excess, Math.max(0, s.isaAllowance * g * n - toLisa - toIsa), Math.max(0, capIsa - toIsa));
          sweepGia = Math.min(excess - sweepIsa, Math.max(0, capGia - toGia));
          isa += sweepIsa;
          gia += sweepGia;
          basis += sweepGia;
          cash -= sweepIsa + sweepGia;
        }
      } else {
        let need = -net;

        // Cash above the buffer
        const spare = Math.max(0, cash - cashTarget);
        wCash = Math.min(spare, need);
        cash -= wCash;
        need -= wCash;

        const canDraw = i => people[i].age + t >= people[i].pensionAccessAge && pension[i] > 0;
        const pensionTax = (i, W) => {
          const tf = Math.min(W * R.PENSION_TAX_FREE_SHARE, lsaLeft[i]);
          return T.incomeTax(income[i] + W - tf, region, g) - T.incomeTax(income[i], region, g);
        };
        const drawPension = (i, W) => {
          const tf = Math.min(W * R.PENSION_TAX_FREE_SHARE, lsaLeft[i]);
          const tax = pensionTax(i, W);
          lsaLeft[i] -= tf;
          income[i] += W - tf;
          pension[i] -= W;
          extraTax += tax;
          wPension += W;
          drawn[i] += W;
          taxFreeTaken[i] += tf;
          return W - tax;
        };

        // Pension withdrawals that stay inside each person's personal allowance (tax-free)
        for (let i = 0; i < n && need > 1e-9; i++) {
          if (!canDraw(i)) continue;
          const room = T.personalAllowance(income[i], g) - income[i];
          if (room <= 0) continue;
          const taxableShare = lsaLeft[i] > 0 ? 1 - R.PENSION_TAX_FREE_SHARE : 1;
          const W = Math.min(pension[i], need, room / taxableShare);
          need -= drawPension(i, W);
        }

        // General investment account (CGT on the gain share)
        if (need > 1e-9 && gia > 0) {
          const gainShare = Math.max(0, 1 - basis / gia);
          const cgtOn = x => {
            let tax = 0;
            for (let i = 0; i < n; i++) {
              tax += T.capitalGainsTax((gains + x * gainShare) / n, income[i], g) - T.capitalGainsTax(gains / n, income[i], g);
            }
            return tax;
          };
          const S = grossUp(need, cgtOn, gia);
          const tax = cgtOn(S);
          gains += S * gainShare;
          basis -= basis * (S / gia);
          gia -= S;
          if (gia < 1e-9) { gia = 0; basis = 0; }
          extraTax += tax;
          cgt += tax;
          need -= S - tax;
          wGia = S;
        }

        // ISA (tax-free)
        if (need > 1e-9 && isa > 0) {
          wIsa = Math.min(isa, need);
          isa -= wIsa;
          need -= wIsa;
        }

        // Lifetime ISAs from 60 (tax-free)
        for (const l of lisas) {
          if (need <= 1e-9) break;
          if (people[l.owner].age + t < R.LISA.accessAge || l.bal <= 0) continue;
          const x = Math.min(l.bal, need);
          l.bal -= x;
          need -= x;
          wLisa += x;
        }

        // Taxed pension withdrawals, from whoever has the lower income first
        for (let pass = 0; pass < 2 * n && need > 0.01; pass++) {
          const order = people.map((_, i) => i).filter(canDraw).sort((x, y) => income[x] - income[y]);
          if (!order.length) break;
          const i = order[0];
          const W = grossUp(need, w => pensionTax(i, w), pension[i]);
          need -= drawPension(i, W);
          if (pension[i] < 0.01) pension[i] = 0;
        }

        // Finally the cash buffer
        if (need > 0.01 && cash > 0) {
          const x = Math.min(cash, need);
          cash -= x;
          need -= x;
          wCash += x;
        }

        // Last resort: Lifetime ISAs before 60, paying the 25% charge
        for (const l of lisas) {
          if (need <= 0.01) break;
          if (l.bal <= 0) continue;
          const W = Math.min(l.bal, need / (1 - R.LISA.charge));
          l.bal -= W;
          need -= W * (1 - R.LISA.charge);
          wLisa += W;
          lisaCharge += W * R.LISA.charge;
        }

        // Ignore pennies left by the gross-up tolerance.
        if (need > 0.5) {
          unfunded = need;
          short += need;
        }
      }

      if (detail) {
        out.earnings[t] = earnings;
        out.otherIncome[t] = other;
        out.statePension[t] = statePension;
        out.withdrawals[t] = wCash + wGia + wIsa + wPension + wLisa - lisaCharge;
        out.wCash[t] = wCash; out.wGia[t] = wGia; out.wIsa[t] = wIsa; out.wPension[t] = wPension;
        out.spending[t] = pre.expenses[t] + pre.eventsOut[t];
        out.taxes[t] = baseTax + extraTax + lisaCharge;
        out.flatTax[t] = pre.flatTax[t];
        out.cgt[t] = cgt;
        out.debtPay[t] = debtRegular + lumpOverpay + overpay;
        out.debtRegular[t] = debtRegular;
        out.debtInterest[t] = debtInterest;
        out.lumpOverpay[t] = lumpOverpay;
        out.overpay[t] = overpay;
        out.saved[t] = employee + extraOut + toCash + toIsa + toGia + toLisa + toPension;
        out.toPension[t] = toPension;
        out.sacrificed[t] = pre.people.reduce((acc, P) => acc + P.sacrificed[t], 0);
        out.toLisa[t] = toLisa; out.lisaBonus[t] = lisaBonus; out.wLisa[t] = wLisa; out.lisaHome[t] = lisaHome; out.lisaCharge[t] = lisaCharge;
        out.pensionRelief[t] = pre.people.reduce((acc, P) => acc + P.relief[t], 0);
        out.extraPension[t] = extraOut;
        out.toCash[t] = toCash; out.toIsa[t] = toIsa; out.toGia[t] = toGia;
        out.pensionIn[t] = pensionIn;
        out.unfunded[t] = unfunded;
        out.gCash[t] = gCash; out.gIsa[t] = gIsa; out.gGia[t] = gGia; out.gPension[t] = gPension;
        out.gBonds[t] = gBonds; out.gProperty[t] = gProperty;
        out.bondsMatured[t] = bondsMatured; out.bondsToIsa[t] = bondsToIsa; out.propSold[t] = propSold;
        out.sweepIsa[t] = sweepIsa; out.sweepGia[t] = sweepGia;
        out.nonWork[t] = nonWorkIncome(pre, t);
        for (let i = 0; i < n; i++) {
          const o = out.persons[i];
          o.taxable[t] = income[i];
          o.allowance[t] = R.personalAllowance(income[i], g);
          o.incomeTax[t] = T.incomeTax(income[i], region, g) - pre.people[i].relief[t];
          o.relief[t] = pre.people[i].relief[t];
          o.ni[t] = pre.people[i].ni[t];
          o.pensionDrawn[t] = drawn[i];
          o.pensionTaxFree[t] = taxFreeTaken[i];
        }
      }
    }
    return out;
  }

  function project(plan) {
    const pre = precompute(plan);
    const out = runPath(plan, pre, newPath(pre.N, true, plan.household.people.length));
    const rows = [];
    for (let t = 0; t <= pre.N; t++) {
      const liquid = out.cash[t] + out.isa[t] + out.gia[t] + out.pension[t] + out.bonds[t] - out.short[t];
      const row = {
        t, year: pre.years[t], ages: pre.ages.map(a => a[t]), deflator: pre.price[t],
        inflation: t < pre.N ? pre.econ.infl[t] : 0, thresholdFactor: pre.g[t],
        stockWeight: pre.econ.stockW[t], expectedReturn: t < pre.N ? pre.econ.ret[t] : 0,
        cash: out.cash[t], isa: out.isa[t], gia: out.gia[t], pension: out.pension[t], bonds: out.bonds[t],
        property: out.property[t], debt: out.debt[t], shortfall: out.short[t],
        liquid, netWorth: liquid + out.property[t] - out.debt[t] - out.locked[t], locked: out.locked[t],
        lisa: out.lisa ? out.lisa[t] : 0,
      };
      for (const k of FLOW_KEYS) row[k] = t < pre.N ? out[k][t] : 0;
      row.persons = out.persons.map(o => {
        const P = {};
        for (const k of Object.keys(o)) P[k] = t < pre.N || k === 'pension' ? o[k][t] : 0;
        return P;
      });
      rows.push(row);
    }
    return { pre, rows, out };
  }

  // This year's monthly plan for the surplus.
  function monthlyPlan(proj) {
    const r = proj.rows[0];
    return {
      isa: r.toIsa / 12, gia: r.toGia / 12, overpay: (r.overpay + r.lumpOverpay) / 12, cash: r.toCash / 12,
      lisa: (r.toLisa || 0) / 12,
      pension: r.pensionIn / 12,
      toPension: (r.toPension || 0) / 12,
      invest: (r.toIsa + r.toGia + (r.toLisa || 0) + (r.toPension || 0)) / 12,
      surplus: (r.toIsa + r.toGia + (r.toLisa || 0) + (r.toPension || 0) + r.overpay + r.toCash) / 12,
      shortfall: (r.withdrawals + r.unfunded) / 12,
    };
  }

  function milestones(plan, proj) {
    const { rows, pre } = proj;
    const people = plan.household.people;
    const list = [];
    const yearAt = (i, age) => plan.startYear + (age - people[i].age);
    const inRange = y => y >= plan.startYear && y <= plan.startYear + pre.N;
    people.forEach((p, i) => {
      const who = people.length > 1 ? `${p.name} ` : '';
      const add = (age, label, kind) => { const y = yearAt(i, age); if (inRange(y)) list.push({ year: y, label: `${who}${label}`.replace(/^./, c => c.toUpperCase()), kind }); };
      add(p.retireAge, people.length > 1 ? 'retires' : 'Retire', 'retire');
      add(p.pensionAccessAge, people.length > 1 ? 'can access pension' : 'Pension access', 'pension');
      add(p.statePensionAge, people.length > 1 ? 'starts State Pension' : 'State Pension starts', 'sp');
    });
    if (rows[0].debt > 0) {
      const r = rows.find(x => x.debt <= 0.5);
      if (r) list.push({ year: r.year, label: 'Mortgage-free', kind: 'debt' });
    }
    const fi = rows.find(r => r.t < pre.N && r.spending > 0 && r.liquid >= 25 * r.spending);
    if (fi) list.push({ year: fi.year, label: 'Financially independent (25× spending)', kind: 'fi' });
    const out = rows.find(r => r.shortfall > 0);
    if (out) list.push({ year: out.year, label: 'Money runs out', kind: 'short' });
    return list.sort((x, y) => x.year - y.year);
  }


  // ---------------------------------------------------------------- history

  // An economy that replays history from `start` (an index into hist.years), wrapping round to
  // the first year after the last. Real share and bond returns are put on top of UK inflation
  // for the same year; salaries, house prices and interest rates follow its inflation
  // surprises exactly as in the simulations.
  function historicalEcon(plan, N, hist, start) {
    const a = plan.assumptions;
    const mu = a.inflation / 100;
    const L = hist.years.length;
    const link = a.varyRates ? a.rateSensitivity : 0;
    const e = newEcon(N);
    for (let t = 0; t <= N; t++) e.stockW[t] = stockWeight(plan, t);
    e.price[0] = 1; e.surprise[0] = 1; e.wage[0] = 1;
    for (let t = 0; t < N; t++) {
      const k = (start + t) % L;
      const pi = hist.ukInflation[k];
      const rs = (1 + hist.stocksReal[k]) * (1 + pi) - 1;
      const rb = (1 + hist.bondsReal[k]) * (1 + pi) - 1;
      e.mean[t] = (e.stockW[t] * a.stockReturn + (1 - e.stockW[t]) * a.bondReturn) / 100;
      e.ret[t] = e.stockW[t] * rs + (1 - e.stockW[t]) * rb + crashAt(plan, t, e.stockW[t]);
      e.infl[t] = pi;
      const dev = pi - mu;
      e.price[t + 1] = e.price[t] * (1 + pi);
      e.surprise[t + 1] = e.price[t + 1] / Math.pow(1 + mu, t + 1);
      e.wage[t + 1] = 1;
      e.house[t] = dev;
      e.rateShift[t] = link * dev;
    }
    return e;
  }

  // Runs the plan once from every starting year in history. For each start: whether the
  // money lasts, when it would run out, liquid assets in today's money, and each goal.
  function historicalRuns(plan, hist) {
    const N = horizon(plan), T = N + 1, L = hist.years.length;
    const out = newPath(N, false);
    const p1 = plan.household.people[0];
    const debtPayments = plan.accounts.filter(a => a.type === 'debt' && !a.excluded).reduce((acc, a) => acc + a.payment * 12, 0);
    const snap = { cash: 0, isa: 0, gia: 0, pension: 0, bonds: 0, property: 0, debt: 0, short: 0, locked: 0 };
    const tOf = g => Math.max(0, Math.min(N, g.year - plan.startYear));

    // One pass over every start year for a plan; `check` records per-run goal results.
    const pass = (pl, check) => {
      const res = [];
      for (let s = 0; s < L; s++) {
        const econ = historicalEcon(pl, N, hist, s);
        const pre = precompute(pl, econ);
        runPath(pl, pre, out);
        const liquid = new Array(T);
        let failT = -1;
        for (let t = 0; t < T; t++) {
          liquid[t] = (out.cash[t] + out.isa[t] + out.gia[t] + out.pension[t] + out.bonds[t] - out.short[t]) / econ.price[t];
          if (failT < 0 && out.short[t] > 0) failT = t;
        }
        res.push({ s, econ, pre, liquid, failT, success: out.short[N] <= 0, goals: check ? check(pre, econ) : null });
      }
      return res;
    };

    const goalCheck = (pre, econ) => {
      const r = {};
      for (const g of plan.goals) {
        const tg = tOf(g);
        if (g.type === 'netWorth' || g.type === 'passiveIncome') {
          let hit = false;
          for (let t = 0; t <= tg && !hit; t++) {
            for (const k in snap) snap[k] = out[k][t];
            const v = g.type === 'passiveIncome' ? passiveIncome(snap, nonWorkIncome(pre, t), g) : goalValue(snap, g.measure);
            hit = v >= goalTarget(g, econ.price[t]);
          }
          r[g.id] = hit;
        } else if (g.type === 'debtFree') {
          let hit = false;
          for (let t = 0; t <= tg && !hit; t++) hit = out.debt[t] <= 0.5;
          r[g.id] = hit;
        } else if (g.type === 'emergency') {
          for (const k in snap) snap[k] = out[k][Math.min(tg, N - 1)];
          r[g.id] = emergencyHave(g, snap) >= emergencyNeed(g, pre, out.debt[tg] > 0.5 ? debtPayments : 0, tg) - 0.5;
        } else {
          r[g.id] = out.short[N] <= 0; // retirement as planned; other ages below
        }
      }
      return r;
    };

    const base = pass(plan, goalCheck);
    // Retirement goals at a different age from the plan: run that version of the plan too.
    for (const g of plan.goals) {
      const who = g.type === 'retire' ? retiree(plan, g) : null;
      if (!who || g.age === who.retireAge) continue;
      const shifted = pass(shiftRetirement(plan, g.age - who.retireAge, who.id));
      shifted.forEach((x, i) => { base[i].goals[g.id] = x.success; });
    }

    const starts = base.map(x => ({
      year: hist.years[x.s],
      wraps: x.s + N > L,
      success: x.success,
      failYear: x.failT >= 0 ? plan.startYear + x.failT : null,
      endReal: x.liquid[N],
      minReal: Math.min(...x.liquid),
      goals: x.goals,
    }));
    const bands = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    for (let t = 0; t < T; t++) {
      const col = base.map(x => x.liquid[t]).sort((a, b) => a - b);
      for (const [k, p] of PCTS) bands[k].push(percentile(col, p));
    }
    const goalRates = {};
    for (const g of plan.goals) goalRates[g.id] = starts.filter(x => x.goals[g.id]).length / L;
    const years = [];
    for (let t = 0; t < T; t++) years.push(plan.startYear + t);
    return {
      years, starts, bands, goalRates,
      liquid: base.map(x => x.liquid),
      successRate: starts.filter(x => x.success).length / L,
      complete: starts.filter(x => !x.wraps).length,
      first: hist.years[0], last: hist.years[L - 1],
    };
  }

  // ---------------------------------------------------------------- goals

  // Income that arrives without working: rent, gifts, pensions in payment, State Pension.
  function nonWorkIncome(pre, t) {
    if (t >= pre.N) t = pre.N - 1;
    let v = pre.taxFree[t];
    for (const P of pre.people) v += P.other[t] + P.statePension[t];
    return v;
  }

  // Passive income: a sustainable withdrawal from investments plus non-work income.
  function passiveIncome(b, nonWork, goal) {
    const short = b.short !== undefined ? b.short : b.shortfall || 0;
    const invest = b.cash + b.isa + b.gia + b.bonds + (goal.includePensions ? b.pension : 0) - short;
    return Math.max(0, invest) * goal.withdrawalRate / 100 + nonWork;
  }

  // Value a balance snapshot under a goal measure.
  function goalValue(b, measure) {
    const short = b.short !== undefined ? b.short : b.shortfall || 0;
    const locked = b.locked || 0;   // set aside to be spent: not counted
    if (measure === 'savings') return b.cash + b.isa + b.gia + b.bonds - short - locked;
    const liquid = b.cash + b.isa + b.gia + b.pension + b.bonds - short;
    if (measure === 'liquid') return liquid;
    const nw = liquid + b.property - b.debt - locked;
    return measure === 'noPension' ? nw - b.pension : nw;
  }

  function goalTarget(goal, price) {
    return goal.basis === 'real' ? goal.amount * price : goal.amount;
  }

  // First year the expected projection meets an amount or passive-income goal.
  function goalYear(goal, proj) {
    const meets = goal.type === 'passiveIncome'
      ? (x, t) => passiveIncome(x, nonWorkIncome(proj.pre, t), goal) >= goalTarget(goal, x.deflator)
      : x => goalValue(x, goal.measure) >= goalTarget(goal, x.deflator);
    const r = proj.rows.find(meets);
    return r ? r.year : null;
  }

  // Debt payments in a projection year (regular payments, not overpayments).
  const debtPayAt = (proj, t) => (t < proj.pre.N ? proj.rows[t].debtRegular : 0);

  // First year the expected projection holds enough cash for an emergency-fund goal.
  function emergencyYear(goal, proj) {
    const r = proj.rows.find((x, t) => t < proj.pre.N && emergencyHave(goal, x) >= emergencyNeed(goal, proj.pre, debtPayAt(proj, t), t) - 0.5);
    return r ? r.year : null;
  }

  // Cash buffer (today's money) that covers the goal now.
  function solveEmergency(plan, goal) {
    const proj = project(plan);
    const r0 = proj.rows[0];
    const need = emergencyNeed(goal, proj.pre, debtPayAt(proj, 0), 0);
    const have = emergencyHave(goal, r0);
    const invested = have - r0.cash;
    // Cash buffer that, with what else counts, covers the need today.
    const buffer = Math.max(0, Math.ceil((need - invested) / 500) * 500);
    return { need, buffer, have, invested, already: plan.strategy.cashReserve + invested >= need - 0.5, cashNow: r0.cash };
  }

  function debtFreeYear(proj) {
    if (proj.rows[0].debt <= 0.5) return proj.rows[0].year;
    const r = proj.rows.find(x => x.debt <= 0.5);
    return r ? r.year : null;
  }

  function goalTitle(goal, plan) {
    if (goal.name) return goal.name;
    return autoTitle(goal, plan);
  }

  // The goal described in words, e.g. "£1M by 2031" (also the subtitle of named goals).
  function autoTitle(goal, plan) {
    const p1 = plan.household.people[0];
    if (goal.type === 'debtFree') return `Mortgage-free by ${goal.year}`;
    if (goal.type === 'retire') return `${plan.household.people.length > 1 ? `${retiree(plan, goal).name} retires` : 'Retire'} at ${goal.age}`;
    if (goal.type === 'emergency') return `Emergency fund: ${goal.months} months by ${goal.year}`;
    const amt = goal.amount >= 1e6 ? `£${+(goal.amount / 1e6).toFixed(2)}M` : `£${Math.round(goal.amount / 1000)}K`;
    if (goal.type === 'passiveIncome') return `${amt} a year passive income by ${goal.year}`;
    if (goal.measure === 'savings') return `${amt} saved by ${goal.year}`;
    return `${amt} by ${goal.year}`;
  }

  function statusOf(prob) {
    return prob >= 0.8 ? 'good' : prob >= 0.5 ? 'warn' : 'bad';
  }

  // Probability and expected timing for each goal.
  function evaluateGoals(plan, proj, mc, opts = {}) {
    const runs = opts.runs || 500, seed = opts.seed || 1;
    const p1 = plan.household.people[0];
    const N = proj.pre.N;
    return plan.goals.map(goal => {
      const t = Math.max(0, Math.min(N, goal.year - plan.startYear));
      const res = { goal, title: goalTitle(goal, plan) };
      if (goal.type === 'netWorth' || goal.type === 'passiveIncome') {
        res.expectedYear = goalYear(goal, proj);
        res.probability = mc.goalHits[goal.id] ? mc.goalHits[goal.id][t] : 0;
        res.byYear = mc.goalHits[goal.id];
        res.summary = res.expectedYear ? `Expected in ${res.expectedYear} on average returns.` : 'Not reached within the plan on average returns.';
      } else if (goal.type === 'emergency') {
        res.expectedYear = emergencyYear(goal, proj);
        res.probability = mc.goalHits[goal.id] ? mc.goalHits[goal.id][t] : 0;
        res.byYear = mc.goalHits[goal.id];
        res.need = emergencyNeed(goal, proj.pre, debtPayAt(proj, 0), 0);
        res.summary = res.expectedYear
          ? `Covered from ${res.expectedYear} on average: ${goal.months} months of spending and mortgage payments${goal.counts === 'investments' ? ', counting ISAs and investments' : ' in cash'}.`
          : `${goal.counts === 'investments' ? 'Cash and investments are' : 'Your cash buffer is'} short of ${goal.months} months of spending and mortgage payments.`;
      } else if (goal.type === 'debtFree') {
        res.expectedYear = debtFreeYear(proj);
        res.probability = mc.debtFreeByYear[t];
        res.byYear = mc.debtFreeByYear;
        res.summary = res.expectedYear ? `Expected to be paid off in ${res.expectedYear}.` : 'Not paid off within the plan.';
      } else {
        const who = retiree(plan, goal);
        const delta = goal.age - who.retireAge;
        const variant = delta === 0 ? null : shiftRetirement(plan, delta, who.id);
        res.probability = variant ? successRate(variant, runs, seed) : mc.successRate;
        res.expectedYear = plan.startYear + (goal.age - who.age);
        res.summary = `Chance the money lasts to the end of the plan if ${who.name} retires at ${goal.age}${delta === 0 ? ' (as planned)' : ''}.`;
      }
      res.status = statusOf(res.probability);
      return res;
    });
  }

  // ---------------------------------------------------------------- Monte Carlo

  function mulberry32(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6D2B79F5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function makeNormal(rng) {
    let spare = null;
    return function () {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u = 0;
      while (u === 0) u = rng();
      const v = rng();
      const m = Math.sqrt(-2 * Math.log(u));
      spare = m * Math.sin(2 * Math.PI * v);
      return m * Math.cos(2 * Math.PI * v);
    };
  }

  function percentile(sorted, p) {
    const idx = p * (sorted.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  }

  const PCTS = [['p10', 0.10], ['p25', 0.25], ['p50', 0.50], ['p75', 0.75], ['p90', 0.90]];

  function bandsOf(data, runs, T) {
    const b = { p10: [], p25: [], p50: [], p75: [], p90: [] };
    for (let t = 0; t < T; t++) {
      const col = data.slice(t * runs, (t + 1) * runs).sort();
      for (const [k, p] of PCTS) b[k].push(percentile(col, p));
    }
    return b;
  }

  // Each run draws a whole economy: investment returns, inflation, salaries, house prices
  // and interest rates (as switched on in the assumptions). Money series are summarised in
  // both future (nominal) and today's money, deflating each run by its own prices.
  function monteCarlo(plan, runs, seed, opts = {}) {
    const N = horizon(plan), T = N + 1;
    const normal = makeNormal(mulberry32(seed));
    const draw = makeRandomEcon(plan, N, normal);
    const out = newPath(N, false);
    const SERIES = ['liquid', 'netWorth', 'property', 'debt', 'earnings'];
    const data = {};
    for (const k of SERIES) data[k] = new Float64Array(T * runs);
    const price = new Float64Array(T * runs);
    const infl = new Float64Array(T * runs);
    const funded = new Float64Array(T);
    const debtFree = new Float64Array(T);
    const nwGoals = plan.goals.filter(g => g.type === 'netWorth' || g.type === 'passiveIncome');
    const efGoals = plan.goals.filter(g => g.type === 'emergency');
    const hits = {};
    const gvals = {};   // each goal's own measure, every run and year (for its range chart)
    for (const g of nwGoals.concat(efGoals)) { hits[g.id] = new Float64Array(T); gvals[g.id] = new Float64Array(T * runs); }
    const debtPayments = plan.accounts.filter(a => a.type === 'debt' && !a.excluded).reduce((acc, a) => acc + a.payment * 12, 0);
    const failYears = [];
    const snap = { cash: 0, isa: 0, gia: 0, pension: 0, bonds: 0, property: 0, debt: 0, short: 0, locked: 0 };

    for (let i = 0; i < runs; i++) {
      const econ = draw();
      const pre = precompute(plan, econ);
      runPath(plan, pre, out);
      const reached = nwGoals.map(() => false);
      let paid = false;
      for (let t = 0; t < T; t++) {
        const k = t * runs + i;
        for (const key in snap) snap[key] = out[key][t];
        const liquid = out.cash[t] + out.isa[t] + out.gia[t] + out.pension[t] + out.bonds[t] - out.short[t];
        data.liquid[k] = liquid;
        data.netWorth[k] = liquid + out.property[t] - out.debt[t] - out.locked[t];
        data.property[k] = out.property[t];
        data.debt[k] = out.debt[t];
        let e = 0;
        if (t < N) for (const P of pre.people) e += P.gross[t] + P.netPay[t];
        data.earnings[k] = e;
        price[k] = econ.price[t];
        infl[k] = t < N ? econ.infl[t] : econ.infl[N - 1];
        if (out.short[t] <= 0) funded[t] += 1;
        if (!paid && out.debt[t] <= 0.5) paid = true;
        if (paid) debtFree[t] += 1;
        nwGoals.forEach((g, j) => {
          const v = g.type === 'passiveIncome' ? passiveIncome(snap, nonWorkIncome(pre, t), g) : goalValue(snap, g.measure);
          gvals[g.id][k] = v;
          if (!reached[j]) reached[j] = v >= goalTarget(g, econ.price[t]);
          if (reached[j]) hits[g.id][t] += 1;
        });
        for (const g of efGoals) {
          const have = emergencyHave(g, snap);
          gvals[g.id][k] = have;
          if (t < N && have >= emergencyNeed(g, pre, out.debt[t] > 0.5 ? debtPayments : 0, t) - 0.5) hits[g.id][t] += 1;
        }
      }
      if (out.short[N] > 0) {
        let t = 0;
        while (out.short[t] <= 0) t++;
        failYears.push(plan.startYear + t);
      }
    }

    const both = arr => {
      const real = new Float64Array(T * runs);
      for (let j = 0; j < real.length; j++) real[j] = arr[j] / price[j];
      return { nominal: bandsOf(arr, runs, T), real: bandsOf(real, runs, T) };
    };
    const series = {};
    for (const k of SERIES) series[k] = both(data[k]);
    const goalBands = {};
    for (const id in gvals) goalBands[id] = both(gvals[id]);
    const years = [];
    for (let t = 0; t < T; t++) years.push(plan.startYear + t);
    for (const id in hits) hits[id] = Array.from(hits[id], c => c / runs);
    failYears.sort((x, y) => x - y);
    return {
      years, runs, series,
      inflation: bandsOf(infl, runs, T),
      priceIndex: bandsOf(price, runs, T),
      bands: series.liquid.nominal,
      fundedByYear: Array.from(funded, c => c / runs),
      debtFreeByYear: Array.from(debtFree, c => c / runs),
      goalHits: hits,
      goalBands,
      fails: failYears.length,
      successRate: (runs - failYears.length) / runs,
      medianFailYear: failYears.length ? failYears[Math.floor(failYears.length / 2)] : null,
    };
  }

  // Success only, without collecting series (used by solvers and goal checks).
  function successRate(plan, runs, seed) {
    const N = horizon(plan);
    const draw = makeRandomEcon(plan, N, makeNormal(mulberry32(seed)));
    const out = newPath(N, false);
    let ok = 0;
    for (let i = 0; i < runs; i++) {
      runPath(plan, precompute(plan, draw()), out);
      if (out.short[N] <= 0) ok++;
    }
    return ok / runs;
  }

  // Typical range of one income or expense stream (today's and future money).
  function streamBands(plan, item, runs = 400, seed = 7) {
    const N = horizon(plan), T = N + 1;
    const draw = makeRandomEcon(plan, N, makeNormal(mulberry32(seed)));
    const nominal = new Float64Array(T * runs), real = new Float64Array(T * runs);
    for (let i = 0; i < runs; i++) {
      const econ = draw();
      for (let t = 0; t < T; t++) {
        const v = item.fx !== undefined ? incomeAfterCosts(item, plan, t, econ) : (isActive(item, plan, t) ? annual(item) * growthFactor(item, plan, t, econ) : 0);
        nominal[t * runs + i] = v;
        real[t * runs + i] = v / econ.price[t];
      }
    }
    const years = [];
    const expected = [];
    const econ = expectedEcon(plan, N);
    for (let t = 0; t < T; t++) {
      years.push(plan.startYear + t);
      expected.push(item.fx !== undefined ? incomeAfterCosts(item, plan, t, econ) : (isActive(item, plan, t) ? annual(item) * growthFactor(item, plan, t, econ) : 0));
    }
    return { years, expected, price: Array.from(econ.price), nominal: bandsOf(nominal, runs, T), real: bandsOf(real, runs, T) };
  }

  // ---------------------------------------------------------------- solvers & sweeps

  const clonePlan = p => JSON.parse(JSON.stringify(p));

  // Everyone retires `delta` years later (earlier if negative), or only `owner`.
  function shiftRetirement(plan, delta, owner) {
    const p = clonePlan(plan);
    for (const person of p.household.people) if (!owner || person.id === owner) person.retireAge += delta;
    return p;
  }

  // A Lifetime ISA can only buy a first home: not for anyone who already owns one.
  const ownsHome = plan => plan.accounts.some(a => a.type === 'property' && !a.excluded && a.balance > 0);

  // The person a retirement goal is about.
  const retiree = (plan, goal) => plan.household.people.find(x => x.id === goal.owner) || plan.household.people[0];

  // Smallest shift (years, applied to everyone) to retirement ages reaching `target`.
  // Same seed for every candidate (common random numbers) keeps success near-monotonic.
  function solveRetirement(plan, target, runs, seed) {
    const p1 = plan.household.people[0];
    const lo = p1.age - p1.retireAge;
    const hi = Math.min(80, p1.endAge - 1) - p1.retireAge;
    const at = d => successRate(shiftRetirement(plan, d), runs, seed);
    if (at(hi) < target) return { delta: null, success: at(hi) };
    if (at(lo) >= target) return { delta: lo, success: at(lo) };
    let l = lo, h = hi;
    while (h - l > 1) {
      const m = Math.floor((l + h) / 2);
      if (at(m) >= target) h = m; else l = m;
    }
    return { delta: h, success: at(h) };
  }

  function scaleSpending(plan, k) {
    const p = clonePlan(plan);
    for (const e of p.expenses) e.amount *= k;
    if (p.strategy.retireSpending > 0) p.strategy.retireSpending *= k;
    return p;
  }

  // Largest multiple of planned spending that still reaches `target`.
  function solveSpending(plan, target, runs, seed) {
    const ok = k => successRate(scaleSpending(plan, k), runs, seed) >= target;
    if (!ok(0)) return { multiple: null };
    let lo = 0, hi = 1;
    while (ok(hi) && hi < 16) { lo = hi; hi *= 2; }
    if (hi >= 16 && ok(hi)) return { multiple: hi };
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      if (ok(m)) lo = m; else hi = m;
    }
    return { multiple: lo };
  }

  // Annual spending in retirement (today's money) the plan can afford at `target`
  // success if everyone retires `delta` years from plan.
  function solveRetirementSpending(plan, target, runs, seed, delta = 0) {
    const base = delta ? shiftRetirement(plan, delta) : clonePlan(plan);
    const at = v => { const p = clonePlan(base); p.strategy.retireSpending = v; return successRate(p, runs, seed); };
    if (at(1000) < target) return { amount: null };
    let lo = 1000, hi = 20000;
    while (at(hi) >= target && hi < 1e6) { lo = hi; hi *= 2; }
    for (let k = 0; k < 14; k++) {
      const m = (lo + hi) / 2;
      if (at(m) >= target) lo = m; else hi = m;
    }
    return { amount: Math.floor(lo / 100) * 100 };
  }

  // Smallest share of surplus to overpay so the expected projection is debt-free by `year`.
  function solveDebtFree(plan, year) {
    const at = (pct, cap) => {
      const p = clonePlan(plan);
      p.strategy.overpayPct = pct;
      if (cap !== undefined) p.strategy.overpayCapPct = cap;
      return debtFreeYear(project(p));
    };
    const ok = (pct, cap) => { const y = at(pct, cap); return y !== null && y <= year; };
    if (ok(plan.strategy.overpayPct)) return { overpayPct: plan.strategy.overpayPct, capNeeded: false, already: true };
    if (!ok(100)) {
      if (ok(100, 0)) {
        let lo = 0, hi = 100;
        while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (ok(m, 0)) hi = m; else lo = m; }
        return { overpayPct: hi, capNeeded: true };
      }
      return { overpayPct: null, capNeeded: true };
    }
    let lo = 0, hi = 100;
    while (hi - lo > 1) { const m = Math.floor((lo + hi) / 2); if (ok(m)) hi = m; else lo = m; }
    return { overpayPct: hi, capNeeded: false };
  }

  // Monthly spending cut (today's money, before retirement) needed for the expected
  // projection to reach a net worth goal by its year.
  function solveNetWorth(plan, goal) {
    const reaches = pct => {
      const p = clonePlan(plan);
      p.strategy.spendNowPct = pct;
      const y = goalYear(goal, project(p));
      return y !== null && y <= goal.year;
    };
    const now = plan.strategy.spendNowPct;
    if (reaches(now)) return { spendNowPct: now, already: true, monthlyCut: 0 };
    if (!reaches(0)) return { spendNowPct: null };
    let lo = 0, hi = now;
    for (let k = 0; k < 14; k++) { const m = (lo + hi) / 2; if (reaches(m)) lo = m; else hi = m; }
    const yearly = plan.expenses.reduce((acc, e) => acc + streamAt(e, plan, 0), 0);
    return { spendNowPct: lo, monthlyCut: yearly * (now - lo) / 100 / 12 };
  }

  const LEVERS = {
    overpay: {
      label: 'Share of surplus used to overpay the mortgage',
      values: [0, 25, 50, 75, 100],
      format: v => `${v}% overpay`,
      apply: (p, v) => { p.strategy.overpayPct = v; },
    },
    retire: {
      label: 'Retire earlier or later (everyone)',
      values: [-4, -2, 0, 2, 4],
      format: v => (v === 0 ? 'As planned' : `${v > 0 ? '+' : ''}${v} years`),
      apply: (p, v) => { for (const x of p.household.people) x.retireAge += v; },
    },
    spending: {
      label: 'Spending level',
      values: [80, 90, 100, 110, 120],
      format: v => `${v}% spending`,
      apply: (p, v) => { for (const e of p.expenses) e.amount *= v / 100; if (p.strategy.retireSpending > 0) p.strategy.retireSpending *= v / 100; },
    },
    returns: {
      label: 'Stock market returns',
      values: [-2, -1, 0, 1, 2],
      format: v => (v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} pts/yr`),
      apply: (p, v) => { p.assumptions.stockReturn += v; },
    },
    inflation: {
      label: 'Inflation',
      values: [-1, 0, 1, 2, 3],
      format: v => (v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} pts/yr`),
      apply: (p, v) => { p.assumptions.inflation += v; },
    },
    remortgage: {
      label: 'Mortgage rate after the fixed period ends',
      values: [-1, 0, 1, 2, 3],
      format: v => (v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} pts`),
      apply: (p, v) => { for (const a of p.accounts) if (a.type === 'debt') a.rateAfterFix = (a.rateAfterFix === null ? a.rate : a.rateAfterFix) + v; },
    },
    houses: {
      label: 'House price growth',
      values: [-3, -1.5, 0, 1.5, 3],
      format: v => (v === 0 ? 'As assumed' : `${v > 0 ? '+' : ''}${v} pts/yr`),
      apply: (p, v) => { for (const a of p.accounts) if (a.type === 'property') a.rate += v; },
    },
  };

  function variant(plan, lever, v) {
    const p = clonePlan(plan);
    LEVERS[lever].apply(p, v);
    return p;
  }

  // Key numbers for a plan, used by Compare, sweeps and the lever explorer.
  function summarize(plan, runs, seed) {
    const proj = project(plan);
    const mc = monteCarlo(plan, runs, seed);
    const p1 = plan.household.people[0];
    const tr = Math.max(0, Math.min(proj.pre.N, p1.retireAge - p1.age));
    const last = proj.rows[proj.pre.N];
    const nwGoal = plan.goals.find(g => g.type === 'netWorth');
    return {
      proj, mc,
      success: mc.successRate,
      retireYear: plan.startYear + tr,
      retireT: tr,
      liquidAtRetire: proj.rows[tr].liquid / proj.rows[tr].deflator,
      netWorthAtRetire: proj.rows[tr].netWorth / proj.rows[tr].deflator,
      endNetWorth: last.netWorth / last.deflator,
      medianEndLiquid: mc.series.liquid.real.p50[proj.pre.N],
      lifetimeTax: proj.rows.reduce((acc, r) => acc + r.taxes / r.deflator, 0),
      debtFree: proj.rows[0].debt > 0 ? debtFreeYear(proj) : null,
      runsOut: (proj.rows.find(r => r.shortfall > 0) || {}).year || null,
      goalYear: nwGoal ? goalYear(nwGoal, proj) : null,
      monthly: monthlyPlan(proj),
    };
  }

  function sweep(plan, lever, runs, seed) {
    return LEVERS[lever].values.map(v => ({ value: v, label: LEVERS[lever].format(v), plan: variant(plan, lever, v), summary: summarize(variant(plan, lever, v), runs, seed) }));
  }

  // ---------------------------------------------------------------- check-ins

  function makeCheckin(plan, scenarioName, date) {
    const proj = project(plan);
    const r0 = proj.rows[0];
    const actual = {};
    for (const k of ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt', 'netWorth', 'liquid', 'spending']) actual[k] = r0[k];
    return normalizeCheckin({
      id: uid(),
      date: date || new Date().toISOString().slice(0, 10),
      year: plan.startYear,
      scenarioName,
      actual,
      predicted: {
        years: proj.rows.map(r => r.year),
        netWorth: proj.rows.map(r => r.netWorth),
        liquid: proj.rows.map(r => r.liquid),
        byType: Object.fromEntries(CHECKIN_TYPES.map(k => [k, proj.rows.map(r => r[k])])),
      },
      monthlyInvest: monthlyPlan(proj).invest,
    });
  }

  const CHECKIN_TYPES = ['cash', 'isa', 'gia', 'pension', 'bonds', 'property', 'debt'];

  function checkinReview(checkins) {
    const sorted = checkins.slice().sort((a, b) => a.date.localeCompare(b.date));
    return sorted.map((c, i) => {
      const prev = sorted.slice(0, i).reverse().find(x => x.predicted.years.includes(c.year));
      if (!prev) return { checkin: c, predicted: null, diff: null, pct: null, from: null };
      const k = prev.predicted.years.indexOf(c.year);
      const predicted = prev.predicted.netWorth[k];
      const diff = c.actual.netWorth - predicted;
      return { checkin: c, predicted, diff, pct: predicted ? diff / Math.abs(predicted) : null, from: prev };
    });
  }

  // Move the plan forward by `years`: everyone older, past events dropped.
  function rollForward(plan, years = 1) {
    const p = clonePlan(plan);
    p.startYear += years;
    for (const person of p.household.people) person.age += years;
    p.events = p.events.filter(e => e.year >= p.startYear);
    for (const a of p.accounts) {
      if (a.type === 'bonds' && a.maturityYear && a.maturityYear < p.startYear) a.balance = 0;
      if (a.type === 'property' && a.sellYear && a.sellYear < p.startYear) a.balance = 0;
    }
    return p;
  }

  // ---------------------------------------------------------------- exports

  const api = {
    R, ACCOUNT_TYPES, OWNED_TYPES, GOAL_TYPES, INCOME_KINDS, TAX_TREATMENTS, FLOW_KEYS, LEVERS, GOAL_MEASURES, BASIC_RELIEF,
    incomeAfterCosts, taxOf, dbPensionAt, dbEarly, nonWorkIncome, passiveIncome, estimateDb, renewalPayment, emergencyNeed, emergencyHave, emergencyYear, solveEmergency,
    uid, currentYear, todayISO, isDate, asOfDate, reservesAt, RESERVE_KINDS, RESERVE_ACCOUNTS, lastSeptember, defaultPlan, defaultWorkspace, defaultAssumptions, defaultStrategy, defaultGoals,
    normalizePlan, normalizeWorkspace, normalizeCheckin, normalizeGoal, validatePlan,
    streamAt, streamWindow, isActive, growthFactor, pensionContrib, thresholdFactor, stockWeight, horizon, personIndex,
    expectedEcon, makeRandomEcon, precompute, runPath, newPath, project, monthlyPlan, milestones,
    goalValue, goalTarget, goalYear, debtFreeYear, goalTitle, autoTitle, evaluateGoals, statusOf, assignGoalColours, GOAL_ICONS, crashAt,
    monteCarlo, successRate, streamBands, historicalEcon, historicalRuns,
    solveRetirement, solveSpending, solveRetirementSpending, solveDebtFree, solveNetWorth,
    shiftRetirement, retiree, ownsHome, scaleSpending, variant, summarize, sweep,
    makeCheckin, checkinReview, rollForward,
    mulberry32, makeNormal, lognormal, percentile, clonePlan, grossUp,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Engine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
