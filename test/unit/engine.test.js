'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');
const R = require('../../src/uk-rules.js');

const near = (actual, expected, tol = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

// Gross-up iterations stop within half a penny, so allow 1p of rounding per year.
const PENNY = 0.01;

// A small, fully specified single-person plan for precise checks.
function simplePlan(overrides = {}) {
  return E.normalizePlan({
    startYear: 2026,
    household: { region: 'scotland', people: [{ name: 'Test', age: 40, retireAge: 60, endAge: 90, statePension: R.STATE_PENSION_FULL, statePensionAge: 67, pensionAccessAge: 57 }] },
    accounts: [
      { name: 'Cash', type: 'cash', balance: 10000 },
      { name: 'ISA', type: 'isa', owner: 'p1', balance: 50000 },
      { name: 'Pension', type: 'pension', owner: 'p1', balance: 100000 },
    ],
    income: [{ name: 'Salary', owner: 'p1', kind: 'salary', tax: 'uk', amount: 50000, freq: 'year', growth: 0, startRef: 'now', endRef: 'retire', pensionMode: 'pct', employeePension: 5, employerPension: 3 }],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month', inflationLinked: true, startRef: 'now', endRef: 'end' }],
    events: [],
    strategy: { cashReserve: 10000, overpayPct: 0, overpayCapPct: 10, isaAllowance: 20000 },
    assumptions: { inflation: 2, stockReturn: 6, stockVolatility: 15, bondReturn: 4, bondVolatility: 5, stockPctNow: 80, stockPctRetire: 50, cashRate: 0, thresholdFreezeUntil: 2026, statePensionRealGrowth: 0 },
    ...overrides,
  });
}

function identityGap(rows) {
  let worst = 0;
  for (const r of rows.slice(0, -1)) {
    const inflow = r.earnings + r.otherIncome + r.statePension + r.withdrawals + r.unfunded;
    const outflow = r.spending + r.taxes + r.debtPay + r.saved;
    worst = Math.max(worst, Math.abs(inflow - outflow));
  }
  return worst;
}

test('default workspace and plan normalise to themselves', () => {
  const w = E.normalizeWorkspace(E.defaultWorkspace());
  const again = E.normalizeWorkspace(JSON.parse(JSON.stringify(w)));
  assert.deepEqual(again, w);
});

test('garbage input normalises to a usable workspace', () => {
  for (const junk of [null, 42, 'x', {}, { scenarios: 'nope' }, { scenarios: [null, { plan: { household: { people: [{ age: 'old' }] } } }] }]) {
    const w = E.normalizeWorkspace(junk);
    assert.ok(w.scenarios.length >= 1);
    const proj = E.project(w.scenarios[0].plan);
    assert.ok(proj.rows.length > 1);
    assert.ok(Number.isFinite(proj.rows[0].netWorth));
  }
});

test('a bare plan file imports as a one-scenario workspace', () => {
  const w = E.normalizeWorkspace(E.defaultPlan(2026));
  assert.equal(w.scenarios.length, 1);
  assert.equal(w.scenarios[0].plan.household.people.length, 2);
});

test('money in equals money out every year', () => {
  assert.ok(identityGap(E.project(E.defaultPlan(2026)).rows) < PENNY);
  assert.ok(identityGap(E.project(simplePlan()).rows) < PENNY);
  // Also when the plan runs out of money
  const broke = simplePlan();
  broke.expenses[0].amount = 9000;
  const rows = E.project(broke).rows;
  assert.ok(rows.some(r => r.unfunded > 0));
  assert.ok(identityGap(rows) < PENNY);
});

test('first-year taxes for a gross salary match the rules', () => {
  const p = simplePlan();
  const r = E.project(p).rows[0];
  const employee = 50000 * 0.05;
  const expectedTax = R.incomeTax(50000 - employee, 'scotland') + R.nationalInsurance(50000);
  near(r.taxes, expectedTax, 0.01);
  near(r.pensionIn, 50000 * 0.08, 0.01);
});

test('salary sacrifice also saves NI, capped at £2,000 from April 2029', () => {
  const p = simplePlan();
  p.income[0].sacrifice = true;
  const rows = E.project(p).rows;
  const ee = 2500;
  near(rows[0].taxes, R.incomeTax(50000 - ee, 'scotland') + R.nationalInsurance(50000 - ee), 0.01);
  const t2029 = 2029 - 2026;
  const g = E.thresholdFactor(p, t2029);
  near(rows[t2029].taxes, R.incomeTax(50000 - ee, 'scotland', g) + R.nationalInsurance(50000 - 2000, g), 0.01);
});

test('take-home pay is not taxed again', () => {
  const p = simplePlan();
  Object.assign(p.income[0], { tax: 'none', amount: 3000, freq: 'month', pensionMode: 'fixed', employeePension: 200, employerPension: 100 });
  const r = E.project(p).rows[0];
  assert.equal(r.taxes, 0);
  near(r.earnings, 36000, 0.01);
  near(r.pensionIn, 3600, 0.01);
});

test('pension cannot be touched before the access age', () => {
  const p = simplePlan();
  p.household.people[0].retireAge = 50; // retire at 50 with pension access at 57
  const rows = E.project(p).rows;
  for (const r of rows) if (r.ages[0] < 57) assert.equal(r.wPension, 0, `pension used at ${r.ages[0]}`);
  assert.ok(rows.some(r => r.ages[0] >= 57 && r.wPension > 0));
});

test('pension drawn within the personal allowance is tax-free', () => {
  const p = simplePlan();
  p.household.people[0].retireAge = 58;
  p.accounts = p.accounts.filter(a => a.type === 'pension');
  p.accounts[0].balance = 500000;
  p.strategy.cashReserve = 0;
  p.expenses[0].amount = 800; // small need, covered inside the allowance
  const rows = E.project(p).rows;
  const r = rows.find(x => x.ages[0] === 59);
  assert.ok(r.wPension > 0);
  assert.equal(r.taxes, 0);
});

test('ISA contributions respect the allowance and the excess goes to the GIA', () => {
  const p = simplePlan();
  p.income[0].amount = 150000;
  const r = E.project(p).rows[0];
  assert.ok(r.toIsa <= 20000 + 1e-6);
  assert.ok(r.toGia > 0);
});

test('mortgage overpayment pays the mortgage off sooner', () => {
  const base = simplePlan();
  base.accounts.push(...E.normalizePlan({ ...base, accounts: [{ name: 'Mortgage', type: 'debt', balance: 150000, rate: 4.5, payment: 900 }] }).accounts);
  const freeYear = p => (E.project(p).rows.find(r => r.debt <= 0.5) || {}).year;
  const over = E.clonePlan(base);
  over.strategy.overpayPct = 100;
  assert.ok(freeYear(over) < freeYear(base), `${freeYear(over)} should be before ${freeYear(base)}`);
});

test('overpayments respect the yearly limit', () => {
  const p = simplePlan();
  p.accounts.push(...E.normalizePlan({ ...p, accounts: [{ name: 'Mortgage', type: 'debt', balance: 100000, rate: 4, payment: 800 }] }).accounts);
  p.strategy.overpayPct = 100;
  p.strategy.overpayCapPct = 5;
  const r = E.project(p).rows[0];
  assert.ok(r.overpay <= 100000 * 0.05 + 1e-6);
});

test('bonds mature into cash and property sales are invested', () => {
  const p = simplePlan();
  p.accounts.push(...E.normalizePlan({ ...p, accounts: [
    { name: 'Gilt', type: 'bonds', balance: 10000, rate: 5, maturityYear: 2028 },
    { name: 'Flat', type: 'property', balance: 200000, rate: 0, sellYear: 2030 },
  ] }).accounts);
  const rows = E.project(p).rows;
  const at = y => rows.find(r => r.year === y);
  assert.ok(at(2027).bonds > 0);
  assert.equal(at(2028).bonds, 0);
  assert.equal(at(2030).property, 200000);
  assert.equal(at(2031).property, 0);
  assert.ok(at(2030).otherIncome >= 200000);
});

test('Monte Carlo with zero volatility matches the expected-return projection', () => {
  const p = simplePlan();
  p.assumptions.stockVolatility = 0;
  p.assumptions.bondVolatility = 0;
  for (const k of ['varyInflation', 'varyHouses', 'varySalaries', 'varyRates']) p.assumptions[k] = false;
  const proj = E.project(p);
  const mc = E.monteCarlo(p, 20, 1);
  for (let t = 0; t < proj.rows.length; t += 7) near(mc.bands.p50[t], proj.rows[t].liquid, 1e-6 * proj.rows[t].liquid + 1e-6);
});

test('Monte Carlo is reproducible for a seed and varies across seeds', () => {
  const p = E.defaultPlan(2026);
  const a = E.monteCarlo(p, 300, 7);
  const b = E.monteCarlo(p, 300, 7);
  const c = E.monteCarlo(p, 300, 8);
  assert.deepEqual(a.bands.p50, b.bands.p50);
  assert.notDeepEqual(a.bands.p50, c.bands.p50);
  assert.ok(a.successRate >= 0 && a.successRate <= 1);
  assert.ok(a.bands.p10.every((v, i) => v <= a.bands.p90[i]));
});

test('more spending never improves the success rate (common random numbers)', () => {
  const p = E.defaultPlan(2026);
  const rates = [0.8, 1, 1.2, 1.4].map(k => E.successRate(E.scaleSpending(p, k), 400, 3));
  for (let i = 1; i < rates.length; i++) assert.ok(rates[i] <= rates[i - 1], rates.join(', '));
});

test('solvers return sensible answers', () => {
  const p = E.defaultPlan(2026);
  const ret = E.solveRetirement(p, 0.9, 300, 3);
  assert.ok(ret.delta !== null && ret.success >= 0.9);
  const sp = E.solveSpending(p, 0.9, 300, 3);
  assert.ok(sp.multiple > 0.5 && sp.multiple < 3);
  assert.ok(E.successRate(E.scaleSpending(p, sp.multiple), 300, 3) >= 0.9);
});

test('goal year respects the measure and the basis', () => {
  const p = E.defaultPlan(2026);
  const goal = { id: 'g', type: 'netWorth', amount: 1000000, measure: 'all', basis: 'nominal', year: 2036 };
  const proj = E.project(p);
  const all = E.goalYear(goal, proj);
  const noPension = E.goalYear({ ...goal, measure: 'noPension' }, proj);
  const real = E.goalYear({ ...goal, measure: 'noPension', basis: 'real' }, proj);
  assert.ok(all && noPension && real);
  assert.ok(all <= noPension && noPension <= real, `${all} ${noPension} ${real}`);
  p.goals = [goal];
  const mc = E.monteCarlo(p, 300, 1);
  const hits = mc.goalHits.g;
  assert.ok(hits.every((v, i, arr) => i === 0 || v >= arr[i - 1]), 'goal probability never falls');
  assert.ok(mc.debtFreeByYear.every((v, i, arr) => i === 0 || v >= arr[i - 1]), 'debt-free probability never falls');
});

test('sweeps return one summary per lever value', () => {
  const p = E.defaultPlan(2026);
  for (const lever of Object.keys(E.LEVERS)) {
    const res = E.sweep(p, lever, 100, 1);
    assert.equal(res.length, E.LEVERS[lever].values.length);
    for (const r of res) assert.ok(Number.isFinite(r.summary.success));
  }
});

test('check-ins compare actuals with last year\'s projection', () => {
  const p = E.defaultPlan(2026);
  const c1 = E.makeCheckin(p, 'Base', '2026-11-01');
  const next = E.rollForward(p);
  assert.equal(next.startYear, 2027);
  assert.equal(next.household.people[0].age, p.household.people[0].age + 1);
  next.accounts.find(a => a.type === 'cash').balance += 10000;
  const c2 = E.makeCheckin(next, 'Base', '2027-11-01');
  const review = E.checkinReview([c2, c1]);
  assert.equal(review[0].predicted, null);
  const predicted2027 = c1.predicted.netWorth[c1.predicted.years.indexOf(2027)];
  near(review[1].predicted, predicted2027, 1e-6);
  near(review[1].diff, c2.actual.netWorth - predicted2027, 1e-6);
  assert.ok(c1.actual.spending > 0);
});

test('roll forward drops past events and matured accounts', () => {
  const p = E.defaultPlan(2026);
  p.events.push({ id: 'old', name: 'Old', kind: 'expense', year: 2026, amount: 1 });
  const next = E.rollForward(p);
  assert.ok(!next.events.some(e => e.year < 2027));
});

test('validation flags impossible inputs', () => {
  const p = E.defaultPlan(2026);
  p.household.people[0].endAge = 30;
  p.accounts.find(a => a.type === 'debt').payment = 1;
  const warnings = E.validatePlan(p);
  assert.ok(warnings.some(w => /plan until age/.test(w)));
  assert.ok(warnings.some(w => /never shrinks/.test(w)));
});
