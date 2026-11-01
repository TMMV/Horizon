'use strict';

// Guided spending check-up: the questions, and how answers map onto plan expenses.
// Expenses created here carry a `key` so re-running the check-up updates them in place.

(function (root) {
  const STEPS = [
    {
      id: 'home', title: 'Home', intro: 'Regular costs of running your home. Mortgage payments go under Accounts, not here.',
      questions: [
        { key: 'rent', match: ['rent', 'renda'], label: 'Rent', hint: 'Leave at 0 if you own', freq: 'month' },
        { key: 'council-tax', match: ['council'], label: 'Council tax', hint: 'In Scotland this includes water and sewerage', freq: 'month' },
        { key: 'energy', match: ['energy', 'gas', 'electric', 'luz'], label: 'Gas & electricity', freq: 'month' },
        { key: 'broadband', match: ['broadband', 'internet', 'tv licen', 'sky', 'virgin'], label: 'Broadband & TV', freq: 'month' },
        { key: 'home-insurance', match: ['home insurance', 'contents', 'buildings', 'seguro casa'], label: 'Home & contents insurance', freq: 'month' },
        { key: 'maintenance', match: ['maintenance', 'repair', 'gardener', 'jardin', 'manutencao'], label: 'Maintenance & repairs', hint: 'Boiler service, decorating, gardener', freq: 'year' },
      ],
    },
    {
      id: 'food', title: 'Food & household', intro: 'What you spend on food and running the household.',
      questions: [
        { key: 'groceries', match: ['grocer', 'supermarket', 'supermercado', 'food shop', 'tesco', 'aldi'], label: 'Supermarket shopping', freq: 'month' },
        { key: 'meal-kits', match: ['hellofresh', 'gousto', 'takeaway', 'meal kit', 'deliveroo'], label: 'Meal kits & takeaways', freq: 'month' },
        { key: 'eating-out', match: ['eating out', 'restaurant', 'coffee'], label: 'Eating out & coffee', freq: 'month' },
        { key: 'household', match: ['cleaning', 'household'], label: 'Cleaning & household items', freq: 'month' },
      ],
    },
    {
      id: 'transport', title: 'Getting around', intro: 'Day-to-day travel. Big purchases like a new car fit better as one-off events.',
      questions: [
        { key: 'fuel', match: ['fuel', 'petrol', 'diesel', 'charging'], label: 'Fuel or charging', freq: 'month' },
        { key: 'car-insurance', match: ['car insurance', 'road tax', 'car tax'], label: 'Car insurance & road tax', freq: 'year' },
        { key: 'car-service', match: ['mot', 'servic'], label: 'Servicing, MOT & repairs', freq: 'year' },
        { key: 'public-transport', match: ['bus', 'train', 'transport', 'taxi'], label: 'Bus, train & taxis', freq: 'month' },
      ],
    },
    {
      id: 'children', title: 'Children', intro: 'Costs that stop when the children are older. Set when they end below.',
      endAge: true,
      questions: [
        { key: 'childcare', match: ['childcare', 'nursery', 'childminder'], label: 'Nursery or childminder', freq: 'month' },
        { key: 'clubs', match: ['afterschool', 'after school', 'after-school', 'breakfast club'], label: 'Breakfast & after-school clubs', freq: 'month' },
        { key: 'activities', match: ['activities', 'swimming', 'lessons'], label: 'Activities, sport & lessons', freq: 'month' },
        { key: 'school', match: ['school', 'uniform'], label: 'Uniform, trips & school costs', freq: 'year' },
      ],
    },
    {
      id: 'personal', title: 'Personal & health', intro: 'Looking after yourselves.',
      questions: [
        { key: 'life-insurance', match: ['life insurance', 'income protection', 'seguro vida'], label: 'Life & income protection insurance', freq: 'month' },
        { key: 'mobile', match: ['mobile', 'phone', 'tlm'], label: 'Mobile phones', freq: 'month' },
        { key: 'health', match: ['dentist', 'optician', 'prescription', 'health'], label: 'Dentist, optician & prescriptions', freq: 'year' },
        { key: 'gym', match: ['gym', 'sport'], label: 'Gym & sport', freq: 'month' },
        { key: 'clothing', match: ['cloth', 'shoes'], label: 'Clothes & shoes', freq: 'month' },
        { key: 'personal-care', match: ['haircut', 'hair', 'personal care'], label: 'Haircuts & personal care', freq: 'month' },
      ],
    },
    {
      id: 'subscriptions', title: 'Subscriptions & giving', intro: 'Small regular payments add up.',
      questions: [
        { key: 'streaming', match: ['netflix', 'spotify', 'streaming', 'apple', 'disney', 'subscription'], label: 'Streaming, music & apps', freq: 'month' },
        { key: 'memberships', match: ['monzo', 'membership', 'bank fee'], label: 'Memberships & bank fees', freq: 'month' },
        { key: 'charity', match: ['charity', 'caridade', 'donation'], label: 'Charity', freq: 'month' },
        { key: 'gifts', match: ['gift', 'christmas', 'birthday'], label: 'Birthdays, Christmas & gifts', freq: 'year' },
      ],
    },
    {
      id: 'leisure', title: 'Holidays & fun', intro: 'The things that make it worth it.',
      questions: [
        { key: 'holidays', match: ['holiday', 'travel', 'ferias'], label: 'Holidays', freq: 'year' },
        { key: 'hobbies', match: ['hobby', 'hobbies'], label: 'Hobbies', freq: 'month' },
        { key: 'nights-out', match: ['night out', 'nights out', 'cinema', 'entertainment'], label: 'Nights out & entertainment', freq: 'month' },
        { key: 'other', match: ['everything else', 'extras', 'misc', 'other'], label: 'Anything else', hint: 'A buffer for the unexpected', freq: 'month' },
      ],
    },
  ];

  const QUESTIONS = STEPS.flatMap(s => s.questions.map(q => ({ ...q, step: s.id, category: s.title })));

  // Current answers taken from the plan: check-up expenses by key, otherwise the first
  // other expense whose name matches the question (recorded in `from` so applying the
  // check-up replaces it instead of counting it twice).
  function answersFromPlan(plan) {
    const answers = {};
    const used = new Set();
    for (const q of QUESTIONS) {
      const e = plan.expenses.find(x => x.key === q.key);
      if (e) { answers[q.key] = { amount: e.amount, freq: e.freq }; used.add(e.id); }
    }
    for (const q of QUESTIONS) {
      if (answers[q.key]) continue;
      const e = plan.expenses.find(x => !x.key && !used.has(x.id) && q.match.some(m => x.name.toLowerCase().includes(m)));
      if (e) {
        used.add(e.id);
        answers[q.key] = { amount: e.amount, freq: e.freq, from: e.id };
        if (q.step === 'children' && e.endRef === 'age') answers._childrenEndAge = e.endAge;
      } else {
        answers[q.key] = { amount: 0, freq: q.freq };
      }
    }
    const kids = plan.expenses.find(x => x.category === 'Children' && x.key && x.endRef === 'age');
    if (kids) answers._childrenEndAge = kids.endAge;
    if (answers._childrenEndAge === undefined) answers._childrenEndAge = plan.household.people[0].age + 10;
    return answers;
  }

  // Expenses the check-up does not cover (kept unless the user says otherwise).
  function uncovered(plan, answers) {
    const replaced = new Set(QUESTIONS.map(q => answers[q.key] && answers[q.key].from).filter(Boolean));
    return plan.expenses.filter(e => (!e.key || !QUESTIONS.some(q => q.key === e.key)) && !replaced.has(e.id));
  }

  const annual = a => (a.amount || 0) * (a.freq === 'month' ? 12 : 1);

  function totals(answers) {
    const byStep = {};
    let year = 0;
    for (const q of QUESTIONS) {
      const v = annual(answers[q.key] || {});
      byStep[q.step] = (byStep[q.step] || 0) + v;
      year += v;
    }
    return { byStep, year, month: year / 12 };
  }

  // Returns a new expenses list. Wizard expenses are replaced by the answers; other
  // expenses are kept unless `keepOthers` is false.
  function applyAnswers(plan, answers, opts = {}) {
    const keepOthers = opts.keepOthers !== false;
    const p1 = plan.household.people[0];
    const others = uncovered(plan, answers);
    const fresh = [];
    for (const q of QUESTIONS) {
      const a = answers[q.key];
      if (!a || !(a.amount > 0)) continue;
      const existing = plan.expenses.find(e => e.key === q.key) || plan.expenses.find(e => a.from && e.id === a.from);
      const isKids = q.step === 'children';
      fresh.push({
        id: existing ? existing.id : `wiz-${q.key}`,
        key: q.key,
        category: q.category,
        name: existing ? existing.name : q.label,
        owner: 'joint',
        amount: a.amount,
        freq: a.freq,
        inflationLinked: true,
        growth: 0,
        startRef: 'now',
        startAge: p1.age,
        endRef: isKids ? 'age' : 'end',
        endAge: isKids ? Math.round(answers._childrenEndAge || p1.age + 10) : p1.endAge,
      });
    }
    return keepOthers ? others.concat(fresh) : fresh;
  }

  const api = { STEPS, QUESTIONS, answersFromPlan, uncovered, totals, applyAnswers };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SpendingWizard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
