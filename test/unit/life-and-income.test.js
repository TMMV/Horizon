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

test('pay progression: rises until an age, then slower, plus promotions', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  const pay = p.income[0];   // Alex, 38, £62,000, 3% a year
  Object.assign(pay, { growth: 4, growthUntilAge: 45, growthAfter: 2, raises: [{ age: 41, pct: 10 }] });
  const q = E.normalizePlan(p);
  const it = q.income[0];
  const at = t => E.streamAt(it, q, t);
  assert.ok(Math.abs(at(2) - 62000 * 1.04 ** 2) < 0.01, 'before the promotion');
  assert.ok(Math.abs(at(3) - 62000 * 1.04 ** 3 * 1.1) < 0.01, 'promotion at 41');
  assert.ok(Math.abs(at(10) - 62000 * 1.04 ** 7 * 1.02 ** 3 * 1.1) < 0.01, '4% to 45, then 2%');
  // Without the new fields, pay grows as before.
  const plain = E.normalizePlan(E.defaultPlan(2026));
  assert.ok(Math.abs(E.streamAt(plain.income[0], plain, 5) - 62000 * 1.03 ** 5) < 0.01);
  assert.equal(plain.income[0].growthUntilAge, 0);
  assert.deepEqual(plain.income[0].raises, []);
});

test('life check-up: care costs rise faster than prices until they start', () => {
  const E = require('../../src/engine.js');
  const LW = require('../../src/life-wizard.js');
  const p = E.defaultPlan(2026);
  const age = p.household.people[0].age;
  const cost = a => LW.build(p, { ...LW.answersFromPlan(p), careAge: 85, careCost: 60000, careYears: 3, ...a }).expenses.find(e => e.key === 'life:care').amount;
  assert.equal(cost({ careRealGrowth: 0 }), 60000);
  assert.equal(cost({ careRealGrowth: 1 }), Math.round(60000 * Math.pow(1.01, 85 - age)));
  assert.equal(LW.defaults(p).careRealGrowth, 1);
});

test('life check-up: a car and home repairs are counted only when asked for; an earlier check-up keeps what it had', () => {
  const p = E.defaultPlan();
  p.life = null;
  p.expenses = p.expenses.filter(e => !(e.key || '').startsWith('life:'));
  p.events = p.events.filter(e => !(e.id || '').startsWith('life:'));
  const fresh = LW.answersFromPlan(p);
  assert.equal(fresh.carsOn, false);
  assert.equal(fresh.homeOn, false);
  assert.equal(LW.summary(p, fresh).total, 0);                       // nothing before anything is typed
  const kids = { ...fresh, children: [{ name: '', age: 17 }], schoolCost: 0, carAt17: 0, uniPerYear: 3000, uniYears: 4 };
  const s = LW.summary(p, kids);
  assert.deepEqual(s.lines.map(l => l.name), ['Child 1: university support']);
  assert.equal(s.lines[0].when, `${p.startYear + 1}–${p.startYear + 4}`);   // years, not the parent's age
  assert.equal(s.total, 12000);
  const withCar = LW.build(p, { ...kids, carsOn: true });
  assert.ok(withCar.events.some(e => e.name === 'Replace car'));
  assert.ok(!withCar.events.some(e => e.name === 'Major home repairs'));
  // A plan that went through the check-up before the question existed keeps its cars and repairs.
  const old = E.defaultPlan();
  old.life = { cars: 1, carCost: 18000, carEvery: 8, carNext: old.startYear + 3, homeCost: 12000, homeEvery: 10, homeNext: old.startYear + 5 };
  const kept = LW.answersFromPlan(old);
  assert.equal(kept.carsOn, true);
  assert.equal(kept.homeOn, true);
  assert.ok(LW.build(old, kept).events.some(e => e.name === 'Major home repairs'));
});
