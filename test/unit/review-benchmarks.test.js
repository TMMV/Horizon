'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const R = require('../../src/uk-rules');
const RV = require('../../src/review');
const B = require('../../src/benchmarks');

function workspace() {
  const ws = E.defaultWorkspace();
  const p = ws.scenarios[0].plan;
  p.asOf = `${p.startYear}-10-15`;
  ws.checkins.push(E.makeCheckin(p, 'Base plan', p.asOf));
  return ws;
}
// A review a year after the figures date.
const nextYear = ws => { const y = ws.scenarios[0].plan.startYear + 1; return { year: y, date: `${y}-10-15` }; };

test('check-ins record the prediction by account type', () => {
  const ws = workspace();
  const c = ws.checkins[0];
  for (const t of RV.TYPES) assert.equal(c.predicted.byType[t].length, c.predicted.years.length, t);
  const back = E.normalizeCheckin(JSON.parse(JSON.stringify(c)));
  assert.deepEqual(back.predicted.byType, c.predicted.byType);
  // Older check-ins without the breakdown still load.
  const old = E.normalizeCheckin({ year: 2024, actual: { netWorth: 1 }, predicted: { years: [2024], netWorth: [1] } });
  assert.equal(old.predicted.byType, undefined);
});

test('rolling a plan forward grows today’s-money amounts as the plan expects', () => {
  const p = E.defaultPlan();
  const q = RV.rollPlan(p, 1);
  assert.equal(q.startYear, p.startYear + 1);
  assert.equal(q.household.people[0].age, p.household.people[0].age + 1);
  const sal = p.income.find(i => i.kind === 'salary' && !i.inflationLinked);
  const sal2 = q.income.find(i => i.id === sal.id);
  assert.ok(Math.abs(sal2.amount - sal.amount * (1 + sal.growth / 100)) <= 1);
  const ex = p.expenses.find(e => e.inflationLinked);
  const ex2 = q.expenses.find(e => e.id === ex.id);
  assert.ok(Math.abs(ex2.amount - ex.amount * (1 + p.assumptions.inflation / 100)) <= 1);
  assert.ok(q.strategy.cashReserve > p.strategy.cashReserve);
});

test('defined benefit pensions build up by a year of accrual when rolled forward', () => {
  const p = E.defaultPlan();
  p.income.push(E.normalizePlan({ ...p, income: [{ name: 'DB', owner: 'p1', kind: 'dbpension', amount: 10000, dbAccrual: 600, freq: 'year', inflationLinked: true, startRef: 'age', startAge: 67, endRef: 'end' }] }).income[0]);
  const q = RV.rollPlan(p, 1);
  const db = q.income.find(i => i.kind === 'dbpension');
  assert.ok(Math.abs(db.amount - 10600 * (1 + p.assumptions.inflation / 100)) <= 1);
});

test('a review left untouched matches the prediction exactly', () => {
  const ws = workspace();
  const d = RV.start(ws, nextYear(ws));
  assert.equal(d.years, 1);
  assert.ok(d.predicted && d.predicted.byType);
  const v = RV.variance(d);
  assert.equal(v.mode, 'prediction');
  assert.ok(Math.abs(v.total.diff) < 10, `diff ${v.total.diff}`);
  for (const r of v.rows) assert.ok(Math.abs(r.diff) < 10, r.type);
});

test('the variance explains the difference by account type', () => {
  const ws = workspace();
  const d = RV.start(ws, nextYear(ws));
  const isa = d.plan.accounts.find(a => a.type === 'isa');
  const debt = d.plan.accounts.find(a => a.type === 'debt');
  RV.setValue(d, 'accounts', isa.id, isa.balance + 10000);
  RV.setValue(d, 'accounts', debt.id, debt.balance - 2000);
  const v = RV.variance(d);
  const row = t => v.rows.find(r => r.type === t);
  assert.ok(Math.abs(row('isa').diff - 10000) < 10);
  assert.ok(Math.abs(row('debt').diff - 2000) < 10, 'less owed counts as a positive difference');
  assert.ok(Math.abs(v.total.diff - 12000) < 20);
  assert.deepEqual(RV.progress(d, 'accounts'), { done: 2, total: d.plan.accounts.length });
});

test('applying a review rolls every selected scenario and records a check-in', () => {
  const ws = workspace();
  const base = ws.scenarios[0];
  const copy = { id: 'copy', name: 'Copy', plan: E.clonePlan(base.plan) };
  copy.plan.assumptions.stockReturn = 5;
  ws.scenarios.push(copy);
  const third = { id: 'own', name: 'Own inflation', plan: E.clonePlan(base.plan) };
  third.plan.assumptions.inflation = 4;
  ws.scenarios.push(third);
  const d = RV.start(ws, nextYear(ws));
  const isa = d.plan.accounts.find(a => a.type === 'isa');
  RV.setValue(d, 'accounts', isa.id, 99999);
  d.market.inflation.next = 3;
  const out = RV.apply(ws, d, { market: { inflation: true }, date: `${d.year}-10-10`, goals: [{ title: 'G', probability: 0.4, expectedYear: 2030 }] });
  for (const s of out.scenarios) {
    assert.equal(s.plan.startYear, d.year, s.name);
    assert.equal(s.plan.accounts.find(a => a.id === isa.id).balance, 99999, s.name);
  }
  assert.equal(out.scenarios.find(s => s.id === 'copy').plan.assumptions.stockReturn, 5, 'own assumptions kept');
  assert.equal(out.scenarios.find(s => s.id === 'copy').plan.assumptions.inflation, 3, 'shared inflation updated');
  assert.equal(out.scenarios.find(s => s.id === 'own').plan.assumptions.inflation, 4, 'own inflation kept');
  assert.equal(out.checkins.length, 2);
  const c = out.checkins[out.checkins.length - 1];
  assert.equal(c.year, d.year);
  assert.deepEqual(c.goals, [{ title: 'G', probability: 0.4, expectedYear: 2030 }]);
  assert.equal(ws.checkins.length, 1, 'input workspace is not changed');
});

test('unselected scenarios are left alone', () => {
  const ws = workspace();
  ws.scenarios.push({ id: 'x', name: 'X', plan: E.clonePlan(ws.scenarios[0].plan) });
  const d = RV.start(ws, nextYear(ws));
  const out = RV.apply(ws, d, { scenarioIds: [d.scenarioId], date: '2030-10-01' });
  assert.equal(out.scenarios.find(s => s.id === 'x').plan.startYear, ws.scenarios[0].plan.startYear);
});

test('the review is due from October, for the calendar year', () => {
  const ws = workspace();
  const y = ws.scenarios[0].plan.startYear;
  ws.checkins = [];
  assert.equal(RV.due(ws, new Date(`${y}-06-01`)).due, false);
  assert.deepEqual(RV.due(ws, new Date(`${y}-10-05`)), { due: true, year: y, reason: 'october' });
  assert.equal(RV.due(ws, new Date(`${y + 1}-02-01`)).due, false, 'not nagged in January');
  assert.deepEqual(RV.due(ws, new Date(`${y + 1}-10-02`)), { due: true, year: y + 1, reason: 'october' });
  assert.equal(RV.due(ws, new Date(`${y + 2}-03-01`)).reason, 'behind');
  ws.checkins.push(E.makeCheckin(ws.scenarios[0].plan, 'x', `${y}-10-04`));
  assert.deepEqual(RV.due(ws, new Date(`${y}-10-20`)), { due: false, next: y + 1 });
  assert.equal(RV.suggestedYear(ws.scenarios[0].plan, new Date(`${y}-11-01`)), y);
  assert.equal(RV.suggestedYear(ws.scenarios[0].plan, new Date(`${y + 1}-10-01`)), y + 1);
});

test('gross pay from take-home inverts tax and NI', () => {
  for (const gross of [20000, 45000, 80000, 140000]) {
    for (const region of ['scotland', 'ruk']) {
      const net = gross - R.incomeTax(gross, region) - R.nationalInsurance(gross);
      assert.ok(Math.abs(R.grossFromTakeHome(net, region) - gross) < 1, `${region} ${gross}`);
    }
  }
});

test('spending guides scale with the household', () => {
  const couple = { adults: 2, children: [], cars: 1, homeValue: 300000 };
  const family = { adults: 2, children: [5, 9], cars: 2, homeValue: 300000 };
  const g1 = B.forQuestion('groceries', couple), g2 = B.forQuestion('groceries', family);
  assert.ok(g2.low > g1.low && g2.high > g1.high);
  assert.equal(B.forQuestion('fuel', family).high, 2 * B.forQuestion('fuel', couple).high);
  assert.ok(B.forQuestion('clubs', couple).none, 'no school-age children: no club costs expected');
  assert.ok(Math.abs(B.forQuestion('maintenance', couple).low * 12 - 1500) < 1);
  assert.equal(B.position(200, { low: 100, high: 300 }), 'typical');
  assert.equal(B.position(50, { low: 100, high: 300 }), 'below');
  assert.equal(B.position(400, { low: 100, high: 300 }), 'above');
  for (const q of require('../../src/spending-wizard').QUESTIONS) {
    if (q.key === 'rent') continue;
    assert.ok(B.GUIDES[q.key], `guide for ${q.key}`);
  }
});

test('plan check: emergency fund, children and the £100k trap', () => {
  const p = E.defaultPlan();
  const ids = list => list.map(i => i.id);
  let list = B.insights(p, E.project(p));
  assert.ok(ids(list).includes('buffer'));
  assert.ok(ids(list).includes('saving-rate'));
  assert.ok(list.every(i => ['warn', 'tip', 'good', 'info'].includes(i.tone)));
  // Warnings come first.
  const rank = { warn: 0, tip: 1, good: 2, info: 3 };
  for (let i = 1; i < list.length; i++) assert.ok(rank[list[i - 1].tone] <= rank[list[i].tone]);

  // A child under 12 and after-school clubs: Child Benefit and Tax-Free Childcare.
  const q = E.clonePlan(p);
  q.life = { children: [{ name: '', age: 5 }] };
  q.expenses.push(E.normalizePlan({ ...q, expenses: [{ name: 'After school club', amount: 300, freq: 'month' }] }).expenses[0]);
  list = B.insights(q, E.project(q));
  const tfc = list.find(i => i.id === 'tfc');
  assert.ok(tfc, 'Tax-Free Childcare checked');
  assert.match(tfc.title, /£\d/);
  assert.ok(list.find(i => i.id === 'child-benefit'));

  // £110k salary: inside the taper.
  const r = E.clonePlan(p);
  r.income[0].amount = 118000;
  r.income[0].employeePension = 0;
  list = B.insights(r, E.project(r));
  assert.ok(list.some(i => i.id.startsWith('trap-') && i.tone === 'warn'));
});
