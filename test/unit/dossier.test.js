'use strict';

// The dossier: the plan written out year by year. Its figures must be the projection's own.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const D = require('../../src/dossier');
const Q = require('../../src/quick-start');

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
const sum = lines => lines.reduce((a, l) => a + l.value, 0);

function doc(plan, opts = {}) {
  const proj = E.project(plan), mc = E.monteCarlo(plan, 120, 7);
  const goals = E.evaluateGoals(plan, proj, mc, { runs: 120, seed: 7 });
  return { d: D.build(plan, proj, mc, goals, opts), proj, mc };
}

test('every year of the example plan adds up to the projection', () => {
  const plan = E.normalizePlan(E.defaultWorkspace().scenarios[0].plan);
  const { d, proj } = doc(plan);
  assert.equal(d.years.length, proj.rows.length - 1);
  assert.equal(d.meta.title, 'Alex and Sam’s plan, year by year');
  for (const y of d.years) {
    const r = proj.rows[y.t], next = proj.rows[y.t + 1];
    const g = id => y.groups.find(x => x.id === id);
    // What reaches the bank = what comes in, less what comes off.
    near(g('in').total.value + sum(g('off').lines), g('off').total.value + (r.otherIncome + r.earnings + r.statePension - g('in').total.value) * -1, 2);
    // What goes out is spending plus the required debt payments.
    near(-g('out').total.value, r.spending + r.debtRegular + r.lumpOverpay, 1);
    near(sum(g('out').lines), g('out').total.value, 1);
    // What is left goes somewhere; a gap is drawn from somewhere (unless the money has run out).
    if (g('save')) near(sum(g('save').lines), g('save').total.value, 2);
    if (g('draw') && !(r.unfunded > 0.5)) near(sum(g('draw').lines), g('draw').total.value, 2);
    assert.ok(!!g('save') !== !!g('draw'), `${y.year}: either saving or drawing`);
    // The end of the year is the next year's start.
    near(g('end').total.value, next.netWorth, 1);
    near(sum(g('end').lines), next.netWorth, 2);
    near(y.net.real, next.netWorth / next.deflator, 1);
    assert.ok(y.net.low <= y.net.high);
  }
});

test('what is new in a year: stopping work, the State Pension, a debt paid off, a fix ending, one-off costs', () => {
  const plan = E.normalizePlan(E.defaultWorkspace().scenarios[0].plan);
  const { d } = doc(plan, { steps: [{ when: 'now', title: 'Pay into ISAs', text: 'x' }, { when: 2043, title: 'Alex retires', text: 'y' }, { when: 'yearly', title: 'The yearly review', text: 'z' }] });
  const year = n => d.years.find(y => y.year === n);
  const says = (n, re) => assert.ok(year(n).changes.some(c => re.test(c)), `${n}: ${year(n).changes.join(' | ')}`);
  says(2043, /Alex stops work this year, at 55/);
  assert.ok(!year(2043).changes.some(c => /Alex salary stops/.test(c)));        // said once, not twice
  says(2043, /income no longer covers spending/);
  says(2056, /Alex’s State Pension starts/);
  says(2028, /fixed rate on Mortgage ends/);
  says(2029, /Replace car: about £/);
  const paid = d.years.find(y => y.changes.some(c => /Mortgage is paid off this year/.test(c)));
  assert.ok(paid && paid.year >= 2040);
  assert.equal(year(2026).phase, 'working');
  assert.equal(year(2043).phase, 'part');
  assert.equal(year(2060).phase, 'retired');
  // Steps land in their year; "now" in the first; yearly ones are listed once.
  assert.deepEqual(year(2026).todo.map(s => s.title), ['Pay into ISAs']);
  assert.deepEqual(year(2043).todo.map(s => s.title), ['Alex retires']);
  assert.deepEqual(d.everyYear.map(s => s.title), ['The yearly review']);
  // Dates that matter are in order and carry ages.
  assert.ok(d.dates.length >= 6);
  assert.ok(d.dates.every((x, i) => i === 0 || x.year >= d.dates[i - 1].year));
  assert.deepEqual(d.dates.find(x => /Alex retires/.test(x.label)).ages, [55, 53]);
  // A pay rise is said on the line.
  assert.match(year(2027).groups.find(g => g.id === 'in').lines[0].note, /up 3\.0% on last year/);
});

test('a short dossier for a quick-start plan: fewer years, plain “you”, debts by name', () => {
  const a = Q.blank('scotland');
  Object.assign(a.people[0], { age: 27, pay: 'takehome', amount: 1850, workPension: 'unsure', pot: 2000 });
  a.cash = 1400; a.home = 'rent'; a.rent = 475; a.spending = 1000;
  a.debts = [{ kind: 'car', owed: 6800, pay: 189 }];
  const plan = Q.build(a, { startYear: 2026, asOf: '2026-11-13' });
  const { d } = doc(plan, { years: 5 });
  assert.equal(d.years.length, 5);
  assert.equal(d.meta.title, 'Your plan, year by year');
  const y0 = d.years[0];
  assert.match(y0.headline, /a month comes in after tax and pension/);
  assert.ok(y0.groups.find(g => g.id === 'debt').lines.some(l => l.label === 'Car finance'));
  assert.ok(y0.groups.find(g => g.id === 'pension').lines.some(l => /^Your own contributions$/.test(l.label)));
  assert.ok(d.assumptions.some(x => x.label === 'Your State Pension'));
  assert.ok(d.glossary.length > 10);
  assert.ok(d.short.length === 2 && d.short.every(s => s.text.length > 10));
});
