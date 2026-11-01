'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');
const LW = require('../../src/life-wizard.js');

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test('defined benefit pension: built up + yearly accrual, paid from pension age with prices', () => {
  const p = E.defaultPlan(2026);
  const sam = p.household.people[1]; // 36, retires 55
  p.income.push(E.normalizePlan({ ...p, income: [{ name: 'USS', owner: 'p2', kind: 'dbpension', tax: 'uk', amount: 4000, dbAccrual: 600, startRef: 'age', startAge: 67, endRef: 'end', lumpMultiple: 3 }] }).income[0]);
  const db = p.income[p.income.length - 1];
  const t67 = 67 - sam.age;
  const price = Math.pow(1 + p.assumptions.inflation / 100, t67);
  const expected = (4000 + 600 * (55 - 36)) * price;
  assert.equal(E.incomeAfterCosts(db, p, t67 - 1), 0);
  near(E.incomeAfterCosts(db, p, t67), expected, 1e-6);
  const pre = E.precompute(p);
  near(pre.people[1].other[t67] - E.precompute(E.defaultPlan(2026)).people[1].other[t67], expected, 1e-6); // taxable income
  const lumpDiff = pre.eventsIn[t67] - E.precompute(E.defaultPlan(2026)).eventsIn[t67];
  near(lumpDiff, 3 * expected, 1e-6); // tax-free lump sum in the first year
});

test('spare cash above the buffer is invested, ISA first', () => {
  const p = E.defaultPlan(2026);
  p.accounts.find(a => a.type === 'cash').balance = 60000; // buffer is £15,000
  const on = E.project(p).rows;
  assert.ok(on[0].sweepIsa + on[0].sweepGia > 40000);
  assert.ok(on[1].cash < 20000);
  p.strategy.sweepCash = false;
  const off = E.project(p).rows;
  assert.equal(off[0].sweepIsa + off[0].sweepGia, 0);
  assert.ok(off[1].cash > 55000);
});

test('matured gilts get reinvested', () => {
  const p = E.defaultPlan(2026);
  const gilt = p.accounts.find(a => a.type === 'bonds');
  const rows = E.project(p).rows;
  const m = rows.find(r => r.year === gilt.maturityYear - 1);
  assert.ok(m.bondsMatured > 0, 'gilt pays out into cash');
  // Whatever is not needed for spending is invested by the following year,
  // so cash is back at the buffer (which rises with prices).
  const after = rows.find(r => r.year === gilt.maturityYear + 1);
  assert.ok(after.cash < p.strategy.cashReserve * after.deflator * 1.05, `cash ${after.cash}`);
  const sweptTotal = rows.slice(0, 6).reduce((s2, r) => s2 + r.sweepIsa + r.sweepGia, 0);
  assert.ok(sweptTotal > 5000);
});

test('passive income goal: withdrawal rate on investments plus non-work income', () => {
  const p = E.defaultPlan(2026);
  const goal = E.normalizeGoal({ type: 'passiveIncome', amount: 30000, basis: 'real', year: 2045, withdrawalRate: 4, includePensions: true }, 2026, p.household.people[0]);
  const proj = E.project(p);
  const r = proj.rows[5];
  const nonWork = E.nonWorkIncome(proj.pre, 5);
  near(E.passiveIncome(r, nonWork, goal), (r.cash + r.isa + r.gia + r.bonds + r.pension) * 0.04 + nonWork, 1e-6);
  const noPens = { ...goal, includePensions: false };
  assert.ok(E.passiveIncome(r, nonWork, noPens) < E.passiveIncome(r, nonWork, goal));
  p.goals = [goal];
  const mc = E.monteCarlo(p, 200, 3);
  const res = E.evaluateGoals(p, proj, mc)[0];
  assert.ok(res.probability >= 0 && res.probability <= 1);
  assert.match(res.title, /£30K a year passive income by 2045/);
  const y = E.goalYear(goal, proj);
  assert.ok(y && y > 2026);
});

test('savings goal counts cash, ISA, GIA and bonds only', () => {
  const p = E.defaultPlan(2026);
  const goal = { type: 'netWorth', measure: 'savings', amount: 1, basis: 'nominal' };
  const r = E.project(p).rows[0];
  near(E.goalValue(r, 'savings'), r.cash + r.isa + r.gia + r.bonds);
  assert.match(E.goalTitle({ ...goal, amount: 40000, year: 2040 }, p), /£40K saved by 2040/);
});

test('life check-up adds children, cars, home, retirement and care costs', () => {
  const p = E.defaultPlan(2026);
  const a = { ...LW.defaults(p), children: [{ name: 'Kid', age: 8 }], depositHelp: 20000, travelExtra: 6000, careAge: 85, slowDownAge: 75 };
  const q = LW.apply(p, a);
  const names = q.expenses.filter(e => e.key.startsWith('life:')).map(e => e.name);
  assert.ok(names.includes('Kid: school costs'));
  assert.ok(names.includes('Kid: university support'));
  assert.ok(names.includes('Care in later life'));
  const uni = q.expenses.find(e => e.name === 'Kid: university support');
  assert.equal(uni.startAge, 38 + 10); // when the child turns 18
  assert.equal(uni.endAge, 38 + 10 + a.uniYears);
  const deposit = q.events.find(e => e.name === 'Kid: help with a house deposit');
  assert.equal(deposit.year, 2026 + (30 - 8));
  assert.ok(q.events.filter(e => e.name === 'Replace car').length >= 3);
  assert.equal(q.strategy.slowDownAge, 75);
  assert.ok(E.successRate(q, 300, 2) < E.successRate(p, 300, 2), 'more costs, lower chance of success');
});

test('running the life check-up again replaces its items', () => {
  const p = E.defaultPlan(2026);
  const once = LW.apply(p, { ...LW.defaults(p), children: [{ age: 5 }, { age: 2 }] });
  const twice = LW.apply(once, { ...LW.answersFromPlan(once), children: [{ age: 5 }] });
  assert.equal(twice.expenses.filter(e => e.name.endsWith('school costs')).length, 1);
  assert.equal(twice.events.filter(e => e.name.endsWith('first car')).length, 1);
  assert.deepEqual(twice.expenses.filter(e => !e.key.startsWith('life:')), p.expenses);
  assert.equal(LW.answersFromPlan(twice).children.length, 1);
});

test('spending slows down from the chosen age', () => {
  const p = E.defaultPlan(2026);
  const base = E.precompute(p);
  p.strategy.slowDownAge = 75;
  p.strategy.slowDownPct = 80;
  const pre = E.precompute(p);
  const t75 = 75 - p.household.people[0].age;
  near(pre.expenses[t75 - 1], base.expenses[t75 - 1], 1e-6);
  near(pre.expenses[t75], base.expenses[t75] * 0.8, 1e-6);
});
