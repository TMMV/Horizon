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
