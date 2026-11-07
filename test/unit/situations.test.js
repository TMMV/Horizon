'use strict';

// Situations that do not follow the usual pattern: a home bought later, student loans,
// self-employed profit, other assets, dates in calendar years and notes on any item.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const R = require('../../src/uk-rules');
const RV = require('../../src/review');

const near = (a, b, tol = 1) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

// A young renter: one person, pay before tax, no investments growing in surprising ways.
function renter(extra = {}) {
  return E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Robin', age: 25, retireAge: 67, ...(extra.person || {}) }] },
    accounts: [{ id: 'bank', type: 'cash', balance: 40000 }, ...(extra.accounts || [])],
    income: extra.income || [{ name: 'Pay', kind: 'salary', owner: 'p1', tax: 'uk', amount: 40000, freq: 'year', growth: 3 }],
    expenses: extra.expenses || [{ name: 'Rent', amount: 1000, freq: 'month' }],
    events: [], goals: extra.goals || [],
    assumptions: { houseGrowthSd: 0 },
  });
}

test('items can start and stop in a calendar year as well as at an age', () => {
  const p = renter({ expenses: [{ name: 'Rent', amount: 1000, freq: 'month', endRef: 'year', toYear: 2030 }, { name: 'Gym', amount: 50, freq: 'month', startRef: 'year', fromYear: 2028 }] });
  const [rent, gym] = p.expenses;
  assert.equal(rent.endRef, 'year');
  assert.equal(rent.toYear, 2030);
  // Paid in 2026–2029, not from 2030 (the year it stops).
  assert.ok(E.streamAt(rent, p, 3) > 0);
  assert.equal(E.streamAt(rent, p, 4), 0);
  assert.equal(E.streamAt(gym, p, 1), 0);
  assert.ok(E.streamAt(gym, p, 2) > 0);
  // Moving the plan on a year keeps the same calendar years.
  const q = E.rollForward(p, 1);
  assert.ok(E.streamAt(q.expenses[0], q, 2) > 0);
  assert.equal(E.streamAt(q.expenses[0], q, 3), 0);
});

test('a home bought later: the deposit is paid that year, the home counts and the mortgage starts', () => {
  const p = renter({ accounts: [{ id: 'flat', name: 'Flat', type: 'property', balance: 200000, rate: 0, buyYear: 2029, deposit: 10, mortRate: 5, mortYears: 25 }] });
  const flat = p.accounts.find(a => a.id === 'flat');
  assert.deepEqual([flat.buyYear, flat.deposit, flat.mortRate, flat.mortYears], [2029, 10, 5, 25]);
  const pr = E.project(p);
  const row = y => pr.rows.find(r => r.year === y);
  // Not owned (or owed) before; bought at the start of 2029 at its price.
  assert.equal(row(2029).property, 0);
  assert.equal(row(2029).debt, 0);
  near(row(2029).homeBuy, 20000);
  near(row(2030).property, 200000);
  // A 25-year repayment mortgage of £180,000 at 5%: about £12,771 a year, starting in 2029.
  const pay = 180000 * 0.05 / (1 - Math.pow(1.05, -25));
  near(row(2029).debtRegular, pay, 1);
  assert.ok(row(2030).debt < 180000 && row(2030).debt > 170000);
  // Paid off after 25 years: mortgage-free in 2054, and a mortgage-free goal is not met before then.
  assert.equal(E.debtFreeYear(pr), 2054);
  assert.ok(E.milestones(p, pr).some(m => m.kind === 'home' && m.year === 2029));
  assert.ok(E.milestones(p, pr).some(m => m.kind === 'debt' && m.year === 2054));
  // Not counted in today's estimate, nor in the review, until it is bought.
  const today = RV.estimateAt(p, '2026-06-01', pr);
  assert.equal(today.byType.property, 0);
  assert.equal(RV.notYet(p, flat, 0.5), true);
  assert.equal(RV.notYet(p, flat, 3.5), false);
  near(RV.estimateAt(p, '2030-06-01', pr).byType.property, 200000, 1);
  // Once the year has passed, rolling the plan on counts it as owned.
  assert.equal(E.rollForward(p, 4).accounts.find(a => a.id === 'flat').buyYear, 0);
});

test('a home bought later with no mortgage, as when downsizing', () => {
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Sam', age: 62, retireAge: 62 }] },
    accounts: [
      { id: 'home', type: 'property', balance: 400000, rate: 0, sellYear: 2028 },
      { id: 'next', type: 'property', balance: 250000, rate: 0, buyYear: 2028, deposit: 100 },
      { type: 'cash', balance: 10000 },
    ],
    income: [], expenses: [], events: [], goals: [], assumptions: { houseGrowthSd: 0 },
  });
  const pr = E.project(p);
  const r = pr.rows.find(x => x.year === 2028);
  near(r.propSold, 400000);
  near(r.homeBuy, 250000);
  assert.equal(pr.rows.every(x => x.debt === 0), true);
  near(pr.rows.find(x => x.year === 2029).property, 250000);
});

test('student loans: 9% of pay above the threshold until written off; take-home pay rises when it ends', () => {
  const L = R.STUDENT_LOANS.plan2;
  const p = renter({ person: { loanPlan: 'plan2', loanBalance: 50000, loanEndYear: 2040 } });
  const P = E.precompute(p).people[0];
  near(P.loanPaid[0], 0.09 * (40000 - L.threshold), 0.5);
  assert.ok(P.loanBal[1] > 50000, 'Plan 2 interest outgrows small repayments');
  // Written off in 2040: nothing paid from then on, and nothing owed.
  assert.ok(P.loanPaid[13] > 0);
  assert.equal(P.loanPaid[14], 0);
  assert.equal(P.loanBal[15], 0);
  // Paid from pay before tax, so it counts with the year's taxes.
  const noLoan = E.precompute(renter()).people[0];
  near(P.baseTax[0] - noLoan.baseTax[0], P.loanPaid[0], 0.01);

  // Take-home pay already has it taken off: it rises by the repayment once the loan ends.
  const th = extra => renter({ person: extra, income: [{ name: 'Pay', kind: 'salary', owner: 'p1', tax: 'none', amount: 2500, freq: 'month', growth: 3 }] });
  const A = E.precompute(th({ loanPlan: 'plan2', loanBalance: 5000, loanEndYear: 2050 })).people[0];
  const B0 = E.precompute(th({})).people[0];
  near(A.netPay[0], B0.netPay[0], 0.01);
  const off = Array.from(A.loanBal).findIndex((v, t) => t > 0 && v <= 0.5);
  assert.ok(off > 0 && off < 10, 'a small loan is repaid within a few years');
  assert.ok(A.netPay[off + 1] > B0.netPay[off + 1] + 100, 'take-home pay rises once it is repaid');

  // A plan without a loan has none, whatever is typed in.
  assert.equal(E.normalizePlan({ household: { people: [{ loanPlan: 'plan9', loanBalance: 100 }] } }).household.people[0].loanPlan, '');
  // A loan with no write-off year is flagged.
  assert.ok(E.validatePlan(renter({ person: { loanPlan: 'plan5', loanBalance: 1000 } })).some(w => /written off/.test(w)));
});

test('the yearly review moves a student loan balance on as the plan expects', () => {
  const p = renter({ person: { loanPlan: 'plan2', loanBalance: 50000, loanEndYear: 2040 } });
  const pre = E.precompute(p).people[0];
  const q = RV.rollPlan(p, 1);
  near(q.household.people[0].loanBalance, pre.loanBal[1], 1);
});

test('self-employed profit pays income tax and Class 4 National Insurance', () => {
  const p = renter({ income: [{ name: 'Profit', kind: 'self', owner: 'p1', tax: 'uk', amount: 40000, freq: 'year', inflationLinked: true }] });
  const P = E.precompute(p).people[0];
  near(P.ni[0], R.selfEmployedNI(40000), 0.01);
  near(R.selfEmployedNI(40000), 0.06 * (40000 - 12570), 0.01);
  near(P.baseIT[0], R.incomeTax(40000, 'ruk'), 0.01);
  // Ignoring tax switches it off too.
  const q = E.normalizePlan({ ...p, household: { ...p.household, ignoreTax: true } });
  assert.equal(E.precompute(q).people[0].ni[0], 0);
});

test('other assets count with property and are sold in their year', () => {
  const p = renter({ accounts: [{ id: 'biz', name: 'Business', type: 'asset', balance: 100000, rate: 0, sellYear: 2030 }] });
  assert.equal(p.accounts[1].type, 'asset');
  const pr = E.project(p);
  near(pr.rows[0].property, 100000);
  near(pr.rows.find(r => r.year === 2030).propSold, 100000);
  assert.equal(pr.rows.find(r => r.year === 2031).property, 0);
  near(RV.estimateAt(p, '2026-01-01', pr).byType.property, 100000);
});

test('notes are kept on accounts, income, spending and one-offs', () => {
  const p = E.normalizePlan({
    accounts: [{ type: 'debt', balance: 5000, note: 'From Gran: no interest' }],
    income: [{ kind: 'other', amount: 100, note: 'Help with rent' }],
    expenses: [{ name: 'Keep', amount: 200, note: 'To Mum' }],
    events: [{ name: 'Gift', kind: 'income', year: 2030, amount: 5000, note: 'For the deposit' }],
  });
  assert.deepEqual([p.accounts[0].note, p.income[0].note, p.expenses[0].note, p.events[0].note], ['From Gran: no interest', 'Help with rent', 'To Mum', 'For the deposit']);
  assert.equal(E.normalizePlan({ expenses: [{ note: 42 }] }).expenses[0].note, '');
  assert.equal(E.normalizePlan({ expenses: [{ note: 'x'.repeat(900) }] }).expenses[0].note.length, 500);
});

test('putting off the State Pension: it starts later and pays about 5.8% more a year for life', () => {
  const mk = spDefer => E.normalizePlan({ startYear: 2026, household: { region: 'scotland', people: [{ name: 'Sam', age: 66, retireAge: 66, statePensionAge: 67, statePension: 12000, spDefer }] }, accounts: [], income: [], expenses: [], events: [], goals: [] });
  const now = E.precompute(mk(0)).people[0], later = E.precompute(mk(2)).people[0];
  assert.ok(now.statePension[1] > 0);
  assert.equal(later.statePension[1], 0);
  assert.equal(later.statePension[2], 0);
  near(later.statePension[3] / now.statePension[3], 1 + 2 * 52 / 9 / 100, 1e-9);
  assert.equal(E.spStart(mk(2).household.people[0]), 69);
  assert.ok(E.milestones(mk(2), E.project(mk(2))).some(m => m.kind === 'sp' && m.year === 2029));
  assert.equal(E.normalizePlan({ household: { people: [{ spDefer: 40 }] } }).household.people[0].spDefer, 10);
});

test('an annuity is bought with part of the pension pot and pays a taxable income for life', () => {
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'scotland', people: [{ name: 'Pat', age: 64, retireAge: 64, statePensionAge: 67 }] },
    accounts: [{ type: 'pension', owner: 'p1', balance: 300000 }, { type: 'cash', balance: 20000 }],
    income: [{ kind: 'annuity', name: 'Annuity', owner: 'p1', tax: 'uk', amount: 7000, freq: 'year', cost: 100000, startAge: 66, inflationLinked: false }],
    expenses: [], events: [], goals: [],
  });
  const it = p.income[0];
  assert.deepEqual([it.kind, it.cost, it.startAge], ['annuity', 100000, 66]);
  const infl = p.assumptions.inflation / 100;
  // Nothing before 66; then fixed in the pounds of the year it is bought.
  assert.equal(E.incomeAfterCosts(it, p, 1), 0);
  near(E.incomeAfterCosts(it, p, 2), 7000 * Math.pow(1 + infl, 2), 0.01);
  near(E.incomeAfterCosts(it, p, 10), 7000 * Math.pow(1 + infl, 2), 0.01);
  near(E.incomeAfterCosts({ ...it, inflationLinked: true }, p, 10), 7000 * Math.pow(1 + infl, 10), 0.01);
  const pr = E.project(p);
  near(pr.rows[2].annuityBought, 100000 * Math.pow(1 + infl, 2), 1);
  // Taxed as income.
  assert.ok(E.precompute(p).people[0].other[2] > 7000);
  // Too early for a pension: flagged.
  assert.ok(E.validatePlan(E.normalizePlan({ ...p, income: [{ ...it, startAge: 50 }] })).some(w => /annuity/.test(w)));
  // A year on, an annuity already bought keeps its pounds; one not bought yet moves with prices.
  const q = RV.rollPlan(E.normalizePlan({ ...p, household: { ...p.household, people: [{ ...p.household.people[0], age: 70 }] }, income: [{ ...it, startAge: 66 }] }), 1);
  assert.equal(q.income[0].amount, 7000);
  const r = RV.rollPlan(p, 1);
  near(r.income[0].cost, 100000 * (1 + infl), 1);
});

test('a Lifetime ISA for a first home is paid out when the home to buy is bought', () => {
  const p = E.normalizePlan({
    startYear: 2026, asOf: '2026-01-01',
    household: { region: 'ruk', people: [{ name: 'Robin', age: 25, retireAge: 67 }] },
    accounts: [
      { id: 'lisa', type: 'lisa', owner: 'p1', balance: 8000, contribution: 0, purpose: 'home' },
      { id: 'flat', type: 'property', balance: 500000, rate: 3, buyYear: 2029, deposit: 10 },
      { type: 'cash', balance: 60000 },
    ],
    income: [{ kind: 'salary', owner: 'p1', tax: 'uk', amount: 120000, freq: 'year' }], expenses: [], events: [], goals: [],
  });
  assert.equal(E.lisaHomeYear(p, p.accounts[0]), 2029);
  const pr = E.project(p);
  assert.ok(pr.rows.find(r => r.year === 2029).lisaHome > 8000);
  // Over £450,000 the Lifetime ISA cannot be used without the charge: flagged.
  assert.ok(E.validatePlan(p).some(w => /Lifetime ISA can be used/.test(w)));
});
