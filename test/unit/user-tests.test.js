'use strict';

// Fixes from the first round of "pretend user" tests (a single parent with an NHS pension and a
// credit card; a self-employed renter family buying a home with help from parents).

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const R = require('../../src/uk-rules');
const B = require('../../src/benchmarks');
const LW = require('../../src/life-wizard');

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

function nurse(extra = {}) {
  return E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Morag', age: 41, retireAge: 60 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 2000 }, ...(extra.accounts || [])],
    income: [
      { name: 'NHS pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 39500, freq: 'year', growth: 3, pensionMode: 'pct', employeePension: 9.8, employerPension: 22.5, ...(extra.pay || {}) },
      { name: 'NHS pension', kind: 'dbpension', owner: 'p1', tax: 'uk', amount: 9200, dbAccrual: 730, startAge: 67, dbScheme: 'nhs', freq: 'year' },
    ],
    expenses: [{ name: 'Living', amount: 1900, freq: 'month' }], events: [], goals: [],
  });
}

test('contributions into a defined benefit scheme come off pay but build no pension pot', () => {
  const pot = E.precompute(nurse()).people[0];
  const db = E.precompute(nurse({ pay: { pensionTo: 'db' } })).people[0];
  assert.ok(pot.contrib[0] > 10000, 'into a pot by default');
  assert.equal(db.contrib[0], 0);
  // Pay before tax is still reduced by her share, with tax relief, either way.
  near(db.employee[0], 39500 * 0.098, 1);
  near(db.taxable[0], pot.taxable[0], 0.01);
  // A defined benefit pension, pot contributions and no pot: flagged.
  assert.ok(E.validatePlan(nurse()).some(w => /count twice/.test(w)));
  assert.ok(!E.validatePlan(nurse({ pay: { pensionTo: 'db' } })).some(w => /count twice/.test(w)));
});

test('expensive debt is cleared from any surplus before saving, and flagged', () => {
  const p = nurse({ pay: { pensionTo: 'db' }, accounts: [{ id: 'card', name: 'Credit card', type: 'debt', balance: 3400, rate: 22.9, payment: 150 }] });
  const pr = E.project(p);
  assert.ok(pr.rows[0].hiDebtPay > 0);
  assert.equal(pr.rows[1].debt, 0);
  assert.ok(E.monthlyPlan(pr).hiDebt > 0);
  const tip = B.insights(p, pr).find(i => i.id === 'dear-debt');
  assert.match(tip.title, /22.9%/);
  // A mortgage at 4% is not.
  const q = nurse({ accounts: [{ type: 'debt', balance: 90000, rate: 4, payment: 600 }] });
  assert.equal(E.project(q).rows[0].hiDebtPay, 0);
});

test('a loan can be written off in a year, and a lump sum can go to a chosen loan', () => {
  const p = E.normalizePlan({
    startYear: 2026, household: { region: 'ruk', people: [{ name: 'Dan', age: 34, retireAge: 67 }] },
    accounts: [
      { id: 'mum', name: 'Loan from parents', type: 'debt', balance: 15000, rate: 0, payment: 250, forgiveYear: 2029 },
      { id: 'mort', name: 'Mortgage', type: 'debt', balance: 100000, rate: 5, payment: 700 },
      { type: 'cash', balance: 30000 },
    ],
    income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 45000, freq: 'year' }], expenses: [],
    events: [{ name: 'Pay back parents', kind: 'overpay', year: 2027, amount: 2000, debtId: 'mum' }], goals: [],
  });
  assert.equal(p.accounts[0].forgiveYear, 2029);
  assert.equal(p.events[0].debtId, 'mum');
  const pr = E.project(p);
  const mumAt = t => pr.out.debts.find(d => d.id === 'mum').bal[t];
  // 2027: £3,000 of payments plus the £2,000 lump sum (in 2027 pounds) off the family loan.
  near(mumAt(1) - mumAt(2), 3000 + 2000 * (1 + p.assumptions.inflation / 100), 1);
  assert.ok(pr.rows[3].debtForgiven > 0);
  assert.equal(mumAt(4), 0);
});

test('account tables add up in the year a home is bought and a Lifetime ISA is used', () => {
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01', household: { region: 'ruk', people: [{ name: 'Priya', age: 32, retireAge: 67 }] },
    accounts: [{ type: 'cash', balance: 20000 }, { type: 'lisa', owner: 'p1', balance: 7500, purpose: 'home', contribution: 0 },
      { type: 'property', balance: 250000, rate: 3, buyYear: 2029, deposit: 10 }],
    income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 60000, freq: 'year' }], expenses: [], events: [], goals: [],
  });
  const pr = E.project(p);
  const t = 3, r = pr.rows[t], n = pr.rows[t + 1];
  near(r.property + r.gProperty + r.propBought - r.propSold, n.property, 1);
  near(r.debt + r.debtInterest + r.debtNew - r.debtRegular - r.overpay - r.lumpOverpay - r.hiDebtPay - r.debtForgiven, n.debt, 1);
  near(r.cash + r.gCash + r.toCash + r.bondsMatured + r.lisaHome - r.wCash - r.sweepIsa - r.sweepGia, n.cash, 1);
  // Someone who rents and will buy later does not own a home yet (Lifetime ISA advice).
  assert.equal(E.ownsHome(p), false);
});

test('an income that varies swings in the simulations but not on average', () => {
  const mk = vary => E.normalizePlan({
    startYear: 2026, household: { region: 'ruk', people: [{ name: 'Dan', age: 34, retireAge: 67 }] },
    accounts: [], income: [{ id: 'biz', kind: 'self', owner: 'p1', tax: 'uk', amount: 45000, freq: 'year', inflationLinked: true, vary }], expenses: [], events: [], goals: [],
  });
  const p = mk(15), q = mk(0);
  near(E.incomeAfterCosts(p.income[0], p, 3), E.incomeAfterCosts(q.income[0], q, 3), 0.01);
  const draw = E.makeRandomEcon(p, 10, E.makeNormal(E.mulberry32(1)));
  const vals = [];
  for (let k = 0; k < 40; k++) vals.push(E.incomeAfterCosts(p.income[0], p, 2, draw()));
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length);
  assert.ok(sd / mean > 0.08 && sd / mean < 0.3, `swings about 15%: ${sd / mean}`);
  // Plans without one keep exactly the same simulated futures as before.
  assert.equal(E.makeRandomEcon(q, 10, E.makeNormal(E.mulberry32(1)))().noise, undefined);
});

test('money already put aside for a known cost counts as held from the start', () => {
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01', household: { people: [{ age: 34 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 14000 }],
    events: [{ name: 'Tax bill', kind: 'expense', year: 2027, amount: 6000 }],
    reserves: [{ kind: 'saving', eventName: 'Tax bill', accountId: 'bank', saved: 6000 }],
  });
  const [r] = E.reservesAt(p, 0);
  near(r.held, 6000, 0.01);
  assert.ok(r.perYear < 1000, 'little left to build up');
});

test('advice: no inheritance tax alarm for a young family; Lifetime ISA for a first home when renting', () => {
  const young = E.normalizePlan({
    startYear: 2026, household: { region: 'ruk', people: [{ name: 'Dan', age: 34, retireAge: 67 }, { name: 'Priya', age: 32, retireAge: 67 }] },
    accounts: [{ type: 'cash', balance: 14000 }], income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 80000, freq: 'year', growth: 4 }],
    expenses: [{ name: 'Living', amount: 1500, freq: 'month' }], events: [], goals: [],
    life: { children: [{ name: 'Zara', age: 1 }] },
  });
  const ins = B.insights(young, E.project(young));
  assert.equal(ins.some(i => i.id === 'iht'), false);
  const lisa = ins.find(i => i.id === 'lisa');
  assert.ok(lisa && /first home/.test(lisa.text) && !/already own/.test(lisa.text));
});

test('future costs: amounts scale with income and university follows the region', () => {
  const mk = (region, pay) => E.normalizePlan({ startYear: 2026, household: { region, people: [{ age: 41 }] }, accounts: [], income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: pay, freq: 'year' }], expenses: [], events: [], goals: [] });
  const low = LW.defaults(mk('ruk', 30000)), high = LW.defaults(mk('scotland', 120000));
  assert.equal(low.uniYears, 3);
  assert.equal(high.uniYears, 4);
  assert.ok(low.carCost < high.carCost && low.schoolCost < high.schoolCost);
  assert.equal(high.carCost, 20000);
});

test('defined benefit schemes are cut when taken early, roughly 5% a year', () => {
  const p = nurse({ pay: { pensionTo: 'db' } });
  const db = p.income.find(i => i.kind === 'dbpension');
  const x = p.household.people[0];
  assert.equal(E.dbEarly({ ...db, startAge: 68 }, x).factor, 1);
  assert.equal(x.statePensionAge - 60, 8);
  near(E.dbEarly({ ...db, startAge: 60 }, x).factor, 0.675, 1e-9);
  assert.ok(R.DB_SCHEMES.civil && R.DB_SCHEMES.other.early);
});

test('each pension account shows its owner\'s own pot, not a share of the household total', () => {
  const RV = require('../../src/review');
  // One partner pays a lot into a big pot; the other pays a little into a small new one.
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ id: 'p1', name: 'Sam', age: 40, retireAge: 60 }, { id: 'p2', name: 'Alex', age: 40, retireAge: 60 }] },
    accounts: [
      { id: 'big', type: 'pension', owner: 'p1', balance: 80000 },
      { id: 'small', type: 'pension', owner: 'p2', balance: 1000 },
    ],
    income: [
      { kind: 'salary', owner: 'p1', tax: 'uk', amount: 90000, freq: 'year', pensionMode: 'fixed', employeePension: 2000, employerPension: 100, sacrifice: true },
      { kind: 'salary', owner: 'p2', tax: 'uk', amount: 45000, freq: 'year', pensionMode: 'fixed', employeePension: 180, employerPension: 40, sacrifice: true },
    ],
    expenses: [], events: [], goals: [],
  });
  const pr = E.project(p);
  const t = 10, est = RV.estimateAt(p, '2036-01-01', pr);
  near(est.byId.big, pr.out.persons[0].pension[t], 1);
  near(est.byId.small, pr.out.persons[1].pension[t], 1);
  // Splitting by starting balance would have given the small pot about 1.2% of the total.
  assert.ok(est.byId.small > 0.05 * pr.rows[t].pension);
  near(est.byId.big + est.byId.small, pr.rows[t].pension, 1);
});

test('looking ahead, homes, loans, bonds and Lifetime ISAs each show their own value', () => {
  const RV = require('../../src/review');
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ id: 'p1', name: 'Sam', age: 30, retireAge: 65 }, { id: 'p2', name: 'Alex', age: 30, retireAge: 65 }] },
    accounts: [
      { id: 'cash', type: 'cash', balance: 60000 },
      { id: 'slow', type: 'property', balance: 300000, rate: 2 },
      { id: 'fast', type: 'property', balance: 200000, rate: 6 },
      { id: 'sold', type: 'property', balance: 100000, rate: 3, sellYear: 2030 },
      { id: 'later', type: 'property', balance: 250000, rate: 3, buyYear: 2029, deposit: 20, mortRate: 4, mortYears: 25 },
      { id: 'mort', type: 'debt', balance: 200000, rate: 4, payment: 1200 },
      { id: 'car', type: 'debt', balance: 9000, rate: 7, payment: 400 },
      { id: 'g1', type: 'bonds', balance: 10000, rate: 4, maturityYear: 2028 },
      { id: 'g2', type: 'bonds', balance: 10000, rate: 4, maturityYear: 2040 },
      { id: 'l1', type: 'lisa', owner: 'p1', balance: 5000, contribution: 4000, purpose: 'retirement' },
      { id: 'l2', type: 'lisa', owner: 'p2', balance: 5000, contribution: 0, purpose: 'retirement' },
    ],
    income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 70000, freq: 'year' }, { kind: 'salary', owner: 'p2', tax: 'uk', amount: 50000, freq: 'year' }],
    expenses: [{ name: 'Living', amount: 2500, freq: 'month' }], events: [], goals: [],
  });
  const pr = E.project(p);
  const t = 6, b = RV.expectedBalances(p, t, pr).byId, own = id => pr.out.byAccount[id][t];
  near(b.slow, 300000 * 1.02 ** t, 1);
  near(b.fast, 200000 * 1.06 ** t, 1);
  assert.equal(b.sold, 0);
  near(b.later, own('later'), 1);
  near(b.car, pr.out.debts.find(d => d.id === 'car').bal[t], 1);
  near(b.mort, pr.out.debts.find(d => d.id === 'mort').bal[t], 1);
  assert.equal(b.g1, 0);
  near(b.g2, own('g2'), 1);
  assert.ok(b.l1 > b.l2 + 20000, 'the one paid into is bigger');
  // The mortgage on the home bought in 2029 has no account yet: shown as expected, not added to the others.
  const miss = RV.expectedBalances(p, t, pr).missing.find(m => m.type === 'debt');
  near(miss.value, pr.out.debts.find(d => d.id === 'later:mortgage').bal[t], 1);
  // Each type still adds up to the projection.
  near(b.slow + b.fast + b.sold + b.later, pr.rows[t].property, 1);
  near(b.mort + b.car + miss.value, pr.rows[t].debt, 1);
});

test('each ISA and general account is followed on its own, each person paying into their own', () => {
  const RV = require('../../src/review');
  const base = (accounts, strategy = {}) => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ id: 'p1', name: 'Sam', age: 40, retireAge: 67 }, { id: 'p2', name: 'Alex', age: 40, retireAge: 67 }] },
    accounts: [{ id: 'cash', type: 'cash', balance: 10000 }, ...accounts],
    income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 90000, freq: 'year' }, { kind: 'salary', owner: 'p2', tax: 'uk', amount: 80000, freq: 'year' }],
    expenses: [{ name: 'Living', amount: 3000, freq: 'month' }], events: [], goals: [], strategy,
  });
  // Automatic: each person's allowance goes into their own ISA, so a small ISA catches up.
  let p = base([{ id: 'big', type: 'isa', owner: 'p1', balance: 100000 }, { id: 'small', type: 'isa', owner: 'p2', balance: 1000 }]);
  let pr = E.project(p), own = (id, t) => pr.out.byAccount[id][t];
  const r0 = pr.rows[0], g = 1 + r0.gIsa / (100000 + 1000);
  near(own('small', 1), 1000 * g + r0.toIsa / 2, 1);
  near(own('big', 1), 100000 * g + r0.toIsa / 2, 1);
  let b = RV.expectedBalances(p, 5, pr);
  near(b.byId.big + b.byId.small, pr.rows[5].isa, 1);
  near(b.byId.small, own('small', 5), 1);
  // Money beyond the ISAs goes to a general account for each person, evenly.
  assert.ok(pr.rows[0].toGia > 1000, 'the ISAs fill up');
  near(own('new:gia:p1', 3), own('new:gia:p2', 3), 1);
  const miss = b.missing.filter(m => m.type === 'gia');
  assert.deepEqual(miss.map(m => m.owner).sort(), ['p1', 'p2']);
  near(miss.reduce((s, m) => s + m.value, 0), pr.rows[5].gia, 1);

  // Your own amounts: each ISA gets its own.
  p = base([{ id: 'a', type: 'isa', owner: 'p1', balance: 0, monthly: 500 }, { id: 'c', type: 'isa', owner: 'p2', balance: 0, monthly: 100 }]);
  pr = E.project(p);
  near(pr.out.byAccount.a[1], 5 * pr.out.byAccount.c[1], 1);

  // Only one person has an ISA: the other's allowance goes to an ISA they have yet to open.
  p = base([{ id: 'only', type: 'isa', owner: 'p1', balance: 5000 }]);
  pr = E.project(p);
  b = RV.expectedBalances(p, 3, pr);
  const theirs = b.missing.find(m => m.type === 'isa');
  assert.equal(theirs.owner, 'p2');
  near(b.byId.only + theirs.value, pr.rows[3].isa, 1);
  // The yearly review opens it in their name.
  const ws = E.normalizeWorkspace({ scenarios: [{ id: 's', name: 'Plan', plan: p }], activeId: 's' });
  const d = RV.start(ws, { date: '2029-01-01', year: 2029 });
  const opened = d.plan.accounts.find(a => a.type === 'isa' && a.owner === 'p2');
  assert.equal(opened.name, 'Alex stocks & shares ISA');

  // A joint general account takes both people's money; the projection is as before for it.
  p = base([{ id: 'j', type: 'gia', owner: 'joint', balance: 20000, basis: 10000 }]);
  pr = E.project(p);
  assert.equal(pr.out.byAccount['new:gia:p1'], undefined);
  near(pr.out.byAccount.j[4], pr.rows[4].gia, 0.01);
});

test('a general account’s gains are taxed as its owner’s', () => {
  // Retired couple living off a general account: Sam's holds the gain, Alex's none.
  const plan = (samBasis, alexBasis) => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ id: 'p1', name: 'Sam', age: 70, retireAge: 60 }, { id: 'p2', name: 'Alex', age: 70, retireAge: 60 }] },
    accounts: [{ id: 's', type: 'gia', owner: 'p1', balance: 200000, basis: samBasis }, { id: 'a', type: 'gia', owner: 'p2', balance: 200000, basis: alexBasis }],
    income: [], expenses: [{ name: 'Living', amount: 3000, freq: 'month' }], events: [], goals: [],
  });
  const lopsided = E.project(plan(0, 200000)).rows[0].cgt;
  const even = E.project(plan(100000, 100000)).rows[0].cgt;
  // The same gain overall, but all of it in one name uses one annual exempt amount, not two.
  assert.ok(lopsided > even + 100, `${lopsided} vs ${even}`);
});

test('pay in a defined benefit scheme can also pay into a pot, with the NI cap across both', () => {
  // A lecturer: 6.1% into the scheme, The Match (1% + 1%) and £100 a month more into a pot.
  const plan = extra => E.normalizePlan({
    startYear: 2028, asOf: '2028-01-01',
    household: { region: 'scotland', people: [{ name: 'Morven', age: 40, retireAge: 66 }] },
    accounts: [{ id: 'ib', type: 'pension', owner: 'p1', balance: 1000 }],
    income: [
      { name: 'University pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 50000, freq: 'year', growth: 0, pensionMode: 'pct', employeePension: 6.1, employerPension: 14.5, sacrifice: true, pensionTo: 'db', ...extra },
      { name: 'USS pension', kind: 'dbpension', owner: 'p1', tax: 'uk', amount: 4000, dbAccrual: 667, startAge: 68, freq: 'year' },
    ],
    expenses: [{ name: 'Living', amount: 1500, freq: 'month' }], events: [], goals: [],
  });
  const P = E.precompute(plan({ potMode: 'pct', potEmployee: 1, potEmployer: 1 })).people[0];
  near(P.employee[0], 50000 * 0.071, 0.01);        // both come off pay
  near(P.contrib[0], 50000 * 0.02, 0.01);          // only the pot's builds the pot
  near(P.taxable[0], 50000 * 0.929, 0.01);
  const F = E.precompute(plan({ potMode: 'fixed', potEmployee: 141, potEmployer: 41 })).people[0];
  near(F.contrib[0], (141 + 41) * 12, 0.01);
  // 2028: all sacrifice is free of NI. From April 2029, £2,000 of it across both, not £2,000 each.
  const none = E.precompute(plan({ sacrifice: false })).people[0];
  const ni = (x, t) => x.ni[t];
  near(none.ni[0] - ni(F, 0), 0.08 * (3050 + 141 * 12), 1);
  near(none.ni[1] - ni(F, 1), 0.08 * 2000, 1);
  // More salary sacrifice for this pay goes into the pot, not the scheme.
  const SI = require('../../src/scenario-ideas');
  const q = plan({ potMode: 'fixed', potEmployee: 141, potEmployer: 41 });
  SI.sacrificeMore(q, 'p1', 1200);
  assert.equal(q.income[0].employeePension, 6.1);
  near(q.income[0].potEmployee, 241, 0.01);
});

test('a big pension is drawn at the basic rate before ISAs; a small one is not hurried', () => {
  // Retired at 60 in Scotland, State Pension at 67, spending £60k a year.
  const plan = pot => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Iain', age: 60, retireAge: 60, statePensionAge: 67 }] },
    accounts: [{ id: 'pen', type: 'pension', owner: 'p1', balance: pot }, { id: 'isa', type: 'isa', owner: 'p1', balance: 400000 }],
    income: [], expenses: [{ name: 'Living', amount: 5000, freq: 'month' }], events: [], goals: [],
  });
  const big = E.project(plan(1500000)).rows[0];
  // Taxable income goes up to the top of the 21% band (£43,662), then ISAs pay the rest.
  near(big.persons[0].taxable, 43662, 2);
  assert.ok(big.wIsa > 0 && big.wIsa < 15000, `ISA ${big.wIsa}`);
  const small = E.project(plan(150000)).rows[0];
  // A pot that spreads to about £8k a year: only the tax-free allowance's worth, ISAs the rest.
  near(small.persons[0].taxable, 12570, 2);
  assert.ok(small.wIsa > 40000);
});

test('a cash ISA earns the cash rate and counts as cash for an emergency fund', () => {
  const plan = holding => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Eileen', age: 72, retireAge: 60, statePensionAge: 66 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 4000 }, { id: 'ci', type: 'isa', owner: 'p1', balance: 38000, holding }],
    income: [{ name: 'State Pension', kind: 'other', owner: 'p1', tax: 'uk', amount: 30000, freq: 'year' }],
    expenses: [{ name: 'Living', amount: 1600, freq: 'month' }], events: [],
    goals: [{ id: 'ef', type: 'emergency', months: 6, counts: 'cash', year: 2027, confidence: 80 }],
  });
  const cashIsa = E.project(plan('cash')), invested = E.project(plan('invested'));
  const cr = plan('cash').assumptions.cashRate / 100;
  near(cashIsa.rows[0].gIsa, 38000 * cr, 0.5);   // the year's growth: the cash rate
  assert.notEqual(Math.round(invested.rows[0].gIsa), Math.round(cashIsa.rows[0].gIsa));
  assert.equal(cashIsa.rows[0].cashIsa, 38000);
  // Six months of spending (£9,600) is covered by the cash ISA, not by £4,000 in the bank alone.
  const g = plan('cash').goals[0];
  assert.ok(E.emergencyHave(g, cashIsa.rows[0]) >= 42000 - 1);
  assert.equal(E.emergencyHave(g, invested.rows[0]), 4000);
});

test('a pension inherited from someone who died before 75 is drawn tax-free, at any age', () => {
  const plan = inherited => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Eileen', age: 52, retireAge: 50, statePensionAge: 67 }] },
    accounts: [{ id: 'pot', type: 'pension', owner: 'p1', balance: 85000, inherited }, { id: 'isa', type: 'isa', owner: 'p1', balance: 50000 }],
    income: [{ name: 'Survivor pension', kind: 'other', owner: 'p1', tax: 'uk', amount: 20000, freq: 'year' }],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month' }], events: [], goals: [],
  });
  const r = E.project(plan(true)).rows[0];
  // At 52 (before the minimum pension age) it is drawn, with no tax, before the ISA.
  assert.ok(r.wPension > 5000, `drawn ${r.wPension}`);
  near(r.withdrawTax, 0, 0.01);
  near(r.wIsa, 0, 0.01);
  // Her own pension (not inherited) can't be touched until 57: the ISA pays.
  const own = E.project(plan(false)).rows[0];
  near(own.wPension, 0, 0.01);
  assert.ok(own.wIsa > 5000);
  // Looking ahead it is its own account.
  const RV = require('../../src/review');
  const p = plan(true), pr = E.project(p);
  near(RV.expectedBalances(p, 3, pr).byId.pot, pr.out.byAccount.pot[3], 1);
});

test('already retired: no advice for workers, a pension in payment is not cut, the estate is shown', () => {
  const B = require('../../src/benchmarks');
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Eileen', age: 72, retireAge: 72, statePensionAge: 66 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 4000 }, { id: 'home', type: 'property', balance: 240000, rate: 3 }],
    income: [
      { name: 'Council pension', kind: 'dbpension', owner: 'p1', tax: 'uk', amount: 8400, dbScheme: 'uss', startAge: 60, freq: 'year' },
    ],
    expenses: [{ name: 'Living', amount: 1600, freq: 'month' }], events: [], goals: [],
  });
  // Paid since 60: what it pays now, not cut by early retirement factors.
  assert.equal(E.dbEarly(p.income[0], p.household.people[0]).factor, 1);
  near(E.incomeAfterCosts(p.income[0], p, 0), 8400, 1);
  const ids = B.insights ? B.insights(p, E.project(p)).map(i => i.id) : null;
  if (ids) {
    assert.ok(!ids.includes('saving-rate'), 'no "you keep x% of take-home pay" in retirement');
    assert.ok(ids.includes('iht'), 'what she would leave');
  }
});

test('stopping work before State Pension age leaves NI years out, unless voluntary NI fills them', () => {
  const plan = extra => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Morven', age: 38, retireAge: 57, statePensionAge: 68, niYears: 10, ...extra }] },
    accounts: [{ id: 'isa', type: 'isa', owner: 'p1', balance: 100000 }], income: [],
    expenses: [{ name: 'Living', amount: 1000, freq: 'month' }], events: [], goals: [],
  });
  // 10 years so far + 19 to 57 = 29 of the 35 the forecast assumes.
  const y = E.spYears(plan({}).household.people[0]);
  assert.equal(y.forecast, 35); assert.equal(y.projected, 29);
  const sp = t => E.precompute(plan(t)).people[0].statePension[30];
  const full = E.precompute(plan({ niYears: null })).people[0].statePension[30];
  near(sp({}), full * 29 / 35, 1);
  // Voluntary Class 3 from 57 buys the 6 years back, at about £923 a year for 6 years.
  near(sp({ niVoluntary: true }), full, 1);
  const pre = E.precompute(plan({ niVoluntary: true }));
  assert.ok(pre.eventsOut[19] > 900 && pre.eventsOut[24] > 900 && pre.eventsOut[25] === 0 && pre.eventsOut[18] === 0, 'paid at 57–62 only');
  // Fewer than 10 years: none at all.
  assert.equal(E.spYears(plan({ niYears: 0, retireAge: 45 }).household.people[0]).share, 0);
});

test('a bonus is taxed like pay with no pension on it; share awards kept go into their account', () => {
  const B = require('../../src/benchmarks');
  const plan = pay => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ravi', age: 44, retireAge: 60 }] },
    accounts: [{ id: 'gia', type: 'gia', owner: 'p1', balance: 60000, basis: 40000 }, { id: 'isa', type: 'isa', owner: 'p1', balance: 95000 }],
    income: [{ id: 'pay', name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 135000, freq: 'year', growth: 0, pensionMode: 'pct', employeePension: 5, employerPension: 8, ...pay }],
    expenses: [{ name: 'Living', amount: 5500, freq: 'month' }], events: [], goals: [],
  });
  const base = E.precompute(plan({})).people[0];
  const bonus = E.precompute(plan({ bonus: 20000 })).people[0];
  near(bonus.gross[0] - base.gross[0], 20000, 0.01);
  near(bonus.contrib[0], base.contrib[0], 0.01);     // no pension on the bonus
  // Share awards kept: taxed like pay, what is left goes into the general account.
  const kept = E.project(plan({ shares: 25000, sharesTo: 'gia' }));
  const sold = E.project(plan({ shares: 25000, sharesTo: 'sell' }));
  const k = kept.rows[0].sharesKept;
  assert.ok(k > 25000 * 0.45 && k < 25000 * 0.6, `kept ${k}`);   // 45% tax + 2% NI over £125k... about half
  assert.ok(kept.out.byAccount.gia[1] > sold.out.byAccount.gia[1] + k * 0.9);
  // And the warning about one company.
  const ids = B.insights(plan({ shares: 25000, sharesTo: 'gia' }), kept).map(i => i.id);
  assert.ok(ids.includes('one-company'));
});

test('private school from a child’s age, shown in the child’s ages', () => {
  const LWm = require('../../src/life-wizard');
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ravi', age: 44, retireAge: 60 }] },
    accounts: [], income: [], expenses: [], events: [], goals: [],
  });
  const a = { ...LWm.defaults(p), children: [{ name: 'Maya', age: 6 }, { name: 'Leo', age: 3 }], privateFee: 22000, privateFrom: 11 };
  const q = LWm.apply(p, a);
  const maya = q.expenses.find(e => e.key === 'life:private-0'), leo = q.expenses.find(e => e.key === 'life:private-1');
  assert.equal(maya.startAge, 44 + 5); assert.equal(maya.endAge, 44 + 12);
  assert.equal(leo.startAge, 44 + 8); assert.equal(leo.endAge, 44 + 15);
  assert.equal(maya.amount, 22000);
});

test('a cost can start and stop part-way through a year', () => {
  const plan = e => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ravi', age: 44, retireAge: 60 }] },
    accounts: [], income: [], events: [], goals: [],
    expenses: [{ name: 'Nursery', amount: 1500, freq: 'month', inflationLinked: false, growth: 0, startRef: 'now', endRef: 'year', toYear: 2027, ...e }],
  });
  const at = (p, t) => E.streamAt(p.expenses[0], p, t);
  // To the end of August 2027: 8 months that year.
  let p = plan({ toMonth: 8 });
  near(at(p, 0), 18000, 0.01); near(at(p, 1), 12000, 0.01); near(at(p, 2), 0, 0.01);
  // Without a month, 2027 isn't paid at all (as before).
  p = plan({});
  near(at(p, 1), 0, 0.01);
  // After-school club from September 2027: 4 months that year.
  p = plan({ startRef: 'year', fromYear: 2027, fromMonth: 9, endRef: 'end', amount: 400 });
  near(at(p, 0), 0, 0.01); near(at(p, 1), 1600, 0.01); near(at(p, 2), 4800, 0.01);
});

test('equity release: a lump sum from the home, rolled-up interest repaid from the sale, never more than the home', () => {
  const plan = extra => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Eileen', age: 72, retireAge: 72, endAge: 95 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 4000 }, { id: 'home', type: 'property', balance: 240000, rate: 3, releaseYear: 2028, releaseAmount: 60000, releaseRate: 6.5, ...extra }],
    income: [], expenses: [{ name: 'Living', amount: 1000, freq: 'month' }], events: [], goals: [],
  });
  const pr = E.project(plan({}));
  const owed = id => pr.out.debts.find(d => d.id === id).bal;
  const price2028 = Math.pow(1 + plan({}).assumptions.inflation / 100, 2);
  near(owed('home:release')[3], 60000 * price2028 * 1.065, 1);   // rolled up a year
  assert.ok(pr.rows[2].debtNew > 60000);                        // taken out in 2028
  // Sold in 2040: repaid from the sale first.
  const sold = E.project(plan({ sellYear: 2040 }));
  assert.equal(sold.out.debts.find(d => d.id === 'home:release').bal[15], 0);
  // A big release at a high rate stops at the home's value.
  const big = E.project(plan({ releaseAmount: 200000, releaseRate: 12 }));
  const end = big.rows.length - 1;
  assert.ok(big.out.debts.find(d => d.id === 'home:release').bal[end] <= big.rows[end].property + 1);
});

test('keep income under £60,000: the pay above it is sacrificed as pay rises', () => {
  const plan = line => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Iain', age: 40, retireAge: 60 }] },
    accounts: [{ id: 'pen', type: 'pension', owner: 'p1', balance: 50000 }],
    income: [{ name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 90000, freq: 'year', growth: 3, pensionMode: 'fixed', employeePension: 2500, employerPension: 100, sacrifice: true }],
    expenses: [{ name: 'Living', amount: 2500, freq: 'month' }], events: [], goals: [],
    strategy: { stayUnderLine: line },
  });
  const off = E.precompute(plan(0)).people[0], on = E.precompute(plan(60000)).people[0];
  assert.ok(off.taxable[5] > 64000, `drifts up without it: ${off.taxable[5]}`);
  near(on.taxable[5], 60000, 1);                       // thresholds frozen to 2031: £60,000
  assert.ok(on.contrib[5] > off.contrib[5] + 4000);    // the extra goes into the pension
  // The older switch still means £100,000.
  assert.equal(E.stayUnderLine({ stayUnder100k: true, stayUnderLine: 0 }), 100000);
});

// ---- Review of 2026-11-13: bugs found by loading the round-2 households again

test('spending that starts or stops part-way through a year counts only the months paid', () => {
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ada', age: 40, retireAge: 60 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 20000 }], income: [], events: [], goals: [],
    assumptions: { inflation: 0 },
    expenses: [
      { name: 'Nursery', amount: 1500, freq: 'month', endRef: 'year', toYear: 2027, toMonth: 8 },
      { name: 'Club', amount: 400, freq: 'month', startRef: 'year', fromYear: 2027, fromMonth: 9, endRef: 'year', toYear: 2030 },
    ],
  });
  const pre = E.precompute(plan);
  near(pre.expenses[0], 18000);                 // nursery all year
  near(pre.expenses[1], 8 * 1500 + 4 * 400);    // to the end of August, then the club from September
  near(pre.expenses[2], 4800);
  near(E.streamBands(plan, plan.expenses[0], 20).expected[1], 12000);
});

test('the yearly review keeps the National Insurance record, bonus, share awards and pot payments up to date', () => {
  const RV = require('../../src/review');
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Una', age: 40, retireAge: 55, niYears: 15, niVoluntary: true }, { name: 'Rab', age: 60, retireAge: 60, niYears: 30 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 20000 }, { id: 'pen', type: 'pension', owner: 'p1', balance: 1000 }],
    income: [{ id: 'pay', name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 50000, freq: 'year', growth: 4, growthUntilAge: 41, growthAfter: 2, raises: [{ age: 42, pct: 10 }],
      bonus: 5000, shares: 8000, pensionTo: 'db', pensionMode: 'pct', employeePension: 6, employerPension: 14, potMode: 'fixed', potEmployee: 100, potEmployer: 40 }],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month' }], events: [], goals: [],
  });
  const before = E.spYears(plan.household.people[0]);
  const rolled = RV.rollPlan(plan, 2);
  const [una, rab] = rolled.household.people;
  assert.equal(una.niYears, 17);                 // two more years worked
  assert.equal(rab.niYears, 30);                 // retired, no voluntary NI: none added
  assert.equal(E.spYears(una).share, before.share);
  // Pay as the projection has it two years on: 4% for a year, 2% after 41, a 10% promotion at 42.
  const g = 1.04 * 1.02 * 1.1, pay = rolled.income[0];
  near(pay.amount, 50000 * g);
  near(pay.amount, E.incomeAfterCosts(plan.income[0], plan, 2));
  near(pay.bonus, 5000 * g);
  near(pay.shares, 8000 * g);
  near(pay.potEmployee, 100 * g, 0.01);
  near(pay.potEmployer, 40 * g, 0.01);
});

test('voluntary NI is still paid for someone who has already retired', () => {
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Una', age: 60, retireAge: 57, statePensionAge: 67, niYears: 28, niVoluntary: true }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 200000 }], income: [], goals: [], events: [],
    expenses: [{ name: 'Living', amount: 1000, freq: 'month' }], assumptions: { inflation: 0 },
  });
  const pre = E.precompute(plan);
  const paid = Array.from(pre.eventsOut).filter(v => v > 0);
  assert.equal(paid.length, 7);                  // 28 + 7 = 35 years, paid from now until 67
  near(paid[0], R.NI_YEARS.class3Week * 52, 0.01);
});

test('share awards swing in simulations even when nothing else varies', () => {
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ada', age: 40, retireAge: 60 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 20000 }], goals: [], events: [],
    income: [{ id: 'pay', name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 80000, freq: 'year', growth: 0, shares: 20000 }],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month' }],
    assumptions: { varySalaries: false, varyInflation: false },
  });
  const draw = E.makeRandomEcon(plan, E.horizon(plan), E.makeNormal(E.mulberry32(3)));
  const vests = new Set();
  for (let k = 0; k < 5; k++) vests.add(Math.round(E.precompute(plan, draw()).people[0].vest[3]));
  assert.ok(vests.size > 1, 'the award differs between simulated futures');
});

test('a household that has stopped work is not offered ideas about working or retiring later', () => {
  const SI = require('../../src/scenario-ideas');
  const LV = require('../../src/levers');
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Elsie', age: 72, retireAge: 72, statePensionAge: 66 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 30000 }, { id: 'home', type: 'property', balance: 200000 }],
    income: [{ name: 'Council pension', kind: 'dbpension', owner: 'p1', tax: 'uk', amount: 9000, startAge: 60 }],
    expenses: [{ name: 'Living', amount: 1500, freq: 'month' }], events: [],
    goals: [{ type: 'retire', owner: 'p1', age: 72 }],
  });
  const drivers = SI.driversFor(plan).map(d => d.key);
  for (const k of ['retireLater', 'retireEarlier', 'spendLess', 'pension']) assert.ok(!drivers.includes(k), k);
  assert.ok(drivers.includes('spendLessRetired'));
  const ideas = SI.ideasFor(plan).map(i => i.id);
  for (const k of ['work-longer', 'retire-early', 'spend-less', 'part-time']) assert.ok(!ideas.includes(k), k);
  assert.ok(!SI.comparisonsFor(plan).some(c => c.id === 'retire-when'));
  const keys = LV.defs(plan).map(l => l.key);
  for (const k of ['retireAge0', 'spendNowPct', 'extraPension0']) assert.ok(!keys.includes(k), k);
  // And the plan check does not ask what retirement will cost.
  assert.ok(!B.insights(plan, E.project(plan)).some(i => i.id === 'plsa'));
});

test('the Child Benefit charge comes off the higher earner; a retired person’s goal is that the money lasts', () => {
  const plan = pay => E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Ada', age: 40, retireAge: 60 }, { name: 'Ben', age: 40, retireAge: 60 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 20000 }], events: [], goals: [],
    income: [
      { name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: pay, freq: 'year', growth: 0 },
      { name: 'Child Benefit', kind: 'other', owner: 'p2', tax: 'none', amount: 2000, freq: 'year', inflationLinked: false, growth: 0, endRef: 'end' },
    ],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month' }],
  });
  const charge = pay => E.project(plan(pay)).rows[0].hicbc;
  near(charge(55000), 0);
  near(charge(70000), 1000);      // half way from £60,000 to £80,000
  near(charge(120000), 2000);     // all of it
  const pr = E.project(plan(70000));
  near(pr.rows[0].persons[0].incomeTax, R.incomeTax(70000, 'ruk') + 1000);
  near(pr.rows[0].persons[1].incomeTax, 0);
  // Already retired: the goal reads as the money lasting, not as retiring.
  const old = E.normalizePlan({ startYear: 2026, household: { people: [{ name: 'Elsie', age: 72, retireAge: 72, endAge: 95 }] }, accounts: [], income: [], expenses: [], events: [], goals: [{ type: 'retire', owner: 'p1', age: 72 }] });
  assert.equal(E.goalTitle(old.goals[0], old), 'Money lasts to 95');
  near(R.NI_YEARS.class3Week, 18.40, 0.001);
});

test('the spending check-up keeps an item’s own timing; the mortgage-rate lever moves the rate after a fix too', () => {
  const SW = require('../../src/spending-wizard');
  const LV = require('../../src/levers');
  const plan = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Elsie', age: 72, retireAge: 72 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 30000 }, { id: 'loan', type: 'debt', balance: 50000, rate: 2, payment: 500, fixedUntil: 2028, rateAfterFix: 5 }],
    income: [], events: [], goals: [],
    expenses: [{ id: 'hol', name: 'Holidays', owner: 'p1', amount: 3000, freq: 'year', endRef: 'age', endAge: 80, note: 'While I can still travel' }],
  });
  const answers = SW.answersFromPlan(plan);
  answers.holidays.amount = 4000;
  const hol = SW.applyAnswers(plan, answers).find(e => e.id === 'hol');
  assert.equal(hol.amount, 4000);
  assert.equal(hol.endRef, 'age');
  assert.equal(hol.endAge, 80);                 // still stops at 80
  assert.equal(hol.note, 'While I can still travel');
  const lower = LV.apply(plan, { mortgageRate: -3 }).accounts.find(a => a.id === 'loan');
  assert.equal(lower.rate, 0);                  // not below zero
  assert.equal(lower.rateAfterFix, 2);
  // Retired: one share mix, not "now" and "at retirement".
  const keys = LV.defs(plan).map(d => d.key);
  assert.ok(!keys.includes('stockPctNow') && keys.includes('stockPctRetire'));
});

test('equity release shows in the yearly flows, so each account’s table adds up', () => {
  const pr = E.project(E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Elsie', age: 72, retireAge: 72, statePensionAge: 66 }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 10000 }, { id: 'home', type: 'property', balance: 240000, rate: 3, releaseYear: 2028, releaseAmount: 60000, sellYear: 2040 }],
    income: [], goals: [], events: [], expenses: [{ name: 'Living', amount: 1500, freq: 'month' }],
  }));
  const rows = pr.rows;
  assert.ok(rows[2].releaseIn > 60000);
  assert.ok(rows[14].releaseRepaid > 60000);
  for (let t = 0; t < rows.length - 1; t++) {
    const r = rows[t], n = rows[t + 1];
    near(r.cash + r.gCash + r.toCash + r.bondsMatured + r.releaseIn - r.wCash - r.sweepIsa - r.sweepGia, n.cash);
    near(r.property + r.gProperty + r.propBought - r.propSold - r.releaseRepaid, n.property);
    near(r.debt + r.debtInterest + r.debtNew - r.debtRegular - r.overpay - r.lumpOverpay - r.hiDebtPay - r.debtForgiven - r.releaseRepaid, n.debt);
  }
});
