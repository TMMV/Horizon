'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const S = require('../../src/scenario-ideas');

test('goals get a name, a lasting colour and an icon', () => {
  const p = E.defaultPlan(2026);
  const colours = p.goals.map(g => g.color);
  assert.deepEqual(colours, [0, 1, 2]);
  assert.deepEqual(p.goals.map(g => g.icon), ['goal', 'debt', 'retire']);
  // Removing a goal does not repaint the others; a new goal takes the free slot.
  const q = E.clonePlan(p);
  q.goals.splice(0, 1);
  q.goals.push({ type: 'netWorth', measure: 'savings', name: 'House deposit', amount: 40000, year: 2031, basis: 'real' });
  const n = E.normalizePlan(q);
  assert.deepEqual(n.goals.map(g => g.color), [1, 2, 0]);
  assert.equal(n.goals[2].icon, 'piggy');
  assert.equal(E.goalTitle(n.goals[2], n), 'House deposit');
  assert.equal(E.autoTitle(n.goals[2], n), '£40K saved by 2031');
});

test('a market crash lowers that year’s return in every economy', () => {
  const p = E.defaultPlan(2026);
  p.assumptions.crashYear = 2027;
  const e = E.expectedEcon(p);
  const base = E.expectedEcon(E.defaultPlan(2026));
  assert.ok(Math.abs(e.ret[1] - (base.ret[1] + e.stockW[1] * -0.3)) < 1e-12);
  assert.equal(e.ret[2], base.ret[2]);
  const a = E.project(p).rows[3].isa, b = E.project(E.defaultPlan(2026)).rows[3].isa;
  assert.ok(a < b * 0.85);
});

test('every scenario idea that applies produces a valid, different plan', () => {
  const p = E.defaultPlan(2026);
  const base = E.project(p).rows;
  const ideas = S.ideasFor(p);
  assert.ok(ideas.length >= 10);
  for (const idea of ideas) {
    const v = S.variantOf(idea, p);
    assert.ok(S.textOf(idea, p).length > 5, idea.id);
    const rows = E.project(v).rows;
    const differs = rows.some((r, t) => Math.abs(r.netWorth - base[t].netWorth) > 1);
    assert.ok(differs, `${idea.id} changes the projection`);
  }
  assert.equal(JSON.stringify(E.project(p).rows[5].netWorth), JSON.stringify(base[5].netWorth), 'the original is untouched');
});

test('a year out pauses one salary for exactly one year', () => {
  const p = E.defaultPlan(2026);
  const v = S.variantOf(S.IDEAS.find(i => i.id === 'career-break'), p);
  const pre0 = E.precompute(p), pre1 = E.precompute(v);
  const who = 1; // the partner
  const pay = pre => [0, 1, 2, 3].map(t => pre.people[who].gross[t] + pre.people[who].netPay[t]);
  const a = pay(pre0), b = pay(pre1);
  assert.ok(Math.abs(a[0] - b[0]) < 1);
  assert.equal(b[1], 0);
  assert.ok(Math.abs(a[2] - b[2]) < 1 && Math.abs(a[3] - b[3]) < 1);
});

test('drivers show how typical choices move each goal', () => {
  const p = E.defaultPlan(2026);
  const r = S.driverImpacts(p, 150, 9);
  assert.equal(r.base.length, p.goals.length);
  const row = k => r.rows.find(x => x.driver.key === k);
  const retireGoal = p.goals.findIndex(g => g.type === 'retire');
  assert.ok(row('retireLater').deltas[retireGoal] >= 0, 'working longer helps retirement');
  assert.ok(row('weakMarkets').deltas[retireGoal] <= 0, 'weaker markets hurt');
  const debtGoal = p.goals.findIndex(g => g.type === 'debtFree');
  assert.ok(row('overpay').deltas[debtGoal] > 0, 'overpaying helps mortgage-free');
});
