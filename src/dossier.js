'use strict';

// The dossier: the whole plan written out year by year, to read, print or save as a PDF.
// `build` turns a plan and its projection into a plain document (sections, years, lines);
// the page only has to lay it out. Every figure comes from the projection's own rows, so the
// dossier and the charts cannot disagree.

(function (root) {
  const E = typeof module !== 'undefined' && module.exports ? require('./engine.js') : root.Engine;
  const R = typeof module !== 'undefined' && module.exports ? require('./uk-rules.js') : root.UKRules;

  const gbp = v => `${v < -0.5 ? '−' : ''}£${Math.abs(Math.round(v)).toLocaleString('en-GB')}`;
  const pct = (v, d = 0) => `${(v * 100).toFixed(d)}%`;
  const list = a => (a.length <= 1 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);
  const poss = n => (n === 'You' ? 'your' : `${n}’s`);
  const is = n => (n === 'You' ? 'you are' : `${n} is`);
  const verb = (n, s, pl) => (n === 'You' ? `you ${pl}` : `${n} ${s}`);
  const cap = s => s.charAt(0).toUpperCase() + s.slice(1);

  const line = (label, value, note, opts = {}) => ({ label, value, note: note || '', ...opts });

  // ---------------------------------------------------------------- the parts that do not change by year

  function assumptions(plan) {
    const a = plan.assumptions, hh = plan.household;
    const mix = `${a.stockPctNow}% in shares now, moving to ${a.stockPctRetire}% by retirement; the rest in bonds`;
    const blend = w => (w / 100) * a.stockReturn + (1 - w / 100) * a.bondReturn - (a.fees || 0);
    return [
      { label: 'Prices rise', value: `${a.inflation}% a year`, why: `So £100 of shopping today costs about ${gbp(100 * Math.pow(1 + a.inflation / 100, 10))} in ten years. Every amount in this document is in the pounds of its own year unless it says “today’s money”.` },
      { label: 'Shares return', value: `${a.stockReturn}% a year`, why: 'A long-run average before inflation. In any one year shares can fall by a third or rise by as much; the range on each page shows what that does.' },
      { label: 'Bonds return', value: `${a.bondReturn}% a year`, why: 'Steadier than shares, lower on average.' },
      { label: 'Cash earns', value: `${a.cashRate}% a year`, why: 'Savings accounts and cash ISAs.' },
      { label: 'Investments are held', value: mix, why: `That mix is expected to return about ${blend(a.stockPctNow).toFixed(1)}% a year now and ${blend(a.stockPctRetire).toFixed(1)}% in retirement${a.fees ? `, after fees of ${a.fees}%` : ''}.` },
      hh.ignoreTax ? { label: 'Tax', value: 'Not worked out', why: 'Tax is switched off in this plan, so incomes are treated as already taxed.' }
        : { label: 'Tax', value: `${hh.region === 'scotland' ? 'Scottish' : 'UK'} income tax and National Insurance, ${R.TAX_YEAR || 'current'} rules`, why: `Thresholds stay frozen until ${a.thresholdFreezeUntil}, then rise with prices. A pay rise can therefore push more income into a higher band.` },
      ...hh.people.map(x => ({ label: `${cap(poss(x.name))} State Pension`, value: `${gbp(x.statePension)} a year from age ${x.statePensionAge + (x.spDefer || 0)}`, why: `In today’s money; it rises with prices${a.statePensionRealGrowth ? ` plus ${a.statePensionRealGrowth}%` : ''}.${x.niYears !== null && x.niYears !== undefined ? ` Based on ${x.niYears} National Insurance years so far.` : ' Assumes enough National Insurance years: check the record on gov.uk.'}` })),
      { label: 'The plan runs', value: `until ${list(hh.people.map(x => `${is(x.name)} ${x.endAge}`))}`, why: 'Planning to a late age is deliberate: the risk is living longer than the money.' },
    ];
  }

  const GLOSSARY = [
    ['Actual pounds / today’s money', 'Actual pounds are what you will see on a payslip or statement that year. Today’s money takes inflation back out, so amounts decades apart can be compared.'],
    ['Net worth', 'Everything you own (savings, investments, pensions, property) minus everything you owe.'],
    ['Cash buffer', 'Easy-access cash kept for the unexpected. It is filled first and spent last.'],
    ['ISA', 'An account where savings or investments grow free of tax. Each adult can pay in up to the yearly allowance.'],
    ['Lifetime ISA', 'An ISA for a first home or for after 60: the government adds 25% to what you pay in, up to a yearly limit.'],
    ['General investment account', 'Investments outside an ISA or pension. Gains and dividends above small allowances are taxed.'],
    ['Pension pot', 'Money invested for retirement by you and your employer. It cannot be touched before the minimum pension age; a quarter can then usually be taken tax-free and the rest is taxed as income.'],
    ['Defined benefit pension', 'A pension that pays a set income for life (NHS, council, teachers, universities, some older company schemes), not a pot.'],
    ['Salary sacrifice', 'Giving up part of your pay so your employer pays it into your pension instead. It saves both income tax and National Insurance.'],
    ['State Pension', 'The pension from the government, paid from State Pension age to anyone with enough National Insurance years (35 for the full amount, 10 for any).'],
    ['National Insurance (NI)', 'A deduction from pay that also builds entitlement to the State Pension.'],
    ['Overpayment', 'Paying more than the required monthly amount on a mortgage or loan, so it ends sooner and costs less interest.'],
    ['Chance the money lasts', 'The plan is run through many possible futures with different markets and inflation. The chance is the share of those in which the money never runs out.'],
    ['A bad run / a good run', 'The outcome that only 1 future in 10 is worse than, and the one only 1 in 10 is better than. Most futures fall between them.'],
  ].map(([term, text]) => ({ term, text }));

  // What is owned, by kind, from one row of the projection (start-of-year balances).
  const holdingsOf = r => [
    { id: 'cash', label: 'Cash and savings', value: r.cash + (r.cashIsa || 0) },
    { id: 'isa', label: 'ISAs', value: r.isa - (r.cashIsa || 0) },
    { id: 'gia', label: 'General investment account', value: r.gia },
    { id: 'pension', label: 'Pension pots', value: r.pension },
    { id: 'bonds', label: 'Bonds and gilts', value: r.bonds },
    { id: 'property', label: 'Property', value: r.property },
  ];

  // The series behind the dossier's charts, for the whole plan whatever years are written out.
  // Balances are at the start of each year (as in the projection); flows are for the year.
  function pictures(plan, proj, mc) {
    const rows = proj.rows, N = rows.length - 1, ps = plan.household.people;
    const years = rows.map(r => r.year);
    const kinds = holdingsOf(rows[0]).map((k, j) => ({ id: k.id, label: k.label, values: rows.map(r => holdingsOf(r)[j].value) })).filter(k => k.values.some(v => v > 0.5));
    if (rows.some(r => r.debt > 0.5)) kinds.push({ id: 'debt', label: 'Mortgage and loans', values: rows.map(r => -r.debt) });
    const flow = (id, label, fn) => ({ id, label, values: rows.slice(0, N).map(fn) });
    const flows = [
      flow('income', 'Pay and other income', r => r.earnings + r.otherIncome),
      flow('statePension', 'State Pension', r => r.statePension),
      flow('drawn', 'Drawn from savings and pensions', r => r.withdrawals || 0),
      flow('spending', 'Spending', r => -r.spending),
      flow('tax', 'Tax and National Insurance', r => -r.taxes),
      flow('debt', 'Mortgage and loans', r => -(r.debtPay || 0)),
      flow('saved', 'Saved', r => -r.saved),
    ].filter(f => f.values.some(v => Math.abs(v) > 0.5));
    const debts = (proj.out.debts || []).map(d => ({ id: d.id, label: (plan.accounts.find(a => a.id === d.id) || { name: 'Debt' }).name, values: years.map((y, t) => d.bal[t] || 0) })).filter(d => d.values.some(v => v > 0.5));
    // The debt chart stops two years after the last one is cleared.
    const lastOwed = Math.max(-1, ...debts.map(d => d.values.reduce((k, v, t) => (v > 0.5 ? t : k), -1)));
    const pensions = ps.map((x, i) => ({ id: x.id, label: `${cap(poss(x.name))} pension pots`, values: rows.map(r => r.persons[i].pension || 0) })).filter(p => p.values.some(v => v > 0.5));
    const nw = mc && mc.series && mc.series.netWorth ? mc.series.netWorth.nominal : null;
    const seen = new Set();
    const markers = E.milestones(plan, proj).filter(m => ['retire', 'debt', 'home', 'short'].includes(m.kind) && !seen.has(m.year) && seen.add(m.year)).map(m => ({ year: m.year, label: m.label }));
    return {
      years, flowYears: years.slice(0, N), kinds, net: rows.map(r => r.netWorth), flows,
      debts, debtYears: lastOwed >= 0 ? Math.min(N + 1, lastOwed + 3) : 0, pensions,
      range: nw ? { p10: nw.p10, p25: nw.p25, p50: nw.p50, p75: nw.p75, p90: nw.p90 } : null,
      markers,
    };
  }

  // ---------------------------------------------------------------- one year

  // What to pay where this year (or take from where), with what it was the year before.
  const PLACES = [['hiDebtPay', 'extra off expensive debts'], ['toCash', 'into cash savings'], ['overpay', 'in mortgage overpayments'], ['toLisa', 'into Lifetime ISAs'],
    ['toIsa', 'into ISAs'], ['toGia', 'into the general investment account'], ['toPension', 'extra into pensions']];
  const SOURCES = [['wCash', 'from cash'], ['wGia', 'from the general investment account'], ['wIsa', 'from ISAs'], ['wLisa', 'from Lifetime ISAs'], ['wPension', 'from pension pots']];
  function yearAmounts(r, prev, left) {
    const m = v => gbp(v / 12);
    if (left < -0.5) {
      const parts = SOURCES.filter(([k]) => (r[k] || 0) > 0.5).map(([k, label]) => `${m(r[k])} ${label}`);
      if (!parts.length) return null;
      return { title: `Take about ${m(r.withdrawals || -left)} a month from savings and pensions`, text: `${cap(list(parts))}${(prev.withdrawals || 0) > 0.5 ? ` (${m(prev.withdrawals)} a month last year)` : ''}. In this order, tax stays low.`, draw: true, auto: true };
    }
    const parts = [];
    for (const [k, label] of PLACES) {
      const now = r[k] || 0, was = prev[k] || 0;
      if (now > 0.5) parts.push(`${m(now)} a month ${label}${was <= 0.5 ? ' (new this year)' : Math.abs(now - was) >= 60 ? ` (${m(was)} last year)` : ' (as last year)'}`);
      else if (was > 0.5) parts.push(`nothing more ${label} (${m(was)} a month last year)`);
    }
    if (!parts.length) return null;
    return { title: 'Set the monthly amounts for the year', text: `${cap(list(parts))}. Change the standing orders in January.`, auto: true };
  }

  function yearBlock(plan, proj, mc, t, steps) {
    const rows = proj.rows, pre = proj.pre, out = proj.out, r = rows[t], next = rows[t + 1], prev = t > 0 ? rows[t - 1] : null;
    const hh = plan.household, ps = hh.people, infl = plan.assumptions.inflation / 100;
    const price = Math.pow(1 + infl, t);
    const changes = [];
    const ages = ps.map((x, i) => ({ name: x.name, age: r.ages[i] }));

    // ---- people: stopping work, pensions opening up
    ps.forEach((x, i) => {
      const age = r.ages[i], P = pre.people[i];
      if (t > 0 && age === x.retireAge) changes.push(`${cap(verb(x.name, 'stops', 'stop'))} work this year, at ${age}. Pay and pension contributions end.`);
      if (t > 0 && age === x.pensionAccessAge) changes.push(`${cap(poss(x.name))} pension pots can be drawn on from now (age ${age}).`);
      if (t > 0 && P.statePension[t] > 0 && !(P.statePension[t - 1] > 0)) changes.push(`${cap(poss(x.name))} State Pension starts: about ${gbp(P.statePension[t])} this year. Claim it a couple of months before; it is not paid automatically.`);
    });

    // ---- money coming in, item by item
    const incoming = [];
    for (const item of plan.income) {
      const v = E.incomeAfterCosts(item, plan, t), was = t > 0 ? E.incomeAfterCosts(item, plan, t - 1) : 0;
      if (t > 0 && v > 0.5 && was <= 0.5) changes.push(`${item.name} starts: about ${gbp(v)} this year.`);
      const owner = ps.findIndex(x => x.id === item.owner);
      const retiring = item.kind === 'salary' && owner >= 0 && r.ages[owner] === ps[owner].retireAge;
      if (t > 0 && v <= 0.5 && was > 0.5 && !retiring) changes.push(`${item.name} stops (it paid ${gbp(was)} last year).`);
      if (v <= 0.5) continue;
      const rise = was > 0.5 ? v / was - 1 : 0;
      const kind = item.kind === 'salary' ? (item.tax === 'none' ? 'take-home pay' : 'pay before tax') : item.kind === 'dbpension' ? 'pension, before tax' : item.kind === 'rental' ? 'rent, after costs' : item.tax === 'none' ? 'no tax due' : 'before tax';
      incoming.push(line(item.name, v, `${cap(kind)}${rise > 0.004 ? `; up ${pct(rise, 1)} on last year` : rise < -0.004 ? `; down ${pct(-rise, 1)} on last year` : ''}`));
    }
    ps.forEach((x, i) => { const v = pre.people[i].statePension[t]; if (v > 0.5) incoming.push(line(`${cap(poss(x.name))} State Pension`, v, 'Before tax; rises with prices each April')); });
    const before = incoming.reduce((a, l) => a + l.value, 0);

    // ---- what comes off before it reaches you
    const employee = Math.max(0, r.saved - (r.extraPension || 0) - r.toCash - r.toIsa - r.toGia - (r.toLisa || 0) - (r.toPension || 0) - (r.sharesKept || 0));
    const incomeTaxes = r.taxes - (r.withdrawTax || 0);
    const off = [];
    r.persons.forEach((P, i) => {
      if (P.incomeTax > 0.5) off.push(line(`${cap(poss(ps[i].name))} income tax`, -P.incomeTax, P.taxable > 0 ? `On ${gbp(P.taxable)} of taxable income, after a tax-free allowance of ${gbp(P.allowance)}` : ''));
      if (P.ni > 0.5) off.push(line(`${cap(poss(ps[i].name))} National Insurance`, -P.ni));
    });
    // Each person's income tax includes the tax on pension they draw; that part is counted with the withdrawals.
    const otherTax = r.taxes - r.persons.reduce((a, P) => a + P.incomeTax + P.ni, 0);
    if (Math.abs(otherTax) > 0.5) off.push(line('Other tax', -otherTax, [r.hicbc > 0.5 ? `includes the Child Benefit charge of ${gbp(r.hicbc)}` : '', r.flatTax > 0.5 ? 'tax on rent and other flat-taxed income' : '', r.cgt > 0.5 ? 'tax on gains' : '', r.studentLoan > 0.5 ? `student loan ${gbp(r.studentLoan)}` : ''].filter(Boolean).join('; ')));
    if ((r.withdrawTax || 0) > 0.5) off.push(line('Less: tax on money drawn from savings and pensions', r.withdrawTax, 'Counted further down, with what is drawn'));
    if (employee > 0.5) off.push(line('Pension contributions from pay', -employee, 'Your own share, taken by payroll. The employer’s share is on top and is listed under Pensions'));
    if ((r.extraPension || 0) > 0.5) off.push(line('Extra pension payments', -r.extraPension));
    if ((r.sharesKept || 0) > 0.5) off.push(line('Share awards kept as shares', -r.sharesKept, 'Saved, not cash to spend'));
    const inn = r.earnings + r.otherIncome + r.statePension - incomeTaxes - employee - (r.extraPension || 0) - (r.sharesKept || 0);

    // ---- going out
    const events = plan.events.filter(e => e.year === r.year);
    const oneOffs = events.filter(e => e.kind === 'expense').map(e => line(e.name, -(e.amount * price), 'A one-off cost this year'));
    if ((r.homeBuy || 0) > 0.5) oneOffs.push(line('Deposit on the home bought this year', -r.homeBuy));
    const oneOff = -oneOffs.reduce((a, l) => a + l.value, 0);
    for (const e of events) if (e.kind !== 'expense') changes.push(`${e.name}: ${gbp(e.amount * (e.kind === 'income' ? 1 : price))}${e.kind === 'income' ? ' comes in' : ''} this year.`);
    for (const e of oneOffs) changes.push(`${e.label}: about ${gbp(-e.value)}.`);
    const started = [], stopped = [];
    if (t > 0) for (const e of plan.expenses) {
      const v = E.streamAt(e, plan, t), was = E.streamAt(e, plan, t - 1);
      if (v > 0.5 && was <= 0.5) started.push(`${e.name} (${gbp(v)} a year)`);
      if (v <= 0.5 && was > 0.5) stopped.push(`${e.name} (was ${gbp(was)} a year)`);
    }
    if (started.length) changes.push(`Spending that starts: ${list(started)}.`);
    if (stopped.length) changes.push(`Spending that ends: ${list(stopped)}.`);
    const everyday = Math.max(0, r.spending - oneOff);
    const debtPay = r.debtRegular + r.lumpOverpay;
    const going = [line('Everyday spending', -everyday, prev ? `Your spending list, risen with prices${stopped.length || started.length ? ' and with what starts or ends this year' : ''}` : 'Your spending list'), ...oneOffs];
    if (debtPay > 0.5) going.push(line('Mortgage and loan payments', -debtPay, 'The required payments; anything extra is listed below'));
    const left = inn - r.spending - debtPay;

    // ---- what is left, and where it goes (or what is drawn to cover a gap)
    const where = [];
    const put = (v, label, note) => { if (v > 0.5) where.push(line(label, v, note)); };
    put(r.hiDebtPay || 0, 'Extra to expensive debts', 'Anything costing 8% or more is cleared before saving');
    put(r.toCash, 'Into cash savings', 'Until the cash buffer is full');
    put(r.overpay, 'Mortgage overpayments', 'As the saving strategy says');
    put(r.toLisa || 0, 'Into Lifetime ISAs', (r.lisaBonus || 0) > 0.5 ? `The government adds ${gbp(r.lisaBonus)}` : '');
    put(r.toIsa, 'Into ISAs', 'Tax-free; up to each person’s yearly allowance');
    put(r.toGia, 'Into the general investment account', 'What is left once the ISAs are full');
    put(r.toPension || 0, 'Extra into pensions', (r.pensionRelief || 0) > 0.5 ? `Tax relief adds ${gbp(r.pensionRelief)}` : 'With tax relief on top');
    const drawn = [];
    const take = (v, label, note) => { if (v > 0.5) drawn.push(line(label, v, note)); };
    take(r.wCash, 'From cash', 'No tax');
    take(r.wIsa, 'From ISAs', 'No tax');
    take(r.wLisa || 0, 'From Lifetime ISAs', 'No tax after 60');
    take(r.wGia, 'From the general investment account', 'Gains above the allowance are taxed');
    take(r.wPension, 'From pension pots', (() => { const tf = r.persons.reduce((a, P) => a + (P.pensionTaxFree || 0), 0); return tf > 0.5 ? `${gbp(tf)} of it tax-free; the rest is taxed as income` : 'Taxed as income'; })());
    if ((r.withdrawTax || 0) > 0.5) drawn.push(line('Tax on what is drawn', -r.withdrawTax, 'Already allowed for in the amounts above'));
    if (prev && r.withdrawals > 0.5 && !(prev.withdrawals > 0.5)) changes.push('From this year, income no longer covers spending: the gap is drawn from savings and pensions, as listed.');
    if (prev && r.toIsa > 0.5 && !(prev.toIsa > 0.5)) changes.push('Money starts going into ISAs this year.');
    if (prev && r.toGia > 0.5 && !(prev.toGia > 0.5)) changes.push('The ISAs are full, so the rest starts going into a general investment account.');
    if (prev && prev.toCash > 0.5 && !(r.toCash > 0.5) && r.withdrawals <= 0.5) changes.push('The cash buffer is full: nothing more needs to go into cash.');
    if (prev && (r.sacrificed || 0) > 0.5 && !((prev.sacrificed || 0) > 0.5)) changes.push(`Pay now goes over the line you chose, so ${gbp(r.sacrificed)} more is salary sacrificed into the pension this year. Ask payroll to raise the sacrifice.`);
    if ((r.unfunded || 0) > 0.5) changes.push(`The money runs short this year by about ${gbp(r.unfunded)}: on average returns, savings and pensions that can be used are spent.`);
    if ((r.propSold || 0) > 0.5) changes.push(`A property is sold: about ${gbp(r.propSold)} comes in.`);
    if ((r.propBought || 0) > 0.5) changes.push(`A home is bought for about ${gbp(r.propBought)}.`);
    if ((r.bondsMatured || 0) > 0.5) changes.push(`Bonds or gilts mature: about ${gbp(r.bondsMatured)} is paid back.`);

    // ---- pensions, person by person
    const pensions = [];
    ps.forEach((x, i) => {
      const P = pre.people[i];
      const own = P.ee[t] + (P.sacrificed[t] || 0), employer = Math.max(0, P.contrib[t] - P.ee[t]);
      const was = t > 0 ? pre.people[i].ee[t - 1] + (pre.people[i].sacrificed[t - 1] || 0) : own;
      if (own > 0.5) pensions.push(line(`${cap(poss(x.name))} own contributions`, own, `${gbp(own / 12)} a month${(P.sacrificed[t] || 0) > 0.5 ? `, of which ${gbp(P.sacrificed[t])} is the extra salary sacrifice` : ''}${t > 0 && was > 0.5 && Math.abs(own / was - 1) > 0.08 ? `; ${own > was ? 'up' : 'down'} from ${gbp(was)} last year` : ''}`));
      if (employer > 0.5) pensions.push(line(`${cap(poss(x.name))} employer adds`, employer, `${gbp(employer / 12)} a month`));
      if ((P.relief[t] || 0) > 0.5) pensions.push(line(`Tax relief for ${x.name}`, P.relief[t]));
      const drawnP = r.persons[i].pensionDrawn || 0;
      if (drawnP > 0.5) pensions.push(line(`Drawn from ${poss(x.name)} pots`, -drawnP));
      if (next && (next.persons[i].pension > 0.5 || r.persons[i].pension > 0.5)) pensions.push(line(`${cap(poss(x.name))} pots at the end of the year`, next.persons[i].pension, `From ${gbp(r.persons[i].pension)} at the start`, { strong: true }));
    });

    // ---- debts, one by one
    const debts = [];
    (out.debts || []).forEach(d => {
      const acc = plan.accounts.find(a => a.id === d.id) || { name: 'Debt' };
      const b0 = d.bal[t] || 0, b1 = d.bal[t + 1] || 0;
      if (b0 <= 0.5 && b1 <= 0.5) return;
      debts.push(line(acc.name, -b1, b0 <= 0.5 ? 'Taken out this year' : b1 <= 0.5 ? `Paid off this year (owed ${gbp(b0)} at the start)` : `Down from ${gbp(b0)} at the start of the year`));
      if (b0 > 0.5 && b1 <= 0.5) changes.push(`${acc.name} is paid off this year. Its payments are free for saving from then on.`);
      if (acc.fixedUntil === r.year) changes.push(`The fixed rate on ${acc.name} ends this year${acc.rateAfterFix !== null && acc.rateAfterFix !== undefined ? `; the plan assumes ${acc.rateAfterFix}% afterwards` : ''}. Shop around for a new deal three to six months before.`);
    });
    if (debts.length && r.debtInterest > 0.5) debts.push(line('Interest charged this year', -r.debtInterest, 'Part of the payments above goes on this'));

    // ---- where things stand at the end of the year
    const end = [];
    if (next) {
      const e = (label, v, note) => { if (Math.abs(v) > 0.5) end.push(line(label, v, note)); };
      e('Cash and savings', next.cash + (next.cashIsa || 0), (next.cashIsa || 0) > 0.5 ? `Includes ${gbp(next.cashIsa)} in cash ISAs` : '');
      e('ISAs', next.isa - (next.cashIsa || 0) - (next.lisa || 0), 'Invested');
      e('Lifetime ISAs', next.lisa || 0);
      e('General investment account', next.gia);
      e('Bonds and gilts', next.bonds);
      e('Pension pots', next.pension, ps.some((x, i) => next.ages[i] < x.pensionAccessAge) ? `Cannot be touched before age ${Math.min(...ps.map(x => x.pensionAccessAge))}` : '');
      e('Property', next.property);
      e('Mortgage and loans', -next.debt);
    }
    const nw = mc && mc.series && mc.series.netWorth ? mc.series.netWorth.nominal : null;
    const band = k => (nw && nw[k] ? nw[k][Math.min(t + 1, nw[k].length - 1)] : null);
    const net = next ? { value: next.netWorth, real: next.netWorth / next.deflator, low: band('p10'), high: band('p90') } : null;

    // ---- the page's headline
    const working = ps.filter((x, i) => r.ages[i] < x.retireAge);
    const phase = working.length === ps.length ? 'working' : working.length ? 'part' : 'retired';
    const headline = left >= 0
      ? `${gbp(inn / 12)} a month comes in after tax and pension. ${gbp((r.spending + debtPay) / 12)} goes out. ${gbp(left / 12)} a month is left to save.`
      : `${gbp(inn / 12)} a month comes in after tax. ${gbp((r.spending + debtPay) / 12)} goes out. The gap of ${gbp(-left / 12)} a month is drawn from savings and pensions.`;

    const groups = [
      { id: 'in', title: 'Money coming in', explain: 'Each source for the year, before tax unless it says otherwise.', lines: incoming, total: line('Total before tax', before) },
      { id: 'off', title: 'What comes off first', explain: 'Tax, National Insurance and your own pension contributions are taken before the money reaches your bank.', lines: off, total: line('Left in your bank', inn, `${gbp(inn / 12)} a month`) },
      { id: 'out', title: 'Money going out', explain: 'What the year is expected to cost.', lines: going, total: line('Total going out', -(r.spending + debtPay), `${gbp((r.spending + debtPay) / 12)} a month`) },
      left >= -0.5
        ? { id: 'save', title: 'What is left, and where to put it', explain: `Held ${pct(r.stockWeight)} in shares and ${pct(1 - r.stockWeight)} in bonds this year (ISAs, general account and pensions).`, lines: where, total: line('Left to save', Math.max(0, left), `${gbp(Math.max(0, left) / 12)} a month`), monthly: true }
        : { id: 'draw', title: 'What to take from savings and pensions', explain: 'Income does not cover the year, so the rest is drawn in the order that costs least tax: cash, then the general account, ISAs and pensions.', lines: drawn, total: line('Gap to cover', -left, `${gbp(-left / 12)} a month`), monthly: true },
      pensions.length ? { id: 'pension', title: 'Pensions', explain: 'What goes into each person’s pots this year and what they should hold at the end of it.', lines: pensions } : null,
      debts.length ? { id: 'debt', title: 'Mortgage and loans', explain: 'What is still owed on each at the end of the year.', lines: debts } : null,
      end.length ? { id: 'end', title: 'Where you should be at the end of the year', explain: 'On average returns. Compare these with your real balances at the yearly review: that is how you know if you are on plan.', lines: end, total: net ? line('Net worth', net.value, `${gbp(net.real)} in today’s money`) : null } : null,
    ].filter(g => g && (g.lines.length || g.total));

    const todo = (steps || []).filter(s => s.when === r.year || (t === 0 && (s.when === 'now' || s.when === 'tax'))).map(s => ({ title: s.title, text: s.text }));
    // From the second year on: the amounts to set up for the year, against the year before.
    // (The first year's are the "now" steps.)
    if (prev) {
      const amounts = yearAmounts(r, prev, left);
      if (amounts && !todo.some(s => /^Take about/.test(s.title) && amounts.draw)) todo[amounts.draw ? 'push' : 'unshift'](amounts);
    }

    // ---- the year as two bars: where the money goes, and what is owned at the end of it
    const split = [
      { id: 'tax', label: 'Tax and National Insurance', value: Math.max(0, r.taxes) },
      { id: 'pension', label: 'Into pensions from pay', value: employee + (r.extraPension || 0) + (r.sharesKept || 0) },
      { id: 'spending', label: 'Spending', value: r.spending },
      { id: 'debt', label: 'Mortgage and loans', value: debtPay },
      { id: 'saved', label: 'Left to save', value: Math.max(0, left) },
    ].filter(x => x.value > 0.5);
    const holdings = next ? holdingsOf(next).filter(x => x.value > 0.5) : [];
    return { t, year: r.year, ages, phase, headline, changes, groups, todo, net, inn, left, spending: r.spending + debtPay, split, drawn: r.withdrawals || 0, holdings, owed: next ? next.debt : 0 };
  }

  // ---------------------------------------------------------------- the whole document

  // steps: the plan's dated instructions ({ when: 'now' | 'yearly' | year, title, text }).
  // goals: the evaluated goals. opts.years: how many years to write out (default: all).
  function build(plan, proj, mc, goals, opts = {}) {
    const rows = proj.rows, N = rows.length - 1;
    const ps = plan.household.people;
    const count = Math.max(1, Math.min(N, opts.years || N));
    const steps = opts.steps || [];
    const years = [];
    for (let t = 0; t < Math.max(count, Math.min(N, 2)); t++) years.push(yearBlock(plan, proj, mc, t, steps));

    const verdict = g => {
      const pc = Math.round((g.probability || 0) * 100);
      if (g.goal && g.goal.type === 'emergency') return g.status === 'good' ? 'Yes: the cash you keep covers it.' : `Not yet. ${g.summary || ''}`;
      const lead = g.status === 'good' ? 'Yes, likely' : g.status === 'warn' ? 'Possibly' : 'Unlikely as things stand';
      return `${lead}: it works out in ${pc} of 100 futures tried.${g.summary ? ` ${g.summary}` : ''}`;
    };

    // Dates that matter, in order: milestones, events, debts ending, fixes ending.
    const timeline = [];
    for (const m of E.milestones(plan, proj)) timeline.push({ year: m.year, label: m.label });
    for (const e of plan.events) timeline.push({ year: e.year, label: `${e.name} (${gbp(e.amount)} in today’s money)` });
    for (const a of plan.accounts) if (a.type === 'debt' && a.fixedUntil >= plan.startYear) timeline.push({ year: a.fixedUntil, label: `Fixed rate on ${a.name} ends` });
    timeline.sort((a, b) => a.year - b.year);
    const seen = new Set();
    const dates = timeline.filter(x => x.year >= plan.startYear && x.year <= rows[N].year && !seen.has(`${x.year}${x.label}`) && seen.add(`${x.year}${x.label}`))
      .map(x => ({ ...x, ages: ps.map(p => p.age + (x.year - plan.startYear)) }));

    // How wide the range of outcomes is at a few points.
    const at = [5, 10, 20, 30, N].filter((k, i, a) => k <= N && a.indexOf(k) === i);
    const nw = mc && mc.series && mc.series.netWorth ? mc.series.netWorth.nominal : null;
    const range = nw ? at.map(k => ({ year: rows[k].year, ages: rows[k].ages, expected: rows[k].netWorth, low: nw.p10[k], mid: nw.p50[k], high: nw.p90[k], deflator: rows[k].deflator })) : [];

    return {
      meta: {
        title: `${list(ps.map(x => (x.name === 'You' ? 'Your' : x.name)))}${ps.length === 1 && ps[0].name === 'You' ? '' : ps.every(x => x.name !== 'You') ? '’s' : ''} plan, year by year`.replace('Your’s', 'Your'),
        people: ps.map(x => ({ name: x.name, age: x.age, retireAge: x.retireAge })),
        asOf: plan.asOf, startYear: plan.startYear, endYear: rows[N].year, scenario: opts.scenario || '',
        successRate: mc ? mc.successRate : null,
      },
      short: (goals || []).map(g => ({ id: g.goal.id, title: g.title, status: g.status, text: verdict(g) })),
      // The short list to act on: now, before the tax year ends, and next year.
      sheet: {
        now: steps.filter(s => s.when === 'now' || s.when === plan.startYear).map(s => ({ title: s.title, text: s.text })),
        tax: steps.filter(s => s.when === 'tax').map(s => ({ title: s.title, text: s.text })),
        next: years[1] ? { year: years[1].year, todo: years[1].todo, changes: years[1].changes } : null,
      },
      assumptions: assumptions(plan),
      dates,
      everyYear: steps.filter(s => s.when === 'yearly').map(s => ({ title: s.title, text: s.text })),
      years: years.slice(0, count),
      range,
      pictures: pictures(plan, proj, mc),
      glossary: GLOSSARY,
    };
  }

  const api = { build, yearBlock, yearAmounts, pictures, assumptions, GLOSSARY, gbp };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Dossier = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
