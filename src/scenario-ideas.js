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

  const childName = p => { const c = ((p.life && p.life.children) || []).filter(x => x.age < 30).sort((a, b) => b.age - a.age)[0]; return c && c.name ? c.name : 'your eldest'; };

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
    { id: 'gifts', icon: 'heart', title: 'Give £10,000 a year to family', text: p => `From ${people(p)[0].name}'s retirement until 85, in today's money: gifts out of surplus income are free of inheritance tax.`,
      applies: p => !!(p.life && (p.life.children || []).length),
      apply: p => addExpense(p, { key: 'life:gifts', name: 'Gifts to family', amount: 10000, freq: 'year', category: 'Gifts', startRef: 'retire', endRef: 'age', endAge: 85 }) },
    { id: 'first-home', icon: 'home', title: 'Help a child buy a first home', text: p => `£50,000 in today's money when ${childName(p)} is 30.`,
      applies: p => !!(p.life && (p.life.children || []).some(c => c.age < 30)),
      apply: p => {
        const c = (p.life.children || []).filter(x => x.age < 30).sort((a, b) => b.age - a.age)[0];
        p.events.push(E.normalizePlan({ ...p, events: [{ name: `First home help${c.name ? ` for ${c.name}` : ''}`, kind: 'expense', amount: 50000, year: p.startYear + 30 - c.age }] }).events[0]);
      } },
    { id: 'spend-more', icon: 'piggy', title: 'Spend 20% more in retirement', text: 'More holidays, help for family, a better car: what if you enjoy more of it?',
      applies: p => p.strategy.retireSpending > 0 || retirementSpending(p) > 0,
      apply: p => { p.strategy.retireSpending = Math.round((p.strategy.retireSpending > 0 ? p.strategy.retireSpending : retirementSpending(p)) * 1.2 / 100) * 100; } },
    { id: 'care', icon: 'heart', title: 'Care costs later in life', text: p => `£60,000 a year of care for three years from ${people(p)[0].name}'s 85th birthday.`,
      applies: p => people(p)[0].endAge > 86,
      apply: p => addExpense(p, { key: 'idea:care', name: 'Care in later life', amount: 60000, freq: 'year', startRef: 'age', startAge: 85, endRef: 'age', endAge: 88 }) },
  ];

  // ---- comparisons: one choice made two ways, next to the plan as it is
  const R = E.R;
  const gbp = v => `£${Math.round(v).toLocaleString('en-GB')}`;
  // A person's main salary, for salary sacrifice: taxed pay, or pay entered as take-home (its
  // gross is estimated). None when the household switches tax off: there is nothing to save.
  const grossOf = (p, i) => {
    const v = E.incomeAfterCosts(i, p, 0);
    return i.tax === 'uk' ? v : R.grossFromTakeHome(v, p.household.region);
  };
  function mainSalary(p, owner) {
    if (p.household.ignoreTax) return null;
    return p.income.filter(i => i.kind === 'salary' && i.owner === owner && (i.tax === 'uk' || i.tax === 'none') && E.incomeAfterCosts(i, p, 0) > 0)
      .sort((a, b) => grossOf(p, b) - grossOf(p, a))[0] || null;
  }
  // People still working, highest paid first.
  const earners = p => people(p).filter(x => x.retireAge > x.age && mainSalary(p, x.id))
    .sort((a, b) => grossOf(p, mainSalary(p, b.id)) - grossOf(p, mainSalary(p, a.id)));
  const lisaOf = (p, owner) => p.accounts.find(a => a.type === 'lisa' && a.owner === owner && !a.excluded) || null;
  // Someone who can pay into a Lifetime ISA for retirement: has one (under 50), or can open one (18–39).
  const lisaPerson = p => earners(p).find(x => {
    const l = lisaOf(p, x.id);
    return l ? l.purpose === 'retirement' && x.age < R.LISA.payUntil : x.age >= 18 && x.age < R.LISA.openBefore;
  }) || null;

  function setLisa(p, person, amount) {
    const l = lisaOf(p, person.id);
    if (l) l.contribution = amount;
    else if (amount > 0) p.accounts.push({ id: E.uid(), name: `${person.name} Lifetime ISA`, type: 'lisa', owner: person.id, balance: 0, contribution: amount, purpose: 'retirement' });
  }

  // A person's pay after pension, income tax and NI this year (taxed pay).
  function takeHome(p, i) {
    const P = E.precompute(p).people[i];
    return P.gross[0] - P.employee[0] - P.baseIT[0] - P.ni[0];
  }

  // Take-home pay lost this year by giving up `gross` of a salary entered as take-home pay.
  function takeHomeCost(p, item, gross) {
    const region = p.household.region, g0 = grossOf(p, item);
    const net = x => x - R.incomeTax(x, region) - R.nationalInsurance(x);
    return net(g0) - net(Math.max(0, g0 - gross));
  }

  // Pay `gross` a year more into the pension from a person's salary by salary sacrifice, until
  // `untilAge` (the salary is split there so the rest of it carries on as before). Pay entered
  // as take-home falls by what the sacrifice costs after tax.
  function sacrificeMore(p, owner, gross, untilAge = Infinity) {
    const person = people(p)[E.personIndex(p, owner)];
    const item = mainSalary(p, owner);
    const v = E.incomeAfterCosts(item, p, 0);
    if (untilAge < person.retireAge && untilAge > person.age) {
      p.income.splice(p.income.indexOf(item) + 1, 0, { ...item, id: E.uid(), startRef: 'age', startAge: untilAge });
      item.endRef = 'age'; item.endAge = untilAge;
    }
    const v2 = item.tax === 'uk' ? v : v - takeHomeCost(p, item, gross);
    item.amount *= v2 / v;
    item.sacrifice = true;
    if (item.pensionMode === 'pct') {
      item.employeePension = (item.employeePension * v / 100 + gross) / v2 * 100;
      item.employerPension = item.employerPension * v / v2;
    } else item.employeePension += gross / 12;
  }

  // The salary to give up so that take-home pay falls by `net` a year.
  function grossForTakeHome(p, owner, net) {
    const i = E.personIndex(p, owner);
    const item = mainSalary(p, owner);
    const base = item.tax === 'uk' ? takeHome(p, i) : 0;
    const cost = gross => {
      if (item.tax !== 'uk') return takeHomeCost(p, item, gross);
      const q = E.clonePlan(p);
      sacrificeMore(q, owner, gross);
      return base - takeHome(q, i);
    };
    let gross = net;
    for (let k = 0; k < 6; k++) {
      const c = cost(gross);
      if (c < 1) break;
      gross *= net / c;
    }
    return Math.round(gross / 10) * 10;
  }

  // Said when the salary was entered as take-home pay, so the tax saved is an estimate.
  const guess = (p, x) => (mainSalary(p, x.id).tax === 'uk' ? '' : ' (tax estimated from take-home pay)');

  const PENSION_ISA_NET = 3600;   // £300 a month of take-home pay

  const COMPARISONS = [
    { id: 'sacrifice-lisa', icon: 'pension', title: 'Salary sacrifice or Lifetime ISA',
      applies: p => !!lisaPerson(p),
      text: p => {
        const x = lisaPerson(p);
        return `${x.name} puts ${gbp(R.LISA.maxContribution)} of take-home pay a year into a Lifetime ISA (the government adds 25%, tax-free from 60), or gives up the salary that costs the same take-home pay into the pension (tax and NI relief, taxed when drawn, from ${x.pensionAccessAge}). Both until ${x.name} is ${R.LISA.payUntil}, when Lifetime ISA payments stop.`;
      },
      options: p => {
        const x = lisaPerson(p), net = R.LISA.maxContribution;
        const gross = grossForTakeHome(p, x.id, net);
        return [
          { name: 'Lifetime ISA', text: `${gbp(net)} a year into ${x.name}’s Lifetime ISA`, apply: q => setLisa(q, x, net) },
          { name: 'Salary sacrifice', text: `${gbp(gross)} a year more into ${x.name}’s pension, for ${gbp(net)} less take-home pay${guess(p, x)}`, apply: q => { setLisa(q, x, 0); sacrificeMore(q, x.id, gross, R.LISA.payUntil); } },
        ];
      } },
    { id: 'pension-isa', icon: 'piggy', title: 'Pension or ISA',
      applies: p => earners(p).length > 0,
      text: p => `${earners(p)[0].name} gives up the salary that costs ${gbp(PENSION_ISA_NET / 12)} a month of take-home pay, into the pension by salary sacrifice, instead of that money being saved in ISAs. Until retirement.`,
      base: 'ISAs (as now)',
      options: p => {
        const x = earners(p)[0];
        const gross = grossForTakeHome(p, x.id, PENSION_ISA_NET);
        return [{ name: 'Pension by salary sacrifice', text: `${gbp(gross)} a year more into ${x.name}’s pension, for ${gbp(PENSION_ISA_NET)} less take-home pay${guess(p, x)}`, apply: q => sacrificeMore(q, x.id, gross) }];
      } },
    { id: 'after-isa', icon: 'pension', title: 'Once the ISAs are full',
      applies: p => !p.household.ignoreTax && !p.strategy.pensionFirst && p.strategy.giaMonthly === null && earners(p).length > 0,
      text: 'What is left after the ISAs goes into a general investment account (dividends and gains taxed, money available any time), or first into the pensions of whoever pays the most tax and is still working: tax relief at their top rate, within the £60,000 annual allowance, available from the minimum pension age with a quarter tax-free.',
      base: 'General account (as now)',
      options: () => [{ name: 'Pensions first', text: 'Then the general account', apply: q => { q.strategy.pensionFirst = true; } }] },
    { id: 'overpay-invest', icon: 'debt', title: 'Overpay the mortgage or invest',
      applies: hasDebt,
      text: p => `What is left over each month all goes into investments, or all pays the mortgage off sooner${p.strategy.overpayCapPct > 0 ? ` (up to the ${p.strategy.overpayCapPct}% a year most lenders allow)` : ''}.`,
      options: () => [
        { name: 'Invest the surplus', text: 'No overpayments', apply: q => { q.strategy.overpayPct = 0; } },
        { name: 'Overpay with all of it', text: 'All of the surplus to the mortgage', apply: q => { q.strategy.overpayPct = 100; } },
      ] },
    { id: 'retire-when', icon: 'retire', title: 'Retire earlier or later',
      applies: p => people(p).every(x => x.retireAge - 3 > x.age) || people(p).every(x => x.retireAge + 3 <= 80),
      text: 'Everyone stops work three years sooner, or three years later.',
      options: p => [
        people(p).every(x => x.retireAge - 3 > x.age) && { name: 'Retire 3 years earlier', text: people(p).map(x => `${x.name} at ${x.retireAge - 3}`).join(', '), apply: q => moveRetirement(q, -3) },
        people(p).every(x => x.retireAge + 3 <= 80) && { name: 'Work 3 years longer', text: people(p).map(x => `${x.name} at ${x.retireAge + 3}`).join(', '), apply: q => moveRetirement(q, 3) },
      ].filter(Boolean) },
    { id: 'markets', icon: 'trend', title: 'Weaker or stronger markets',
      applies: () => true,
      text: p => `Shares return 2 points a year less, or more, than the ${p.assumptions.stockReturn}% you assume.`,
      options: p => [
        { name: 'Weaker markets', text: `Shares ${p.assumptions.stockReturn - 2}% a year`, apply: q => { q.assumptions.stockReturn -= 2; } },
        { name: 'Stronger markets', text: `Shares ${p.assumptions.stockReturn + 2}% a year`, apply: q => { q.assumptions.stockReturn += 2; } },
      ] },
    { id: 'mortgage-rate', icon: 'debt', title: 'Mortgage rate after the fix',
      applies: p => !!fixedDebt(p),
      text: p => { const d = fixedDebt(p); return `${d.name}: the rate after the fix ends in ${d.fixedUntil} is 1 point lower, or 2 points higher, than the ${d.rateAfterFix === null ? d.rate : d.rateAfterFix}% in the plan.`; },
      options: p => {
        const r = (d => (d.rateAfterFix === null ? d.rate : d.rateAfterFix))(fixedDebt(p));
        const lower = Math.max(0, Math.round((r - 1) * 100) / 100), higher = Math.round((r + 2) * 100) / 100;
        const set = v => q => { fixedDebt(q).rateAfterFix = v; };
        return [
          { name: 'Mortgage rate 1 point lower', text: `${lower}% after the fix`, apply: set(lower) },
          { name: 'Mortgage rate 2 points higher', text: `${higher}% after the fix`, apply: set(higher) },
        ];
      } },
  ];

  const comparisonsFor = plan => COMPARISONS.filter(c => c.applies(plan));

  // A comparison's options, each with its plan; options that change nothing are left out.
  function optionsOf(cmp, plan) {
    const same = JSON.stringify(plan);
    return cmp.options(plan).map(o => ({ ...o, plan: variantOf(o, plan) }))
      .filter(o => JSON.stringify(o.plan) !== same);
  }

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

  const api = { DRIVERS, IDEAS, COMPARISONS, driversFor, ideasFor, comparisonsFor, optionsOf, variantOf, textOf, driverImpacts, changeSalary, retirementSpending, grossForTakeHome, takeHome };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ScenarioIdeas = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
