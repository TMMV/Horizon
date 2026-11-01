'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');
const L = require('../../src/levers.js');

test('levers cover every group and read the plan', () => {
  const p = E.defaultPlan(2026);
  const defs = L.defs(p);
  for (const g of Object.keys(L.GROUPS)) assert.ok(defs.some(d => d.group === g), g);
  const v = L.currentValues(p);
  assert.equal(v.retireAge0, p.household.people[0].retireAge);
  assert.equal(v.overpayPct, 0);
  assert.equal(v.stockReturn, 0);
  for (const d of defs) assert.ok(v[d.key] >= d.min && v[d.key] <= d.max, `${d.key} ${v[d.key]} outside ${d.min}-${d.max}`);
});

test('applying unchanged levers leaves the plan as it was', () => {
  const p = E.defaultPlan(2026);
  assert.deepEqual(L.apply(p, L.currentValues(p)), p);
  assert.deepEqual(L.changed(p, L.currentValues(p)), []);
});

test('each lever changes only what it should', () => {
  const p = E.defaultPlan(2026);
  const v = L.currentValues(p);
  const q = L.apply(p, { ...v, retireAge1: 60, overpayPct: 40, stockReturn: -2, houses: 1 });
  assert.equal(q.household.people[0].retireAge, p.household.people[0].retireAge);
  assert.equal(q.household.people[1].retireAge, 60);
  assert.equal(q.strategy.overpayPct, 40);
  assert.equal(q.assumptions.stockReturn, p.assumptions.stockReturn - 2);
  const home = p.accounts.find(a => a.type === 'property');
  assert.equal(q.accounts.find(a => a.id === home.id).rate, home.rate + 1);
  assert.equal(p.strategy.overpayPct, 0, 'original untouched');
});

test('one-off overpayment lever creates a dated overpay event', () => {
  const p = E.defaultPlan(2026);
  const v = L.currentValues(p);
  const q = L.apply(p, { ...v, lumpSum: 25000, lumpYear: 2030 });
  const ev = q.events.find(e => e.id === L.LUMP_ID);
  assert.ok(ev);
  assert.equal(ev.kind, 'overpay');
  assert.equal(ev.amount, 25000);
  assert.equal(ev.year, 2030);
  const back = L.apply(q, { ...L.currentValues(q), lumpSum: 0 });
  assert.ok(!back.events.some(e => e.id === L.LUMP_ID));
});

test('selling a property lever sets and clears the sale year', () => {
  const p = E.defaultPlan(2026);
  const home = p.accounts.find(a => a.type === 'property');
  const key = `sell-${home.id}`;
  const v = L.currentValues(p);
  assert.equal(v[key], 2025); // "Keep"
  const q = L.apply(p, { ...v, [key]: 2045 });
  assert.equal(q.accounts.find(a => a.id === home.id).sellYear, 2045);
  const r = L.apply(q, { ...L.currentValues(q), [key]: 2025 });
  assert.equal(r.accounts.find(a => a.id === home.id).sellYear, 0);
});

test('trade-offs: overpaying helps the mortgage goal and costs investing', () => {
  const p = E.defaultPlan(2026);
  const q = L.apply(p, { ...L.currentValues(p), overpayPct: 60 });
  const { before, after } = L.goalComparison(p, q, 200, 3);
  const debt = g => g.goals.find(x => x.goal.type === 'debtFree');
  assert.ok(debt(after).probability > debt(before).probability);
  assert.ok(after.summary.debtFree < before.summary.debtFree);
  assert.ok(after.summary.monthly.invest < before.summary.monthly.invest);
});

test('trade-offs: retiring later raises the chance the money lasts', () => {
  const p = E.defaultPlan(2026);
  const v = L.currentValues(p);
  const q = L.apply(p, { ...v, retireAge0: v.retireAge0 + 4, retireAge1: v.retireAge1 + 4 });
  const { before, after } = L.goalComparison(p, q, 200, 3);
  assert.ok(after.summary.success >= before.summary.success);
  assert.ok(after.summary.netWorthAtRetire > before.summary.netWorthAtRetire);
});

test('each goal is only offered the levers and changes that can move it', () => {
  const p = E.defaultPlan(2026);   // first retirement in 2043
  const p1 = p.household.people[0];
  const goal = (g) => E.normalizeGoal(g, p.startYear, p1);
  const keys = g => L.defs(p).filter(d => L.leverFits(d, g, p)).map(d => d.key);

  const early = goal({ type: 'netWorth', amount: 1e6, year: 2036, measure: 'all' });
  assert.ok(!keys(early).some(k => k.startsWith('retireAge') || k === 'retireSpending' || k === 'stockPctRetire'), 'no retirement levers before anyone retires');
  assert.ok(keys(early).includes('extraPension0'), 'pensions count towards net worth');
  assert.ok(!L.groupsForGoal(p, early).includes('retirement'));
  for (const k of ['retireLater', 'retireEarlier', 'spendLessRetired']) assert.equal(L.driverFits(k, early, p), false, k);

  const late = goal({ type: 'netWorth', amount: 1e6, year: 2060, measure: 'all' });
  assert.ok(L.groupsForGoal(p, late).includes('retirement'), 'a goal after retirement depends on it');
  assert.equal(L.driverFits('retireLater', late, p), true);

  const saved = goal({ type: 'netWorth', amount: 40000, year: 2030, measure: 'savings' });
  assert.ok(!keys(saved).some(k => k.startsWith('extraPension')), 'savings goals ignore pensions');
  assert.ok(!keys(saved).includes('houses'));
  assert.equal(L.driverFits('pension', saved, p), false);

  const mortgage = goal({ type: 'debtFree', year: 2040 });
  assert.ok(!keys(mortgage).includes('stockReturn') && !keys(mortgage).includes('stockPctNow'), 'share returns do not pay off a mortgage');
  assert.ok(keys(mortgage).includes('overpayPct'));
  assert.equal(L.driverFits('weakMarkets', mortgage, p), false);
  assert.equal(L.driverFits('spendLess', mortgage, p), false, 'spending less only helps if the surplus overpays');

  const cash = goal({ type: 'emergency', months: 6, year: 2028, counts: 'cash' });
  assert.deepEqual(L.groupsForGoal(p, cash), ['saving', 'stress']);
  assert.equal(L.driverFits('crash', cash, p), false);
  assert.equal(L.driverFits('crash', goal({ type: 'emergency', months: 6, year: 2028, counts: 'investments' }), p), true);

  const retire = goal({ type: 'retire', age: 55 });
  assert.ok(L.groupsForGoal(p, retire).includes('retirement'));
  assert.equal(L.driverFits('retireLater', retire, p), true);
});
