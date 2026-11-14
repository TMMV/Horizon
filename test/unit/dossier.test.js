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
  assert.deepEqual(year(2043).todo.map(s => s.title.replace(/£[\d,]+/, '£N')), ['Alex retires', 'Take about £N a month from savings and pensions']);
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

test('the pictures are the projection: kinds add up to net worth, and each year\u2019s bar to its money', () => {
  const plan = E.normalizePlan(E.defaultWorkspace().scenarios[0].plan);
  const { d, proj } = doc(plan, { years: 5 });
  const pic = d.pictures, rows = proj.rows;
  // The charts cover the whole plan even when only five years are written out.
  assert.equal(d.years.length, 5);
  assert.equal(pic.years.length, rows.length);
  assert.equal(pic.flowYears.length, rows.length - 1);
  rows.forEach((r, t) => near(pic.kinds.reduce((a, k) => a + k.values[t], 0), r.netWorth, 2));
  // Money in and money out balance each year (unless the money has run out).
  rows.slice(0, -1).forEach((r, t) => { if (!(r.unfunded > 0.5)) near(pic.flows.reduce((a, f) => a + f.values[t], 0), 0, 5); });
  assert.deepEqual(pic.range.p50.length, rows.length);
  assert.ok(pic.markers.some(m => m.label === 'Alex retires'));
  assert.ok(pic.debts.length === 1 && pic.debtYears > 2 && pic.debtYears <= rows.length);
  for (const y of d.years) {
    const r = rows[y.t], next = rows[y.t + 1];
    near(sum(y.split), r.earnings + r.otherIncome + r.statePension + (r.withdrawals || 0), 5);
    near(sum(y.holdings) - y.owed, next.netWorth, 2);
  }
});

test('a chart is plain SVG: stacked layers, columns, a marked year, and nothing unescaped', () => {
  const S = require('../../src/svg-chart');
  const layers = S.stack([{ values: [1, 2] }, { values: [3, -1] }, { values: [-2, -2] }], 2);
  assert.deepEqual(layers.map(l => [l.lower, l.upper]), [[[0, 0], [1, 2]], [[1, -1], [4, 0]], [[-2, -3], [0, -1]]]);
  const svg = S.plot({ width: 400, height: 200, xs: [2026, 2027, 2028], areas: [{ label: 'A', color: '--s1', values: [10, 20, 30] }],
    lines: [{ label: 'L', color: '--text', values: [10, 20, 30] }], markers: [{ x: 2027, label: 'Tom & <Jo> stop' }], here: 1, tip: i => `year ${i}` });
  assert.match(svg, /^<svg [^>]*viewBox="0 0 400 200"/);
  assert.match(svg, /Tom &amp; &lt;Jo&gt; stop/);
  assert.equal((svg.match(/<circle /g) || []).length, 1);
  assert.equal((svg.match(/<title>/g) || []).length, 3);
  assert.match(svg, /fill:var\(--s1\)/);
  assert.ok(!/NaN|undefined/.test(svg));
  const bars = S.plot({ width: 300, xs: [2026, 2027], bars: [{ label: 'In', color: '--s1', values: [5, 0] }, { label: 'Out', color: '--s5', values: [-5, -2] }] });
  assert.ok(!/NaN|undefined/.test(bars));
  assert.equal(S.compact(1250000), '£1.25M');
  assert.equal(S.compact(-4500), '−£4.5K');
});

test('every later year says what to set up, against the year before; the sheet gathers now, the tax year and next year', () => {
  const plan = E.normalizePlan(E.defaultWorkspace().scenarios[0].plan);
  const steps = [{ when: 'now', title: 'Pay into ISAs', text: 'x' }, { when: 'tax', title: 'By 5 April 2027: use the ISA allowance', text: 't' }, { when: 2027, title: 'Mortgage: start looking at new deals', text: 'm' }, { when: 'yearly', title: 'The yearly review', text: 'z' }];
  const { d, proj } = doc(plan, { steps, years: 1 });
  const rows = proj.rows;
  // Asked for one year, the sheet still knows next year.
  assert.equal(d.years.length, 1);
  assert.deepEqual(d.sheet.now.map(s => s.title), ['Pay into ISAs']);
  assert.deepEqual(d.sheet.tax.map(s => s.title), ['By 5 April 2027: use the ISA allowance']);
  assert.equal(d.sheet.next.year, 2027);
  assert.deepEqual(d.sheet.next.todo.map(s => s.title), ['Set the monthly amounts for the year', 'Mortgage: start looking at new deals']);
  // The first year lists the tax-year steps too.
  assert.deepEqual(d.years[0].todo.map(s => s.title), ['Pay into ISAs', 'By 5 April 2027: use the ISA allowance']);
  // The amounts are the projection's own, a month, with last year's beside them.
  const a = D.yearAmounts(rows[1], rows[0], 1);
  assert.ok(a.text.includes(`${D.gbp(rows[1].toIsa / 12)} a month into ISAs (${D.gbp(rows[0].toIsa / 12)} last year)`), a.text);
  // Something that stops is said, and something new is marked.
  const b = D.yearAmounts({ toIsa: 6000, toCash: 0 }, { toIsa: 0, toCash: 2400 }, 1);
  assert.match(b.text, /£500 a month into ISAs \(new this year\)/);
  assert.match(b.text, /nothing more into cash savings \(£200 a month last year\)/i);
  // A year that draws on savings says how much from where.
  const c = D.yearAmounts({ withdrawals: 24000, wCash: 6000, wPension: 18000 }, { withdrawals: 12000 }, -24000);
  assert.equal(c.title, 'Take about £2,000 a month from savings and pensions');
  assert.match(c.text, /£500 from cash and £1,500 from pension pots \(£1,000 a month last year\)/);
  assert.equal(D.yearAmounts({}, {}, 0), null);
  // A plan year starts in the month of the figures date: that is when to change the amounts.
  assert.match(b.text, /Change the standing orders in January\.$/);
  assert.match(D.yearAmounts({ toIsa: 6000 }, { toIsa: 0 }, 1, 'November').text, /Change the standing orders in November\.$/);
});

test('when a mortgage ends is said one way: paid off during a year, nothing owed from the next', () => {
  const plan = E.normalizePlan(E.defaultWorkspace().scenarios[0].plan);
  const { d, proj } = doc(plan);
  const free = E.debtFreeYear(proj);
  const paid = d.years.find(y => y.changes.some(c => /Mortgage is paid off this year/.test(c)));
  assert.equal(paid.year, free - 1);
  assert.ok(paid.changes.some(c => c.includes(`nothing is owed on it from ${free}`)));
  assert.ok(d.dates.some(x => x.year === free && x.label === `Mortgage-free from this year (the last payment is during ${free - 1})`));
  const goal = E.evaluateGoals(plan, proj, E.monteCarlo(plan, 120, 7), { runs: 120, seed: 7 }).find(r => r.goal.type === 'debtFree');
  assert.equal(goal.summary, `Expected to be paid off during ${free - 1}, so nothing is owed from ${free}.`);
});
