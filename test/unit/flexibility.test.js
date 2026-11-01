'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine.js');

const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

function plan(extra = {}) {
  return E.normalizePlan({
    startYear: 2026,
    household: { region: 'scotland', people: [{ name: 'A', age: 40, retireAge: 65, endAge: 90 }] },
    accounts: [{ name: 'Cash', type: 'cash', balance: 10000 }, { name: 'ISA', type: 'isa', owner: 'p1', balance: 100000 }, { name: 'Pension', type: 'pension', owner: 'p1', balance: 100000 }],
    income: [{ name: 'Salary', owner: 'p1', kind: 'salary', tax: 'uk', amount: 60000, freq: 'year', growth: 0, startRef: 'now', endRef: 'retire' }],
    expenses: [{ name: 'Living', amount: 2000, freq: 'month', inflationLinked: true }],
    strategy: { cashReserve: 0 },
    assumptions: { inflation: 2, cashRate: 0 },
    ...extra,
  });
}

test('older files migrate to the new tax field', () => {
  const p = E.normalizePlan({ income: [
    { name: 'Old net pay', kind: 'salary', basis: 'net', amount: 1 },
    { name: 'Old gross pay', kind: 'salary', basis: 'gross', amount: 1 },
    { name: 'Old tax-free', kind: 'taxfree', amount: 1 },
  ] });
  assert.deepEqual(p.income.map(i => [i.kind, i.tax]), [['salary', 'none'], ['salary', 'uk'], ['other', 'none']]);
  assert.ok(p.income.every(i => i.fx === 1 && i.costPct === 0 && i.fixedCosts === 0 && i.basis === undefined));
});

test('switching UK tax off removes income tax, NI and CGT', () => {
  const p = plan();
  assert.ok(E.project(p).rows[0].taxes > 10000);
  p.household.ignoreTax = true;
  const rows = E.project(p).rows;
  assert.ok(rows.every(r => r.taxes === 0));
  assert.ok(rows.every(r => r.cgt === 0));
});

test('rent with exchange rate, costs and flat tax matches the spreadsheet formula', () => {
  const p = plan({ income: [{ name: 'Rent', owner: 'joint', kind: 'rental', tax: 'flat', taxRate: 10, costPct: 10, fx: 0.84, amount: 1148, freq: 'month', growth: 2.5, startRef: 'now', endRef: 'end' }] });
  const r = E.project(p).rows;
  const net0 = 1148 * 12 * 0.84 * 0.9; // after costs, before the flat tax
  near(E.incomeAfterCosts(p.income[0], p, 0), net0);
  near(r[0].otherIncome, net0);
  near(r[0].flatTax, net0 * 0.1);
  near(r[0].taxes, net0 * 0.1);
  near(r[0].otherIncome - r[0].flatTax, 9373.1904, 0.001); // the workbook's yearly rent
  near(E.incomeAfterCosts(p.income[0], p, 3), net0 * Math.pow(1.025, 3), 1e-6);
});

test('fixed costs rise with prices', () => {
  const p = plan({ income: [{ name: 'Rent', owner: 'joint', kind: 'rental', tax: 'none', amount: 1000, freq: 'month', growth: 0, fixedCosts: 1200, startRef: 'now', endRef: 'end' }] });
  near(E.incomeAfterCosts(p.income[0], p, 0), 12000 - 1200);
  near(E.incomeAfterCosts(p.income[0], p, 5), 12000 - 1200 * Math.pow(1.02, 5), 1e-6);
});

test('a gift or already-taxed income adds no tax even with UK tax on', () => {
  const base = plan();
  const p = plan({ income: base.income.concat([{ name: 'Gift', owner: 'p1', kind: 'other', tax: 'none', amount: 10000, freq: 'year', startRef: 'now', endRef: 'end' }]) });
  near(E.project(p).rows[0].taxes, E.project(base).rows[0].taxes);
  const taxed = plan({ income: base.income.concat([{ name: 'Side', owner: 'p1', kind: 'other', tax: 'uk', amount: 10000, freq: 'year', startRef: 'now', endRef: 'end' }]) });
  near(E.project(taxed).rows[0].taxes - E.project(base).rows[0].taxes, 4200); // 42% higher-rate band in Scotland
});

test('excluded accounts are ignored entirely', () => {
  const p = plan();
  const before = E.project(p).rows[0].netWorth;
  p.accounts[1].excluded = true;
  near(before - E.project(p).rows[0].netWorth, 100000);
});

test('own return assumptions replace the mix in projections and centre simulations', () => {
  const p = plan();
  p.assumptions.investReturn = 10;
  p.assumptions.pensionReturn = 7;
  const r = E.project(p).rows[0];
  near(r.gIsa, r.isa * 0.10, 1e-6);
  near(r.gPension, r.pension * 0.07, 1e-6);
  for (const k of ['stockVolatility', 'bondVolatility']) p.assumptions[k] = 0;
  for (const k of ['varyInflation', 'varyHouses', 'varySalaries', 'varyRates']) p.assumptions[k] = false;
  const mc = E.monteCarlo(p, 10, 1);
  const proj = E.project(p);
  near(mc.series.liquid.nominal.p50[10], proj.rows[10].liquid, 1e-3);
});

test('cash flow still balances with flat taxes and costs', () => {
  const p = plan({ income: [
    { name: 'Salary', owner: 'p1', kind: 'salary', tax: 'flat', taxRate: 25, amount: 50000, freq: 'year', startRef: 'now', endRef: 'retire' },
    { name: 'Rent', owner: 'joint', kind: 'rental', tax: 'flat', taxRate: 10, costPct: 10, fx: 0.84, amount: 1148, freq: 'month', startRef: 'now', endRef: 'end' },
  ] });
  for (const r of E.project(p).rows.slice(0, -1)) {
    const inflow = r.earnings + r.otherIncome + r.statePension + r.withdrawals + r.unfunded;
    const outflow = r.spending + r.taxes + r.debtPay + r.saved;
    near(inflow, outflow, 0.01);
  }
});
