'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const R = require('../../src/uk-rules');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

function fixedPlan() {
  const p = E.defaultPlan(2026);
  const debt = p.accounts.find(a => a.type === 'debt');
  debt.fixedUntil = 2027;
  return { p, debt };
}

test('after the fix ends, a new mortgage rate applies from the following year', () => {
  const { p, debt } = fixedPlan();
  debt.rateAfterFix = 6;
  const proj = E.project(E.normalizePlan(p));
  const d = proj.out.debts[0];
  near(d.rate[1], debt.rate / 100, 1e-12, '2027 still fixed');
  near(d.rate[2], 0.06, 1e-12, '2028 new rate');
  const same = E.project(E.normalizePlan(fixedPlan().p));
  assert.ok(E.debtFreeYear(proj) > E.debtFreeYear(same), 'a higher rate with the same payment takes longer');
});

test('keeping the end date resets the payment on renewal', () => {
  const base = fixedPlan();
  const free0 = E.debtFreeYear(E.project(E.normalizePlan(base.p)));
  const { p, debt } = fixedPlan();
  debt.rateAfterFix = 6.5;
  debt.afterFix = 'term';
  const proj = E.project(E.normalizePlan(p));
  assert.ok(Math.abs(E.debtFreeYear(proj) - free0) <= 1, 'ends about when it would have');
  assert.ok(proj.rows[2].debtRegular > proj.rows[1].debtRegular * 1.05, 'payment goes up');
  // The helper: same rate gives the same payment.
  near(E.renewalPayment(150000, 0.045, 12000, 0.045), 12000, 1);
});

test('fund fees reduce investment and pension growth', () => {
  const p = E.defaultPlan(2026);
  const q = E.clonePlan(p);
  q.assumptions.fees = 0.5;
  const a = E.project(p).rows[10], b = E.project(E.normalizePlan(q)).rows[10];
  assert.ok(b.isa < a.isa && b.pension < a.pension);
  assert.equal(b.property, a.property);
});

test('emergency fund goal: covered when the cash buffer is big enough', () => {
  const p = E.defaultPlan(2026);
  p.goals = [E.normalizeGoal({ id: 'ef', type: 'emergency', months: 6, year: 2027 }, 2026, p.household.people[0])];
  const sol = E.solveEmergency(p, p.goals[0]);
  assert.ok(sol.need > 10000 && sol.buffer >= sol.need);
  p.strategy.cashReserve = 1000;
  let proj = E.project(p);
  let res = E.evaluateGoals(p, proj, E.monteCarlo(p, 200, 3))[0];
  assert.equal(res.title, 'Emergency fund: 6 months by 2027');
  assert.ok(res.probability < 0.05, `small buffer: ${res.probability}`);
  assert.equal(res.expectedYear, null);
  // A bigger buffer is filled from surplus over the next few years.
  p.strategy.cashReserve = sol.buffer * 1.15;
  p.goals[0].year = 2031;
  proj = E.project(p);
  res = E.evaluateGoals(p, proj, E.monteCarlo(p, 200, 3))[0];
  assert.ok(res.probability > 0.9, `big buffer: ${res.probability}`);
  assert.ok(res.expectedYear && res.expectedYear <= 2031, `expected ${res.expectedYear}`);
});

test('defined benefit estimate from the scheme, year joined and salary', () => {
  const e = E.estimateDb({ scheme: 'uss', joined: 2016, salary: 49323, startYear: 2026, realGrowth: 0 });
  assert.equal(e.years, 10);
  near(e.perYear, 49323 / 75, 0.01);
  near(e.builtUp, 10 * 49323 / 75, 0.5);
  assert.equal(e.lumpMultiple, 3);
  assert.equal(e.pensionAge, null, 'USS is paid from State Pension age');
  const g = E.estimateDb({ scheme: 'uss', joined: 2016, salary: 49323, startYear: 2026, realGrowth: 1 });
  assert.ok(g.builtUp < e.builtUp, 'earlier salaries were lower');
  const l = E.estimateDb({ scheme: 'lgps', joined: 2020, salary: 30000, startYear: 2026, partTime: 50 });
  near(l.perYear, 15000 / 49, 0.01);
  assert.equal(l.pensionAge, null, 'LGPS is paid from State Pension age');
  for (const k of Object.keys(R.DB_SCHEMES)) assert.ok(R.DB_SCHEMES[k].accrual > 0);
});

test('new fields survive normalising, and hidden plan-check items are kept', () => {
  const ws = E.defaultWorkspace();
  ws.dismissed = ['tfc', 'tfc', 3, 'child-benefit'];
  const p = ws.scenarios[0].plan;
  p.accounts.find(a => a.type === 'debt').rateAfterFix = 5.25;
  p.accounts.find(a => a.type === 'debt').afterFix = 'term';
  const back = E.normalizeWorkspace(JSON.parse(JSON.stringify(ws)));
  assert.deepEqual(back.dismissed, ['tfc', 'child-benefit']);
  const d = back.scenarios[0].plan.accounts.find(a => a.type === 'debt');
  assert.equal(d.rateAfterFix, 5.25);
  assert.equal(d.afterFix, 'term');
  assert.equal(E.normalizePlan({}).accounts.length, 0);
  assert.equal(E.normalizeWorkspace(E.defaultWorkspace()).dismissed.length, 0);
});

test('remortgage sweep varies the rate after the fix', () => {
  const { p } = fixedPlan();
  const v = E.variant(E.normalizePlan(p), 'remortgage', 2);
  const d = v.accounts.find(a => a.type === 'debt');
  near(d.rateAfterFix, d.rate + 2, 1e-9);
});

test('emergency fund can count ISAs and investments, with market risk', () => {
  const p = E.defaultPlan(2026);
  p.strategy.cashReserve = 1000;
  // 18 months by 2030: covered by cash + investments on average, but not after a bad market spell.
  p.goals = [E.normalizeGoal({ id: 'ef', type: 'emergency', months: 18, year: 2030, counts: 'investments' }, 2026, p.household.people[0])];
  assert.equal(p.goals[0].counts, 'investments');
  const sol = E.solveEmergency(p, p.goals[0]);
  assert.ok(sol.have > sol.cashNow, 'investments count');
  const proj = E.project(p);
  const res = E.evaluateGoals(p, proj, E.monteCarlo(p, 300, 5))[0];
  const cashOnly = E.clonePlan(p);
  cashOnly.goals[0].counts = 'cash';
  const res2 = E.evaluateGoals(cashOnly, E.project(cashOnly), E.monteCarlo(cashOnly, 300, 5))[0];
  assert.ok(res.probability > res2.probability, `${res.probability} > ${res2.probability}`);
  assert.ok(res.probability < 1, 'a market fall can leave it short');
});

test('gilts held in an ISA pay back into the ISA without using allowance', () => {
  const p = E.defaultPlan(2026);
  p.strategy.isaAllowance = 0; // no allowance left: maturing gilts outside an ISA end up in the GIA
  const g = p.accounts.find(a => a.type === 'bonds');
  g.maturityYear = 2028;
  const base = E.project(E.normalizePlan(E.clonePlan(p)));
  g.inIsa = true;
  const q = E.normalizePlan(p);
  assert.equal(q.accounts.find(a => a.type === 'bonds').inIsa, true);
  const proj = E.project(q);
  const t = proj.rows.findIndex(r => r.bondsToIsa > 0);
  assert.ok(t >= 0 && proj.rows[t].bondsMatured === 0);
  const k = base.rows.findIndex(r => r.bondsMatured > 0);
  assert.equal(t, k);
  assert.ok(proj.rows[t + 1].isa > base.rows[t + 1].isa, 'more ends up sheltered');
  assert.ok(proj.rows[t + 1].gia < base.rows[t + 1].gia, 'less in the taxable account');
});

test('keeping the end date: the payment follows the rate, so the mortgage ends on time in every simulation', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  const d = p.accounts.find(a => a.type === 'debt');
  Object.assign(d, { fixedUntil: 2027, afterFix: 'term', rateAfterFix: null });
  const q = E.normalizePlan(p);
  const end = E.debtFreeYear(E.project(q));
  const mc = E.monteCarlo(q, 300, 3);
  assert.equal(mc.debtFreeByYear[end - 2026], 1, 'paid off by the expected year in every run');
  // Keeping the payment instead lets the end date move with rates.
  d.afterFix = 'payment';
  const mc2 = E.monteCarlo(E.normalizePlan(p), 300, 3);
  assert.ok(mc2.debtFreeByYear[end - 2026] < 1);
});

test('a retirement goal can be about either person', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  p.goals.push({ type: 'retire', owner: 'p2', age: 60 });
  const q = E.normalizePlan(p);
  const g = q.goals.find(x => x.owner === 'p2');
  assert.equal(E.goalTitle(g, q), 'Sam retires at 60');
  assert.equal(q.goals.find(x => x.type === 'retire' && x.owner === 'p1').age, 55);
  const proj = E.project(q);
  const res = E.evaluateGoals(q, proj, E.monteCarlo(q, 200, 1), { runs: 200, seed: 1 }).find(r => r.goal.id === g.id);
  assert.equal(res.expectedYear, 2026 + 60 - 36);
  // Only Sam retires later for this goal: the same as shifting Sam alone.
  const alone = E.successRate(E.shiftRetirement(q, 5, 'p2'), 200, 1);
  assert.equal(res.probability, alone);
  assert.equal(E.shiftRetirement(q, 5, 'p2').household.people[0].retireAge, 55);
  // An unknown owner falls back to the first person.
  assert.equal(E.normalizePlan({ ...q, goals: [{ type: 'retire', owner: 'p9' }] }).goals[0].owner, 'p1');
});

test('your own monthly ISA amount: the rest stays in cash', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  const base = E.monthlyPlan(E.project(E.normalizePlan(p)));
  p.strategy.isaMonthly = 200;
  p.strategy.giaMonthly = 0;
  const m = E.monthlyPlan(E.project(E.normalizePlan(p)));
  assert.ok(Math.abs(m.isa - 200) < 0.01);
  assert.equal(m.gia, 0);
  assert.ok(Math.abs(m.cash - (base.surplus - base.cash - 200) - base.cash) < 1, 'the rest goes to cash');
  // Automatic again: the same as before.
  assert.equal(E.normalizePlan({ ...p, strategy: { ...p.strategy, isaMonthly: '' } }).strategy.isaMonthly, null);
});

test('USS taken before its Normal Pension Age is cut by USS early retirement factors', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  p.household.people[1].statePensionAge = 68;
  p.income.push({ name: 'USS', owner: 'p2', kind: 'dbpension', tax: 'uk', amount: 6000, dbAccrual: 600, startRef: 'age', startAge: 68, endRef: 'end', freq: 'year', lumpMultiple: 3, dbScheme: 'uss' });
  const q = E.normalizePlan(p);
  const db = q.income.find(i => i.kind === 'dbpension');
  const sam = q.household.people[1];
  assert.deepEqual(E.dbEarly(db, sam), { npa: 68, years: 0, factor: 1 });
  assert.equal(E.dbEarly({ ...db, startAge: 60 }, sam).factor, 0.675);   // 8 years early
  assert.equal(E.dbEarly({ ...db, startAge: 67 }, sam).factor, 0.948);
  const full = E.dbPensionAt(db, q, 68 - sam.age);
  const early = E.dbPensionAt({ ...db, startAge: 60 }, q, 68 - sam.age);
  near(early / full, 0.675, 1e-9);
  // Other schemes are cut by about 5% a year (public service schemes' actuarial reduction).
  near(E.dbEarly({ ...db, dbScheme: 'nhs', startAge: 60 }, sam).factor, 0.675, 1e-9);
  near(E.dbEarly({ ...db, dbScheme: 'lgps', startAge: 66 }, sam).factor, 0.906, 1e-9);
  assert.equal(E.dbEarly({ ...db, dbScheme: 'nhs', startAge: 68 }, sam).factor, 1);
});
