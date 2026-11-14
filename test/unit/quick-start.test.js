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
