'use strict';

// Money set aside: an emergency fund, savings building up for a repeated cost, yearly budgets.

const test = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/engine');
const RV = require('../../src/review');
const B = require('../../src/benchmarks');

function base(reserves = []) {
  const p = E.defaultPlan(2026);
  p.asOf = '2026-01-01';
  p.accounts = [
    { id: 'bank', name: 'Bank', type: 'cash', balance: 10000 },
    { id: 'isa', name: 'ISA', type: 'isa', owner: 'p1', balance: 20000 },
    { id: 'house', name: 'House', type: 'property', balance: 300000 },
  ];
  p.strategy.cashReserve = 10000;
  p.expenses.push({ id: 'trips', name: 'Trips', amount: 3000, freq: 'year' });
  p.events = [2029, 2034, 2039].map(y => ({ name: 'Roof and boiler', kind: 'expense', year: y, amount: 10000 }));
  p.reserves = reserves;
  return E.normalizePlan(p);
}

test('reserves are cleaned: kinds, accounts that can hold money, budgets need their item', () => {
  const p = base([
    { kind: 'emergency', accountId: 'bank' },
    { kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'house' },
    { kind: 'budget', expenseId: 'nope' },
    { kind: 'odd', amount: 'x' },
  ]);
  assert.equal(p.reserves.length, 3);
  assert.deepEqual(p.reserves.map(r => r.kind), ['emergency', 'saving', 'emergency']);
  assert.equal(p.reserves[0].amount, null);
  assert.equal(p.reserves[1].accountId, '', 'a house cannot hold money set aside');
  assert.equal(p.reserves[1].saved, null);
});

test('an emergency fund follows the cash buffer and rises with prices', () => {
  const p = base([{ kind: 'emergency', accountId: 'bank' }]);
  const [now] = E.reservesAt(p, 0);
  assert.equal(now.amount, 10000);
  assert.equal(now.held, 10000);
  const [later] = E.reservesAt(p, 2);
  assert.ok(Math.abs(later.amount - 10000 * Math.pow(1 + p.assumptions.inflation / 100, 2)) < 0.01);
});

test('savings build up to each planned cost, then start again', () => {
  const p = base([{ kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'isa' }]);
  const at = y => E.reservesAt(p, y)[0];
  const infl = 1 + p.assumptions.inflation / 100;
  // The first cost is in plan year 3, taken as due at 3.5 years.
  assert.equal(at(0).amount, 0);
  assert.equal(at(0).dueYear, 2029);
  assert.ok(Math.abs(at(3.5 * 0.5).amount - 0.5 * 10000 * infl ** 3) < 0.01, 'half way');
  assert.ok(Math.abs(at(3.49).amount - 10000 * infl ** 3) < 10000 * infl ** 3 * 0.01, 'nearly all of it just before');
  // Just after: building up for the next one, five years later.
  assert.equal(at(3.6).dueYear, 2034);
  assert.ok(at(3.6).amount < 300);
  assert.ok(Math.abs(at(3.6).perYear - 10000 * infl ** 8 / 5) < 0.01);
  // After the last one, nothing.
  assert.equal(at(14).amount, 0);
  // What was already put aside counts.
  const q = base([{ kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'isa', saved: 4000 }]);
  assert.equal(E.reservesAt(q, 0)[0].amount, 4000);
  assert.ok(E.reservesAt(q, 1.75)[0].amount > E.reservesAt(p, 1.75)[0].amount);
});

test('savings held in cash stay in cash until paid; elsewhere the plan is unchanged', () => {
  const none = E.project(base());
  const inIsa = E.project(base([{ kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'isa' }]));
  const inBank = E.project(base([{ kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'bank' }]));
  assert.equal(inIsa.rows[2].cash, none.rows[2].cash);
  assert.ok(inBank.rows[2].cash > none.rows[2].cash + 4000, 'two years of savings in the bank');
  assert.ok(inBank.rows[2].isa < none.rows[2].isa, 'invested less instead');
  // Once paid, the cash falls back towards the buffer plus the new savings.
  assert.ok(inBank.rows[4].cash < inBank.rows[3].cash);
});

test('a budget is available for the year; what is kept from last year is spent too', () => {
  const p = base([{ kind: 'budget', name: 'Trips', expenseId: 'trips', accountId: 'bank', left: 800 }]);
  const [r] = E.reservesAt(p, 0);
  assert.equal(r.yearly, 3000);
  assert.equal(r.amount, 3800);
  assert.equal(r.held, 800, 'only what is left is already in the account');
  assert.equal(E.reservesAt(p, 1)[0].left, 0);
  const without = E.project(base([{ kind: 'budget', name: 'Trips', expenseId: 'trips', accountId: 'bank' }]));
  const withLeft = E.project(p);
  assert.ok(Math.abs((without.rows[1].netWorth - withLeft.rows[1].netWorth) - 800) < 1);
  // Until it is spent it sits in the account but is not counted in net worth: it is to be spent.
  assert.ok(Math.abs(withLeft.rows[0].locked - 800) < 0.01);
  assert.ok(Math.abs((without.rows[0].netWorth - withLeft.rows[0].netWorth) - 800) < 0.01);
  assert.equal(withLeft.rows[0].cash, without.rows[0].cash);
  assert.ok(Math.abs(RV.estimateAt(p, '2026-01-01').locked - 800) < 0.01);
});

test('the yearly review starts budgets again and passes on what is kept', () => {
  const p = base([
    { id: 'em', kind: 'emergency', accountId: 'bank', amount: 8000 },
    { id: 'tr', kind: 'budget', name: 'Trips', expenseId: 'trips', accountId: 'bank', left: 500 },
  ]);
  const rolled = RV.rollPlan(p, 1);
  assert.equal(rolled.reserves.find(r => r.id === 'tr').left, 0);
  assert.ok(rolled.reserves.find(r => r.id === 'em').amount > 8000);
  const ws = E.normalizeWorkspace({ scenarios: [{ id: 'a', name: 'A', plan: p }, { id: 'b', name: 'B', plan: E.clonePlan(p) }], activeId: 'a' });
  const draft = RV.start(ws, { year: 2027, date: '2027-01-01' });
  draft.plan.reserves.find(r => r.id === 'tr').left = 1200;
  const out = RV.apply(ws, draft);
  for (const s of out.scenarios) assert.equal(s.plan.reserves.find(r => r.name === 'Trips').left, 1200);
});

test('a suggestion to mark money set aside, until something is', () => {
  const p = base();
  assert.ok(B.insights(p, E.project(p)).some(i => i.id === 'reserves'));
  const q = base([{ kind: 'emergency', accountId: 'bank' }]);
  assert.ok(!B.insights(q, E.project(q)).some(i => i.id === 'reserves'));
});

test('money to be spent is locked: in its account, not in net worth', () => {
  const none = E.project(base());
  const p = base([{ kind: 'saving', name: 'Roof', eventName: 'Roof and boiler', accountId: 'isa' }]);
  const pr = E.project(p);
  const held = E.reservesAt(p, 2)[0].held;
  assert.ok(held > 4000);
  assert.ok(Math.abs(pr.rows[2].locked - held) < 0.01);
  assert.ok(Math.abs(pr.rows[2].isa - none.rows[2].isa) < 0.01, 'still invested');
  assert.ok(Math.abs((none.rows[2].netWorth - pr.rows[2].netWorth) - held) < 0.01);
  assert.ok(Math.abs(E.goalValue(none.rows[2], 'all') - E.goalValue(pr.rows[2], 'all') - held) < 0.01);
  assert.equal(E.goalValue(pr.rows[2], 'liquid'), E.goalValue(none.rows[2], 'liquid'), 'still there to spend in a pinch');
  // The estimate for a date leaves it out too.
  const est = RV.estimateAt(p, '2028-01-01');
  assert.ok(Math.abs(est.locked - held) < 0.01);
  // The emergency fund is not meant to be spent, so it still counts.
  const q = base([{ kind: 'emergency', accountId: 'bank' }]);
  assert.equal(E.project(q).rows[2].netWorth, none.rows[2].netWorth);
});

test('the yearly review explains the gap in parts that add up', () => {
  const p = base([{ id: 'tr', kind: 'budget', name: 'Trips', expenseId: 'trips', accountId: 'bank' }]);
  const ws = E.normalizeWorkspace({ scenarios: [{ id: 'a', name: 'A', plan: p }], activeId: 'a' });
  const draft = RV.start(ws, { year: 2027, date: '2027-01-01' });
  const sum = x => x.parts.reduce((s, q) => s + q.diff, 0);
  let x = RV.explain(draft);
  assert.ok(Math.abs(x.total) < 1, 'nothing typed in: on plan');
  // Investments 3,000 up, house 10,000 down; 1,000 of trips not spent and kept.
  const isa = draft.plan.accounts.find(a => a.id === 'isa');
  RV.setValue(draft, 'accounts', 'isa', isa.balance + 3000);
  const house = draft.plan.accounts.find(a => a.id === 'house');
  RV.setValue(draft, 'accounts', 'house', house.balance - 10000);
  RV.setReserve(draft, 'tr', { spent: 2000, keep: true });
  x = RV.explain(draft);
  assert.ok(Math.abs(sum(x) - x.total) < 0.01, 'the parts add up');
  const part = k => (x.parts.find(q => q.key === k) || { diff: 0 }).diff;
  assert.ok(Math.abs(part('investments') - 3000) < 1);
  assert.ok(Math.abs(part('property') + 10000) < 1);
  assert.ok(Math.abs(part('budgets') - 1000) < 1);
  assert.ok(Math.abs(part('setAside') + 1000) < 1, 'kept to spend, so not counted');
  assert.equal(x.parts[0].key, 'property', 'biggest first');
  // Saying what was paid in splits markets from saving.
  draft.paidIn = x.expectedPaidIn + 1000;
  x = RV.explain(draft);
  const q = k => (x.parts.find(r => r.key === k) || { diff: 0 }).diff;
  assert.ok(Math.abs(q('paidIn') - 1000) < 1);
  assert.ok(Math.abs(q('markets') - 2000) < 1);
  assert.ok(Math.abs(sum(x) - x.total) < 0.01);
  // The review keeps the budget's leftover in the plan it saves.
  assert.equal(draft.plan.reserves.find(r => r.id === 'tr').left, 1000);
});
