'use strict';

// UK tax and pension rules used by the engine. Tax year 2026/27.
// Keep every legislated number in this file so a new tax year is a one-file update.
//
// Thresholds are in nominal pounds for the tax year. The engine scales them by a
// "threshold factor" each year: 1 while thresholds are frozen, then rising with inflation.

(function (root) {
  const TAX_YEAR = '2026/27';

  const PERSONAL_ALLOWANCE = 12570;
  const PA_TAPER_START = 100000;          // allowance falls £1 for every £2 above this

  // Band widths apply to income above the personal allowance. The final band is open.
  const INCOME_TAX = {
    scotland: {
      label: 'Scotland',
      bands: [
        { name: 'Starter', width: 3967, rate: 0.19 },       // £12,571 – £16,537
        { name: 'Basic', width: 12989, rate: 0.20 },        // £16,538 – £29,526
        { name: 'Intermediate', width: 14136, rate: 0.21 }, // £29,527 – £43,662
        { name: 'Higher', width: 31338, rate: 0.42 },       // £43,663 – £75,000
        { name: 'Advanced', width: 62710, rate: 0.45 },     // £75,001 – £125,140
        { name: 'Top', width: Infinity, rate: 0.48 },       // over £125,140
      ],
    },
    ruk: {
      label: 'England, Wales & Northern Ireland',
      bands: [
        { name: 'Basic', width: 37700, rate: 0.20 },        // £12,571 – £50,270
        { name: 'Higher', width: 87440, rate: 0.40 },       // £50,271 – £125,140
        { name: 'Additional', width: Infinity, rate: 0.45 },
      ],
    },
  };

  // Employee Class 1 National Insurance.
  const NI = { primaryThreshold: 12570, upperEarningsLimit: 50270, mainRate: 0.08, upperRate: 0.02 };

  // Capital gains tax uses UK-wide bands, including for Scottish taxpayers.
  const CGT = { annualExempt: 3000, basicRate: 0.18, higherRate: 0.24, basicBand: 37700 };

  const ISA_ALLOWANCE = 20000;
  const STATE_PENSION_FULL = 241.30 * 52;   // new State Pension, £/year
  const LUMP_SUM_ALLOWANCE = 268275;        // cap on tax-free pension cash, per person
  const PENSION_TAX_FREE_SHARE = 0.25;
  const MIN_PENSION_AGE = 57;               // from April 2028
  const PENSION_ANNUAL_ALLOWANCE = 60000;
  const FREEZE_UNTIL = 2031;                // income tax & NI thresholds frozen until April 2031
  // From April 2029 only the first £2,000 a year of salary-sacrificed pension
  // contributions is free of National Insurance (Autumn Budget 2025, confirmed 2026).
  const SACRIFICE_NI_CAP = 2000;
  const SACRIFICE_NI_CAP_FROM = 2029;

  // Family support used by the plan check (insights), 2026/27.
  const CHILD_BENEFIT = {
    eldest: 27.05 * 52, additional: 17.90 * 52,
    chargeFrom: 60000, chargeTo: 80000,     // High Income Child Benefit Charge: 1% per £200 over £60k
  };
  const TAX_FREE_CHILDCARE = { topUp: 0.2, capPerChild: 2000, incomeLimit: 100000, maxAge: 11 };
  const JUNIOR_ISA_ALLOWANCE = 9000;
  // Inheritance tax, per person: nil-rate band and residence nil-rate band (frozen to April 2030),
  // the residence band withdrawn £1 for every £2 of estate over £2m; 40% above. Gifts of up to
  // £3,000 a year are exempt.
  const IHT = { nilRate: 325000, residence: 175000, taperFrom: 2000000, rate: 0.4, annualGift: 3000 };

  // Lifetime ISA: open from 18 to 39, pay in until 50, 25% government bonus, inside the ISA
  // allowance. Withdrawals are free from 60 or for a first home up to £450,000; otherwise
  // a 25% charge applies (losing the bonus and a bit more).
  // Self-employed profits: Class 4 National Insurance (Class 2 is no longer compulsory).
  const CLASS4 = { lower: 12570, upper: 50270, mainRate: 0.06, upperRate: 0.02 };
  // Student loans in England, Wales, Scotland and NI, 2026/27: repaid as a share of pay above a
  // yearly threshold, through the payslip; whatever is left is written off. `extra` is interest
  // above the plan's inflation, roughly (it is set from RPI). Plan 2's threshold is frozen to April
  // 2030, Plan 5's to April 2027; the others rise with prices.
  const STUDENT_LOANS = {
    plan1: { label: 'Plan 1 (started before Sept 2012, or in NI)', threshold: 26900, pct: 9, extra: 0.5, frozenUntil: 0, writeOff: 25 },
    plan2: { label: 'Plan 2 (England & Wales, started Sept 2012 to July 2023)', threshold: 29385, pct: 9, extra: 2, frozenUntil: 2030, writeOff: 30 },
    plan4: { label: 'Plan 4 (Scotland)', threshold: 33795, pct: 9, extra: 0.5, frozenUntil: 0, writeOff: 30 },
    plan5: { label: 'Plan 5 (England, started from Aug 2023)', threshold: 25000, pct: 9, extra: 0.5, frozenUntil: 2027, writeOff: 40 },
    pg: { label: 'Postgraduate loan', threshold: 21000, pct: 6, extra: 3.5, frozenUntil: 0, writeOff: 30 },
  };
  const LISA = { maxContribution: 4000, bonus: 0.25, openBefore: 40, payUntil: 50, accessAge: 60, charge: 0.25, homePriceCap: 450000 };

  // Defined benefit (career average) schemes: pension added per year = salary / accrual,
  // an automatic lump sum of `lump` × the pension, and the normal pension age.
  // USS early retirement: % of the pension (and its lump sum) kept when taken 0, 1, 2… full years
  // before Normal Pension Age (factors from 1 October 2024, uss.co.uk "Factors used by USS").
  const USS_EARLY = [100, 94.8, 90, 85.5, 81.4, 77.5, 74, 70.6, 67.5, 64.6, 61.8, 59.3, 56.8, 54.5, 52.4, 50.3, 48.4];

  const DB_SCHEMES = {
    // USS Normal Pension Age follows State Pension age (66 in 2026; uss.co.uk glossary).
    uss: { label: 'USS (universities)', accrual: 75, lump: 3, age: 'spa', early: USS_EARLY },
    saul: { label: 'SAUL (university staff)', accrual: 75, lump: 3, age: 65 },
    lgps: { label: 'Local Government (LGPS Scotland)', accrual: 49, lump: 0, age: 'spa' },
    teachers: { label: 'Scottish Teachers (STPS)', accrual: 57, lump: 0, age: 'spa' },
    nhs: { label: 'NHS Scotland (2015 scheme)', accrual: 54, lump: 0, age: 'spa' },
    other: { label: 'Other', accrual: 60, lump: 0, age: 'spa' },
  };

  // State Pension age under current legislation (approximate around transition dates).
  function statePensionAge(birthYear) {
    if (birthYear >= 1978) return 68;
    if (birthYear >= 1961) return 67;
    return 66;
  }

  function personalAllowance(income, g) {
    const pa = PERSONAL_ALLOWANCE * g;
    const over = income - PA_TAPER_START * g;
    return over > 0 ? Math.max(0, pa - over / 2) : pa;
  }

  // Income tax on non-savings income. `g` scales thresholds (1 in 2026/27).
  function incomeTax(income, region, g = 1) {
    if (income <= 0) return 0;
    const bands = (INCOME_TAX[region] || INCOME_TAX.scotland).bands;
    let taxable = income - personalAllowance(income, g);
    let tax = 0;
    for (const b of bands) {
      if (taxable <= 0) break;
      const slice = Math.min(taxable, b.width * g);
      tax += slice * b.rate;
      taxable -= slice;
    }
    return tax;
  }

  // Marginal income tax rate at `income` (ignores the taper's 50% uplift for clarity
  // in the UI, but includes the taper in the effective calculation above).
  function marginalRate(income, region, g = 1) {
    const step = 100;
    return (incomeTax(income + step, region, g) - incomeTax(income, region, g)) / step;
  }

  function selfEmployedNI(profit, g = 1) {
    const lo = CLASS4.lower * g, hi = CLASS4.upper * g;
    if (profit <= lo) return 0;
    return CLASS4.mainRate * (Math.min(profit, hi) - lo) + CLASS4.upperRate * Math.max(0, profit - hi);
  }

  function nationalInsurance(earnings, g = 1) {
    const pt = NI.primaryThreshold * g, uel = NI.upperEarningsLimit * g;
    if (earnings <= pt) return 0;
    return NI.mainRate * (Math.min(earnings, uel) - pt) + NI.upperRate * Math.max(0, earnings - uel);
  }

  // CGT for one person on `gain` realised in a year, given their income for the year.
  function capitalGainsTax(gain, income, g = 1) {
    const chargeable = gain - CGT.annualExempt;
    if (chargeable <= 0) return 0;
    const taxableIncome = Math.max(0, income - personalAllowance(income, g));
    const basicLeft = Math.max(0, CGT.basicBand * g - taxableIncome);
    const atBasic = Math.min(chargeable, basicLeft);
    return atBasic * CGT.basicRate + (chargeable - atBasic) * CGT.higherRate;
  }

  // Rough gross salary for a yearly take-home figure (income tax + NI, no pension).
  function grossFromTakeHome(net, region) {
    let lo = net, hi = net * 2.5 + 20000;
    for (let k = 0; k < 40; k++) {
      const mid = (lo + hi) / 2;
      const take = mid - incomeTax(mid, region) - nationalInsurance(mid);
      if (take < net) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Income thresholds as totals (for display), e.g. "Higher: £43,663 – £75,000".
  function bandTable(region, g = 1) {
    const bands = (INCOME_TAX[region] || INCOME_TAX.scotland).bands;
    const rows = [{ name: 'Personal allowance', from: 0, to: PERSONAL_ALLOWANCE * g, rate: 0 }];
    // The allowance is fully tapered away at £125,140, which is where the last band starts.
    const taperEnd = (PA_TAPER_START + 2 * PERSONAL_ALLOWANCE) * g;
    let from = PERSONAL_ALLOWANCE * g;
    for (const b of bands) {
      let to = b.width === Infinity ? Infinity : from + b.width * g;
      if (to !== Infinity && to > taperEnd) to = taperEnd;
      rows.push({ name: b.name, from, to, rate: b.rate });
      from = to;
    }
    return rows;
  }

  const api = {
    TAX_YEAR, PERSONAL_ALLOWANCE, PA_TAPER_START, INCOME_TAX, NI, CGT, IHT,
    ISA_ALLOWANCE, STATE_PENSION_FULL, LUMP_SUM_ALLOWANCE, PENSION_TAX_FREE_SHARE,
    MIN_PENSION_AGE, PENSION_ANNUAL_ALLOWANCE, FREEZE_UNTIL, SACRIFICE_NI_CAP, SACRIFICE_NI_CAP_FROM,
    CHILD_BENEFIT, TAX_FREE_CHILDCARE, JUNIOR_ISA_ALLOWANCE, DB_SCHEMES, USS_EARLY, LISA, CLASS4, STUDENT_LOANS, selfEmployedNI,
    statePensionAge, grossFromTakeHome, personalAllowance, incomeTax, marginalRate, nationalInsurance,
    capitalGainsTax, bandTable,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.UKRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
