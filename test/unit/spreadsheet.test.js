'use strict';
// Horizon set up with spreadsheet-style simplifications must reproduce a plain
// year-by-year spreadsheet exactly. The figures here are fictional.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const E = require('../../src/engine.js');

const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `expected ${b}, got ${a}`);

test('a spreadsheet-style plan matches hand-written spreadsheet formulas', () => {
  const plan = E.normalizePlan({
    startYear: 2026,
    household: { region: 'scotland', ignoreTax: true, people: [
      { name: 'A', age: 40, retireAge: 70, endAge: 90 }, { name: 'B', age: 40, retireAge: 70, endAge: 90 },
    ] },
    accounts: [
      { name: 'Invested', type: 'isa', owner: 'p1', balance: 20000 },
      { name: 'Home', type: 'property', balance: 300000, rate: 3 },
      { name: 'Mortgage', type: 'debt', balance: 200000, rate: 4, payment: 1500 },
    ],
    income: [
      { name: 'Pay A', owner: 'p1', kind: 'salary', tax: 'none', amount: 3000, freq: 'month', growth: 4, startRef: 'now', endRef: 'retire' },
      { name: 'Pay B', owner: 'p2', kind: 'salary', tax: 'none', amount: 2000, freq: 'month', growth: 4, startRef: 'now', endRef: 'retire' },
      { name: 'Rent', owner: 'joint', kind: 'rental', tax: 'flat', taxRate: 10, costPct: 10, fx: 0.85, amount: 1000, freq: 'month', growth: 2, startRef: 'now', endRef: 'end' },
    ],
    expenses: [{ name: 'Living', amount: 2500, freq: 'month', inflationLinked: true, startRef: 'now', endRef: 'end' }],
    strategy: { cashReserve: 0, isaAllowance: 1e9 },
    assumptions: { inflation: 3, investReturn: 8, cashRate: 0 },
  });
  const rows = E.project(plan).rows;

  // The spreadsheet: one row per year, balances at the start of the year.
  let invested = 20000, home = 300000, debt = 200000;
  for (let t = 0; t < 25; t++) {
    near(rows[t].isa + rows[t].gia, invested, 0.01);
    near(rows[t].property, home, 1e-6);
    near(rows[t].debt, debt, 1e-6);
    const pay = (3000 + 2000) * 12 * Math.pow(1.04, t);
    const rent = 1000 * 12 * 0.85 * 0.9 * 0.9 * Math.pow(1.02, t);
    const living = 2500 * 12 * Math.pow(1.03, t);
    const interest = debt * 0.04;
    const mortgagePaid = Math.min(18000, debt + interest);
    const surplus = pay + rent - living - mortgagePaid;
    invested = invested * 1.08 + surplus;
    home *= 1.03;
    debt = debt + interest - mortgagePaid;
  }
});

test('the bundled example plan file imports cleanly', () => {
  const file = path.join(__dirname, '../../plans/example.json');
  const ws = E.normalizeWorkspace(JSON.parse(fs.readFileSync(file, 'utf8')));
  assert.equal(ws.scenarios.length, 1);
  assert.ok(ws.scenarios[0].plan.goals.length >= 1);
  assert.ok(E.project(ws.scenarios[0].plan).rows.length > 10);
});

test('a full workspace survives export and import unchanged', () => {
  const ws = E.normalizeWorkspace(E.defaultWorkspace());
  ws.settings = { realDollars: false, runs: 2000, seed: 7, theme: 'dark', confidence: 85, lastSaved: '2026-11-01', showTo: 0 };
  ws.scenarios[0].plan.household.ignoreTax = true;
  ws.scenarios[0].plan.assumptions.investReturn = 9.5;
  ws.scenarios[0].plan.accounts[0].excluded = true;
  ws.checkins.push(E.makeCheckin(ws.scenarios[0].plan, 'Base', '2026-11-01'));
  const again = E.normalizeWorkspace(JSON.parse(JSON.stringify(ws)));
  assert.deepEqual(again, ws);
});
