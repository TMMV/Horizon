'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const R = require('../../src/uk-rules');
const H = require('../../data/history.js');

const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg || ''} ${a} vs ${b}`);

test('bundled history covers 1928 onwards with sensible values', () => {
  assert.equal(H.years[0], 1928);
  assert.ok(H.years.length >= 97);
  for (const k of ['stocksReal', 'bondsReal', 'ukInflation']) {
    assert.equal(H[k].length, H.years.length, k);
    assert.ok(H[k].every(v => Number.isFinite(v) && v > -0.6 && v < 0.7), k);
  }
  const at = (k, y) => H[k][H.years.indexOf(y)];
  assert.ok(at('stocksReal', 2008) < -0.3, '2008 crash');
  assert.ok(at('ukInflation', 1975) > 0.2, '1975 UK inflation');
  const geo = a => Math.pow(a.reduce((p, v) => p * (1 + v), 1), 1 / a.length) - 1;
  assert.ok(geo(H.stocksReal) > 0.05 && geo(H.stocksReal) < 0.08);
});

test('a historical economy replays real returns on top of UK inflation', () => {
  const p = E.defaultPlan(2026);
  const s = H.years.indexOf(1973);
  const e = E.historicalEcon(p, 10, H, s);
  const w = e.stockW[0];
  const k = s;
  const expect = w * ((1 + H.stocksReal[k]) * (1 + H.ukInflation[k]) - 1) + (1 - w) * ((1 + H.bondsReal[k]) * (1 + H.ukInflation[k]) - 1);
  near(e.ret[0], expect, 1e-12);
  near(e.price[1], 1 + H.ukInflation[k], 1e-12);
  // Wraps round after the last year.
  const last = E.historicalEcon(p, 3, H, H.years.length - 1);
  near(last.infl[1], H.ukInflation[0], 1e-12);
});

test('replaying every start year: bad starts end with less', () => {
  const p = E.defaultPlan(2026);
  const r = E.historicalRuns(p, H);
  assert.equal(r.starts.length, H.years.length);
  assert.ok(r.complete > 20 && r.complete < H.years.length);
  const end = y => r.starts.find(x => x.year === y).endReal;
  assert.ok(end(1929) < end(1982), '1929 is a worse start than 1982');
  for (const g of p.goals) assert.ok(r.goalRates[g.id] >= 0 && r.goalRates[g.id] <= 1);
  assert.equal(r.bands.p50.length, r.years.length);
  // A plan that spends far too much fails in every history.
  const q = E.clonePlan(p);
  q.strategy.retireSpending = 400000;
  const bad = E.historicalRuns(E.normalizePlan(q), H);
  assert.ok(bad.successRate < 0.05);
  assert.ok(bad.starts.every(x => x.success || x.failYear > q.startYear));
});

test('Lifetime ISA: 25% bonus, shares the ISA allowance, stops at 50', () => {
  const p = E.defaultPlan(2026);
  p.accounts.push({ id: 'lisa', name: 'LISA', type: 'lisa', owner: 'p1', balance: 0 });
  const q = E.normalizePlan(p);
  assert.equal(q.accounts.find(a => a.id === 'lisa').contribution, 4000);
  const rows = E.project(q).rows;
  const base = E.project(E.defaultPlan(2026)).rows;
  near(rows[0].toLisa, 4000, 0.01);
  near(rows[0].lisaBonus, 1000, 0.01);
  near(rows[0].toIsa + rows[0].toLisa, base[0].toIsa, 0.01, 'same total into ISAs');
  assert.ok(rows[1].isa > base[1].isa, 'the bonus is extra');
  const p1 = q.household.people[0];
  const t50 = 50 - p1.age;
  assert.equal(rows[t50].toLisa, 0, 'no payments from 50');
  assert.ok(rows[t50 - 1].toLisa > 0);
});

test('Lifetime ISA for a first home pays out that year', () => {
  const p = E.defaultPlan(2026);
  p.accounts.push({ id: 'lisa', name: 'LISA', type: 'lisa', owner: 'p1', balance: 10000, purpose: 'home', homeYear: 2029 });
  const rows = E.project(E.normalizePlan(p)).rows;
  const t = 2029 - 2026;
  assert.ok(rows[t].lisaHome > 10000, `${rows[t].lisaHome}`);
  assert.equal(rows[t].toLisa, 0, 'no more payments in or after the purchase year');
  assert.equal(rows[t + 1].lisaHome, 0);
});

test('Lifetime ISA can only be opened before 40', () => {
  const p = E.defaultPlan(2026);
  p.household.people[0].age = 42;
  p.accounts.push({ id: 'lisa', name: 'LISA', type: 'lisa', owner: 'p1', balance: 0 });
  const q = E.normalizePlan(p);
  assert.equal(E.project(q).rows[0].toLisa, 0);
  assert.ok(E.validatePlan(q).some(w => w.includes('before 40')));
});

test('higher-rate relief follows the marginal rate, including the £100k trap', () => {
  const relief = (salary, region, extra) => {
    const p = E.defaultPlan(2026);
    p.household.region = region;
    p.income[0].amount = salary;
    p.income[0].employeePension = 0;
    p.household.people[0].extraPension = extra;
    return E.project(E.normalizePlan(p)).rows[0].pensionRelief;
  };
  near(relief(25000, 'scotland', 100), 0, 0.01, 'basic rate: nothing more to claim');
  near(relief(40000, 'scotland', 100), 1500 * 0.01, 0.01, 'Scottish intermediate rate: 1%');
  near(relief(65000, 'ruk', 100), 1500 * 0.20, 0.01, 'rUK higher rate: 20%');
  // £110k in rUK: paying £10k gross restores £5k of personal allowance too (60% effective).
  near(relief(110000, 'ruk', 8000 / 12), 10000 * 0.40, 1, 'inside the taper');
  assert.equal(R.LISA.bonus, 0.25);
});
