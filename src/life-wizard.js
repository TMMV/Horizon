'use strict';

// Life check-up: the big costs that come with time. Answers become spending items and
// one-off events tagged "life:", so running the check-up again replaces them cleanly.
// All amounts are today's money; the engine adds inflation.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  const PREFIX = 'life:';

  function defaults(plan) {
    const p1 = plan.household.people[0];
    // Typical amounts scale with what the household earns (full at £70,000 a year and up, half at £35,000).
    const income = plan.income.filter(i => i.kind === 'salary' || i.kind === 'self').reduce((acc, i) => acc + E.incomeAfterCosts(i, plan, 0), 0);
    const k = Math.min(1, Math.max(0.5, income / 70000));
    const r = (v, step) => Math.round((v * k) / step) * step;
    const scot = plan.household.region === 'scotland';
    return {
      children: [],                 // [{ name, age }]
      schoolCost: r(1500, 100),     // per child per year until 18: uniforms, trips, clubs
      privateFee: 0,                // private school fees per child per year (0 = state school)
      privateFrom: 11,              // the child's age when private school starts (to 18)
      uniPerYear: r(6000, 500),     // help with living costs at university (tuition: free in Scotland, a loan elsewhere)
      uniYears: scot ? 4 : 3,
      carAt17: 3000,                // driving lessons and a first car
      weddingHelp: 0,
      depositHelp: 0,
      helpAge: 30,                  // age of the child for wedding / deposit help
      // No car when the spending list has a bus or train pass and no car costs; home repairs
      // only for a home that is owned.
      cars: plan.expenses.some(e => e.amount > 0 && /\b(bus|train|public transport)\b/i.test(`${e.key || ''} ${e.name || ''}`.replace(/-/g, ' '))) && !plan.expenses.some(e => e.amount > 0 && /\b(car|fuel|petrol|diesel|mot|road tax)\b/i.test(`${e.key || ''} ${e.name || ''}`.replace(/-/g, ' '))) ? 0 : 1,
      carEvery: 8, carCost: r(20000, 1000), carNext: plan.startYear + 3,
      homeEvery: 10, homeCost: plan.accounts.some(a => a.type === 'property' && !a.excluded && !(a.buyYear > plan.startYear)) ? r(15000, 1000) : 0, homeNext: plan.startYear + 5,
      travelExtra: 0, travelYears: 10,
      slowDownAge: 0, slowDownPct: 80,
      careAge: 0, careYears: 3, careCost: 40000,
      careRealGrowth: 1,            // care costs rise this much a year faster than prices (mostly wages)
      familyAmount: 0, familyFrom: p1.age, familyTo: p1.age + 10,
    };
  }

  const STEPS = [
    { id: 'children', title: 'Children', intro: 'Costs that come with each stage of growing up. Leave at 0 children to skip.' },
    { id: 'cars', title: 'Cars', intro: 'Replacing a car every few years adds up.' },
    { id: 'home', title: 'Home', intro: 'Roofs, boilers, kitchens and bathrooms all need replacing eventually.' },
    { id: 'retirement', title: 'Retirement years', intro: 'Many people spend more in the first, active years of retirement and less later.' },
    { id: 'care', title: 'Later life & family', intro: 'Care in later life, and helping parents or other family.' },
  ];

  function answersFromPlan(plan) {
    return { ...defaults(plan), ...(plan.life && typeof plan.life === 'object' ? plan.life : {}) };
  }

  // Turns answers into the spending items, events and strategy settings they imply.
  function build(plan, a) {
    const p1 = plan.household.people[0];
    const yearAtAge = age => plan.startYear + (age - p1.age);
    const p1AgeInYear = year => p1.age + (year - plan.startYear);
    const lastYear = plan.startYear + (p1.endAge - p1.age);
    const expenses = [];
    const events = [];
    const exp = (key, name, amount, startAge, endAge, extra = {}) => {
      if (!(amount > 0) || endAge <= startAge) return;
      expenses.push({
        id: `${PREFIX}${key}`, key: `${PREFIX}${key}`, category: 'Life check-up', name, owner: 'p1',
        amount, freq: 'year', inflationLinked: true, growth: 0,
        startRef: startAge <= p1.age ? 'now' : 'age', startAge, endRef: 'age', endAge, ...extra,
      });
    };
    const ev = (key, name, year, amount) => {
      if (!(amount > 0) || year < plan.startYear || year > lastYear) return;
      events.push({ id: `${PREFIX}${key}`, name, kind: 'expense', year, amount });
    };

    (a.children || []).forEach((c, i) => {
      const label = c.name || `Child ${i + 1}`;
      const ageNow = Math.max(0, Math.round(c.age || 0));
      const p1At = childAge => p1.age + (childAge - ageNow);
      exp(`school-${i}`, `${label}: school costs`, a.schoolCost, Math.max(p1.age, p1At(Math.max(ageNow, 4))), p1At(18));
      exp(`private-${i}`, `${label}: private school`, a.privateFee, Math.max(p1.age, p1At(Math.max(ageNow, a.privateFrom || 11))), p1At(18));
      exp(`uni-${i}`, `${label}: university support`, a.uniPerYear, Math.max(p1.age, p1At(18)), p1At(18 + a.uniYears));
      ev(`car-${i}`, `${label}: driving lessons & first car`, yearAtAge(p1At(17)), a.carAt17);
      ev(`wedding-${i}`, `${label}: wedding`, yearAtAge(p1At(a.helpAge)), a.weddingHelp);
      ev(`deposit-${i}`, `${label}: help with a house deposit`, yearAtAge(p1At(a.helpAge)), a.depositHelp);
    });

    if (a.cars > 0 && a.carEvery > 0) {
      for (let y = a.carNext, k = 0; y <= Math.min(lastYear, yearAtAge(80)); y += a.carEvery, k++) {
        ev(`cars-${k}`, a.cars > 1 ? `Replace ${a.cars} cars` : 'Replace car', y, a.carCost * a.cars);
      }
    }
    if (a.homeEvery > 0) {
      for (let y = a.homeNext, k = 0; y <= Math.min(lastYear, yearAtAge(85)); y += a.homeEvery, k++) {
        ev(`home-${k}`, 'Major home repairs', y, a.homeCost);
      }
    }
    exp('travel', 'Active retirement: travel & hobbies', a.travelExtra, p1.retireAge, p1.retireAge + a.travelYears, { startRef: 'retire' });
    // Today's cost, grown by how much faster than prices care is expected to rise until it starts.
    const careAt = a.careCost * Math.pow(1 + (a.careRealGrowth || 0) / 100, Math.max(0, a.careAge - p1.age));
    const careNote = a.careRealGrowth > 0 && careAt > a.careCost + 1
      ? `£${Math.round(a.careCost).toLocaleString('en-GB')} a year in today’s prices. Care costs are expected to rise ${a.careRealGrowth}% a year faster than prices, so about £${Math.round(careAt).toLocaleString('en-GB')} by age ${a.careAge} (still in today’s money).`
      : '';
    if (a.careAge > 0) exp('care', 'Care in later life', Math.round(careAt), a.careAge, a.careAge + a.careYears, careNote ? { note: careNote } : {});
    exp('family', 'Helping family', a.familyAmount, a.familyFrom, a.familyTo);

    return {
      expenses, events,
      slowDownAge: a.slowDownAge > 0 ? a.slowDownAge : 0,
      slowDownPct: a.slowDownAge > 0 ? a.slowDownPct : 100,
      p1AgeInYear,
    };
  }

  // A new plan with the check-up applied (earlier check-up items replaced).
  function apply(plan, answers) {
    const p = E.clonePlan(plan);
    const b = build(p, answers);
    p.expenses = p.expenses.filter(e => !(e.key || '').startsWith(PREFIX)).concat(b.expenses);
    p.events = p.events.filter(e => !(e.id || '').startsWith(PREFIX)).concat(b.events);
    p.strategy.slowDownAge = b.slowDownAge;
    p.strategy.slowDownPct = b.slowDownPct;
    p.life = JSON.parse(JSON.stringify(answers));
    return E.normalizePlan(p);
  }

  // Total cost (today's money) of everything the answers add, for the review step.
  function summary(plan, answers) {
    const b = build(plan, answers);
    const p1 = plan.household.people[0];
    const lines = [];
    for (const e of b.expenses) lines.push({ name: e.name, when: `age ${e.startRef === 'retire' ? p1.retireAge : e.startAge}–${e.endRef === 'age' ? e.endAge : ''}`.replace(/–$/, ''), total: e.amount * (e.endAge - (e.startRef === 'retire' ? p1.retireAge : Math.max(p1.age, e.startAge))) });
    for (const e of b.events) lines.push({ name: e.name, when: String(e.year), total: e.amount });
    return { lines, total: lines.reduce((s, l) => s + l.total, 0), slowDown: b.slowDownAge ? `Spend ${b.slowDownPct}% from age ${b.slowDownAge}` : null };
  }

  const api = { PREFIX, STEPS, defaults, answersFromPlan, build, apply, summary };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LifeWizard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
