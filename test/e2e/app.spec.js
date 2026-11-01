// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { openApp, tab, go, openGoal, asTable, settle } = require('./helpers');

test.describe('Horizon app', () => {
  let tracker;
  test.beforeEach(async ({ page }) => { tracker = await openApp(page); });
  test.afterEach(async () => {
    expect(tracker.problems, 'no page errors').toEqual([]);
    expect(tracker.external, 'no network requests leave the browser').toEqual([]);
  });

  test('home shows the portfolio today, the goals and a chart', async ({ page }) => {
    // The example's figures are as at the last 1 September: Home estimates each balance since.
    await expect(page.locator('#homePortfolio .pf-row.head')).toContainText('1 Sep');
    await expect(page.locator('#homePortfolio .pf-row:not(.head)')).toHaveCount(9);
    await expect(page.locator('#homePortfolio .pf-row').nth(8)).toContainText('£320,000');
    await expect(page.locator('#homePortfolio')).toContainText('Estimated net worth today');
    await expect(page.locator('#homePortfolio')).toContainText('from your figures as at');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(3);
    await expect(page.locator('#ovGoalStrip .goal-tile').first()).toContainText('%');
    await expect(page.locator('#homeYear')).toContainText('Invest each month');
    await expect(page.locator('#homeYear .next-list li').first()).toBeVisible();
    await expect(page.locator('#ovInsights .insight').first()).toBeVisible();
    const box = await page.locator('#ovChart canvas').boundingBox();
    expect(box && box.width).toBeGreaterThan(500);
  });

  test('home estimates every balance for today, and balances can be updated', async ({ page }) => {
    // Figures from half a year ago: the home page moves them on to today.
    const asOf = await page.evaluate(() => {
      const d = new Date(); d.setMonth(d.getMonth() - 6);
      const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      for (const s of window.__horizon.ws.scenarios) s.plan.asOf = iso;
      window.__horizon.refresh();
      return iso;
    });
    await expect(page.locator('#homePortfolio .pf-row .src.est').first()).toContainText('Estimated');
    const nw = await page.evaluate(() => window.__horizon.model.est.netWorth);
    expect(nw).toBeGreaterThan(275000);
    expect(asOf).toMatch(/^\d{4}-/);
    // Update one balance from a banking app.
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await tab(page, 'home');
    await page.click('#updateBtn');
    await expect(page.locator('#updateDlg')).toBeVisible();
    await expect(page.locator('#udSave')).toBeDisabled();
    const input = page.locator('#udBody .rv-row').nth(1).locator('input');
    await input.fill('30000');
    await expect(page.locator('#udBody .rv-row').nth(1).locator('.rv-diff')).toContainText('vs estimate');
    await page.click('#udSave');
    await expect(page.locator('#updateDlg')).toBeHidden();
    await expect(page.locator('#homePortfolio .pf-row').nth(2)).toContainText('Updated today');
    await expect(page.locator('#homePortfolio .pf-row').nth(2)).toContainText('£30,000');
    // Recorded in every scenario that has the account; the projection still starts from the figures.
    const latest = await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.plan.accounts[1].latest));
    expect(latest.map(l => l && l.value)).toEqual([30000, 30000]);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.accounts[1].balance)).toBe(22000);
    // The next review starts from the update.
    await page.evaluate(() => window.__horizon.openReview());
    await page.click('#rvNext');
    await expect(page.locator('#rvBody .rv-row').nth(1)).toContainText('From your update');
    await expect(page.locator('#rvBody .rv-row').nth(1).locator('input')).toHaveValue('30,000');
  });

  test('the bell offers an update once the figures are a month old, and a save', async ({ page }) => {
    await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() - 45);
      const iso = window.Engine.todayISO(d);
      for (const s of window.__horizon.ws.scenarios) s.plan.asOf = iso;
      window.__horizon.refresh();
    });
    await expect(page.locator('#notifyCount')).toBeVisible();
    await page.click('#notifyBtn');
    await expect(page.locator('#notifyPop [data-notify="update"], #notifyPop [data-notify="review"]').first()).toBeVisible();
    await expect(page.locator('#notifyPop [data-notify="save"]')).toContainText('Keep a copy');
    await expect(page.locator('#homePortfolio')).toContainText('Estimated net worth today');
    await expect(page.locator('#homePortfolio .delta')).toContainText('since your last update');
  });

  test('the date your figures are as at can be changed on Finances', async ({ page }) => {
    await go(page, 'finances/portfolio');
    const input = page.locator('#asOfBar input[type="date"]');
    const year = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.startYear);
    await input.fill(`${year - 1}-03-15`);
    await settle(page);
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.asOf).toBe(`${year - 1}-03-15`);
    expect(p.startYear).toBe(year - 1);
    await expect(page.locator('#sec-accounts')).toContainText('15 Mar');
    await expect(page.locator('#sec-accounts .tag.est').first()).toContainText('today');
  });

  test('every tab renders without errors', async ({ page }) => {
    for (const name of ['finances', 'scenarios', 'home']) {
      await tab(page, name);
      await expect(page.locator(`#view-${name}`)).toBeVisible();
    }
  });

  test('chart tooltip appears on hover', async ({ page }) => {
    const canvas = page.locator('#ovChart canvas');
    await canvas.scrollIntoViewIfNeeded();
    const box = await canvas.boundingBox();
    if (!box) throw new Error('no chart');
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    const tip = page.locator('#ovChart .chart-tip');
    await expect(tip).toBeVisible();
    await expect(tip).toContainText('Net worth');
  });

  test('editing a salary updates the projection', async ({ page }) => {
    const before = await page.evaluate(() => window.__horizon.model.proj.rows[0].netWorth);
    const beforeInvest = await page.evaluate(() => window.__horizon.model.monthly.invest);
    await go(page, 'finances/income');
    const salary = page.locator('#sec-income .item').first().locator('input[aria-label="Amount"]');
    await salary.fill('90000');
    await settle(page);
    const afterInvest = await page.evaluate(() => window.__horizon.model.monthly.invest);
    expect(afterInvest).toBeGreaterThan(beforeInvest);
    const after = await page.evaluate(() => window.__horizon.model.proj.rows[0].netWorth);
    expect(after).toBe(before); // today's balances are unchanged
  });

  test('accepts amounts like 25k and formats them on blur', async ({ page }) => {
    await go(page, 'finances/assumptions');
    const input = page.locator('#sec-strategy input').first();
    await input.fill('25k');
    await input.blur();
    await expect(input).toHaveValue('25,000');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.cashReserve)).toBe(25000);
  });

  test('add and remove an account', async ({ page }) => {
    await go(page, 'finances/portfolio');
    const items = page.locator('#sec-accounts .item');
    const n = await items.count();
    await page.click('#sec-accounts button:has-text("+ ISA")');
    await expect(items).toHaveCount(n + 1);
    await items.last().locator('button[aria-label^="Remove"]').click();
    await expect(items).toHaveCount(n);
  });

  test('each kind of account has its own fields, and no type to change', async ({ page }) => {
    await go(page, 'finances/portfolio');
    await page.click('#sec-accounts button:has-text("+ Mortgage or loan")');
    const added = page.locator('#sec-accounts .item').last();
    await expect(added).toContainText('Interest rate');
    await expect(added).toContainText('Monthly payment');
    await expect(added.locator('.item-head .tag').first()).toHaveText('Mortgage or loan');
    await expect(page.locator('#sec-accounts select[aria-label="Type"]')).toHaveCount(0);
  });

  test('add a partner and remove them again', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await page.locator('#sec-household button[aria-label="Remove partner"]').click();
    await expect(page.locator('#sec-household .item')).toHaveCount(1);
    await page.click('#sec-household button:has-text("+ Add partner")');
    await expect(page.locator('#sec-household .item')).toHaveCount(2);
  });

  test('spending check-up pre-fills, walks every step and applies', async ({ page }) => {
    await go(page, 'finances/spending');
    await page.click('#sec-expenses button:has-text("Spending check-up")');
    const dialog = page.locator('#wizard');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Home');
    await expect(page.locator('#wizBody input[aria-label="Council tax"]')).toHaveValue('210');
    await page.locator('#wizBody input[aria-label="Rent"]').fill('500');
    await expect(page.locator('#wizTotal')).toContainText('a month');
    for (let i = 0; i < 7; i++) await page.click('#wizNext');
    await expect(dialog).toContainText('Review');
    await expect(page.locator('#wizNext')).toHaveText('Apply to plan');
    await page.click('#wizNext');
    await expect(dialog).toBeHidden();
    await settle(page);
    const names = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.expenses.map(e => e.name));
    expect(names).toContain('Rent');
    expect(names).toContain('Groceries');
    expect(names.filter(n => n === 'Groceries')).toHaveLength(1);
  });

  test('each goal has its own tab, with its own page', async ({ page }) => {
    const tabs = page.locator('.tab-list .goal-tab');
    await expect(tabs).toHaveCount(3);
    await expect(tabs.nth(1)).toHaveText('Mortgage-free');
    await expect(tabs.nth(2)).toHaveText('Retirement');
    await tabs.first().click();
    await expect(page.locator('#goalPage')).toBeVisible();
    await expect(page.locator('#view-home')).toBeHidden();
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');
    expect(await page.evaluate(() => location.hash)).toMatch(/^#goal\//);
    await expect(page.locator('#goalPage .goal-hero')).toContainText('£1M by');
    await expect(page.locator('#goalPage canvas').first()).toBeVisible();
    await expect(page.locator('#gpHistory')).toContainText('starting years', { timeout: 15000 });
    // Its own chart has a table of every number, with the target.
    const track = page.locator('#goalPage .card').nth(1);
    await track.locator('.chart-tools button:has-text("Table")').click();
    await expect(track.locator('.chart-table thead')).toContainText('Target');
    // The browser's back button returns to Home.
    await page.goBack();
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator('#goalPage')).toBeHidden();
  });

  test('what would it take: mortgage goal solver can be applied', async ({ page }) => {
    await openGoal(page, 'Mortgage-free by');
    const before = await page.locator('.goal-hero .goal-pct').innerText();
    await page.click('#gpTake button:has-text("Work it out")');
    await expect(page.locator('#gpTake .goal-solve')).toContainText('Overpay with', { timeout: 20000 });
    await page.locator('#gpTake .goal-solve button:has-text("Apply")').click();
    await settle(page);
    const pctNow = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.overpayPct);
    expect(pctNow).toBeGreaterThan(0);
    const after = await page.locator('.goal-hero .goal-pct').innerText();
    expect(parseInt(after, 10)).toBeGreaterThan(parseInt(before, 10));
  });

  test('what would it take: retirement goal suggests spending', async ({ page }) => {
    await openGoal(page, 'retires at');
    await page.click('#gpTake button:has-text("Work it out")');
    await expect(page.locator('#gpTake .goal-solve')).toContainText('Earliest retirement', { timeout: 30000 });
    await expect(page.locator('#gpTake .goal-solve')).toContainText('could spend about');
    await expect(page.locator('#goalPage')).toContainText('Your retirement plan');
  });

  test('goal wizard: add an amount goal with lever trade-offs', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await expect(page.locator('#goalWiz')).toBeVisible();
    await page.click('.goal-option:has-text("Reach an amount")');
    await page.locator('#gwBody input[aria-label="Goal amount"]').fill('750k');
    await page.locator('#gwBody input[type="number"]').first().fill('2034');
    await expect(page.locator('#gwPreview')).toContainText('£750K by 2034', { timeout: 15000 });
    await page.click('#gwNext');
    await expect(page.locator('#gwTitle')).toHaveText('Levers you can pull');
    await page.locator('#gwBody input[aria-label="Spending before retirement"]').fill('85');
    await expect(page.locator('#gwImpact')).toContainText('£750K by 2034', { timeout: 15000 });
    await expect(page.locator('#gwImpact')).toContainText('▲');
    await page.click('#gwNext');
    await expect(page.locator('#gwBody')).toContainText('Spending before retirement: 100% → 85%');
    await page.click('#gwBody button:has-text("Save goal and apply changes")');
    await expect(page.locator('#goalWiz')).toBeHidden();
    await expect(page.locator('#goalPage .goal-hero')).toContainText('£750K by 2034');
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(4);
    await expect(page.locator('.tab-list .goal-tab')).toHaveCount(4);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.spendNowPct)).toBe(85);
  });

  test('goal wizard: save trade-offs as a new scenario', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Mortgage-free")');
    await page.click('#gwNext');
    await page.locator('#gwBody input[aria-label="Share of surplus to overpay"]').fill('50');
    await expect(page.locator('#gwStatus')).toContainText('1 change', { timeout: 15000 });
    await page.click('#gwNext');
    await page.click('#gwBody button:has-text("as a new scenario")');
    await expect(page.locator('#scenarioSelect option')).toHaveCount(2);
    const ws = await page.evaluate(() => window.__horizon.ws);
    expect(ws.scenarios[0].plan.strategy.overpayPct).toBe(0);
    expect(ws.scenarios[1].plan.strategy.overpayPct).toBe(50);
    expect(ws.scenarios[1].plan.goals.length).toBe(4);
  });

  test('edit and remove a goal', async ({ page }) => {
    await openGoal(page, '£1M by');
    await page.click('.goal-hero button:has-text("Edit goal")');
    await expect(page.locator('#gwTitle')).toHaveText('Set the target');
    await page.locator('#gwBody input[aria-label="Goal amount"]').fill('2m');
    await page.click('#gwNext');
    await page.click('#gwNext');
    await page.click('#gwBody button:has-text("Save goal")');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('£2M by');
    await page.click('.goal-hero button:has-text("Remove")');
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(2);
    await expect(page.locator('#ovGoalStrip')).not.toContainText('£2M by');
  });

  test('lever explorer compares, then applies changes', async ({ page }) => {
    await tab(page, 'scenarios');
    await expect(page.locator('#expApply')).toBeDisabled();
    await page.locator('#expLevers input[aria-label="Alex retires at"]').fill('60');
    await expect(page.locator('#expStatus')).toContainText('1 change', { timeout: 15000 });
    await expect(page.locator('#expImpact')).toContainText('Chance the money lasts');
    await expect(page.locator('#expChart canvas')).toBeVisible();
    await page.click('#expApply');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.household.people[0].retireAge)).toBe(60);
    await expect(page.locator('#expApply')).toBeDisabled();
  });

  test('stress-test levers do not need applying to be useful', async ({ page }) => {
    await tab(page, 'scenarios');
    await page.locator('#expLevers summary:has-text("Stress test")').click();
    await page.locator('#expLevers input[aria-label="Stock returns higher or lower"]').fill('-3');
    await expect(page.locator('#expImpact')).toContainText('▼', { timeout: 15000 });
    await page.click('#expReset');
    await expect(page.locator('#expStatus')).toContainText('Move a slider');
  });

  test('money: every page has its inputs, a prediction and a table, and accounts add up', async ({ page }) => {
    for (const [sub, box] of [['assumptions', '#mpAssumptions'], ['income', '#mpIncome'], ['spending', '#mpSpending'], ['cashflow', '#mpTax'], ['portfolio', '#mpPortfolio']]) {
      await go(page, `finances/${sub}`);
      await asTable(page.locator(box));
      await expect(page.locator(`${box} .chart-table tbody tr`).first()).toBeVisible();
      await expect(page.locator(`${box} .explain`)).toBeVisible();
      await expect(page.locator('#asOfBar')).toContainText('Your figures are as at');
    }
    await expect(page.locator('#cfChart canvas')).toBeHidden();
    const chips = page.locator('#mpPortfolio .chips .chip');
    const n = await chips.count();
    for (let i = 0; i < n; i++) {
      await page.locator('#mpPortfolio .chips .chip').nth(i).click();
      await asTable(page.locator('#mpPortfolio'));
      const checks = await page.locator('#mpPortfolio .chart-table tbody tr td:last-child').allInnerTexts();
      expect(checks.every(c => c === '✓'), `${i}: ${checks.find(c => c !== '✓')}`).toBe(true);
    }
  });

  test('workings: tax table can be downloaded as CSV', async ({ page }, info) => {
    await go(page, 'finances/cashflow');
    await asTable(page.locator('#mpTax'));
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#mpTax .chart-tools button:has-text("CSV")')]);
    const file = info.outputPath('tax.csv');
    await download.saveAs(file);
    const text = fs.readFileSync(file, 'utf8');
    expect(text.split('\n')[0]).toContain('Taxable income');
    expect(text.split('\n').length).toBeGreaterThan(20);
  });

  test('income cards show a typical trend', async ({ page }) => {
    await go(page, 'finances/income');
    const item = page.locator('#sec-income .item').first();
    await item.locator('.trend summary').click();
    await expect(item.locator('.trend canvas')).toBeVisible();
    await expect(item.locator('.trend-caption')).toContainText('8 in 10 simulations');
  });

  test('Monte Carlo shows everything else that varies', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await expect(page.locator('#mcFans .fan')).toHaveCount(3);
    await expect(page.locator('#mcFans')).toContainText('Inflation each year');
    await expect(page.locator('#mcFans')).toContainText('Property values');
  });

  test('switching off variation changes the simulation', async ({ page }) => {
    const before = await page.evaluate(() => window.__horizon.model.mc.inflation.p90[10]);
    await go(page, 'finances/assumptions');
    await page.locator('#sec-market summary:has-text("What else varies")').click();
    await page.locator('#sec-market .vary').first().locator('input[role="switch"]').uncheck();
    await settle(page);
    const after = await page.evaluate(() => window.__horizon.model.mc.inflation.p90[10]);
    expect(after).toBeLessThan(before);
    expect(after).toBeCloseTo(0.025, 6);
  });

  test('household tax switch removes UK tax but keeps flat rates', async ({ page }) => {
    const before = await page.evaluate(() => window.__horizon.model.proj.rows[0].taxes);
    await go(page, 'finances/assumptions');
    await page.locator('#sec-household input[role="switch"]').first().uncheck();
    await settle(page);
    const r0 = await page.evaluate(() => window.__horizon.model.proj.rows[0]);
    expect(r0.taxes).toBeLessThan(before);
    expect(r0.taxes).toBeCloseTo(r0.flatTax, 2);
    await expect(page.locator('#sec-tax')).toContainText('switched off');
    await expect(page.locator('#sec-household')).not.toContainText('Tax rules');
  });

  test('rent with currency, costs and a flat tax is worked out like a formula', async ({ page }) => {
    await go(page, 'finances/income');
    const rent = page.locator('#sec-income .item').nth(2); // Rental flat
    await rent.locator('input[aria-label="Amount"]').fill('1148');
    await rent.locator('input[aria-label="Exchange rate"]').fill('0.84');
    await settle(page);
    const item = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.income.find(i => i.kind === 'rental'));
    const expected = 1148 * 0.84 * (1 - item.costPct / 100) * (1 - item.taxRate / 100);
    await expect(page.locator('#sec-income .item').nth(2).locator('.hint.calc')).toContainText(`£${Math.round(expected).toLocaleString('en-GB')} a month`);
  });

  test('an account can be left out of the plan', async ({ page }) => {
    const before = await page.evaluate(() => window.__horizon.model.proj.rows[0].netWorth);
    await go(page, 'finances/portfolio');
    const home = page.locator('#sec-accounts .item').nth(7); // Home
    await home.locator('details.more summary').click();
    await home.locator('input[role="switch"]').uncheck();
    await settle(page);
    const after = await page.evaluate(() => window.__horizon.model.proj.rows[0].netWorth);
    expect(before - after).toBe(320000);
    await expect(page.locator('#sec-accounts .item').nth(7).locator('.tag:not(.est)')).toHaveText('Not counted');
  });

  test('own return assumptions for investments and pensions', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await page.locator('#sec-market summary:has-text("Use your own return")').click();
    await page.locator('#sec-market input[aria-label="Investment return"]').fill('10');
    await page.locator('#sec-market input[aria-label="Pension return"]').fill('7');
    await settle(page);
    const r = await page.evaluate(() => { const rows = window.__horizon.model.proj.rows; return { g: rows[0].gIsa, isa: rows[0].isa, gp: rows[0].gPension, pen: rows[0].pension }; });
    expect(r.g / r.isa).toBeCloseTo(0.10, 6);
    expect(r.gp / r.pen).toBeCloseTo(0.07, 6);
    await page.locator('#sec-market input[aria-label="Investment return"]').fill('');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.assumptions.investReturn)).toBeNull();
  });

  test('details stay tucked away until asked for', async ({ page }) => {
    await go(page, 'finances/income');
    const salary = page.locator('#sec-income .item').first();
    await expect(salary.locator('text=Workplace pension')).toBeHidden();
    await salary.locator('details.more summary').click();
    await expect(salary.locator('text=Workplace pension')).toBeVisible();
    await salary.locator('input[aria-label="Amount"]').fill('70000');
    await settle(page);
    await expect(page.locator('#sec-income .item').first().locator('text=Workplace pension')).toBeVisible();
  });

  test('life check-up: children, cars, home, retirement and care', async ({ page }) => {
    const before = await page.evaluate(() => window.__horizon.model.mc.successRate);
    await tab(page, 'home');
    await page.click('#lifeBtn');
    await expect(page.locator('#lifeWiz')).toBeVisible();
    await page.locator('#lwBody input[aria-label="Number of children"]').fill('2');
    await page.locator('#lwBody input[aria-label="Child 1 age"]').fill('7');
    await page.locator('#lwBody input[aria-label="Child 2 age"]').fill('4');
    await expect(page.locator('#lwTotal')).toContainText('over your lifetime');
    for (let i = 0; i < 3; i++) await page.click('#lwNext');
    await page.locator('#lwBody input[aria-label="Extra travel & hobbies (a year)"]').fill('6000');
    await page.click('#lwNext');
    await page.locator('#lwBody input[aria-label="Possible care costs from age"]').fill('85');
    await page.click('#lwNext');
    await expect(page.locator('#lwTitle')).toHaveText('Review');
    await expect(page.locator('#lwBody')).toContainText('Child 1: university support');
    await expect(page.locator('#lwBody')).toContainText('Care in later life');
    await page.click('#lwNext');
    await expect(page.locator('#lifeWiz')).toBeHidden();
    await settle(page);
    const plan = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(plan.expenses.filter(e => e.key.startsWith('life:')).length).toBeGreaterThan(4);
    expect(plan.life.children).toHaveLength(2);
    const after = await page.evaluate(() => window.__horizon.model.mc.successRate);
    expect(after).toBeLessThan(before);
    // Re-opening remembers the answers
    await tab(page, 'home');
    await page.click('#lifeBtn');
    await expect(page.locator('#lwBody input[aria-label="Child 2 age"]')).toHaveValue('4');
  });

  test('defined benefit pension card works it out', async ({ page }) => {
    await go(page, 'finances/income');
    await page.click('#sec-income button:has-text("+ Defined benefit pension")');
    const db = page.locator('#sec-income .item').last();
    await db.locator('input[aria-label="Pension built up so far"]').fill('5000');
    await db.locator('input[aria-label="Pension added each year"]').fill('600');
    await settle(page);
    await go(page, 'finances/income');
    await expect(page.locator('#sec-income .item').last().locator('.hint.calc')).toContainText('£5,000 + £600 ×');
    const inc = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.income.at(-1));
    expect(inc.kind).toBe('dbpension');
    expect(inc.startRef).toBe('age');
    expect(inc.tax).toBe('uk');
  });

  test('new goal types: saving for something and passive income', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Save for something")');
    await page.locator('#gwBody input[aria-label="Goal amount"]').fill('40k');
    await expect(page.locator('#gwPreview')).toContainText('£40K saved by', { timeout: 15000 });
    await page.click('#gwNext');
    await page.click('#gwNext');
    await page.click('#gwBody button:has-text("Save goal")');
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Passive income")');
    await expect(page.locator('#gwPreview')).toContainText('a year passive income by', { timeout: 15000 });
    await page.click('#gwNext');
    await expect(page.locator('#gwImpact')).toContainText('passive income', { timeout: 15000 });
    await page.click('#gwNext');
    await page.click('#gwBody button:has-text("Save goal")');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('passive income');
    await expect(page.locator('#goalPage canvas').first()).toBeVisible();
    await page.click('#gpTake button:has-text("Work it out")');
    await expect(page.locator('#gpTake .goal-solve')).not.toBeEmpty({ timeout: 20000 });
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(5);
  });

  test('spare cash setting is in the saving strategy', async ({ page }) => {
    await go(page, 'finances/assumptions');
    const sw = page.locator('#sec-strategy label.switch:has-text("Invest cash above the buffer") input');
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.sweepCash)).toBe(false);
  });

  test('Monte Carlo controls change the simulation', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await page.selectOption('#runsSelect', '500');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.model.mc.runs)).toBe(500);
    const before = await page.evaluate(() => window.__horizon.model.mc.bands.p50.join());
    await page.click('#rerollBtn');
    await settle(page);
    const after = await page.evaluate(() => window.__horizon.model.mc.bands.p50.join());
    expect(after).not.toBe(before);
  });

  test('mortgage overpayment sweep compares five variants', async ({ page }) => {
    await tab(page, 'scenarios');
    await page.selectOption('#sweepLever', 'overpay');
    await page.click('#sweepRun');
    await expect(page.locator('#sweepResults tbody tr')).toHaveCount(5, { timeout: 30000 });
    await expect(page.locator('#sweepResults')).toContainText('100% overpay');
    await page.locator('#sweepResults button:has-text("Save as scenario")').nth(2).click();
    await expect(page.locator('#scenarioSelect option')).toHaveCount(2);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan.strategy.overpayPct)).toBe(50);
  });

  test('duplicate a scenario, edit it and compare', async ({ page }) => {
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await expect(page.locator('#scenarioSelect option')).toHaveCount(2);
    await expect(page.locator('#view-scenarios')).toBeVisible();
    await page.locator('#sec-scenario input').fill('Retire later');
    await go(page, 'finances/assumptions');
    await page.locator('#sec-household .item').first().locator('input').nth(2).fill('60');
    await settle(page);
    await tab(page, 'scenarios');
    await expect(page.locator('#compareResults tbody tr')).toHaveCount(2, { timeout: 30000 });
    await expect(page.locator('#compareResults')).toContainText('Retire later');
    await page.selectOption('#scenarioSelect', { index: 0 });
    await expect(page.locator('#scenarioSelect')).toHaveValue(await page.evaluate(() => window.__horizon.ws.scenarios[0].id));
  });

  test('yearly review: update numbers, compare with last year and roll every scenario forward', async ({ page }) => {
    await go(page, 'finances/history');
    await expect(page.locator('#view-finances')).toContainText('No check-ins yet');
    await page.click('#checkinBtn');
    await expect(page.locator('#progTable tbody tr')).toHaveCount(1);
    // The yearly review is offered by the notification bell too.
    await page.click('#notifyBtn');
    await expect(page.locator('#notifyPop')).toBeVisible();
    await page.click('#notifyBtn');
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await go(page, 'finances/history');
    const { year, asOf } = await page.evaluate(() => ({ year: window.__horizon.ws.scenarios[0].plan.startYear, asOf: window.__horizon.ws.scenarios[0].plan.asOf }));
    const nextDate = `${year + 1}${asOf.slice(4)}`;
    await page.click('#reviewBtn');
    await expect(page.locator('#reviewWiz')).toBeVisible();
    await page.click(`#rvBody .goal-option:has-text("Start ${year + 1}")`);
    await expect(page.locator('#rvStep')).toContainText(`Yearly review ${year + 1}`);
    await page.click('#rvNext');
    // Balances as at a year after the figures: each one starts as the plan's estimate.
    const dateIn = page.locator('#rvBody input[aria-label="Balances as at"]');
    await expect(dateIn).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
    await dateIn.fill(nextDate);
    await expect(page.locator('#rvBody input[aria-label="Balances as at"]')).toHaveValue(nextDate);
    // One account comes in £10k above the estimate
    const row = page.locator('#rvBody .rv-row').nth(1);
    const input = row.locator('input');
    const was = Number((await input.inputValue()).replace(/,/g, ''));
    await input.fill(String(was + 10000));
    await expect(row.locator('.rv-diff')).toContainText('+£10,000');
    await expect(page.locator('#rvBody .rv-progress')).toContainText('1 of');
    await page.click('#rvBody button:has-text("Keep the rest as they are")');
    await expect(page.locator('#rvBody .rv-progress')).toContainText('updated');
    await page.click('#rvNext'); // income
    await expect(page.locator('#rvBody .rv-row').first()).toBeVisible();
    await page.click('#rvNext'); // spending
    await page.click('#rvNext'); // markets
    await expect(page.locator('#rvBody .rv-market')).toHaveCount(3);
    await page.click('#rvNext'); // results
    await expect(page.locator('#rvBody .rv-delta')).toContainText('+£10,000');
    await expect(page.locator('#rvBody .divbar')).not.toHaveCount(0);
    await expect(page.locator('#rvBody .impact table')).toBeVisible({ timeout: 30000 });
    await page.click('#rvNext'); // update scenarios
    await expect(page.locator('#rvBody .rv-scen')).toHaveCount(2);
    await page.click('#rvSave');
    await expect(page.locator('#reviewWiz')).toBeHidden({ timeout: 30000 });
    await expect(page.locator('#toast')).toContainText('review saved');
    const years = await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.plan.startYear));
    expect(years).toEqual([year + 1, year + 1]);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.plan.asOf))).toEqual([nextDate, nextDate]);
    await page.click('#progList summary');
    await expect(page.locator('#progTable tbody tr')).toHaveCount(2);
    await expect(page.locator('#progTable tbody tr').first()).toContainText(String(year + 1));
    await expect(page.locator('#progTable tbody tr').first().locator('td').nth(4)).toContainText('+£10,000');
    await expect(page.locator('#progReview')).toContainText('What made the difference');
    await expect(page.locator('#progReview')).toContainText('Goals then and now');
  });

  test('every chart can switch to a table of its numbers', async ({ page }) => {
    const host = page.locator('#ovChart');
    await host.locator('.chart-tools button:has-text("Table")').click();
    await expect(host.locator('canvas')).toBeHidden();
    await expect(host.locator('.chart-table table')).toBeVisible();
    await expect(host.locator('.chart-table thead')).toContainText('Net worth');
    const rows = await host.locator('.chart-table tbody tr').count();
    expect(rows).toBeGreaterThan(20);
    await host.locator('.chart-tools button:has-text("Chart")').click();
    await expect(host.locator('canvas')).toBeVisible();
  });

  test('legend items hide and show a series', async ({ page }) => {
    const item = page.locator('#ovLegend .legend-item').first();
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'false');
    await item.click();
    await expect(item).toHaveAttribute('aria-pressed', 'true');
  });

  test('spending check-up shows typical UK ranges and the 50/30/20 picture', async ({ page }) => {
    await go(page, 'finances/spending');
    await page.click('#sec-expenses button:has-text("Spending check-up")');
    await expect(page.locator('#wizBody .wiz-guide').first()).toContainText('Typical');
    const q = page.locator('#wizBody .wiz-q').filter({ hasText: 'Gas & electricity' });
    await q.locator('input').fill('900');
    await expect(q.locator('.guide-pos')).toHaveText('Above typical');
    for (let i = 0; i < 7; i++) await page.click('#wizNext');
    await expect(page.locator('#wizCompare')).toContainText('50/30/20');
    await expect(page.locator('#wizCompare .split-bar').first()).toBeVisible();
  });

  test('retirement questionnaire: ages, PLSA spending, early years and State Pension', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Plan your retirement")');
    await expect(page.locator('#gwBody .rq-sec')).toHaveCount(6);
    await page.locator('#gwBody input[aria-label="Alex retirement age"]').fill('58');
    await page.click('#gwBody .spend-option:has-text("Moderate")');
    await expect(page.locator('#gwBody .spend-option:has-text("Moderate")')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#gwBody input[aria-label="Extra travel a year"]').fill('5000');
    await expect(page.locator('#rqPreview .goal-pct')).toContainText('%', { timeout: 15000 });
    await expect(page.locator('#rqPreview canvas')).toBeVisible();
    await page.click('#rqPreview button:has-text("Earliest age")');
    await expect(page.locator('#rqPreview .rq-answers')).toContainText('could spend', { timeout: 30000 });
    await page.click('#gwNext');
    await expect(page.locator('#gwBody .lever').first()).toBeVisible();
    await page.click('#gwNext');
    await expect(page.locator('#gwBody')).toContainText('Saving also updates your plan');
    await expect(page.locator('#gwBody')).toContainText('Alex retires at 58');
    await page.click('#gwBody button:has-text("Save goal")');
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.household.people[0].retireAge).toBe(58);
    expect(p.strategy.retireSpending).toBe(43900);
    expect(p.expenses.find(e => e.key === 'life:travel').amount).toBe(5000);
    expect(p.goals.some(g => g.type === 'retire' && g.age === 58)).toBe(true);
  });

  test('emergency fund goal sets the cash buffer', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Emergency fund")');
    await expect(page.locator('#gwBody .ef-facts')).toContainText('6 months needs');
    await page.locator('#gwBody select[aria-label="What counts"]').selectOption('investments');
    await expect(page.locator('#gwBody .ef-facts')).toContainText('Cash and investments today');
    await page.locator('#gwBody select[aria-label="What counts"]').selectOption('cash');
    await expect(page.locator('#gwPreview .goal-pct')).toBeVisible({ timeout: 15000 });
    await page.click('#gwNext');
    await page.click('#gwNext');
    await expect(page.locator('#gwBody')).toContainText('Cash buffer');
    await page.click('#gwBody button:has-text("Save goal")');
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.goals.some(g => g.type === 'emergency' && g.months === 6)).toBe(true);
    expect(p.strategy.cashReserve).toBeGreaterThan(15000);
    await expect(page.locator('#goalPage .goal-hero')).toContainText('Emergency fund: 6 months');
    await expect(page.locator('#goalPage')).toContainText('Needed');
  });

  test('plan check items can be marked as sorted and shown again', async ({ page }) => {
    const first = page.locator('#ovInsights .insight').first();
    const title = await first.locator('strong').innerText();
    await first.locator('button:has-text("Already sorted")').click();
    await expect(page.locator('#ovInsights .insights').first()).not.toContainText(title);
    await page.click('#ovInsights button:has-text("marked as sorted")');
    await page.locator('#ovInsights .insight.sorted button:has-text("Show again")').click();
    await expect(page.locator('#ovInsights .insights').first()).toContainText(title);
    expect(await page.evaluate(() => window.__horizon.ws.dismissed)).toEqual([]);
  });

  test('mortgage: rate after the fix and keeping the end date', async ({ page }) => {
    await go(page, 'finances/portfolio');
    const item = page.locator('#sec-accounts .item').filter({ has: page.locator('.item-head .tag', { hasText: /^Mortgage or loan$/ }) });
    await item.locator('details.more summary').click();
    await item.locator('input[aria-label="Rate after the fix ends"]').fill('6');
    await item.locator('select[aria-label="When the fix ends"]').selectOption('term');
    await settle(page);
    const d = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.accounts.find(a => a.type === 'debt'));
    expect(d.rateAfterFix).toBe(6);
    expect(d.afterFix).toBe('term');
    const rows = await page.evaluate(() => window.__horizon.model.proj.rows.map(r => r.debtRegular));
    const fixedEnd = d.fixedUntil - (await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.startYear));
    expect(rows[fixedEnd + 1]).toBeGreaterThan(rows[fixedEnd] * 1.05);
  });

  test('defined benefit pension can be estimated from the year joined', async ({ page }) => {
    await go(page, 'finances/income');
    await page.click('#sec-income button:has-text("+ Defined benefit pension")');
    const db = page.locator('#sec-income .item').last();
    await db.locator('summary:has-text("Estimate it")').click();
    await db.locator('input[aria-label="Year joined"]').fill('2016');
    await db.locator('input[aria-label="Salary for the estimate"]').fill('45000');
    await settle(page);
    await expect(db.locator('[data-dbest]')).toContainText('years so far');
    await db.locator('button:has-text("Use this estimate")').click();
    await settle(page);
    const it = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.income.find(i => i.kind === 'dbpension'));
    expect(it.dbAccrual).toBe(600);
    expect(it.amount).toBeGreaterThan(5000);
    expect(it.lumpMultiple).toBe(3);
    expect(it.startAge).toBe(65);
  });

  test('goals: own colours and badges on the home page, and what moves them', async ({ page }) => {
    const tiles = page.locator('#ovGoalStrip .goal-tile:not(.add)');
    await expect(tiles).toHaveCount(3);
    const colours = await tiles.evaluateAll(els => els.map(e => getComputedStyle(e).getPropertyValue('--gc').trim()));
    expect(new Set(colours).size).toBe(3);
    await expect(tiles.first().locator('.goal-badge')).toBeVisible();
    // Drivers arrive in the background.
    await expect(tiles.first().locator('.gt-driver')).not.toHaveClass(/muted/, { timeout: 30000 });
    await tiles.first().click();
    await expect(page.locator('#goalPage')).toBeVisible();
    await expect(page.locator('#gpMoves .divbar').first()).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#gpMoves')).toContainText('Retire 2 years later');
    await tab(page, 'scenarios');
    await expect(page.locator('#driversBody table.heat')).toBeVisible({ timeout: 30000 });
    await expect(page.locator('#driversBody table.heat tbody tr')).not.toHaveCount(0);
    await expect(page.locator('#driversBody')).toContainText('Retire 2 years later');
    await page.locator('#driversBody .chart-tools button:has-text("Table")').click();
    await expect(page.locator('#driversBody .table-wrap table')).toBeVisible();
  });

  test('add a named goal from a preset, with its own colour, then remove it', async ({ page }) => {
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("House deposit")');
    await expect(page.locator('#gwBody input[aria-label="Goal name"]')).toHaveValue('House deposit');
    await page.locator('#gwBody .swatch').nth(5).click();
    await page.click('#gwNext');
    await page.click('#gwNext');
    await page.click('#gwBody button:has-text("Save goal")');
    const g = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.goals.find(x => x.name === 'House deposit'));
    expect(g.color).toBe(5);
    expect(g.icon).toBe('home');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('House deposit');
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip')).toContainText('House deposit');
    await page.locator('#ovGoalStrip .goal-tile', { hasText: 'House deposit' }).click();
    page.removeAllListeners('dialog');
    page.on('dialog', d => d.accept());
    await page.locator('[aria-label="Remove goal House deposit"]').click();
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip')).not.toContainText('House deposit');
  });

  test('scenario ideas add ready-made scenarios', async ({ page }) => {
    await tab(page, 'scenarios');
    await expect(page.locator('#ideaGrid .idea')).not.toHaveCount(0);
    await page.locator('#ideaGrid .idea[data-idea="crash"] button').click();
    await expect(page.locator('#ideaGrid .idea[data-idea="crash"] button')).toHaveText('Added');
    const s = await page.evaluate(() => window.__horizon.ws.scenarios.map(x => ({ name: x.name, crash: x.plan.assumptions.crashYear })));
    expect(s).toHaveLength(2);
    expect(s[1].name).toContain('Market crash');
    expect(s[1].crash).toBeGreaterThan(0);
    await expect(page.locator('#compareResults tbody tr')).toHaveCount(2, { timeout: 30000 });
  });

  test('start a blank plan', async ({ page }) => {
    await page.click('#dataMenu summary');
    await page.click('#blankBtn');
    await expect(page.locator('#view-finances')).toBeVisible();
    await expect(page.locator('#sec-household')).toBeVisible();
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.accounts).toHaveLength(0);
    expect(p.goals).toHaveLength(0);
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip')).toContainText('No goals yet');
  });

  test('replaying history: every starting year since 1928', async ({ page }) => {
    await openGoal(page, 'retires at');
    await expect(page.locator('#histTiles .tile')).toHaveCount(4, { timeout: 15000 });
    await expect(page.locator('#histTiles')).toContainText('of 98');
    const starts = page.locator('#histCard .chart').first();
    await expect(starts.locator('canvas')).toBeVisible();
    await expect(page.locator('#histCard')).toContainText('From 1929');
    await asTable(starts);
    await expect(starts.locator('.chart-table tbody tr')).toHaveCount(98);
    await expect(starts.locator('.chart-table')).toContainText('Wall Street Crash');
    await expect(page.locator('#histGoals tbody tr')).toHaveCount(3);
  });

  test('a Lifetime ISA gets its bonus and shows in the plan', async ({ page }) => {
    await go(page, 'finances/portfolio');
    await page.click('#sec-accounts button:has-text("+ Lifetime ISA")');
    await settle(page);
    const row = await page.evaluate(() => window.__horizon.model.proj.rows[0]);
    expect(row.toLisa).toBe(4000);
    expect(row.lisaBonus).toBe(1000);
    const item = page.locator('#sec-accounts .item').last();
    await expect(item).toContainText('Pay in each year');
    await item.locator('details.more summary').click();
    await item.locator('select').filter({ hasText: 'A first home' }).selectOption('home');
    await expect(item.locator('input[aria-label="First home year"]')).toBeVisible();
    await tab(page, 'home');
    await expect(page.locator('#homeYear')).toContainText('Lifetime ISAs');
  });

  test('higher-rate relief on extra pension saving can be switched off', async ({ page }) => {
    await page.evaluate(() => { window.__horizon.ws.scenarios[0].plan.household.people[0].extraPension = 200; window.__horizon.refresh(); });
    const on = await page.evaluate(() => window.__horizon.model.proj.rows[0].pensionRelief);
    expect(on).toBeGreaterThan(0);
    await go(page, 'finances/assumptions');
    await page.locator('#sec-strategy label.switch:has-text("Claim higher-rate relief") input').uncheck();
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.model.proj.rows[0].pensionRelief)).toBe(0);
  });

  test('backfill a past year by hand', async ({ page }) => {
    await go(page, 'finances/history');
    await page.click('text=Add a past year by hand');
    await page.fill('#manualCheckin input[name="year"]', '2024');
    await page.fill('#manualCheckin input[name="netWorth"]', '210k');
    await page.fill('#manualCheckin input[name="predicted"]', '250k');
    await page.click('#manualCheckin button[type="submit"]');
    await page.fill('#manualCheckin input[name="year"]', '2025');
    await page.fill('#manualCheckin input[name="netWorth"]', '240k');
    await page.click('#manualCheckin button[type="submit"]');
    await page.click('#progList summary');
    await expect(page.locator('#progTable tbody tr')).toHaveCount(2);
    await expect(page.locator('#progTable tbody tr').first()).toContainText('−£10,000');
  });

  test('plan persists across reloads', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await page.locator('#sec-household .item').first().locator('input.name').fill('Jordan');
    await settle(page);
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.household.people[0].name)).toBe('Jordan');
  });

  test('export and import round-trip', async ({ page }, info) => {
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await page.click('#dataMenu summary');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
    const file = info.outputPath('plan.json');
    await download.saveAs(file);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(data.scenarios).toHaveLength(2);
    expect(Object.keys(data.settings).sort()).toEqual(['confidence', 'lastSaved', 'realDollars', 'runs', 'seed', 'theme']);
    expect(data.settings.lastSaved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await tab(page, 'home');
    await expect(page.locator('#homeYear')).not.toContainText('Not yet');
    expect(data.scenarios[0].plan.goals.length).toBeGreaterThan(0);

    await page.click('#dataMenu summary');
    await page.click('#resetBtn');
    await expect(page.locator('#scenarioSelect option')).toHaveCount(1);

    await page.setInputFiles('#importFile', file);
    await expect(page.locator('#scenarioSelect option')).toHaveCount(2);
    const back = await page.evaluate(() => JSON.parse(JSON.stringify(window.__horizon.ws)));
    expect(back).toEqual(data);
  });

  test('settings, check-ins and goals all round-trip through a file', async ({ page }, info) => {
    await page.locator('#view-home [data-inflation] input').uncheck();
    await page.click('#themeBtn');
    await go(page, 'finances/history');
    await page.click('#checkinBtn');
    await go(page, 'finances/assumptions');
    await page.selectOption('#runsSelect', '2000');
    await settle(page);
    await page.click('#dataMenu summary');
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#exportBtn')]);
    const file = info.outputPath('all.json');
    await download.saveAs(file);
    const saved = await page.evaluate(() => JSON.parse(JSON.stringify(window.__horizon.ws)));
    await page.click('#dataMenu summary');
    await page.click('#resetBtn');
    await page.setInputFiles('#importFile', file);
    await settle(page);
    const back = await page.evaluate(() => JSON.parse(JSON.stringify(window.__horizon.ws)));
    expect(back).toEqual(saved);
    expect(back.settings).toMatchObject({ realDollars: false, theme: 'dark', runs: 2000 });
    expect(back.checkins).toHaveLength(1);
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });

  test('the bundled example file imports', async ({ page }) => {
    const file = require('path').resolve(__dirname, '../../plans/example.json');
    await page.setInputFiles('#importFile', file);
    await settle(page);
    await expect(page.locator('#homePortfolio .pf-row').nth(8)).toContainText('£320,000');
  });

  test('importing a broken file shows an error and keeps the plan', async ({ page }, info) => {
    const file = info.outputPath('bad.json');
    fs.writeFileSync(file, '{"hello": "world"}');
    const messages = [];
    page.removeAllListeners('dialog');
    page.on('dialog', d => { messages.push(d.message()); d.accept(); });
    await page.setInputFiles('#importFile', file);
    await expect.poll(() => messages.length).toBe(1);
    expect(messages[0]).toContain('Could not open');
    await expect(page.locator('#homePortfolio .pf-row').nth(8)).toContainText('£320,000');
  });

  test('the inflation switch changes future amounts but not today', async ({ page }) => {
    const host = page.locator('#ovChart');
    await asTable(host);
    const lastRow = () => host.locator('.chart-table tbody tr').last().innerText();
    const firstRow = () => host.locator('.chart-table tbody tr').first().innerText();
    const real = await lastRow();
    const today = await firstRow();
    const sw = page.locator('#view-home [data-inflation] input');
    await expect(sw).toBeChecked();
    await sw.uncheck();
    await expect.poll(lastRow).not.toBe(real);
    expect(await firstRow()).toBe(today);
    expect(await page.evaluate(() => window.__horizon.ws.settings.realDollars)).toBe(false);
  });

  test('white by default; the theme button cycles dark and automatic', async ({ page }) => {
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe('rgb(13, 13, 13)');
    await page.click('#themeBtn');
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).toBe('rgb(13, 13, 13)');
  });

  test('market data card applies suggested assumptions', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await expect(page.locator('#sec-market')).toContainText('Bank Rate');
    await page.click('#sec-market button:has-text("Use suggested values")');
    await settle(page);
    const a = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.assumptions);
    const m = await page.evaluate(() => window.MARKET_DATA.suggested);
    expect(a.inflation).toBe(m.inflation.value);
    expect(a.bondReturn).toBe(m.bondReturn.value);
  });

  test('switching to England changes the tax table', async ({ page }) => {
    await go(page, 'finances/assumptions');
    await expect(page.locator('#sec-tax')).toContainText('Intermediate');
    await page.locator('#sec-household select').first().selectOption('ruk');
    await expect(page.locator('#sec-tax')).not.toContainText('Intermediate');
    await expect(page.locator('#sec-tax')).toContainText('Additional');
  });
});

test.describe('mobile layout', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('no horizontal scrolling on any tab', async ({ page }) => {
    const tracker = await openApp(page);
    const goal = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.goals[0].id);
    for (const name of ['home', `goal/${goal}`, 'finances/portfolio', 'finances/income', 'finances/spending', 'finances/cashflow', 'finances/assumptions', 'finances/history', 'scenarios']) {
      await go(page, name);
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
    }
    expect(tracker.problems).toEqual([]);
  });
});
