'use strict';

// Levers: the dials a household can turn (or a stress test can turn for them).
// Each lever reads its current value from a plan and writes a new one into a copy.
// Kept free of DOM code so the trade-off maths can be unit tested.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;

  const LUMP_ID = 'lever-lump-sum';

  // Which lever groups matter most for each goal type (used by the goal wizard).
  const GOAL_GROUPS = {
    retire: ['retirement', 'saving', 'investing'],
    debtFree: ['mortgage', 'saving'],
    netWorth: ['saving', 'mortgage', 'investing', 'property'],
    passiveIncome: ['saving', 'retirement', 'investing', 'property'],
    emergency: ['saving'],
  };

  // What a goal depends on, so its page only offers changes that can move it. A goal dated
  // before anyone retires doesn't care about retirement; one that ignores pensions doesn't
  // care about pension saving; a mortgage goal doesn't care about share returns.
  function goalScope(plan, goal) {
    const people = plan.household.people;
    const firstRetire = Math.min(...people.map(p => plan.startYear + p.retireAge - p.age));
    const m = goal.measure;
    return {
      type: goal.type,
      retire: goal.type === 'retire',
      afterRetire: goal.type === 'retire' || goal.year > firstRetire,
      pensions: goal.type === 'retire' || (goal.type === 'netWorth' && (m === 'all' || m === 'liquid')) || (goal.type === 'passiveIncome' && goal.includePensions),
      property: goal.type === 'netWorth' && (m === 'all' || m === 'noPension'),
      investments: goal.type !== 'debtFree' && !(goal.type === 'emergency' && goal.counts !== 'investments'),
      mortgage: plan.accounts.some(a => a.type === 'debt' && !a.excluded && a.balance > 0),
      overpaying: plan.strategy.overpayPct > 0,
    };
  }

  // Does this lever matter for this goal?
  function leverFits(def, goal, plan) {
    const s = goalScope(plan, goal);
    const k = def.key;
    if (k.startsWith('retireAge') || k === 'retireSpending') return s.afterRetire;
    if (k === 'spendNowPct') return s.type !== 'debtFree' || s.overpaying;
    if (k === 'cashReserve') return s.type === 'emergency' || s.type === 'netWorth';
    if (k.startsWith('extraPension')) return s.pensions;
    if (def.group === 'mortgage') return s.mortgage && ['debtFree', 'netWorth', 'retire'].includes(s.type);
    if (k === 'mortgageRate') return s.mortgage && (s.type === 'debtFree' || s.property);
    if (k === 'stockPctNow' || k === 'stockReturn') return s.investments;
    if (k === 'stockPctRetire') return s.investments && s.afterRetire;
    if (k.startsWith('sell-')) return ['netWorth', 'passiveIncome', 'retire'].includes(s.type);
    if (k === 'houses') return s.property;
    return true;
  }

  // Does this "what moves your goals" change matter for this goal? (keys from ScenarioIdeas.DRIVERS)
  function driverFits(key, goal, plan) {
    const s = goalScope(plan, goal);
    switch (key) {
      case 'retireLater': case 'retireEarlier': case 'spendLessRetired': return s.afterRetire;
      case 'spendLess': return s.type !== 'debtFree' || s.overpaying;
      case 'pension': return s.pensions;
      case 'overpay': return s.type !== 'emergency';
      case 'weakMarkets': case 'crash': return s.investments;
      default: return true;
    }
  }

  // The lever groups with something for this goal, in display order (stress tests last).
  function groupsForGoal(plan, goal) {
    const fit = defs(plan).filter(d => leverFits(d, goal, plan));
    return Object.keys(GROUPS).filter(g => fit.some(d => d.group === g));
  }

  const GROUPS = {
    retirement: { title: 'Retirement', intro: 'When you stop work and what you spend afterwards.' },
    saving: { title: 'Saving & spending', intro: 'What you spend now and what you put into pensions.' },
    mortgage: { title: 'Mortgage', intro: 'Paying the mortgage off faster means investing less.' },
    investing: { title: 'Investing', intro: 'How much is in stocks. More stocks: higher average growth, bigger swings.' },
    property: { title: 'Property', intro: 'Selling a property turns it into money that can be invested or spent.' },
    stress: { title: 'Stress test', intro: 'Not choices: what if the world turns out differently from your assumptions?' },
  };

  function defs(plan) {
    const people = plan.household.people;
    const out = [];
    const debts = plan.accounts.filter(a => a.type === 'debt');
    const props = plan.accounts.filter(a => a.type === 'property');

    people.forEach((p, i) => {
      out.push({
        key: `retireAge${i}`, group: 'retirement', unit: 'age',
        label: `${p.name} retires at`, min: Math.max(p.age, 40), max: 75, step: 1,
        get: pl => pl.household.people[i].retireAge,
        set: (pl, v) => {
          // This person's retirement goal moves with their retirement age.
          const who = pl.household.people[i];
          for (const g of pl.goals) if (g.type === 'retire' && (g.owner || pl.household.people[0].id) === who.id && g.age === who.retireAge) g.age = v;
          pl.household.people[i].retireAge = v;
        },
        hint: i === 0 ? 'Salaries stop at retirement; pensions can be drawn from the access age.' : null,
      });
    });
    out.push({
      key: 'retireSpending', group: 'retirement', unit: 'money', zeroLabel: 'As listed',
      label: 'Spending in retirement (a year, today’s money)', min: 0, max: 150000, step: 1000,
      get: pl => pl.strategy.retireSpending,
      set: (pl, v) => { pl.strategy.retireSpending = v; },
      hint: 'Leave at “As listed” to keep your spending items; set an amount to replace them after you retire.',
    });

    out.push({
      key: 'spendNowPct', group: 'saving', unit: 'pct',
      label: 'Spending before retirement', min: 50, max: 150, step: 1,
      get: pl => pl.strategy.spendNowPct,
      set: (pl, v) => { pl.strategy.spendNowPct = v; },
      hint: 'Percent of your current spending list. 90% means spending a tenth less.',
      describe: (v, pl) => {
        const now = pl.expenses.reduce((acc, e) => acc + E.streamAt(e, pl, 0), 0);
        return `≈ £${Math.round(now * v / 100 / 12).toLocaleString('en-GB')} a month`;
      },
    });
    out.push({
      key: 'cashReserve', group: 'saving', unit: 'money',
      label: 'Cash buffer to keep (today’s money)', min: 0, max: 100000, step: 500,
      get: pl => pl.strategy.cashReserve,
      set: (pl, v) => { pl.strategy.cashReserve = v; },
      hint: 'Easy-access cash for emergencies. It is topped up from surplus before anything is invested.',
    });
    people.forEach((p, i) => {
      out.push({
        key: `extraPension${i}`, group: 'saving', unit: 'money',
        label: `Extra into ${p.name}’s pension (a month)`, min: 0, max: 2000, step: 25,
        get: pl => pl.household.people[i].extraPension,
        set: (pl, v) => { pl.household.people[i].extraPension = v; },
        hint: i === 0 ? 'Paid from take-home pay; 20% basic-rate tax relief is added to the pot.' : null,
      });
    });

    if (debts.length) {
      out.push({
        key: 'overpayPct', group: 'mortgage', unit: 'pct',
        label: 'Share of surplus to overpay', min: 0, max: 100, step: 5,
        get: pl => pl.strategy.overpayPct,
        set: (pl, v) => { pl.strategy.overpayPct = v; },
        hint: 'The rest of the surplus goes to ISAs and investments.',
      });
      out.push({
        key: 'overpayCapPct', group: 'mortgage', unit: 'pct',
        label: 'Overpayment limit (of balance, a year)', min: 0, max: 100, step: 1,
        get: pl => pl.strategy.overpayCapPct,
        set: (pl, v) => { pl.strategy.overpayCapPct = v; },
        hint: 'Many lenders allow 10% a year without early repayment charges.',
      });
      out.push({
        key: 'lumpSum', group: 'mortgage', unit: 'money',
        label: 'One-off overpayment', min: 0, max: 200000, step: 1000,
        get: pl => { const e = pl.events.find(x => x.id === LUMP_ID); return e ? e.amount : 0; },
        set: (pl, v) => setLump(pl, v, null),
      });
      out.push({
        key: 'lumpYear', group: 'mortgage', unit: 'year',
        label: 'One-off overpayment in', min: plan.startYear, max: plan.startYear + 25, step: 1,
        get: pl => { const e = pl.events.find(x => x.id === LUMP_ID); return e ? e.year : pl.startYear + 1; },
        set: (pl, v) => setLump(pl, null, v),
      });
      const fixed = debts.find(d => d.fixedUntil >= plan.startYear);
      if (fixed) {
        out.push({
          key: 'rateAfterFix', group: 'mortgage', unit: 'rate',
          label: `Rate after the fix ends (${fixed.fixedUntil})`, min: 1, max: 9, step: 0.25,
          get: pl => { const d = pl.accounts.find(x => x.id === fixed.id); return d.rateAfterFix === null ? d.rate : d.rateAfterFix; },
          set: (pl, v) => { const d = pl.accounts.find(x => x.id === fixed.id); if (d) d.rateAfterFix = v; },
          hint: `Now ${fixed.rate}%. Simulations also move it with inflation surprises.`,
        });
      }
      out.push({
        key: 'mortgageRate', group: 'stress', unit: 'pts',
        label: 'Mortgage rates higher or lower', min: -3, max: 5, step: 0.25,
        get: () => 0,
        set: (pl, v) => { for (const a of pl.accounts) if (a.type === 'debt') a.rate += v; },
      });
    }

    out.push({
      key: 'stockPctNow', group: 'investing', unit: 'pct',
      label: 'Stocks now', min: 0, max: 100, step: 5,
      get: pl => pl.assumptions.stockPctNow,
      set: (pl, v) => { pl.assumptions.stockPctNow = v; },
    });
    out.push({
      key: 'stockPctRetire', group: 'investing', unit: 'pct',
      label: 'Stocks at retirement', min: 0, max: 100, step: 5,
      get: pl => pl.assumptions.stockPctRetire,
      set: (pl, v) => { pl.assumptions.stockPctRetire = v; },
      hint: 'Moves gradually from “now” to this by the time you retire.',
    });

    for (const prop of props) {
      out.push({
        key: `sell-${prop.id}`, group: 'property', unit: 'year', zeroLabel: 'Keep',
        label: `Sell ${prop.name} in`, min: plan.startYear - 1, max: plan.startYear + 40, step: 1,
        get: pl => { const a = pl.accounts.find(x => x.id === prop.id); return a && a.sellYear ? a.sellYear : plan.startYear - 1; },
        set: (pl, v) => { const a = pl.accounts.find(x => x.id === prop.id); if (a) a.sellYear = v < plan.startYear ? 0 : v; },
      });
    }

    out.push({
      key: 'stockReturn', group: 'stress', unit: 'pts',
      label: 'Stock returns higher or lower', min: -4, max: 3, step: 0.5,
      get: () => 0,
      set: (pl, v) => { pl.assumptions.stockReturn += v; },
    });
    out.push({
      key: 'inflation', group: 'stress', unit: 'pts',
      label: 'Inflation higher or lower', min: -1.5, max: 4, step: 0.25,
      get: () => 0,
      set: (pl, v) => { pl.assumptions.inflation += v; },
    });
    if (props.length) {
      out.push({
        key: 'houses', group: 'stress', unit: 'pts',
        label: 'House prices grow faster or slower', min: -5, max: 3, step: 0.5,
        get: () => 0,
        set: (pl, v) => { for (const a of pl.accounts) if (a.type === 'property') a.rate += v; },
      });
    }
    return out;
  }

  function setLump(pl, amount, year) {
    let e = pl.events.find(x => x.id === LUMP_ID);
    if (!e) {
      e = { id: LUMP_ID, name: 'One-off mortgage overpayment', kind: 'overpay', year: pl.startYear + 1, amount: 0 };
      pl.events.push(e);
    }
    if (amount !== null) e.amount = amount;
    if (year !== null) e.year = year;
    if (!(e.amount > 0)) pl.events = pl.events.filter(x => x.id !== LUMP_ID);
  }

  function currentValues(plan) {
    const v = {};
    for (const d of defs(plan)) v[d.key] = d.get(plan);
    return v;
  }

  // A copy of the plan with lever values applied. Unchanged levers are left alone.
  function apply(plan, values) {
    const p = E.clonePlan(plan);
    const base = currentValues(plan);
    const list = defs(plan);
    // Amount before year so the lump-sum event exists when its year is set.
    list.sort((a, b) => (a.key === 'lumpYear') - (b.key === 'lumpYear'));
    for (const d of list) {
      if (values[d.key] === undefined || values[d.key] === base[d.key]) continue;
      if (d.key === 'lumpYear' && !(values.lumpSum > 0) && !(base.lumpSum > 0)) continue;
      d.set(p, values[d.key]);
    }
    return p;
  }

  function changed(plan, values) {
    const base = currentValues(plan);
    return defs(plan).filter(d => values[d.key] !== undefined && values[d.key] !== base[d.key]);
  }

  // Probability and timing for every goal, for comparing two plans side by side.
  function goalComparison(base, next, runs, seed) {
    const eval1 = p => {
      const proj = E.project(p);
      const mc = E.monteCarlo(p, runs, seed);
      return { proj, mc, goals: E.evaluateGoals(p, proj, mc, { runs, seed }), summary: summaryOf(p, proj, mc) };
    };
    return { before: eval1(base), after: eval1(next) };
  }

  function summaryOf(plan, proj, mc) {
    const p1 = plan.household.people[0];
    const tr = Math.max(0, Math.min(proj.pre.N, p1.retireAge - p1.age));
    return {
      success: mc.successRate,
      retireYear: plan.startYear + tr,
      netWorthAtRetire: proj.rows[tr].netWorth / proj.rows[tr].deflator,
      liquidAtRetire: proj.rows[tr].liquid / proj.rows[tr].deflator,
      debtFree: E.debtFreeYear(proj),
      monthly: E.monthlyPlan(proj),
      endNetWorth: proj.rows[proj.pre.N].netWorth / proj.rows[proj.pre.N].deflator,
    };
  }

  const api = { GROUPS, GOAL_GROUPS, LUMP_ID, defs, goalScope, leverFits, driverFits, groupsForGoal, currentValues, apply, changed, goalComparison, summaryOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Levers = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
