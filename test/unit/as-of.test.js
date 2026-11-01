'use strict';

// Figures "as at" a date, estimates for any other date, balances read between reviews,
// and the yearly review starting from those estimates.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const RV = require('../../src/review');

function workspace(asOf) {
  const ws = E.defaultWorkspace();
  const p = ws.scenarios[0].plan;
  p.asOf = asOf || `${p.startYear}-10-15`;
  return ws;
}

test('years between dates count whole anniversaries', () => {
  assert.equal(RV.yearsBetween('2026-10-15', '2027-10-15'), 1);
  assert.equal(RV.yearsBetween('2026-10-15', '2026-10-15'), 0);
  assert.equal(RV.yearsBetween('2027-01-01', '2026-01-01'), 0, 'earlier dates count as 0');
  const half = RV.yearsBetween('2026-01-01', '2026-07-02');
  assert.ok(half > 0.49 && half < 0.51, String(half));
});

test('estimates sit between the projected years, and on the figures date equal the figures', () => {
  const p = workspace().scenarios[0].plan;
  const proj = E.project(p);
  const at0 = RV.estimateAt(p, p.asOf, proj);
  for (const a of p.accounts) assert.ok(Math.abs(at0.byId[a.id] - a.balance) < 0.01, a.name);
  assert.ok(Math.abs(at0.netWorth - proj.rows[0].netWorth) < 1);
  assert.equal(Object.values(at0.source).every(s => s === 'figures'), true);

  const y = p.startYear;
  const at1 = RV.estimateAt(p, `${y + 1}-10-15`, proj);
  assert.ok(Math.abs(at1.netWorth - proj.rows[1].netWorth) < 1, 'a year on matches the next projected year');
  const mid = RV.estimateAt(p, `${y + 1}-04-15`, proj);
  const lo = Math.min(proj.rows[0].netWorth, proj.rows[1].netWorth), hi = Math.max(proj.rows[0].netWorth, proj.rows[1].netWorth);
  assert.ok(mid.netWorth > lo && mid.netWorth < hi, 'half way is in between');
  assert.equal(mid.source[p.accounts[0].id], 'estimate');
});

test('a balance read since the figures date moves the estimate', () => {
  const p = workspace().scenarios[0].plan;
  const isa = p.accounts.find(a => a.type === 'isa');
  const y = p.startYear;
  const plain = RV.estimateAt(p, `${y + 1}-04-15`);
  isa.latest = { value: plain.byId[isa.id] + 5000, date: `${y + 1}-04-15` };
  const same = RV.estimateAt(p, `${y + 1}-04-15`);
  assert.equal(same.source[isa.id], 'updated');
  assert.ok(Math.abs(same.byId[isa.id] - isa.latest.value) < 0.01);
  assert.ok(Math.abs(same.netWorth - plain.netWorth - 5000) < 1);
  // Later on, the reading is moved on the way the plan expects (roughly the same lead).
  const later = RV.estimateAt(p, `${y + 1}-10-15`);
  assert.equal(later.source[isa.id], 'updatedEstimate');
  assert.ok(later.byId[isa.id] > RV.estimateAt({ ...p, accounts: p.accounts.map(a => ({ ...a, latest: null })) }, `${y + 1}-10-15`).byId[isa.id] + 4000);
  // A reading from before the figures date is ignored.
  isa.latest = { value: 1, date: `${y - 1}-01-01` };
  assert.equal(RV.estimateAt(p, `${y + 1}-04-15`).source[isa.id], 'estimate');
});

test('readings are recorded in every scenario with the same account', () => {
  const ws = workspace();
  ws.scenarios.push({ id: 'copy', name: 'Copy', plan: E.clonePlan(ws.scenarios[0].plan) });
  const isa = ws.scenarios[0].plan.accounts.find(a => a.type === 'isa');
  const out = RV.recordReadings(ws, { [isa.id]: 31000 }, '2027-03-01');
  for (const s of out.scenarios) assert.deepEqual(s.plan.accounts.find(a => a.id === isa.id).latest, { value: 31000, date: '2027-03-01' });
  assert.equal(ws.scenarios[0].plan.accounts.find(a => a.id === isa.id).latest, null, 'the original is untouched');
  // Readings survive saving and loading.
  const back = E.normalizeWorkspace(JSON.parse(JSON.stringify(out)));
  assert.deepEqual(back.scenarios[1].plan.accounts.find(a => a.id === isa.id).latest, { value: 31000, date: '2027-03-01' });
});

test('the review starts from estimates for its date, uses readings, and can be re-dated', () => {
  const ws = workspace();
  const p = ws.scenarios[0].plan;
  const y = p.startYear;
  const isa = p.accounts.find(a => a.type === 'isa');
  const cash = p.accounts.find(a => a.type === 'cash');
  isa.latest = { value: 40000, date: `${y + 1}-06-01` };
  const d = RV.start(ws, { year: y + 1, date: `${y + 1}-10-15` });
  assert.equal(d.date, `${y + 1}-10-15`);
  assert.equal(d.plan.asOf, d.date);
  assert.ok(d.readings[isa.id], 'the reading is used');
  assert.equal(d.touched.accounts[isa.id], true);
  assert.ok(d.plan.accounts.find(a => a.id === isa.id).balance > 40000);
  assert.ok(d.plan.accounts.every(a => a.latest === null), 'the reviewed plan carries no readings');
  // A hand-entered balance survives a change of date; estimates move.
  RV.setValue(d, 'accounts', cash.id, 12345);
  const before = d.expected.accounts[p.accounts.find(a => a.type === 'pension').id];
  RV.setDate(d, `${y + 1}-12-31`);
  assert.equal(d.plan.accounts.find(a => a.id === cash.id).balance, 12345);
  assert.notEqual(d.expected.accounts[p.accounts.find(a => a.type === 'pension').id], before);
  assert.equal(d.plan.asOf, `${y + 1}-12-31`);
});

test('applying a review moves every scenario’s figures date and clears readings', () => {
  const ws = workspace();
  ws.scenarios.push({ id: 'copy', name: 'Copy', plan: E.clonePlan(ws.scenarios[0].plan) });
  ws.scenarios[1].plan.accounts[0].latest = { value: 1, date: `${ws.scenarios[0].plan.startYear}-12-01` };
  const y = ws.scenarios[0].plan.startYear + 1;
  const d = RV.start(ws, { year: y, date: `${y}-10-20` });
  const out = RV.apply(ws, d, {});
  for (const s of out.scenarios) {
    assert.equal(s.plan.asOf, `${y}-10-20`);
    assert.ok(s.plan.accounts.every(a => a.latest === null));
  }
  assert.equal(out.checkins.at(-1).date, `${y}-10-20`, 'the check-in is dated as at the review');
});

test('plans saved before figures had a date get one: the check-in for that year, or 1 January', () => {
  const ws = E.defaultWorkspace();
  const p = ws.scenarios[0].plan;
  const raw = JSON.parse(JSON.stringify(ws));
  delete raw.scenarios[0].plan.asOf;
  raw.scenarios[0].plan.startYear = 2020;
  assert.equal(E.normalizeWorkspace(raw).scenarios[0].plan.asOf, '2020-01-01');
  raw.checkins = [E.makeCheckin({ ...E.clonePlan(p), startYear: 2020 }, 'Base plan', '2020-10-28')];
  assert.equal(E.normalizeWorkspace(raw).scenarios[0].plan.asOf, '2020-10-28');
  assert.equal(E.normalizeWorkspace({ ...raw, scenarios: [{ ...raw.scenarios[0], plan: { ...raw.scenarios[0].plan, asOf: 'not a date' } }] }).scenarios[0].plan.asOf, '2020-10-28');
});

test('the last-saved date is kept with the settings', () => {
  const ws = E.defaultWorkspace();
  assert.equal(ws.settings.lastSaved, null);
  ws.settings.lastSaved = '2026-11-01';
  assert.equal(E.normalizeWorkspace(JSON.parse(JSON.stringify(ws))).settings.lastSaved, '2026-11-01');
  ws.settings.lastSaved = 'yesterday';
  assert.equal(E.normalizeWorkspace(JSON.parse(JSON.stringify(ws))).settings.lastSaved, null);
});

test('each amount and emergency goal gets its own range in the simulations', () => {
  const p = E.defaultPlan();
  p.goals.push(E.normalizeGoal({ type: 'emergency', months: 6, year: p.startYear + 2 }, p.startYear, p.household.people[0]));
  const mc = E.monteCarlo(p, 200, 3);
  for (const g of p.goals.filter(x => x.type === 'netWorth' || x.type === 'emergency')) {
    const b = mc.goalBands[g.id];
    assert.ok(b && b.real.p50.length === mc.years.length, g.type);
    for (let t = 0; t < mc.years.length; t++) assert.ok(b.nominal.p10[t] <= b.nominal.p90[t] + 1e-6);
  }
  assert.equal(mc.goalBands[p.goals.find(x => x.type === 'retire').id], undefined);
});
