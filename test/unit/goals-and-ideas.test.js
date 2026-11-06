'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const S = require('../../src/scenario-ideas');
const SI = S;
const L = require('../../src/levers');

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

test('retiring earlier or later moves the retirement goal with it', () => {
  const p = E.defaultPlan(2026);
  const goal = p.goals.find(g => g.type === 'retire');
  const later = SI.variantOf(SI.DRIVERS.find(d => d.key === 'retireLater'), p);
  assert.equal(later.goals.find(g => g.type === 'retire').age, goal.age + 2);
  const idea = SI.IDEAS.find(x => x.id === 'retire-early');
  const early = SI.variantOf(idea, p);
  assert.equal(early.household.people[0].retireAge, p.household.people[0].retireAge - 3);
  assert.equal(early.goals.find(g => g.type === 'retire').age, goal.age - 3);
  // The lever does the same for the first person.
  const v = L.currentValues(p);
  v.retireAge0 = p.household.people[0].retireAge + 4;
  assert.equal(L.apply(p, v).goals.find(g => g.type === 'retire').age, goal.age + 4);
});

test('comparisons: salary sacrifice or Lifetime ISA costs the same take-home pay', () => {
  const p = E.defaultPlan(2026);
  const ids = SI.comparisonsFor(p).map(c => c.id);
  assert.deepEqual(ids, ['sacrifice-lisa', 'pension-isa', 'overpay-invest', 'retire-when', 'markets', 'mortgage-rate']);
  const c = SI.COMPARISONS.find(x => x.id === 'sacrifice-lisa');
  const [lisa, sac] = SI.optionsOf(c, p);
  assert.equal(lisa.name, 'Lifetime ISA');
  const l = lisa.plan.accounts.find(a => a.type === 'lisa');
  assert.equal(l.owner, 'p1');
  assert.equal(l.contribution, E.R.LISA.maxContribution);
  // Salary sacrifice: no Lifetime ISA, and the pension costs £4,000 of take-home pay until 50.
  assert.equal(sac.plan.accounts.some(a => a.type === 'lisa'), false);
  assert.ok(Math.abs(SI.takeHome(p, 0) - SI.takeHome(sac.plan, 0) - E.R.LISA.maxContribution) < 15);
  const pay = sac.plan.income.filter(i => i.owner === 'p1' && i.kind === 'salary');
  assert.equal(pay.length, 2);
  assert.equal(pay[0].endAge, 50);
  assert.equal(pay[1].startAge, 50);
  assert.equal(pay[1].employeePension, p.income[0].employeePension);
  assert.ok(pay[0].employeePension > p.income[0].employeePension);
  // Both pay the same into the ISAs each month now (the Lifetime ISA comes out of the surplus).
  const m = q => E.monthlyPlan(E.project(q));
  assert.ok(Math.abs(m(lisa.plan).invest - m(p).invest) < 1);
  assert.ok(m(lisa.plan).lisa > 300);
});

test('comparisons: options that change nothing are left out, and some need a mortgage or a salary', () => {
  const p = E.defaultPlan(2026);
  const c = SI.COMPARISONS.find(x => x.id === 'overpay-invest');
  assert.deepEqual(SI.optionsOf(c, p).map(o => o.name), ['Overpay with all of it']);   // already invests it
  const q = E.clonePlan(p);
  q.accounts = q.accounts.filter(a => a.type !== 'debt');
  q.household.ignoreTax = true;   // no taxed pay, so no salary sacrifice
  const ids = SI.comparisonsFor(E.normalizePlan(q)).map(x => x.id);
  assert.deepEqual(ids, ['retire-when', 'markets']);
  // Over 40 without a Lifetime ISA: pension or ISA, but no Lifetime ISA.
  const r = E.clonePlan(p);
  r.household.people.forEach(x => { x.age += 5; });
  assert.deepEqual(SI.comparisonsFor(E.normalizePlan(r)).map(x => x.id).slice(0, 2), ['pension-isa', 'overpay-invest']);
});

test('a Lifetime ISA grows once: ISA balances add up year by year', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  p.accounts.push({ id: 'l1', name: 'LISA', type: 'lisa', owner: 'p1', balance: 10000, contribution: 4000, purpose: 'retirement' });
  const rows = E.project(E.normalizePlan(p)).rows;
  for (let t = 0; t < rows.length - 1; t++) {
    const r = rows[t];
    const inn = r.toIsa + r.sweepIsa + r.bondsToIsa + r.toLisa + r.lisaBonus;
    const out = r.wIsa + r.wLisa + r.lisaHome;
    assert.ok(Math.abs(r.isa + r.gIsa + inn - out - rows[t + 1].isa) < 1, `year ${r.year}`);
  }
});

test('comparisons: salary sacrifice also works on pay entered as take-home', () => {
  const p = E.clonePlan(E.defaultPlan(2026));
  Object.assign(p.income[0], { tax: 'none', amount: 3800, freq: 'month', pensionMode: 'fixed', employeePension: 300, employerPension: 300, sacrifice: false });
  const q = E.normalizePlan(p);
  const c = SI.COMPARISONS.find(x => x.id === 'sacrifice-lisa');
  const sac = SI.optionsOf(c, q).find(o => o.name === 'Salary sacrifice');
  assert.match(sac.text, /tax estimated from take-home pay/);
  const pay = sac.plan.income.filter(i => i.owner === 'p1' && i.kind === 'salary');
  const net0 = E.incomeAfterCosts(q.income[0], q, 0), net1 = E.incomeAfterCosts(pay[0], sac.plan, 0);
  assert.ok(Math.abs(net0 - net1 - E.R.LISA.maxContribution) < 10);   // the sacrifice is rounded to £10
  const extra = (pay[0].employeePension - 300) * 12;
  assert.ok(extra > 5000 && extra < 8000, String(extra));   // tax and NI relief on top
  assert.equal(pay[1].amount, 3800);   // from 50 the pay is back to normal
});
