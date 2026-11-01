'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');
const W = require('../../src/spending-wizard.js');

test('every question has a unique key and match words', () => {
  const keys = W.QUESTIONS.map(q => q.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const q of W.QUESTIONS) assert.ok(Array.isArray(q.match) && q.match.length, q.key);
});

test('answers pre-fill from existing expenses by name', () => {
  const p = E.defaultPlan(2026);
  const a = W.answersFromPlan(p);
  assert.equal(a.groceries.amount, 650);
  assert.ok(a.groceries.from);
  assert.equal(a['council-tax'].amount, 210);
  assert.equal(a.rent.amount, 0);
});

test('applying replaces matched expenses instead of double counting', () => {
  const p = E.defaultPlan(2026);
  const before = p.expenses.reduce((s, e) => s + E.streamAt(e, p, 0), 0);
  const a = W.answersFromPlan(p);
  const next = { ...p, expenses: E.normalizePlan({ ...p, expenses: W.applyAnswers(p, a) }).expenses };
  const after = next.expenses.reduce((s, e) => s + E.streamAt(e, next, 0), 0);
  assert.ok(Math.abs(after - before) < 1e-6, `${before} vs ${after}`);
  assert.ok(next.expenses.some(e => e.name === 'Groceries' && e.key === 'groceries'), 'keeps the user\'s own name');
});

test('re-running the check-up updates the same expenses', () => {
  let p = E.defaultPlan(2026);
  const a = W.answersFromPlan(p);
  a.groceries.amount = 700;
  a.rent = { amount: 900, freq: 'month' };
  p = { ...p, expenses: E.normalizePlan({ ...p, expenses: W.applyAnswers(p, a) }).expenses };
  const again = W.answersFromPlan(p);
  assert.equal(again.groceries.amount, 700);
  assert.equal(again.rent.amount, 900);
  const p2 = { ...p, expenses: W.applyAnswers(p, again) };
  assert.equal(p2.expenses.filter(e => e.key === 'rent').length, 1);
});

test('zero answers remove check-up expenses; keepOthers=false drops the rest', () => {
  const p = E.defaultPlan(2026);
  p.expenses.push({ id: 'x', name: 'Boat', amount: 100, freq: 'month', inflationLinked: true, startRef: 'now', endRef: 'end' });
  const a = W.answersFromPlan(p);
  for (const q of W.QUESTIONS) a[q.key].amount = 0;
  assert.deepEqual(W.applyAnswers(p, a).map(e => e.name), ['Boat']);
  assert.deepEqual(W.applyAnswers(p, a, { keepOthers: false }), []);
});

test('children\'s costs end at the chosen age', () => {
  const p = E.defaultPlan(2026);
  const a = W.answersFromPlan(p);
  a._childrenEndAge = 50;
  const ex = W.applyAnswers(p, a).find(e => e.key === 'childcare');
  assert.equal(ex.endRef, 'age');
  assert.equal(ex.endAge, 50);
});

test('totals add monthly and yearly answers', () => {
  const a = {};
  for (const q of W.QUESTIONS) a[q.key] = { amount: 0, freq: 'month' };
  a.groceries = { amount: 100, freq: 'month' };
  a.holidays = { amount: 1200, freq: 'year' };
  const t = W.totals(a);
  assert.equal(t.year, 2400);
  assert.equal(t.month, 200);
});
