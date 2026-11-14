'use strict';

// Quick start: a first plan from a handful of plain questions (who, pay, pension, savings, home,
// debts, spending, what you want to know). Round figures and typical values; everything it adds
// is an ordinary item that can be changed afterwards.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const R = typeof module !== 'undefined' && module.exports ? require('./uk-rules.js') : root.UKRules;

  // Kinds of debt, with a typical interest rate for someone who does not know theirs.
  const DEBTS = {
    card: { label: 'Credit card', rate: 23 },
    overdraft: { label: 'Overdraft', rate: 35 },
    loan: { label: 'Personal loan', rate: 9 },
    car: { label: 'Car finance', rate: 9 },
    bnpl: { label: 'Buy now, pay later', rate: 0 },
    family: { label: 'Owed to family or friends', rate: 0 },
  };
  const AUTO_ENROL = { employee: 5, employer: 3 };   // the legal minimum most employees are on
  // Public-service schemes that build a yearly pension, not a pot: what the quick start calls
  // them, and roughly what comes off pay for each (it varies with salary; 2026 rates).
  const SCHEMES = {
    teachers: { label: 'Teachers’', member: 9.6 },
    nhs: { label: 'NHS', member: 9.8 },
    lgps: { label: 'Council (local government)', member: 6.5 },
    civil: { label: 'Civil service', member: 5.45 },
  };
  const MORTGAGE_RATE = 4.5;

  const person = () => ({ name: '', age: null, pay: '', amount: 0, hourly: 0, hours: 0, pensionNow: 0, retireAge: null, workPension: '', scheme: '', joined: 0, eePct: null, erPct: null, ownPension: 0, pot: 0, fixedPension: 0, fixedAge: null, niYears: 0, loan: false, loanOwed: 0 });
  // What a student loan is typically worth when the person does not know theirs.
  const LOAN_TYPICAL = { plan1: 8000, plan2: 45000, plan4: 15000, plan5: 30000 };
  // The plan most likely for someone of that age living there (it can be changed afterwards).
  const loanPlanFor = (age, region, startYear) => {
    if (region === 'scotland') return 'plan4';
    const started = startYear - age + 18;            // the year they turned 18
    return started >= 2023 ? 'plan5' : started >= 2012 ? 'plan2' : 'plan1';
  };

  function blank(region) {
    return {
      region: region === 'ruk' ? 'ruk' : 'scotland', partner: false, people: [person(), person()],
      otherIncome: 0, childMoney: 0, youngest: null, cash: 0, investments: 0,
      home: '', homeValue: 0, mortgage: 0, mortgagePay: 0, rent: 0,
      let: false, letValue: 0, letMortgage: 0, letPay: 0, letRent: 0,
      debts: [],
      spending: 0,
      goals: { retire: true, emergency: true, save: false, saveName: 'A new car', saveAmount: 0, saveYear: 0, buy: false, buyPrice: 0, buyYear: 0 },
    };
  }

  const peopleOf = a => (a.partner ? a.people.slice(0, 2) : a.people.slice(0, 1));
  const works = x => x.pay === 'takehome' || x.pay === 'salary' || x.pay === 'hourly' || x.pay === 'self';
  const employed = x => works(x) && x.pay !== 'self';
  // The scheme a person's pay builds, when it is one that pays a set pension.
  const schemeOf = x => (employed(x) && x.workPension === 'yes' && SCHEMES[x.scheme] ? x.scheme : '');
  // Pay before tax, a year, however it was given.
  const grossOf = (x, region) => (x.pay === 'hourly' ? Math.round(x.hourly * x.hours * 52) : x.pay === 'takehome' ? Math.round(R.grossFromTakeHome(x.amount * 12, region)) : x.amount);
  // What a scheme has built up, from the year joined and pay now (today's money, a year).
  const schemeEstimate = (x, region, startYear) => E.estimateDb({ scheme: schemeOf(x), joined: Math.min(startYear, Math.max(1960, Math.round(x.joined || startYear))), salary: grossOf(x, region), startYear, realGrowth: 1 });
  const nameOf = (x, i) => (x.name || '').trim() || (i === 0 ? 'You' : 'Partner');
  const spaOf = (x, startYear) => R.statePensionAge(startYear - (x.age || 40));

  // A repayment mortgage's monthly payment over 25 years, when none was given.
  const mortgagePayment = (owed, rate = MORTGAGE_RATE) => {
    const r = rate / 100 / 12;
    return owed > 0 ? Math.round(owed * r / (1 - Math.pow(1 + r, -300))) : 0;
  };

  function build(a, opts = {}) {
    const startYear = opts.startYear || E.currentYear();
    const ps = peopleOf(a);
    const people = ps.map((x, i) => {
      const age = Math.min(100, Math.max(16, Math.round(x.age || 40)));
      const stop = works(x) ? Math.min(80, Math.max(age + 1, Math.round(x.retireAge || spaOf(x, startYear)))) : age;
      const loan = x.loan ? loanPlanFor(age, a.region, startYear) : '';
      return {
        name: nameOf(x, i), age, retireAge: stop,
        ...(x.niYears > 0 ? { niYears: Math.min(50, Math.round(x.niYears)) } : {}),
        // Working for oneself: what is paid into a pension comes out of what is taken home.
        ...(x.pay === 'self' && x.ownPension > 0 ? { extraPension: Math.round(x.ownPension) } : {}),
        ...(loan ? { loanPlan: loan, loanBalance: x.loanOwed > 0 ? x.loanOwed : LOAN_TYPICAL[loan], loanEndYear: startYear + Math.max(1, R.STUDENT_LOANS[loan].writeOff - Math.max(0, age - 22)) } : {}),
      };
    });
    const income = [], accounts = [], expenses = [], goals = [];
    const age = x => Math.min(100, Math.max(16, Math.round(x.age || 40)));
    const g = a.goals || {};
    // A home to buy later: rent or keep stops that year.
    const buyYear = g.buy && g.buyPrice > 0 && (a.home === 'rent' || a.home === 'family') ? Math.max(startYear + 1, Math.round(g.buyYear || startYear + 5)) : 0;
    ps.forEach((x, i) => {
      const id = `p${i + 1}`, n = people[i].name, mine = n === 'You';
      const scheme = schemeOf(x);
      if (x.pay === 'self') {
        // Self-employed profit, or salary and dividends from one's own company: taxed as profit (close, not exact, for dividends).
        if (x.amount > 0) income.push({ name: mine ? 'My business' : `${n}’s business`, kind: 'self', owner: id, tax: 'uk', amount: x.amount, freq: 'year', growth: 3, inflationLinked: false, endRef: 'retire' });
      } else if (works(x)) {
        const gross = x.pay === 'hourly' ? Math.round(x.hourly * x.hours * 52) : x.amount;
        const pct = (v, d) => (v === null || v === undefined || v === '' || !Number.isFinite(+v) ? d : Math.min(60, Math.max(0, +v)));
        const pension = x.workPension === 'no' ? { employeePension: 0, employerPension: 0 }
          : scheme ? { employeePension: SCHEMES[scheme].member, employerPension: 0, pensionTo: 'db' }
            : { employeePension: pct(x.eePct, AUTO_ENROL.employee), employerPension: pct(x.erPct, AUTO_ENROL.employer) };
        if (gross > 0) {
          income.push({
            name: mine ? 'My pay' : `${n}’s pay`, kind: 'salary', owner: id, growth: 3, inflationLinked: false, endRef: 'retire', pensionMode: 'pct', ...pension,
            ...(x.pay === 'takehome' ? { tax: 'none', amount: x.amount, freq: 'month' } : { tax: 'uk', amount: gross, freq: 'year' }),
          });
        }
      } else if (x.pensionNow > 0) {
        income.push({ name: mine ? 'My pensions' : `${n}’s pensions`, kind: 'other', owner: id, tax: 'none', amount: x.pensionNow, freq: 'month', endRef: 'end', inflationLinked: true });
      }
      // The scheme this job builds: estimated from the year joined, and taken when work stops
      // (cut for being early, as the scheme does), since few can live on nothing until then.
      if (scheme && grossOf(x, a.region) > 0) {
        const e = schemeEstimate(x, a.region, startYear);
        const from = Math.min(75, Math.max(55, age(x) + 1, Math.min(people[i].retireAge, e.pensionAge || spaOf(x, startYear))));
        income.push({ name: `${mine ? 'My' : `${n}’s`} ${SCHEMES[scheme].label.replace(/ \(.*/, '')} pension`, kind: 'dbpension', dbScheme: scheme, dbJoined: Math.round(x.joined || startYear), dbSalary: grossOf(x, a.region), owner: id, tax: 'uk',
          amount: Math.round(e.builtUp), dbAccrual: Math.round(e.perYear), lumpMultiple: e.lumpMultiple, freq: 'year', startAge: from });
      }
      // A pension that pays a set amount a year (an old job, council, NHS, teachers): used as the statement gives it.
      if (x.fixedPension > 0) {
        const from = Math.min(75, Math.max(Math.max(50, age(x) + 1), Math.round(x.fixedAge || spaOf(x, startYear))));
        income.push({ name: mine ? 'My pension with a set amount' : `${n}’s pension with a set amount`, kind: 'dbpension', dbScheme: 'other', owner: id, tax: 'uk', amount: x.fixedPension, freq: 'year', startAge: from, dbAccrual: 0, lumpMultiple: 0 });
      }
      if (x.pot > 0 || (x.pay === 'self' && x.ownPension > 0) || (employed(x) && x.workPension !== 'no' && !scheme)) accounts.push({ name: mine ? 'My pension' : `${n}’s pension`, type: 'pension', owner: id, balance: x.pot || 0 });
    });
    // Money that comes because of the children stops when the youngest is 18.
    if (a.childMoney > 0) income.push({ name: 'Money for the children', kind: 'other', owner: 'joint', tax: 'none', amount: a.childMoney, freq: 'month', endRef: 'year', toYear: startYear + Math.max(1, 18 - Math.min(17, Math.max(0, Math.round(a.youngest || 0)))), inflationLinked: true });
    if (a.otherIncome > 0) income.push({ name: 'Other money coming in', kind: 'other', owner: 'joint', tax: 'none', amount: a.otherIncome, freq: 'month', endRef: 'end', inflationLinked: true });
    if (a.cash > 0) accounts.push({ name: 'Bank and savings', type: 'cash', owner: 'joint', balance: a.cash });
    if (a.investments > 0) accounts.push({ name: 'ISAs and investments', type: 'isa', owner: 'p1', balance: a.investments });
    if (a.home === 'mortgage' || a.home === 'own') {
      if (a.homeValue > 0) accounts.push({ name: 'Home', type: 'property', owner: 'joint', balance: a.homeValue, rate: 3 });
      if (a.home === 'mortgage' && a.mortgage > 0) accounts.push({ name: 'Mortgage', type: 'debt', owner: 'joint', balance: a.mortgage, rate: MORTGAGE_RATE, payment: a.mortgagePay > 0 ? a.mortgagePay : mortgagePayment(a.mortgage) });
    }
    // A property that is rented out: its value, what is owed on it, and the rent.
    if (a.let && a.letValue > 0) {
      accounts.push({ name: 'Rented-out property', type: 'property', owner: 'joint', balance: a.letValue, rate: 3 });
      if (a.letMortgage > 0) {
        // A payment that only covers the interest: the rate is the one that payment implies, so the debt stays level.
        const implied = a.letPay > 0 ? a.letPay * 12 / a.letMortgage * 100 : 0;
        const interestOnly = implied > 0 && a.letPay < mortgagePayment(a.letMortgage) * 0.8;
        accounts.push({ name: 'Mortgage on the rented-out property', type: 'debt', owner: 'joint', balance: a.letMortgage,
          rate: interestOnly ? Math.floor(Math.min(12, Math.max(1, implied)) * 100) / 100 : MORTGAGE_RATE, payment: a.letPay > 0 ? a.letPay : mortgagePayment(a.letMortgage) });
      }
      if (a.letRent > 0) income.push({ name: 'Rent from the property', kind: 'rental', owner: 'joint', tax: 'uk', amount: a.letRent, freq: 'month', endRef: 'end', inflationLinked: true });
    }
    if ((a.home === 'rent' || a.home === 'family') && a.rent > 0) expenses.push({ name: a.home === 'rent' ? 'Rent' : 'Keep paid to family', amount: a.rent, freq: 'month', inflationLinked: true, ...(buyYear ? { endRef: 'year', toYear: buyYear } : {}) });
    if (buyYear) accounts.push({ name: 'First home', type: 'property', owner: 'joint', balance: g.buyPrice, rate: 3, buyYear, deposit: 10, mortRate: MORTGAGE_RATE, mortYears: 30 });
    for (const d of a.debts) {
      if (!(d.owed > 0)) continue;
      const k = DEBTS[d.kind] || DEBTS.loan;
      accounts.push({ name: k.label, type: 'debt', owner: 'joint', balance: d.owed, rate: k.rate, payment: d.pay || 0 });
    }
    if (a.spending > 0) expenses.push({ name: 'Everything else', amount: a.spending, freq: 'month', inflationLinked: true, note: 'One round figure from the quick start. The Spending check-up splits it into items.' });
    if (g.retire) goals.push({ type: 'retire', owner: 'p1', age: people[0].retireAge, confidence: 85 });
    if (g.emergency) goals.push({ type: 'emergency', months: 3, counts: 'cash', year: startYear + 2, confidence: 80 });
    if (g.save && g.saveAmount > 0) goals.push({ type: 'netWorth', name: (g.saveName || 'Saving up').slice(0, 60), icon: 'piggy', measure: 'savings', basis: 'real', amount: g.saveAmount, year: Math.max(startYear + 1, Math.round(g.saveYear || startYear + 5)), confidence: 80 });
    return E.normalizePlan({
      startYear, asOf: opts.asOf || E.todayISO(),
      household: { region: a.region, people },
      accounts, income, expenses, events: [], goals,
      strategy: { autoBuffer: true, cashReserve: 0 },
    });
  }

  // What is left each month this year after tax, pension, housing, debts and spending (negative:
  // more goes out than comes in).
  function leftover(plan) {
    const m = E.monthlyPlan(E.project(plan));
    return m.surplus - m.shortfall;
  }

  // The "everything else" spending that leaves `saved` a month.
  function spendingFor(a, saved, opts) {
    return Math.max(0, Math.round((leftover(build({ ...a, spending: 0 }, opts)) - (saved || 0)) / 10) * 10);
  }

  const api = { DEBTS, AUTO_ENROL, SCHEMES, schemeOf, schemeEstimate, grossOf, employed, MORTGAGE_RATE, LOAN_TYPICAL, loanPlanFor, blank, person, peopleOf, works, nameOf, spaOf, mortgagePayment, build, leftover, spendingFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuickStart = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
