'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../../src/uk-rules.js');

const near = (actual, expected, tol = 0.01) =>
  assert.ok(Math.abs(actual - expected) <= tol, `expected ${expected}, got ${actual}`);

test('no income tax within the personal allowance', () => {
  assert.equal(R.incomeTax(12570, 'scotland'), 0);
  assert.equal(R.incomeTax(12570, 'ruk'), 0);
  assert.equal(R.incomeTax(0, 'scotland'), 0);
});

test('Scottish income tax 2026/27 by hand', () => {
  // £30,000: starter 3,967 @19% + basic 12,989 @20% + intermediate 474 @21%
  near(R.incomeTax(30000, 'scotland'), 3967 * 0.19 + 12989 * 0.20 + 474 * 0.21);
  // £60,000 reaches the higher band
  near(R.incomeTax(60000, 'scotland'), 3967 * 0.19 + 12989 * 0.20 + 14136 * 0.21 + (60000 - 43662) * 0.42);
  // Top rate above £125,140 (no personal allowance left)
  const at150 = R.incomeTax(150000, 'scotland');
  const at151 = R.incomeTax(151000, 'scotland');
  near(at151 - at150, 480);
});

test('rest-of-UK income tax including the allowance taper', () => {
  near(R.incomeTax(30000, 'ruk'), (30000 - 12570) * 0.20);
  near(R.incomeTax(60000, 'ruk'), 37700 * 0.20 + (60000 - 50270) * 0.40);
  // £110,000: allowance reduced by £5,000 to £7,570
  near(R.incomeTax(110000, 'ruk'), 37700 * 0.20 + (110000 - 7570 - 37700) * 0.40);
  // 60% effective marginal rate inside the taper
  near(R.incomeTax(110100, 'ruk') - R.incomeTax(110000, 'ruk'), 60);
});

test('Scottish band table matches the published thresholds', () => {
  const rows = R.bandTable('scotland');
  const byName = Object.fromEntries(rows.map(r => [r.name, r]));
  assert.equal(byName.Starter.to, 16537);
  assert.equal(byName.Basic.to, 29526);
  assert.equal(byName.Intermediate.to, 43662);
  assert.equal(byName.Higher.to, 75000);
  assert.equal(byName.Advanced.to, 125140);
  assert.equal(byName.Top.to, Infinity);
});

test('thresholds scale with the threshold factor', () => {
  near(R.incomeTax(20000 * 1.1, 'ruk', 1.1), R.incomeTax(20000, 'ruk') * 1.1);
});

test('employee National Insurance', () => {
  assert.equal(R.nationalInsurance(12570), 0);
  near(R.nationalInsurance(30000), (30000 - 12570) * 0.08);
  near(R.nationalInsurance(60000), 37700 * 0.08 + (60000 - 50270) * 0.02);
});

test('capital gains tax uses the exemption and UK bands', () => {
  assert.equal(R.capitalGainsTax(3000, 20000), 0);
  // Low income: whole gain in the basic band
  near(R.capitalGainsTax(13000, 20000), 10000 * 0.18);
  // Higher-rate taxpayer: all at 24%
  near(R.capitalGainsTax(13000, 80000), 10000 * 0.24);
  // Straddling the basic band limit
  const income = 45000; // taxable 32,430 → 5,270 of basic band left
  near(R.capitalGainsTax(13000, income), 5270 * 0.18 + (10000 - 5270) * 0.24);
});

test('State Pension age by birth year', () => {
  assert.equal(R.statePensionAge(1955), 66);
  assert.equal(R.statePensionAge(1970), 67);
  assert.equal(R.statePensionAge(1988), 68);
});

test('2026/27 headline constants', () => {
  near(R.STATE_PENSION_FULL, 12547.6);
  assert.equal(R.ISA_ALLOWANCE, 20000);
  assert.equal(R.MIN_PENSION_AGE, 57);
  assert.equal(R.LUMP_SUM_ALLOWANCE, 268275);
});
