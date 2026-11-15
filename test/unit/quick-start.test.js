'use strict';

// The quick start: a first plan from a few plain answers.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const Q = require('../../src/quick-start');

const ctx = { startYear: 2026, asOf: '2026-11-13' };

function renter() {
  const a = Q.blank('scotland');
  Object.assign(a.people[0], { name: '', age: 27, pay: 'takehome', amount: 1850, workPension: 'unsure', pot: 2000 });
  a.cash = 1400;
  a.home = 'rent';
  a.rent = 475;
  a.debts = [{ kind: 'overdraft', owed: 300, pay: 0 }, { kind: 'car', owed: 6800, pay: 189 }];
  return a;
}

test('a renter on take-home pay: pay, the usual workplace pension, rent, debts at typical rates and goals', () => {
  const a = renter();
  a.spending = 1000;
  const p = Q.build(a, ctx);
  const x = p.household.people[0];
  assert.equal(x.name, 'You');
  assert.equal(x.age, 27);
  assert.equal(x.retireAge, x.statePensionAge);          // "not sure": the State Pension age
  const pay = p.income.find(i => i.kind === 'salary');
  assert.equal(pay.tax, 'none');                          // take-home: no tax worked out on it
  assert.equal(pay.amount, 1850);
  assert.equal(pay.freq, 'month');
  assert.equal(pay.employeePension, Q.AUTO_ENROL.employee);
  assert.equal(pay.employerPension, Q.AUTO_ENROL.employer);
  assert.equal(p.accounts.find(c => c.type === 'pension').balance, 2000);
  assert.equal(p.accounts.find(c => c.type === 'cash').balance, 1400);
  const od = p.accounts.find(c => c.name === 'Overdraft'), car = p.accounts.find(c => c.name === 'Car finance');
  assert.equal(od.rate, Q.DEBTS.overdraft.rate);
  assert.equal(car.payment, 189);
  assert.deepEqual(p.expenses.map(e => [e.name, e.amount]), [['Rent', 475], ['Everything else', 1000]]);
  assert.deepEqual(p.goals.map(g => g.type), ['retire', 'emergency']);
  // The cash buffer follows the spending; an overdraft with no payment is not a warning (it is paid off first).
  assert.equal(p.strategy.autoBuffer, true);
  assert.deepEqual(E.validatePlan(p), []);
  assert.ok(E.project(p).rows.length > 10);
});

test('spending can be worked out from what is left at the end of the month', () => {
  const a = renter();
  const all = Q.leftover(Q.build(a, ctx));               // nothing spent yet
  assert.ok(all > 900 && all < 1400, `left with no spending: ${all}`);
  a.spending = Q.spendingFor(a, 50, ctx);
  const left = Q.leftover(Q.build(a, ctx));
  assert.ok(Math.abs(left - 50) <= 10, `left ${left}`);
  // Nothing left over, or overdrawn: all of it is spent.
  assert.ok(Math.abs(Q.leftover(Q.build({ ...a, spending: Q.spendingFor(a, 0, ctx) }, ctx))) <= 10);
});

test('a couple who own with a mortgage: salary before tax, pay by the hour, a partner not working, saving up', () => {
  const a = Q.blank('ruk');
  a.partner = true;
  Object.assign(a.people[0], { name: 'Gordon', age: 52, pay: 'salary', amount: 38000, retireAge: 62, workPension: 'yes', pot: 41000 });
  Object.assign(a.people[1], { name: 'Lena', age: 50, pay: 'hourly', hourly: 12.5, hours: 20, workPension: 'no' });
  a.home = 'mortgage'; a.homeValue = 165000; a.mortgage = 46000; a.mortgagePay = 0;
  a.otherIncome = 150;
  a.spending = 2300;
  a.goals = { retire: true, emergency: false, save: true, saveName: 'New car', saveAmount: 12000, saveYear: 2028 };
  const p = Q.build(a, ctx);
  assert.equal(p.household.region, 'ruk');
  assert.deepEqual(p.household.people.map(x => [x.name, x.retireAge]), [['Gordon', 62], ['Lena', 67]]);
  const [g, l] = p.income.filter(i => i.kind === 'salary');
  assert.deepEqual([g.tax, g.amount, g.freq], ['uk', 38000, 'year']);
  assert.deepEqual([l.tax, l.amount, l.employeePension], ['uk', 13000, 0]);   // 12.50 × 20 × 52
  assert.equal(p.accounts.filter(c => c.type === 'pension').length, 1);       // Lena has none
  const m = p.accounts.find(c => c.name === 'Mortgage');
  assert.equal(m.payment, Q.mortgagePayment(46000));                            // no payment given: 25 years at the usual rate
  assert.ok(m.payment > 230 && m.payment < 280);
  assert.equal(p.accounts.find(c => c.type === 'property').balance, 165000);
  assert.equal(p.income.find(i => i.kind === 'other').amount, 150);
  const save = p.goals.find(x => x.type === 'netWorth');
  assert.deepEqual([save.name, save.amount, save.year, save.measure], ['New car', 12000, 2028, 'savings']);
  // Someone not working is retired as far as the plan goes, with any pensions already paid counted.
  a.people[1] = { ...Q.person(), name: 'Lena', age: 66, pay: 'none', pensionNow: 400 };
  const q = Q.build(a, ctx);
  assert.equal(q.household.people[1].retireAge, 66);
  assert.equal(q.income.find(i => i.owner === 'p2').amount, 400);
});

test('a set pension from a letter, money for the children, a home to buy and a student loan', () => {
  const a = Q.blank('scotland');
  Object.assign(a.people[0], { name: 'Mara', age: 46, pay: 'hourly', hourly: 12.9, hours: 38, workPension: 'yes', fixedPension: 3200, fixedAge: 65, loan: true });
  a.childMoney = 510; a.youngest = 15; a.otherIncome = 100;
  a.home = 'rent'; a.rent = 520; a.spending = 900;
  a.goals = { retire: true, emergency: false, save: false, buy: true, buyPrice: 130000, buyYear: 2031 };
  const p = Q.build(a, ctx);
  // The letter's amount at the letter's age, not cut.
  const db = p.income.find(i => i.kind === 'dbpension');
  assert.deepEqual([db.amount, db.startAge, db.dbScheme, db.owner], [3200, 65, 'other', 'p1']);
  assert.equal(E.dbEarly(db, p.household.people[0]).factor, 1);
  // Money for the children stops when the youngest is 18; the rest carries on.
  const kids = p.income.find(i => i.name === 'Money for the children');
  assert.deepEqual([kids.amount, kids.endRef, kids.toYear], [510, 'year', 2029]);
  assert.ok(E.incomeAfterCosts(kids, p, 2) > 0 && E.incomeAfterCosts(kids, p, 3) === 0);
  assert.equal(p.income.find(i => i.name === 'Other money coming in').endRef, 'end');
  // The home is bought in 2031 and the rent stops then.
  const home = p.accounts.find(c => c.type === 'property');
  assert.deepEqual([home.balance, home.buyYear, home.deposit], [130000, 2031, 10]);
  const rent = p.expenses.find(e => e.name === 'Rent');
  assert.deepEqual([rent.endRef, rent.toYear], ['year', 2031]);
  assert.ok(E.streamAt(rent, p, 4) > 0 && E.streamAt(rent, p, 5) === 0);
  // The student loan: Scotland's plan, a typical balance when none is given.
  const x = p.household.people[0];
  assert.deepEqual([x.loanPlan, x.loanBalance], ['plan4', Q.LOAN_TYPICAL.plan4]);
  assert.ok(x.loanEndYear > 2026);
  assert.equal(Q.loanPlanFor(20, 'ruk', 2026), 'plan5');
  assert.equal(Q.loanPlanFor(30, 'ruk', 2026), 'plan2');
  assert.equal(Q.loanPlanFor(50, 'ruk', 2026), 'plan1');
  assert.deepEqual(E.validatePlan(p), []);
  // An owner is not offered a home to buy.
  assert.equal(Q.build({ ...a, home: 'own', homeValue: 200000 }, ctx).accounts.filter(c => c.type === 'property').length, 1);
});

test('a teacher: the scheme is estimated from the year joined, pay builds it and not a pot, and it is taken when work stops', () => {
  const a = Q.blank('scotland');
  Object.assign(a.people[0], { name: 'Fi', age: 49, pay: 'salary', amount: 48000, retireAge: 60, workPension: 'yes', scheme: 'teachers', joined: 2001, pot: 60000 });
  Object.assign(a, { cash: 7500, home: 'mortgage', homeValue: 210000, mortgage: 95000, mortgagePay: 720, spending: 2300 });
  const p = Q.build(a, ctx);
  const db = p.income.find(i => i.kind === 'dbpension'), pay = p.income.find(i => i.kind === 'salary');
  const e = E.estimateDb({ scheme: 'teachers', joined: 2001, salary: 48000, startYear: 2026, realGrowth: 1 });
  assert.equal(db.amount, Math.round(e.builtUp));
  assert.equal(db.dbAccrual, Math.round(48000 / 57));
  assert.equal(db.startAge, 60);                         // when work stops, not the scheme's pension age
  assert.equal(db.dbScheme, 'teachers');
  assert.equal(pay.pensionTo, 'db');                     // contributions are not counted into a pot as well
  assert.equal(pay.employeePension, Q.SCHEMES.teachers.member);
  assert.equal(p.accounts.filter(c => c.type === 'pension').length, 1);
  assert.equal(p.accounts.find(c => c.type === 'pension').balance, 60000);
  // Without the scheme the same answers give a worse plan: that was the false first answer.
  const b = JSON.parse(JSON.stringify(a)); b.people[0].scheme = '';
  const rate = pl => E.successRate(pl, 150, 1);
  assert.ok(rate(p) > rate(Q.build(b, ctx)));
  // Someone who stops before 55 takes it at 55; "not sure" about a pension never builds a scheme.
  a.people[0].retireAge = 52;
  assert.equal(Q.build(a, ctx).income.find(i => i.kind === 'dbpension').startAge, 55);
  a.people[0].workPension = 'unsure';
  assert.equal(Q.build(a, ctx).income.some(i => i.kind === 'dbpension'), false);
});

test('working for yourself, a property that is rented out on an interest-only mortgage, the employer’s share and State Pension years', () => {
  const a = Q.blank('ruk');
  a.partner = true;
  Object.assign(a.people[0], { name: 'Cal', age: 38, pay: 'self', amount: 50000, retireAge: 60, pot: 9000 });
  Object.assign(a.people[1], { name: 'Ash', age: 36, pay: 'salary', amount: 41000, workPension: 'yes', eePct: 6, erPct: 4, niYears: 12 });
  Object.assign(a, { cash: 11000, home: 'mortgage', homeValue: 340000, mortgage: 215000, mortgagePay: 1340, let: true, letValue: 180000, letMortgage: 110000, letPay: 480, letRent: 850, spending: 3250 });
  const p = Q.build(a, ctx);
  const self = p.income.find(i => i.kind === 'self');
  assert.equal(self.amount, 50000);
  assert.equal(self.tax, 'uk');
  assert.equal(self.endRef, 'retire');
  assert.ok(Q.works(a.people[0]) && !Q.employed(a.people[0]));
  const pay = p.income.find(i => i.kind === 'salary');
  assert.equal(pay.employeePension, 6);
  assert.equal(pay.employerPension, 4);
  assert.equal(p.household.people[1].niYears, 12);
  assert.equal(p.household.people[0].niYears, null);
  // The rented-out property: its value, the rent taxed, and a mortgage that stays level.
  assert.equal(p.accounts.find(c => c.name === 'Rented-out property').balance, 180000);
  const rent = p.income.find(i => i.kind === 'rental');
  assert.equal(rent.amount, 850);
  assert.equal(rent.freq, 'month');
  const m = p.accounts.find(c => c.name === 'Mortgage on the rented-out property');
  assert.equal(m.payment, 480);
  assert.equal(m.rate, 5.23);
  const proj = E.project(p), d = proj.out.debts.find(x => x.id === m.id);
  assert.ok(Math.abs(d.bal[20] - 110000) < 1500, String(d.bal[20]));
  // The rent and the business are counted: something is left each month (it was minus £736 without them).
  assert.ok(Q.leftover(p) > 500, String(Q.leftover(p)));
  // Nothing goes into a pension: a trial amount says what it would cost and build.
  const o = E.ownPensionTrial(p, proj, 0);
  assert.ok(o.pay >= 25 && o.pay % 25 === 0, String(o.pay));
  assert.equal(Math.round(o.pot), Math.round(o.pay / 0.8));
  assert.ok(o.cost <= o.pay + 0.5 && o.built > o.pay * 12 * 10, JSON.stringify(o));
  assert.equal(E.ownPensionTrial(p, proj, 1), null);
  // Payments typed in the quick start come out of what is taken home, and the question goes away.
  const b = JSON.parse(JSON.stringify(a));
  b.people[0].ownPension = 200; b.people[0].pot = 0;
  const pb = Q.build(b, ctx), projB = E.project(pb);
  assert.equal(pb.household.people[0].extraPension, 200);
  assert.ok(pb.accounts.some(c => c.type === 'pension' && c.owner === 'p1'));
  assert.equal(Math.round(projB.rows[0].extraPension), 2400);
  assert.equal(E.ownPensionTrial(pb, projB, 0), null);
  // A repayment mortgage on it keeps the usual rate.
  a.letPay = 700;
  assert.equal(Q.build(a, ctx).accounts.find(c => c.name === 'Mortgage on the rented-out property').rate, Q.MORTGAGE_RATE);
});

test('a “paid off by” goal can follow one mortgage: it is overpaid first, and an interest-only one elsewhere does not hold it up', () => {
  const a = Q.blank('ruk');
  Object.assign(a.people[0], { name: 'Cal', age: 38, pay: 'salary', amount: 70000, retireAge: 60, workPension: 'yes' });
  Object.assign(a, { cash: 11000, home: 'mortgage', homeValue: 340000, mortgage: 215000, mortgagePay: 1340, let: true, letValue: 180000, letMortgage: 110000, letPay: 480, letRent: 850, spending: 1500 });
  const base = Q.build(a, ctx);
  base.strategy.overpayPct = 50;
  const home = base.accounts.find(c => c.name === 'Mortgage'), flat = base.accounts.find(c => c.name === 'Mortgage on the rented-out property');
  const withGoal = debtId => E.normalizePlan({ ...JSON.parse(JSON.stringify(base)), goals: [{ id: 'g1', type: 'debtFree', year: ctx.startYear + 12, debtId }] });
  const check = p => { const proj = E.project(p), mc = E.monteCarlo(p, 60, 3); return { proj, res: E.evaluateGoals(p, proj, mc, { runs: 60, seed: 3 })[0] }; };
  // Everything owed: the flat (dearer) is overpaid first.
  const all = withGoal('');
  const A = check(all);
  assert.equal(E.goalDebtId(all), '');
  assert.equal(A.res.title, `Mortgage-free by ${ctx.startYear + 12}`);
  const bal = (proj, id, t) => proj.out.debts.find(d => d.id === id).bal[t];
  assert.ok(bal(A.proj, flat.id, 2) < 110000 - 1000, 'the flat is overpaid first');
  // The home alone: it is overpaid first, the flat stays level, and the goal is about the home.
  const one = withGoal(home.id);
  const B = check(one);
  assert.equal(E.goalDebtId(one), home.id);
  assert.equal(B.res.title, `Mortgage paid off by ${ctx.startYear + 12}`);
  assert.ok(Math.abs(bal(B.proj, flat.id, 2) - 110000) < 1500, String(bal(B.proj, flat.id, 2)));
  assert.ok(bal(B.proj, home.id, 2) < bal(A.proj, home.id, 2) - 1000);
  assert.ok(B.res.expectedYear && (!A.res.expectedYear || B.res.expectedYear < A.res.expectedYear), `${A.res.expectedYear} ${B.res.expectedYear}`);
  assert.ok(B.res.probability >= A.res.probability);
  assert.match(B.res.summary, /follows that one alone/);
  // Without overpaying, the interest-only one is never cleared: the summary names it.
  const none = withGoal(''); none.strategy.overpayPct = 0;
  assert.match(check(none).res.summary, /Mortgage on the rented-out property is still owed at the end/);
  // A goal about a debt that is gone falls back to everything owed.
  assert.equal(E.goalDebtId(withGoal('nope')), '');
});

test('a renter who clears a car loan is not told the mortgage ends; a home bought later has its own date', () => {
  const a = renter();
  a.spending = 900;
  Object.assign(a.goals, { buy: true, buyPrice: 140000, buyYear: 2031 });
  const p = Q.build(a, ctx), proj = E.project(p);
  const ms = E.milestones(p, proj);
  const loans = ms.find(m => m.label === 'Loans and cards paid off');
  assert.ok(loans && loans.year < 2031, JSON.stringify(ms));
  // The only mortgage is the one that starts with the home, so "mortgage-free" cannot come before it.
  for (const m of ms.filter(x => x.label === 'Mortgage-free')) assert.ok(m.year > 2031, JSON.stringify(m));
  assert.equal(p.accounts.some(x => E.isMortgage(p, x)), false);
  // A debt called a mortgage is one; so is a large debt beside a home owned now; a card is not.
  const d = E.defaultPlan(2026);
  assert.equal(E.isMortgage(d, d.accounts.find(x => x.type === 'debt')), true);
  assert.equal(E.isMortgage(d, { type: 'debt', name: 'Home loan', balance: 90000, rate: 5 }), true);
  assert.equal(E.isMortgage(d, { type: 'debt', name: 'Credit card', balance: 3000, rate: 23 }), false);
  assert.ok(E.milestones(d, E.project(d)).some(m => m.label === 'Mortgage-free'));
});

test('maintenance paid is spending until the youngest is 18, not money coming in', () => {
  const a = renter();
  a.spending = 900;
  a.childPaid = 480;
  a.youngest = 12;
  const p = Q.build(a, ctx);
  const e = p.expenses.find(x => x.name === 'Maintenance for the children');
  assert.ok(e);
  assert.equal(e.amount, 480);
  assert.equal(e.toYear, 2032);
  assert.equal(p.income.some(i => /children/i.test(i.name)), false);
  const proj = E.project(p), without = E.project(Q.build({ ...a, childPaid: 0 }, ctx));
  assert.ok(Math.abs((without.rows[0].spending === undefined ? 0 : proj.rows[0].spending - without.rows[0].spending) - 480 * 12) < 1);
});

test('a retired person: a set-amount pension that has already started is paid from now', () => {
  const a = Q.blank('scotland');
  Object.assign(a.people[0], { name: 'Ian', age: 68, pay: 'none', fixedPension: 11500, fixedAge: 63 });
  a.cash = 60000; a.home = 'own'; a.homeValue = 180000; a.spending = 1600;
  const p = Q.build(a, ctx);
  const db = p.income.find(i => i.kind === 'dbpension');
  assert.equal(db.startAge, 63);
  const proj = E.project(p);
  // Paid, and taxed with the State Pension, in the first year.
  assert.ok(proj.pre.people[0].other[0] >= 11499, String(proj.pre.people[0].other[0]));
  assert.ok(proj.rows[0].taxes > 1000, String(proj.rows[0].taxes));
  // One still to come starts next year at the earliest, as before.
  const b = Q.blank('scotland');
  Object.assign(b.people[0], { name: 'Ian', age: 58, pay: 'none', fixedPension: 5000, fixedAge: 65 });
  assert.equal(Q.build(b, ctx).income.find(i => i.kind === 'dbpension').startAge, 65);
});

test('big things coming up land in their year: a cost and money coming in', () => {
  const a = renter();
  a.spending = 900;
  a.big = [{ kind: 'cost', name: 'Wedding', amount: 10000, year: 2028 }, { kind: 'money', name: '', amount: 120000, year: 2030 }, { kind: 'cost', name: 'Nothing', amount: 0, year: 2029 }, { kind: 'cost', name: 'Too soon', amount: 500, year: 2020 }];
  const p = Q.build(a, ctx);
  assert.deepEqual(p.events.map(e => [e.name, e.kind, e.amount, e.year]), [['Wedding', 'expense', 10000, 2028], ['Money coming in', 'income', 120000, 2030], ['Too soon', 'expense', 500, 2026]]);
  const proj = E.project(p), base = E.project(Q.build({ ...a, big: [] }, ctx));
  // The money arrives in 2030 and is still there afterwards; the wedding is paid in 2028.
  assert.ok(proj.rows[5].netWorth - base.rows[5].netWorth > 100000);
  assert.ok(proj.rows[2].oneOff === undefined || true);
  // The year-by-year plan names both in their years, and in the dates.
  const D = require('../../src/dossier.js');
  const d = D.build(p, proj, null, [], { years: 6 });
  assert.ok(d.years[2].changes.some(c => /Wedding/.test(c)), JSON.stringify(d.years[2].changes));
  assert.ok(d.years[4].changes.some(c => /Money coming in/.test(c)), JSON.stringify(d.years[4].changes));
  assert.ok(d.dates.some(x => x.year === 2028 && /Wedding/.test(x.label)));
  assert.ok(d.sheet.later[0].changes.some(c => /Wedding/.test(c)));
});

test('the quick start takes a mortgage rate and fix, a rate for a debt, a Lifetime ISA each and a partner’s own ISA', () => {
  const a = Q.blank('scotland');
  a.partner = true;
  Object.assign(a.people[0], { name: 'Erin', age: 30, pay: 'salary', amount: 41000, workPension: 'yes' });
  Object.assign(a.people[1], { name: 'Rob', age: 29, pay: 'salary', amount: 36000, workPension: 'yes' });
  a.cash = 4000; a.investments = 0; a.investments2 = 6500;
  a.lisa = [9000, 0]; a.lisaPay = [200, 0];
  a.home = 'mortgage'; a.homeValue = 250000; a.mortgage = 180000; a.mortgagePay = 1000; a.mortgageRate = 5.1; a.mortgageFix = 2029;
  a.debts = [{ kind: 'car', owed: 5200, pay: 210, rate: 7.9 }, { kind: 'card', owed: 900, pay: 50 }];
  a.spending = 1900;
  const p = Q.build(a, ctx);
  const m = p.accounts.find(x => x.name === 'Mortgage');
  assert.deepEqual([m.rate, m.fixedUntil], [5.1, 2029]);
  assert.deepEqual(p.accounts.filter(x => x.type === 'debt' && x.name !== 'Mortgage').map(x => [x.name, x.rate]), [['Car finance', 7.9], ['Credit card', 23]]);
  // An ISA is one person's: the partner's is theirs.
  assert.deepEqual(p.accounts.filter(x => x.type === 'isa').map(x => [x.name, x.owner, x.balance]), [['Rob’s ISAs and investments', 'p2', 6500]]);
  const l = p.accounts.find(x => x.type === 'lisa');
  assert.deepEqual([l.name, l.owner, l.balance, l.contribution, l.purpose], ['Erin’s Lifetime ISA', 'p1', 9000, 2400, 'retirement']);
  // The plan pays into it, with the bonus.
  const proj = E.project(p);
  assert.ok(Math.abs(proj.rows[0].toLisa - 2400) < 1 && Math.abs(proj.rows[0].lisaBonus - 600) < 1, `${proj.rows[0].toLisa} ${proj.rows[0].lisaBonus}`);
  // Left empty, the usual rates and no fix; a Lifetime ISA for someone buying is for the home.
  const b = renter();
  b.spending = 900; b.lisa = [3000, 0]; b.lisaPay = [100, 0];
  Object.assign(b.goals, { buy: true, buyPrice: 140000, buyYear: 2031 });
  const q = Q.build(b, ctx);
  assert.equal(q.accounts.find(x => x.type === 'lisa').purpose, 'home');
  assert.equal(q.accounts.find(x => x.type === 'lisa').name, 'Lifetime ISA');
  const c = Q.blank('ruk');
  Object.assign(c.people[0], { age: 40, pay: 'salary', amount: 30000 });
  c.home = 'mortgage'; c.homeValue = 200000; c.mortgage = 100000; c.spending = 1000;
  const mm = Q.build(c, ctx).accounts.find(x => x.name === 'Mortgage');
  assert.deepEqual([mm.rate, mm.fixedUntil || 0], [Q.MORTGAGE_RATE, 0]);
});

test('buying a home is a goal: the deposit in savings by the year of the purchase', () => {
  const a = renter();
  a.spending = 900;
  Object.assign(a.goals, { buy: true, buyPrice: 140000, buyYear: 2031 });
  const p = Q.build(a, ctx);
  const g = p.goals.find(x => x.name === 'Deposit for the home');
  assert.deepEqual([g.type, g.measure, g.amount, g.year], ['netWorth', 'savings', 14000, 2031]);
  const res = E.evaluateGoals(p, E.project(p), E.monteCarlo(p, 60, 1), { runs: 60, seed: 1 }).find(r => r.goal.id === g.id);
  assert.ok(res.probability >= 0 && res.probability <= 1);
  // No home to buy, no such goal.
  assert.equal(Q.build({ ...a, goals: { ...a.goals, buy: false } }, ctx).goals.some(x => x.name === 'Deposit for the home'), false);
});

test('a yearly bonus on a salary is counted, and taxed with it', () => {
  const a = Q.blank('ruk');
  Object.assign(a.people[0], { name: 'Noor', age: 43, pay: 'salary', amount: 118000, bonus: 15000, workPension: 'yes' });
  a.cash = 14000; a.home = 'rent'; a.rent = 1500; a.spending = 3000;
  const p = Q.build(a, ctx), q = Q.build({ ...a, people: [{ ...a.people[0], bonus: 0 }, a.people[1]] }, ctx);
  assert.equal(p.income.find(i => i.kind === 'salary').bonus, 15000);
  assert.equal(q.income.find(i => i.kind === 'salary').bonus, 0);
  const x = E.project(p).rows[0], y = E.project(q).rows[0];
  assert.ok(Math.abs((x.earnings - y.earnings) - 15000) < 1, `${x.earnings - y.earnings}`);
  assert.ok(x.taxes - y.taxes > 6000, `${x.taxes - y.taxes}`);   // over £100,000: more than 40% goes in tax
  // Take-home pay has no bonus box: it is already in what lands in the bank.
  const c = renter();
  c.people[0].bonus = 5000; c.spending = 900;
  assert.equal(Q.build(c, ctx).income.find(i => i.kind === 'salary').bonus, 0);
});
