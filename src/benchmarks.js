'use strict';

// Rough UK spending guides for the spending check-up, and the plan check ("worth a look")
// on the Overview. Guides are deliberately ranges, scaled to the household, in 2026
// prices. Sources: ONS Family Spending in the UK (April 2023 to March 2024, uprated),
// Ofgem's price cap, PLSA Retirement Living Standards (2025) and common rules of thumb.
// They are a sense check, not a target.

(function (root) {
  const R = typeof module !== 'undefined' && module.exports ? require('./uk-rules') : root.UKRules;
  const W = typeof module !== 'undefined' && module.exports ? require('./spending-wizard') : root.SpendingWizard;

  const money = v => `£${Math.round(v).toLocaleString('en-GB')}`;

  // ONS: average weekly household spending on goods and services, FYE 2024 (£623.30).
  const ONS_AVERAGE_MONTH = 623.30 * 52 / 12;

  // PLSA Retirement Living Standards 2025: yearly spending after tax, no mortgage or rent.
  const PLSA = {
    single: { minimum: 13400, moderate: 31700, comfortable: 43900 },
    couple: { minimum: 21600, moderate: 43900, comfortable: 60600 },
  };

  // Monthly ranges. `per` says how a range scales:
  //   household  for a couple, scaled by household size (OECD equivalence: 1 + 0.5 per extra adult + 0.3 per child)
  //   fixed      the same for most homes
  //   adult / person / child / car / schoolChild / youngChild   per head
  //   home       a share of the home's value a year
  const GUIDES = {
    'council-tax': { per: 'fixed', low: 120, high: 300, note: 'Scotland, bands B–F, including water and sewerage.' },
    energy: { per: 'household', low: 110, high: 200, note: 'Ofgem’s price cap puts a typical gas-and-electric home at roughly £140–£150 a month.' },
    broadband: { per: 'fixed', low: 25, high: 60, tip: 'Out-of-contract broadband and TV deals often cost £10–£20 a month more than a new contract.' },
    'home-insurance': { per: 'fixed', low: 15, high: 45, tip: 'Comparing quotes at renewal usually beats auto-renewing.' },
    maintenance: { per: 'home', low: 0.005, high: 0.015, fallback: [80, 250], note: 'Rule of thumb: set aside about 1% of the home’s value a year.' },
    groceries: { per: 'household', low: 300, high: 560, note: 'ONS: the average home spends about £75 a week on food and drink; supermarket shops also cover toiletries and cleaning.' },
    'meal-kits': { per: 'household', low: 0, high: 150 },
    'eating-out': { per: 'household', low: 60, high: 260 },
    household: { per: 'household', low: 25, high: 70 },
    fuel: { per: 'car', low: 70, high: 180 },
    'car-insurance': { per: 'car', low: 50, high: 100, note: 'Insurance plus road tax, about £600–£1,200 a year a car.' },
    'car-service': { per: 'car', low: 25, high: 60, note: 'Servicing, MOT and repairs, about £300–£700 a year a car.' },
    'public-transport': { per: 'adult', low: 0, high: 80 },
    childcare: { per: 'youngChild', low: 0, high: 1300, note: 'Scotland funds 1,140 hours a year of early learning from age 3 (and some 2-year-olds).' },
    clubs: { per: 'schoolChild', low: 120, high: 400, tip: 'Tax-Free Childcare adds £2 for every £8 you pay a registered provider, up to £2,000 a year per child under 12.' },
    activities: { per: 'child', low: 30, high: 120 },
    school: { per: 'child', low: 20, high: 50, note: 'Uniform, trips and school costs, about £250–£600 a year a child.' },
    'life-insurance': { per: 'adult', low: 10, high: 35, tip: 'Life cover usually aims to clear the mortgage and replace a few years of income.' },
    mobile: { per: 'adult', low: 8, high: 30, tip: 'SIM-only deals are often under £10 a month.' },
    health: { per: 'person', low: 8, high: 30 },
    gym: { per: 'adult', low: 0, high: 50 },
    clothing: { per: 'household', low: 70, high: 200 },
    'personal-care': { per: 'household', low: 30, high: 90 },
    streaming: { per: 'fixed', low: 15, high: 60, tip: 'Rotating streaming services instead of keeping them all saves a few hundred pounds a year.' },
    memberships: { per: 'fixed', low: 0, high: 30 },
    charity: { per: 'none', tip: 'Gift Aid adds 25% to donations to UK charities. In Scotland, intermediate, higher and top-rate taxpayers can claim back the difference through self-assessment.' },
    gifts: { per: 'household', low: 40, high: 150 },
    holidays: { per: 'household', low: 170, high: 550, note: 'About £2,000–£6,500 a year for a couple.' },
    hobbies: { per: 'household', low: 30, high: 150 },
    'nights-out': { per: 'household', low: 40, high: 200 },
    other: { per: 'household', low: 80, high: 300, note: 'A buffer of 5–10% of spending covers the things nobody plans for.' },
  };

  const NEEDS = new Set(['rent', 'council-tax', 'energy', 'broadband', 'home-insurance', 'maintenance', 'groceries', 'household',
    'fuel', 'car-insurance', 'car-service', 'public-transport', 'childcare', 'clubs', 'school', 'life-insurance', 'mobile', 'health']);

  // Who lives in the household, from the plan (children from the life check-up).
  function household(plan) {
    const life = plan.life || {};
    const children = Array.isArray(life.children) ? life.children.map(c => c.age) : [];
    const homes = plan.accounts.filter(a => a.type === 'property' && !a.excluded).map(a => a.balance);
    return {
      adults: plan.household.people.length,
      children,
      cars: life.cars !== undefined ? life.cars : 1,
      homeValue: homes.length ? Math.max(...homes) : 0,
    };
  }

  function equivalence(hh) {
    return 1 + 0.5 * Math.max(0, hh.adults - 1) + 0.3 * hh.children.length;
  }

  // The guide for one check-up question: monthly { low, high } scaled to the household.
  function forQuestion(key, hh) {
    const g = GUIDES[key];
    if (!g) return null;
    if (g.per === 'none') return { low: null, high: null, note: g.note, tip: g.tip };
    let k;
    switch (g.per) {
      case 'household': k = equivalence(hh) / 1.5; break;
      case 'adult': k = hh.adults; break;
      case 'person': k = hh.adults + hh.children.length; break;
      case 'child': k = hh.children.filter(a => a < 18).length; break;
      case 'schoolChild': k = hh.children.filter(a => a >= 4 && a < 12).length; break;
      case 'youngChild': k = hh.children.filter(a => a < 5).length; break;
      case 'car': k = hh.cars; break;
      case 'home':
        if (!hh.homeValue) return { low: g.fallback[0], high: g.fallback[1], note: g.note, tip: g.tip };
        return { low: hh.homeValue * g.low / 12, high: hh.homeValue * g.high / 12, note: `${g.note} For a ${money(hh.homeValue)} home that is about ${money(hh.homeValue * 0.01)} a year.`, tip: g.tip };
      default: k = 1;
    }
    if (k <= 0) return { low: 0, high: 0, note: g.note, tip: g.tip, none: true };
    return { low: g.low * k, high: g.high * k, note: g.note, tip: g.tip };
  }

  function position(monthly, guide) {
    if (!guide || guide.low == null || guide.none) return null;
    if (monthly < guide.low * 0.98) return 'below';
    if (monthly > guide.high * 1.02) return 'above';
    return 'typical';
  }

  const annual = e => e.amount * (e.freq === 'month' ? 12 : 1);

  // Which check-up question an expense belongs to (by key, else by name).
  function questionFor(expense) {
    if (expense.key) {
      const q = W.QUESTIONS.find(x => x.key === expense.key);
      if (q) return q;
    }
    const name = (expense.name || '').toLowerCase();
    return W.QUESTIONS.find(q => q.match.some(m => name.includes(m))) || null;
  }

  // Household money this year, from a projection: take-home pay, spending, mortgage.
  function moneyThisYear(plan, proj) {
    const pre = proj.pre, r = proj.rows[0];
    let takeHome = pre.taxFree[0] - pre.flatTax[0];
    const people = pre.people.map((P, i) => {
      takeHome += P.gross[0] + P.netPay[0] - P.employee[0] + P.other[0] + P.statePension[0] - P.baseTax[0];
      // Adjusted net income: taxable income, plus an estimate for take-home salaries.
      const fromNet = P.netPay[0] > 0 ? R.grossFromTakeHome(P.netPay[0], plan.household.region) : 0;
      return { name: plan.household.people[i].name, ani: P.taxable[0] + fromNet, estimated: P.netPay[0] > 0 };
    });
    return { takeHome, spending: r.spending, debtPay: r.debtPay || 0, saved: r.saved || 0, people };
  }

  // Spending split into needs and wants (for the 50/30/20 picture).
  function split(plan) {
    let needs = 0, wants = 0;
    for (const e of plan.expenses) {
      const startNow = e.startRef === 'now';
      if (!startNow) continue;
      const q = questionFor(e);
      if (q && NEEDS.has(q.key)) needs += annual(e); else wants += annual(e);
    }
    return { needs, wants };
  }

  // The plan check: things worth a look, most important first.
  function insights(plan, proj, opts = {}) {
    const out = [];
    const r0 = proj.rows[0];
    const hh = household(plan);
    const m = moneyThisYear(plan, proj);
    const s = plan.strategy;
    const taxOn = !plan.household.ignoreTax;
    const monthlyOut = (r0.spending + m.debtPay) / 12;

    // 1. Emergency fund (counting investments too if the emergency-fund goal does)
    const ef = plan.goals.find(g => g.type === 'emergency');
    if (ef && ef.counts === 'investments' && monthlyOut > 0) {
      const months = (r0.cash + r0.isa + r0.gia + r0.bonds) / monthlyOut;
      out.push({
        id: 'buffer', tone: months >= ef.months ? 'good' : months >= 3 ? 'tip' : 'warn',
        title: `Cash and investments cover ${months.toFixed(1)} months`, action: months >= ef.months ? null : 'strategy',
        text: `Your emergency-fund goal counts ISAs and investments (${ef.months} months is ${money(monthlyOut * ef.months)}). Cash alone covers ${(r0.cash / monthlyOut).toFixed(1)} months; investments can be down when you need them, which the goal's chance allows for.`,
      });
    } else if (monthlyOut > 0) {
      const months = r0.cash / monthlyOut;
      const bufMonths = s.cashReserve / monthlyOut;
      if (months < 3) {
        out.push({ id: 'buffer', tone: 'warn', title: `Cash covers ${months.toFixed(1)} months of spending`, text: `A common aim is 3–6 months of spending and mortgage payments (${money(monthlyOut * 3)}–${money(monthlyOut * 6)}) in easy-access savings. An emergency fund goal tracks it.`, action: plan.goals.some(g => g.type === 'emergency') ? 'strategy' : 'emergency' });
      } else if (!s.sweepCash && months > 12) {
        out.push({ id: 'buffer', tone: 'tip', title: `Cash covers ${Math.round(months)} months of spending`, text: 'Beyond 6 months or so, cash tends to lose ground to inflation. Turning on “Invest cash above the buffer” would put the rest to work.', action: 'strategy' });
      } else {
        out.push({ id: 'buffer', tone: 'good', title: `Emergency fund: ${months.toFixed(1)} months of spending`, text: `Your buffer setting keeps ${bufMonths.toFixed(1)} months (${money(s.cashReserve)}). 3–6 months is the usual guide.` });
      }
    }

    // 2. Saving rate
    if (m.takeHome > 0) {
      const keep = (m.takeHome - r0.spending - m.debtPay) / m.takeHome;
      const tone = keep >= 0.2 ? 'good' : keep >= 0.1 ? 'tip' : 'warn';
      out.push({ id: 'saving-rate', tone, title: `You keep ${Math.round(keep * 100)}% of take-home pay`, text: `After spending and mortgage payments, from ${money(m.takeHome / 12)} a month coming in. A popular guide is 50% needs, 30% wants, 20% saving.`, value: keep });
    }

    // 3. Children: Child Benefit and Tax-Free Childcare
    const kids = hh.children;
    const top = m.people.reduce((a, b) => (b.ani > a.ani ? b : a), m.people[0]);
    if (kids.some(a => a < 16) && taxOn) {
      const n = kids.filter(a => a < 16).length;
      const cb = R.CHILD_BENEFIT.eldest + R.CHILD_BENEFIT.additional * (n - 1);
      const share = Math.min(1, Math.max(0, (top.ani - R.CHILD_BENEFIT.chargeFrom) / (R.CHILD_BENEFIT.chargeTo - R.CHILD_BENEFIT.chargeFrom)));
      const est = top.estimated ? ' (estimated from take-home pay)' : '';
      if (share <= 0) out.push({ id: 'child-benefit', tone: 'good', title: `Child Benefit: ${money(cb)} a year`, text: `Both incomes are under ${money(R.CHILD_BENEFIT.chargeFrom)}, so none of it is clawed back. Claim it if you don't already.` });
      else if (share < 1) out.push({ id: 'child-benefit', tone: 'tip', title: `${Math.round(share * 100)}% of Child Benefit is clawed back`, text: `${top.name}'s income is about ${money(top.ani)}${est}. Each £1,000 paid into a pension (or by salary sacrifice) returns ${money(cb / 20)} of Child Benefit on top of the tax relief.`, action: 'compare:pension-isa' });
      else out.push({ id: 'child-benefit', tone: 'tip', title: 'Child Benefit is fully clawed back', text: `${top.name}'s income is about ${money(top.ani)}${est}, over ${money(R.CHILD_BENEFIT.chargeTo)}. Still register: it protects State Pension credits for a parent with low earnings and gives the child a National Insurance number.` });
    }
    const tfcKids = kids.filter(a => a <= R.TAX_FREE_CHILDCARE.maxAge).length;
    const childcare = plan.expenses.filter(e => { const q = questionFor(e); return q && (q.key === 'clubs' || q.key === 'childcare') && e.startRef === 'now'; })
      .reduce((acc, e) => acc + annual(e), 0);
    if (tfcKids && childcare > 0) {
      const eligible = m.people.every(p => p.ani < R.TAX_FREE_CHILDCARE.incomeLimit);
      const gain = Math.min(childcare * R.TAX_FREE_CHILDCARE.topUp, R.TAX_FREE_CHILDCARE.capPerChild * tfcKids);
      if (eligible) out.push({ id: 'tfc', tone: 'tip', title: `Tax-Free Childcare could save about ${money(gain)} a year`, text: `On ${money(childcare)} a year of childcare and clubs, if the providers are registered: the government pays 20%, up to ${money(R.TAX_FREE_CHILDCARE.capPerChild)} per child under 12. Each parent must earn under ${money(R.TAX_FREE_CHILDCARE.incomeLimit)}.` });
      else out.push({ id: 'tfc', tone: 'warn', title: 'Over £100k loses Tax-Free Childcare', text: `One income is over ${money(R.TAX_FREE_CHILDCARE.incomeLimit)}, which rules out up to ${money(gain)} a year of Tax-Free Childcare. Pension contributions that bring it back under £100k restore it.`, action: 'compare:pension-isa' });
    } else if (!kids.length && plan.expenses.some(e => { const q = questionFor(e); return q && q.step === 'children'; }) && !(plan.life && plan.life.children)) {
      out.push({ id: 'kids-unknown', tone: 'tip', title: 'Tell Horizon about your children', text: 'With their ages, Future costs (in Spending) plans school, university and help with a first home, and the plan check can test Child Benefit and Tax-Free Childcare.', action: 'life' });
    }

    // 4. The £100k trap
    if (taxOn) {
      for (const p of m.people) {
        if (p.ani > R.PA_TAPER_START && p.ani < R.PA_TAPER_START + 2 * R.PERSONAL_ALLOWANCE) {
          out.push({ id: `trap-${p.name}`, tone: 'warn', title: `${p.name} is in the £100k tax trap`, text: `Between £100,000 and £125,140 the personal allowance is withdrawn, so each extra £1 is taxed at over 60%. Paying about ${money(p.ani - R.PA_TAPER_START)} more into a pension would avoid it.`, action: 'compare:pension-isa' });
        }
      }
    }

    // 5. ISA allowance
    const allowance = s.isaAllowance * plan.household.people.length;
    if (r0.toGia > 100) {
      out.push({ id: 'isa-full', tone: 'tip', title: `${money(r0.toGia)} a year goes into a taxable account`, text: `Your ISAs are full (${money(allowance)}). Extra pension contributions get tax relief at your highest rate; a general account pays tax on gains when you sell.`, action: 'compare:pension-isa' });
    } else if (r0.gia > 1000 && r0.toIsa < allowance - 1000) {
      out.push({ id: 'bed-isa', tone: 'tip', title: 'Move the general account into ISAs', text: `You have ${money(r0.gia)} outside an ISA and unused allowance this year. "Bed and ISA" moves up to ${money(s.isaAllowance)} a person each tax year so future growth is tax-free.` });
    }

    // 6. Mortgage: overpay or invest?
    const debt = plan.accounts.find(a => a.type === 'debt' && a.balance > 0 && !a.excluded);
    if (debt) {
      const ret = proj.pre.econ.ret[0] * 100;
      if (debt.rate >= ret - 1) out.push({ id: 'overpay', tone: 'tip', title: `Overpaying the mortgage earns a sure ${debt.rate}%`, text: `That is close to the ${ret.toFixed(1)}% expected from investing, without the risk. Scenarios compares the two on every goal.`, action: 'compare:overpay-invest' });
      else out.push({ id: 'overpay', tone: 'info', title: `Investing is expected to beat overpaying (${ret.toFixed(1)}% vs ${debt.rate}%)`, text: `Overpaying is a guaranteed ${debt.rate}% and clears the debt sooner. Scenarios compares the two on every goal.`, action: 'compare:overpay-invest' });
      if (debt.fixedUntil && debt.fixedUntil <= plan.startYear + 1) {
        const after = debt.rateAfterFix === null ? `the same ${debt.rate}%` : `${debt.rateAfterFix}%`;
        out.push({ id: `remortgage-${debt.fixedUntil}`, tone: 'tip', title: `Mortgage fix ends ${debt.fixedUntil}`, text: `The plan assumes ${after} afterwards. Compare deals about six months before to avoid the lender’s standard variable rate. Scenarios shows what a lower or higher rate does to each goal.`, action: 'compare:mortgage-rate' });
      }
    }

    // 7. Retirement spending vs PLSA standards
    const couple = plan.household.people.length > 1;
    const std = couple ? PLSA.couple : PLSA.single;
    const retireSpend = s.retireSpending > 0 ? s.retireSpending : null;
    if (retireSpend) {
      const level = retireSpend >= std.comfortable ? 'above “comfortable”' : retireSpend >= std.moderate ? 'between “moderate” and “comfortable”' : retireSpend >= std.minimum ? 'between “minimum” and “moderate”' : 'below the “minimum”';
      out.push({ id: 'plsa', tone: 'info', title: `Retirement spending ${money(retireSpend)} a year is ${level}`, text: `PLSA Retirement Living Standards for a ${couple ? 'couple' : 'single person'}: minimum ${money(std.minimum)}, moderate ${money(std.moderate)}, comfortable ${money(std.comfortable)} a year (no mortgage or rent).` });
    } else {
      out.push({ id: 'plsa', tone: 'info', title: 'What will retirement cost?', text: `Your spending list carries on into retirement. For comparison, the PLSA “comfortable” standard is ${money(std.comfortable)} a year for a ${couple ? 'couple' : 'single person'} (moderate ${money(std.moderate)}). Set a retirement amount in Saving strategy.`, action: 'strategy' });
    }

    // 8. Concentration in property
    const assets = r0.liquid + r0.property;
    if (assets > 0 && r0.property / assets > 0.6) {
      out.push({ id: 'property', tone: 'info', title: `${Math.round(r0.property / assets * 100)}% of what you own is property`, text: 'Property can only be spent by selling or downsizing. Goals that count “savings” or “passive income” show how much is usable.' });
    }

    // 9. Lifetime ISA: 25% bonus for anyone under 40 without one
    const lisaOwners = new Set(plan.accounts.filter(a => a.type === 'lisa').map(a => a.owner));
    const eligible = plan.household.people.filter(x => x.age < R.LISA.openBefore && !lisaOwners.has(x.id));
    if (eligible.length) {
      const house = plan.goals.some(g => g.icon === 'home');
      out.push({ id: 'lisa', tone: 'tip', title: 'A Lifetime ISA adds a 25% bonus', action: 'compare:sacrifice-lisa',
        text: `${eligible.map(x => x.name).join(' and ')} can open one before turning 40: up to ${money(R.LISA.maxContribution)} a year (within the ISA allowance) gets ${money(R.LISA.maxContribution * R.LISA.bonus)} from the government, until 50. It can be used from 60, or ${house ? 'for your first home (up to £450,000)' : 'for a first home up to £450,000'}; other withdrawals lose 25%. Scenarios compares it with salary sacrifice into a pension.` });
    }

    // 10. Life check-up
    const lifeDone = plan.expenses.some(e => (e.key || '').startsWith('life:')) || plan.events.some(e => (e.id || '').startsWith('life:'));
    if (!lifeDone) out.push({ id: 'life', tone: 'tip', title: 'Plan for costs that come later', text: 'Cars, home repairs, children’s education, travel in early retirement and care later on. Future costs (in Spending) adds them as dated spending in two minutes.', action: 'life' });
    if (kids.some(a => a < 18)) out.push({ id: 'jisa', tone: 'info', title: 'Junior ISA', text: `Up to ${money(R.JUNIOR_ISA_ALLOWANCE)} a year per child grows tax-free and becomes theirs at 18. A “Save for something” goal can track university or a first deposit.` });

    const rank = { warn: 0, tip: 1, good: 2, info: 3 };
    out.sort((a, b) => rank[a.tone] - rank[b.tone]);
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  const api = { GUIDES, NEEDS, PLSA, ONS_AVERAGE_MONTH, household, equivalence, forQuestion, position, questionFor, moneyThisYear, split, insights };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Benchmarks = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
