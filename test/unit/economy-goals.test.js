'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');

const near = (actual, expected, tol = 0.5) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

const allOff = p => { for (const k of ['varyInflation', 'varyHouses', 'varySalaries', 'varyRates']) p.assumptions[k] = false; return p; };

test('expected economy: prices compound, no surprises', () => {
  const p = E.defaultPlan(2026);
  const e = E.expectedEcon(p, 10);
  near(e.price[10], Math.pow(1 + p.assumptions.inflation / 100, 10), 1e-12);
  assert.ok(Array.from(e.surprise).every(v => v === 1));
  assert.ok(Array.from(e.wage).every(v => v === 1));
  assert.ok(Array.from(e.house).every(v => v === 0));
});

test('random economy with everything switched off keeps inflation fixed', () => {
  const p = allOff(E.defaultPlan(2026));
  const draw = E.makeRandomEcon(p, 20, E.makeNormal(E.mulberry32(3)));
  const e = draw();
  assert.ok(Array.from(e.infl).every(v => Math.abs(v - p.assumptions.inflation / 100) < 1e-12));
  assert.ok(Array.from(e.house).every(v => v === 0));
  assert.ok(Array.from(e.rateShift).every(v => v === 0));
  assert.ok(Array.from(e.wage).every(v => v === 1));
});

test('random inflation averages out near its assumption', () => {
  const p = E.defaultPlan(2026);
  const draw = E.makeRandomEcon(p, 30, E.makeNormal(E.mulberry32(11)));
  let sum = 0, n = 0, min = 1, max = -1;
  for (let i = 0; i < 400; i++) {
    const e = draw();
    for (const v of e.infl) { sum += v; n++; min = Math.min(min, v); max = Math.max(max, v); }
  }
  near(sum / n, p.assumptions.inflation / 100, 0.002);
  assert.ok(min >= -0.02 && max > 0.05, 'inflation actually varies');
});

test('higher prices raise inflation-linked spending', () => {
  const p = E.defaultPlan(2026);
  const base = E.precompute(p);
  const econ = E.expectedEcon(p);
  for (let t = 1; t < econ.price.length; t++) { econ.price[t] *= 1.1; econ.surprise[t] = 1.1; }
  const hot = E.precompute(p, econ);
  near(hot.expenses[5], base.expenses[5] * 1.1, 1e-6);
});

test('variable mortgage rates only move after the fixed period', () => {
  const p = E.defaultPlan(2026);
  const debt = p.accounts.find(a => a.type === 'debt');
  debt.fixedUntil = 2030;
  const econ = E.expectedEcon(p);
  for (let t = 0; t < econ.rateShift.length; t++) econ.rateShift[t] = 0.02;
  const out = E.runPath(p, E.precompute(p, econ), E.newPath(econ.N, true, 2));
  near(out.debts[0].rate[4], debt.rate / 100, 1e-12); // 2030: still fixed (the fix runs through 2030)
  near(out.debts[0].rate[5], debt.rate / 100 + 0.02, 1e-12); // 2031: variable
  const baseFree = E.debtFreeYear(E.project(p));
  const rows = []; for (let t = 0; t <= econ.N; t++) rows.push({ debt: out.debt[t], year: 2026 + t });
  const shocked = (rows.find(r => r.debt <= 0.5) || {}).year;
  assert.ok(shocked > baseFree, `${shocked} should be after ${baseFree}`);
});

test('every account rolls forward: start + growth + in − out = end', () => {
  const p = E.defaultPlan(2026);
  p.household.people[0].extraPension = 200;
  p.events.push({ id: 'lump', name: 'Lump', kind: 'overpay', year: 2029, amount: 20000 });
  p.accounts.find(a => a.type === 'property').sellYear = 2060;
  const { rows } = E.project(E.normalizePlan(p));
  const flows = {
    cash: ['gCash', r => r.toCash + r.bondsMatured, r => r.wCash + r.sweepIsa + r.sweepGia],
    isa: ['gIsa', r => r.toIsa + r.sweepIsa + r.bondsToIsa + r.toLisa + r.lisaBonus, r => r.wIsa + r.wLisa + r.lisaHome],
    gia: ['gGia', r => r.toGia + r.sweepGia, r => r.wGia],
    pension: ['gPension', r => r.pensionIn, r => r.wPension],
    bonds: ['gBonds', () => 0, r => r.bondsMatured + r.bondsToIsa],
    property: ['gProperty', () => 0, r => r.propSold],
    debt: ['debtInterest', () => 0, r => r.debtRegular + r.overpay + r.lumpOverpay],
  };
  for (const [key, [g, inn, out]] of Object.entries(flows)) {
    for (let t = 0; t < rows.length - 1; t++) {
      const r = rows[t];
      near(r[key] + r[g] + inn(r) - out(r), rows[t + 1][key], 0.01);
    }
  }
});

test('extra pension saving costs take-home pay and adds 20% relief', () => {
  const p = E.defaultPlan(2026);
  const before = E.project(p).rows[0];
  p.household.people[0].extraPension = 100;
  const after = E.project(p).rows[0];
  near(after.pensionIn - before.pensionIn, 1200 / 0.8, 1e-6);
  near(after.extraPension, 1200, 1e-6);
  // Alex pays 42% (Scottish higher rate): the extra 22% comes back through self-assessment.
  near(after.pensionRelief, 1500 * 0.22, 0.01);
  near((before.toIsa + before.toGia + before.toCash) - (after.toIsa + after.toGia + after.toCash), 1200 - 330, 0.01);
  p.strategy.claimRelief = false;
  const unclaimed = E.project(p).rows[0];
  assert.equal(unclaimed.pensionRelief, 0);
  near((before.toIsa + before.toGia + before.toCash) - (unclaimed.toIsa + unclaimed.toGia + unclaimed.toCash), 1200, 0.01);
});

test('spending levers: before-retirement scale and retirement amount', () => {
  const p = E.defaultPlan(2026);
  const p1 = p.household.people[0];
  const base = E.precompute(p);
  p.strategy.spendNowPct = 80;
  p.strategy.retireSpending = 30000;
  const pre = E.precompute(p);
  near(pre.expenses[0], base.expenses[0] * 0.8, 1e-6);
  const tr = p1.retireAge - p1.age;
  near(pre.expenses[tr + 2], 30000 * pre.price[tr + 2], 1e-6);
});

test('lump-sum overpayment reduces the mortgage that year', () => {
  const p = E.defaultPlan(2026);
  const base = E.project(p).rows;
  p.events.push({ id: 'l', name: 'Lump', kind: 'overpay', year: 2028, amount: 30000 });
  const rows = E.project(E.normalizePlan(p)).rows;
  const r = rows.find(x => x.year === 2028);
  near(r.lumpOverpay, 30000 * r.deflator, 0.01);
  assert.ok(rows.find(x => x.year === 2029).debt < base.find(x => x.year === 2029).debt - 25000);
});

test('old single-goal plans migrate to the goals list', () => {
  const p = E.normalizePlan({ ...E.defaultPlan(2026), goals: undefined, goal: { amount: 500000, measure: 'noPension', basis: 'real' } });
  assert.equal(p.goals.length, 1);
  assert.equal(p.goals[0].type, 'netWorth');
  assert.equal(p.goals[0].amount, 500000);
  assert.equal(p.goals[0].measure, 'noPension');
  const none = E.normalizePlan({ ...E.defaultPlan(2026), goals: [] });
  assert.equal(none.goals.length, 0);
});

test('goal evaluation: probabilities, expected years and the retire goal', () => {
  const p = E.defaultPlan(2026);
  const proj = E.project(p);
  const mc = E.monteCarlo(p, 300, 5);
  const res = E.evaluateGoals(p, proj, mc, { runs: 300, seed: 5 });
  assert.equal(res.length, p.goals.length);
  for (const r of res) assert.ok(r.probability >= 0 && r.probability <= 1 && ['good', 'warn', 'bad'].includes(r.status));
  const retire = res.find(r => r.goal.type === 'retire');
  assert.equal(retire.probability, mc.successRate); // goal age equals the plan's age
  const debt = res.find(r => r.goal.type === 'debtFree');
  assert.equal(debt.expectedYear, E.debtFreeYear(proj));
  const noDebt = E.clonePlan(p);
  noDebt.accounts = noDebt.accounts.filter(a => a.type !== 'debt');
  const r2 = E.evaluateGoals(noDebt, E.project(noDebt), E.monteCarlo(noDebt, 100, 5)).find(r => r.goal.type === 'debtFree');
  assert.equal(r2.probability, 1);
});

test('solver: overpayment needed to be mortgage-free by a year', () => {
  const p = E.defaultPlan(2026);
  const target = 2040;
  const r = E.solveDebtFree(p, target);
  assert.ok(r.overpayPct > 0 && r.overpayPct <= 100);
  const q = E.clonePlan(p);
  q.strategy.overpayPct = r.overpayPct;
  if (r.capNeeded) q.strategy.overpayCapPct = 0;
  assert.ok(E.debtFreeYear(E.project(q)) <= target);
  q.strategy.overpayPct = r.overpayPct - 1;
  if (!r.capNeeded) assert.ok(E.debtFreeYear(E.project(q)) > target, 'smallest share that works');
});

test('solver: spending cut needed to reach an amount by a year', () => {
  const p = E.defaultPlan(2026);
  const goal = { id: 'g', type: 'netWorth', amount: 1000000, measure: 'all', basis: 'nominal', year: 2034 };
  const r = E.solveNetWorth(p, goal);
  assert.ok(r.spendNowPct > 0 && r.spendNowPct < 100 && r.monthlyCut > 0);
  const q = E.clonePlan(p);
  q.strategy.spendNowPct = r.spendNowPct;
  assert.ok(E.goalYear(goal, E.project(q)) <= 2034);
});

test('solver: affordable retirement spending at a confidence level', () => {
  const p = E.defaultPlan(2026);
  const r = E.solveRetirementSpending(p, 0.85, 200, 9);
  assert.ok(r.amount > 10000 && r.amount < 200000);
  const q = E.clonePlan(p);
  q.strategy.retireSpending = r.amount;
  assert.ok(E.successRate(q, 200, 9) >= 0.85);
  q.strategy.retireSpending = r.amount * 1.3;
  assert.ok(E.successRate(q, 200, 9) < 0.85);
});

test('stream bands bracket the expected path', () => {
  const p = E.defaultPlan(2026);
  const salary = p.income[0];
  const b = E.streamBands(p, salary, 300, 2);
  for (let t = 1; t < 10; t++) {
    assert.ok(b.nominal.p10[t] <= b.nominal.p50[t] && b.nominal.p50[t] <= b.nominal.p90[t]);
    assert.ok(b.nominal.p10[t] < b.expected[t] && b.expected[t] < b.nominal.p90[t]);
    near(b.expected[t], E.streamAt(salary, p, t), 1e-6);
  }
});

test('Monte Carlo reports today\'s-money series deflated by each run\'s prices', () => {
  const p = E.defaultPlan(2026);
  const mc = E.monteCarlo(p, 300, 4);
  const T = mc.years.length;
  assert.equal(mc.series.netWorth.real.p50.length, T);
  assert.ok(mc.series.netWorth.real.p50[T - 1] < mc.series.netWorth.nominal.p50[T - 1]);
  near(mc.series.netWorth.real.p50[0], E.project(p).rows[0].netWorth, 1e-6);
  assert.ok(mc.inflation.p10[10] < mc.inflation.p90[10]);
});
