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
