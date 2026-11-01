'use strict';

// Two lists that turn a plan into variants:
//  - DRIVERS: small, typical changes (and risks) used to show what moves each goal.
//  - IDEAS: ready-made scenarios people often want to test, added as new scenarios.
// Each item says whether it applies to a plan and returns a changed copy. No DOM code.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  const people = p => p.household.people;
  const hasDebt = p => p.accounts.some(a => a.type === 'debt' && a.balance > 0 && !a.excluded);
  const fixedDebt = p => p.accounts.find(a => a.type === 'debt' && a.balance > 0 && a.fixedUntil >= p.startYear);
  const salaries = (p, owner) => p.income.filter(i => i.kind === 'salary' && i.owner === owner);
  // The person a "work" idea is about: the partner if there is one, else the only person.
  const worker = p => {
    const list = people(p).filter(x => salaries(p, x.id).length);
    return list[list.length - 1] || null;
  };

  // Spending list (today's money) that carries into retirement.
  function retirementSpending(p) {
    const p1 = people(p)[0];
    const tr = Math.max(0, p1.retireAge - p1.age);
    const price = Math.pow(1 + p.assumptions.inflation / 100, tr);
    return p.expenses.filter(e => !(e.key || '').startsWith('life:')).reduce((acc, e) => acc + E.streamAt(e, p, tr), 0) / price;
  }

  // Pay a person's salaries at `factor` of normal for `years` years starting `from` years from now.
  function changeSalary(p, owner, from, years, factor) {
    const person = people(p)[E.personIndex(p, owner)];
    const a0 = person.age + from, a1 = years === Infinity ? null : person.age + from + years;
    const out = [];
    for (const it of p.income) {
      if (it.kind !== 'salary' || it.owner !== owner) { out.push(it); continue; }
      const before = { ...it, id: `${it.id}`, endRef: 'age', endAge: a0 };
      const during = { ...it, id: E.uid(), name: `${it.name} (${factor === 0 ? 'break' : `${Math.round(factor * 100)}%`})`, amount: it.amount * factor, startRef: 'age', startAge: a0 };
      if (a1 !== null) { during.endRef = 'age'; during.endAge = a1; } else { during.endRef = it.endRef; during.endAge = it.endAge; }
      if (it.pensionMode === 'fixed') { during.employeePension = it.employeePension * factor; during.employerPension = it.employerPension * factor; }
      out.push(before);
      if (factor > 0) out.push(during);
      if (a1 !== null) out.push({ ...it, id: E.uid(), startRef: 'age', startAge: a1 });
    }
    p.income = out;
    return p;
  }

  function addExpense(p, e) {
    p.expenses.push(E.normalizePlan({ ...p, expenses: [{ owner: 'p1', inflationLinked: true, freq: 'month', ...e }] }).expenses[0]);
  }

  // ---- what moves your goals
  // Retire earlier or later: everyone's retirement age, and a retirement goal with it
  // (that goal is about retiring when the plan says you do).
  function moveRetirement(p, years) {
    for (const x of people(p)) x.retireAge += years;
    for (const g of p.goals) if (g.type === 'retire') g.age += years;
  }

  const DRIVERS = [
    { key: 'retireLater', kind: 'choice', label: 'Retire 2 years later', applies: p => people(p).every(x => x.retireAge + 2 <= 80),
      apply: p => { moveRetirement(p, 2); } },
    { key: 'retireEarlier', kind: 'choice', label: 'Retire 2 years earlier', applies: p => people(p).every(x => x.retireAge - 2 > x.age),
      apply: p => { moveRetirement(p, -2); } },
    { key: 'spendLess', kind: 'choice', label: 'Spend 10% less until retirement', applies: () => true,
      apply: p => { p.strategy.spendNowPct = Math.round(p.strategy.spendNowPct * 0.9); } },
    { key: 'spendLessRetired', kind: 'choice', label: 'Spend 10% less in retirement', applies: p => p.strategy.retireSpending > 0 || retirementSpending(p) > 0,
      apply: p => { p.strategy.retireSpending = Math.round((p.strategy.retireSpending > 0 ? p.strategy.retireSpending : retirementSpending(p)) * 0.9); } },
    { key: 'pension', kind: 'choice', label: '£200 a month more into pensions', applies: () => true,
      apply: p => { people(p)[0].extraPension += 200; } },
    { key: 'overpay', kind: 'choice', label: 'Overpay the mortgage with half the surplus', applies: p => hasDebt(p) && p.strategy.overpayPct < 50,
      apply: p => { p.strategy.overpayPct = 50; } },
    { key: 'weakMarkets', kind: 'risk', label: 'Shares return 2 points a year less', applies: () => true,
      apply: p => { p.assumptions.stockReturn -= 2; } },
    { key: 'inflation', kind: 'risk', label: 'Inflation 1 point higher', applies: () => true,
      apply: p => { p.assumptions.inflation += 1; } },
    { key: 'crash', kind: 'risk', label: 'A 30% share crash next year', applies: () => true,
      apply: p => { p.assumptions.crashYear = p.startYear + 1; p.assumptions.crashPct = -30; } },
  ];

  // ---- ready-made scenarios
  const IDEAS = [
    { id: 'retire-early', icon: 'retire', title: 'Retire 3 years earlier', text: 'Everyone stops work three years sooner.',
      applies: p => people(p).every(x => x.retireAge - 3 > x.age), apply: p => { moveRetirement(p, -3); } },
    { id: 'work-longer', icon: 'retire', title: 'Work 3 years longer', text: 'More years of saving, fewer years to fund.',
      applies: p => people(p).every(x => x.retireAge + 3 <= 80), apply: p => { moveRetirement(p, 3); } },
    { id: 'part-time', icon: 'clock', title: 'Go part-time', text: p => `${worker(p).name} works 60% from next year until retirement.`,
      applies: p => !!worker(p), apply: p => changeSalary(p, worker(p).id, 1, Infinity, 0.6) },
    { id: 'career-break', icon: 'pause', title: 'Take a year out', text: p => `${worker(p).name} takes a year off work next year.`,
      applies: p => !!worker(p), apply: p => changeSalary(p, worker(p).id, 1, 1, 0) },
    { id: 'job-loss', icon: 'warn', title: 'Six months out of work', text: p => `${people(p)[0].name}'s pay halves for a year, starting next year.`,
      applies: p => salaries(p, 'p1').length > 0, apply: p => changeSalary(p, 'p1', 1, 1, 0.5) },
    { id: 'new-baby', icon: 'heart', title: 'Have a baby', text: 'Nursery for three years, everyday child costs to 18, and a year of reduced pay.',
      applies: p => !!worker(p),
      apply: p => {
        const p1 = people(p)[0];
        addExpense(p, { name: 'New baby: nursery', amount: 1100, startRef: 'age', startAge: p1.age + 2, endRef: 'age', endAge: p1.age + 5, category: 'Children' });
        addExpense(p, { name: 'New baby: everyday costs', amount: 350, startRef: 'age', startAge: p1.age + 1, endRef: 'age', endAge: p1.age + 19, category: 'Children' });
        changeSalary(p, worker(p).id, 1, 1, 0.5);
        if (p.life && Array.isArray(p.life.children)) p.life.children.push({ name: 'New baby', age: 0 });
      } },
    { id: 'crash', icon: 'trend-down', title: 'Market crash next year', text: 'Shares fall 30% next year, then carry on as normal.',
      applies: () => true, apply: p => { p.assumptions.crashYear = p.startYear + 1; p.assumptions.crashPct = -30; } },
    { id: 'low-returns', icon: 'trend-down', title: 'Lower returns for good', text: 'Shares return 2 points a year less than assumed.',
      applies: () => true, apply: p => { p.assumptions.stockReturn -= 2; } },
    { id: 'inflation', icon: 'trend', title: 'Higher inflation', text: 'Prices rise 1.5 points a year faster.',
      applies: () => true, apply: p => { p.assumptions.inflation += 1.5; } },
    { id: 'remortgage', icon: 'debt', title: 'Higher rate when the fix ends', text: p => `The mortgage rate is 2 points higher after ${fixedDebt(p).fixedUntil}.`,
      applies: p => !!fixedDebt(p), apply: p => { const d = fixedDebt(p); d.rateAfterFix = (d.rateAfterFix === null ? d.rate : d.rateAfterFix) + 2; } },
    { id: 'overpay', icon: 'debt', title: 'Overpay the mortgage', text: 'Half of each year’s surplus goes to the mortgage instead of investments.',
      applies: hasDebt, apply: p => { p.strategy.overpayPct = 50; } },
    { id: 'spend-less', icon: 'piggy', title: 'Spend 10% less', text: 'Trim spending by a tenth until retirement and invest the difference.',
      applies: () => true, apply: p => { p.strategy.spendNowPct = Math.round(p.strategy.spendNowPct * 0.9); } },
    { id: 'sell-property', icon: 'home', title: 'Sell a property in 10 years', text: p => `Sell ${p.accounts.filter(a => a.type === 'property' && !a.excluded).sort((a, b) => a.balance - b.balance)[0].name} and invest the money.`,
      applies: p => p.accounts.filter(a => a.type === 'property' && !a.excluded).length >= 2,
      apply: p => { const a = p.accounts.filter(x => x.type === 'property' && !x.excluded).sort((x, y) => x.balance - y.balance)[0]; a.sellYear = p.startYear + 10; } },
    { id: 'care', icon: 'heart', title: 'Care costs later in life', text: p => `£60,000 a year of care for three years from ${people(p)[0].name}'s 85th birthday.`,
      applies: p => people(p)[0].endAge > 86,
      apply: p => addExpense(p, { key: 'idea:care', name: 'Care in later life', amount: 60000, freq: 'year', startRef: 'age', startAge: 85, endRef: 'age', endAge: 88 }) },
  ];

  const textOf = (item, plan) => (typeof item.text === 'function' ? item.text(plan) : item.text);

  // A copy of `plan` with a driver or idea applied.
  function variantOf(item, plan) {
    const p = E.clonePlan(plan);
    item.apply(p);
    return E.normalizePlan(p);
  }

  const driversFor = plan => DRIVERS.filter(d => d.applies(plan));
  const ideasFor = plan => IDEAS.filter(i => i.applies(plan));

  // Change in each goal's chance for each driver (percentage points). Synchronous; the
  // app runs the same thing one driver at a time so the page stays responsive.
  function driverImpacts(plan, runs, seed) {
    const evalPlan = p => { const proj = E.project(p); return E.evaluateGoals(p, proj, E.monteCarlo(p, runs, seed), { runs, seed }); };
    const base = evalPlan(plan);
    return {
      base,
      rows: driversFor(plan).map(d => {
        const after = evalPlan(variantOf(d, plan));
        return { driver: d, deltas: base.map(b => { const a = after.find(x => x.goal.id === b.goal.id); return a ? a.probability - b.probability : 0; }) };
      }),
    };
  }

  const api = { DRIVERS, IDEAS, driversFor, ideasFor, variantOf, textOf, driverImpacts, changeSalary, retirementSpending };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScenarioIdeas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
