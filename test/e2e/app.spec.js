// @ts-check
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const { openApp, tab, go, openGoal, asTable, settle, editAll, openGroups } = require('./helpers');

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
    // Four groups, folded at first; opened they show every account.
    await expect(page.locator('#homePortfolio .pf-row.access')).toHaveCount(4);
    await expect(page.locator('#homePortfolio [data-account]')).toHaveCount(0);
    await openGroups(page);
    await expect(page.locator('#homePortfolio [data-account]')).toHaveCount(9);
    await expect(page.locator('#homePortfolio .pf-row.single')).toHaveCount(5);   // types with one account are one row
    await expect(page.locator('#homePortfolio .pf-row.group')).toHaveCount(7);
    await openGroups(page);
    await expect(page.locator('#homePortfolio .pf-row.single', { hasText: 'Property' })).toContainText('£320,000');
    await expect(page.locator('#homePortfolio .pf-row.head')).toContainText('Today (estimated)');
    // No duplicate key, and no "Estimated" tag on every row.
    await expect(page.locator('#homePortfolio .pf-keys')).toHaveCount(0);
    await expect(page.locator('#homePortfolio .src')).toHaveCount(0);
    await expect(page.locator('#homePortfolio')).toContainText('Estimated net worth today');
    // A donut, and the accounts grouped by when the money can be used.
    await expect(page.locator('#homePortfolio .pf-donut circle')).toHaveCount(6);
    await expect(page.locator('#homePortfolio .pf-donut')).toContainText('What you own');
    // Net worth is worked out beside it, so the figures add up.
    await expect(page.locator('#pfSum')).toContainText('What you own');
    await expect(page.locator('#pfSum')).toContainText('What you owe');
    await expect(page.locator('#pfSum .total')).toContainText(await page.locator('#homePortfolio .hero-value').innerText());
    // Hover a slice: the centre gives its details and its row lights up; leave and it resets.
    // Move the mouse onto the middle of the property slice.
    const at = await page.locator('#homePortfolio .pf-donut .arc[data-type="property"]').evaluate(c => {
      const svg = c.ownerSVGElement, r = +c.getAttribute('r'), C = 2 * Math.PI * r;
      const len = parseFloat(c.getAttribute('stroke-dasharray')), off = -parseFloat(c.getAttribute('stroke-dashoffset'));
      const a = ((off + len / 2) / C) * 2 * Math.PI - Math.PI / 2;
      const box = svg.getBoundingClientRect(), k = box.width / 140;
      return { x: box.left + (70 + r * Math.cos(a)) * k, y: box.top + (70 + r * Math.sin(a)) * k };
    });
    await page.mouse.move(at.x, at.y);
    await expect(page.locator('#homePortfolio .pf-donut-centre')).toContainText('% of what you own');
    await expect(page.locator('#homePortfolio .pf-row.hl[data-type="property"]')).toHaveCount(1);   // groups are open here
    await page.locator('#homePortfolio .hero-value').hover();
    await expect(page.locator('#homePortfolio .pf-donut-centre')).toContainText('What you own');
    await expect(page.locator('#homePortfolio .pf-row.hl')).toHaveCount(0);
    // Clicking the ISAs slice opens its accounts.
    await page.locator('#homePortfolio .pf-donut .arc[data-type="isa"]').focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#homePortfolio .pf-row.acct').first()).toBeVisible();
    await page.locator('#homePortfolio .pf-donut .arc[data-type="isa"]').focus();
    await page.keyboard.press('Enter');
    // A homeowner's Lifetime ISA is for retirement only.
    await expect(page.locator('#homePortfolio .pf-row.access.locked')).not.toContainText('first home');
    await expect(page.locator('#homePortfolio .pf-row.access')).toHaveCount(4);
    await expect(page.locator('#homePortfolio .pf-row.access.now')).toContainText('% of what you own');
    await expect(page.locator('#homePortfolio .pf-row.access.locked')).toContainText('Pensions from 57');
    await expect(page.locator('#homePortfolio .pf-row.access.property')).toContainText('selling');
    await expect(page.locator('#homePortfolio')).toContainText('from your figures as at');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(3);
    await expect(page.locator('#ovGoalStrip .goal-tile').first()).toContainText('%');
    // Each goal says what to do this year; there is no separate "This year" card.
    await expect(page.locator('#homeYear')).toHaveCount(0);
    await expect(page.locator('#ovGoalStrip .goal-tile', { hasText: '£1M by' }).locator('.gt-action')).toContainText('Invest £1,034 a month');
    await expect(page.locator('#ovGoalStrip .goal-tile', { hasText: 'Mortgage-free' }).locator('.gt-action')).toContainText('Mortgage payments');
    await expect(page.locator('#ovInsights .sg-card').first()).toBeVisible();
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
    await expect(page.locator('#homePortfolio .pf-row.head')).toContainText('Today (estimated)');
    const nw = await page.evaluate(() => window.__horizon.model.est.netWorth);
    expect(nw).toBeGreaterThan(275000);
    expect(asOf).toMatch(/^\d{4}-/);
    // Update one balance from a banking app.
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await tab(page, 'home');
    await expect(page.locator('#homePortfolio #updateBtn, #homePortfolio button:has-text("Edit accounts")')).toHaveCount(0);   // those live in Finances now
    await go(page, 'finances/portfolio');
    await page.click('#updateBtn');
    await expect(page.locator('#updateDlg')).toBeVisible();
    await expect(page.locator('#udSave')).toBeDisabled();
    const input = page.locator('#udBody .rv-row').nth(1).locator('input');
    await input.fill('30000');
    await expect(page.locator('#udBody .rv-row').nth(1).locator('.rv-diff')).toContainText('vs estimate');
    await page.click('#udSave');
    await expect(page.locator('#updateDlg')).toBeHidden();
    await tab(page, 'home');
    // Accounts are folded under their type; the header says one was updated.
    await openGroups(page);
    await expect(page.locator('#homePortfolio .pf-row.acct').first()).toBeHidden();
    await expect(page.locator('#homePortfolio .pf-row.group', { hasText: 'ISAs' })).toContainText('1 updated');
    await page.locator('#homePortfolio .pf-row.group', { hasText: 'ISAs' }).locator('.pf-toggle').click();
    await expect(page.locator('#homePortfolio .pf-row.acct').nth(0)).toBeVisible();
    await expect(page.locator('#homePortfolio .pf-row.acct').nth(0)).toContainText('Updated today');
    await expect(page.locator('#homePortfolio .pf-row.acct').nth(0)).toContainText('£30,000');
    await expect(page.locator('#homePortfolio .src.updated')).toHaveCount(2);   // the ISAs header and the account
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

  test('the bell offers an update once the figures are a month old', async ({ page }) => {
    await page.evaluate(() => {
      const d = new Date(); d.setDate(d.getDate() - 45);
      const iso = window.Engine.todayISO(d);
      for (const s of window.__horizon.ws.scenarios) s.plan.asOf = iso;
      window.__horizon.refresh();
    });
    await expect(page.locator('#notifyCount')).toBeVisible();
    await page.click('#notifyBtn');
    await expect(page.locator('#notifyPop [data-notify="update"], #notifyPop [data-notify="review"]').first()).toBeVisible();
    await expect(page.locator('#notifyPop [data-notify="save"]')).toHaveCount(0);   // saving lives in the Data menu only
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
    await expect(page.locator('#sec-accounts [data-est]').first()).toContainText('today');
  });

  test('every dialog works inside a second scenario and never shows "null"', async ({ page }) => {
    const noNull = async () => {
      const text = await page.evaluate(() => document.body.innerText);
      expect(text, 'no stray "null" text').not.toMatch(/\bnull\b/);
    };
    await tab(page, 'scenarios');
    await page.click('#dupScenario');
    await page.locator('#ideaGrid .idea-chip').first().click();
    await expect(page.locator('#compareResults .sc-table tbody tr')).toHaveCount(3, { timeout: 30000 });
    await noNull();
    // Spending check-up
    await go(page, 'finances/spending');
    await page.click('#sec-expenses button:has-text("Spending check-up")');
    for (let i = 0; i < 7; i++) { await noNull(); await page.click('#wizNext'); }
    await noNull();
    await page.click('#wizClose');
    // Life check-up
    await go(page, 'finances/spending');
    await page.click('#lifeBtn');
    for (let i = 0; i < 5; i++) { await noNull(); await page.click('#lwNext'); }
    await noNull();
    await page.click('#lwClose');
    // Goal wizard: every kind of goal through to the last step
    for (const kind of ['Plan your retirement', 'Emergency fund', 'Mortgage-free', 'Financial independence', 'Reach an amount', 'Passive income', 'Save for something']) {
      await tab(page, 'home');
      await page.click('#ovAddGoal');
      await noNull();
      // Goals already set (mortgage-free) or covered by another (financial independence) are not offered.
      if (!(await page.locator(`.goal-option:has-text("${kind}")`).count())) { await page.click('#gwClose'); continue; }
      await page.click(`.goal-option:has-text("${kind}")`);
      await page.waitForTimeout(400);
      await noNull();
      await page.click('#gwNext');
      await expect(page.locator('#gwImpact')).toContainText('Chance the money lasts', { timeout: 20000 });
      await noNull();
      await expect(page.locator('#gwNext')).toHaveText('Save goal');
      await noNull();
      await page.click('#gwClose');
    }
    // Update balances
    await go(page, 'finances/portfolio');
    await page.click('#updateBtn');
    await noNull();
    await page.locator('#udBody .rv-row').first().locator('input').fill('12345');
    await page.click('#udSave');
    await noNull();
    // The yearly review, every step
    await page.evaluate(() => window.__horizon.openReview());
    for (let i = 0; i < 6; i++) { await page.waitForTimeout(150); await noNull(); await page.click('#rvNext'); }
    await expect(page.locator('#rvBody .rv-scen')).toHaveCount(3);
    await noNull();
    await page.click('#rvSave');
    await expect(page.locator('#reviewWiz')).toBeHidden({ timeout: 30000 });
    await noNull();
    // Every goal tab in this scenario
    for (const id of await page.evaluate(() => window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan.goals.map(g => g.id))) {
      await go(page, `goal/${id}`);
      await page.waitForTimeout(300);
      await noNull();
    }
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
    await editAll(page, 'income');
    const salary = page.locator('#sec-income .item').first().locator('input[aria-label="Amount"]');
    await salary.fill('90000');
    await settle(page);
    const afterInvest = await page.evaluate(() => window.__horizon.model.monthly.invest);
    expect(afterInvest).toBeGreaterThan(beforeInvest);
    const after = await page.evaluate(() => window.__horizon.model.proj.rows[0].netWorth);
    expect(after).toBe(before); // today's balances are unchanged
  });

  test('accepts amounts like 25k and formats them on blur', async ({ page }) => {
    await go(page, 'finances/saving');
    const input = page.locator('#sec-strategy input').first();
    await input.fill('25k');
    await input.blur();
    await expect(input).toHaveValue('25,000');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.cashReserve)).toBe(25000);
  });

  test('add and remove an account', async ({ page }) => {
    await go(page, 'finances/portfolio');
    await page.click('#sec-accounts summary:has-text("Add an account")');
    const items = page.locator('#sec-accounts .item');
    const n = await items.count();
    await page.click('#sec-accounts button:has-text("+ ISA")');
    await expect(items).toHaveCount(n + 1);
    await items.last().locator('button[aria-label^="Remove"]').click();
    await expect(items).toHaveCount(n);
  });

  test('each kind of account has its own fields, and no type to change', async ({ page }) => {
    await go(page, 'finances/portfolio');
    await page.click('#sec-accounts summary:has-text("Add an account")');
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
    const track = page.locator('#gpTrack');
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
    await expect(page.locator('#gwTitle')).toHaveText('Try changes');
    await expect(page.locator('#gwNext')).toHaveText('Save goal');
    await page.locator('#gwBody input[aria-label="Spending before retirement"]').fill('85');
    await expect(page.locator('#gwImpact')).toContainText('£750K by 2034', { timeout: 15000 });
    await expect(page.locator('#gwImpact')).toContainText('▲');
    await expect(page.locator('#gwSave')).toContainText('Spending before retirement: 100% → 85%');
    await page.locator('#gwSave input[value="apply"]').check();
    await page.click('#gwNext');
    await expect(page.locator('#goalWiz')).toBeHidden();
    await expect(page.locator('#goalPage .goal-hero')).toContainText('£750K by 2034');
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(4);
    await expect(page.locator('.tab-list .goal-tab')).toHaveCount(4);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.spendNowPct)).toBe(85);
  });

  test('goal wizard: save trade-offs as a new scenario', async ({ page }) => {
    await tab(page, 'home');
    await page.evaluate(() => { const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan; p.goals = p.goals.filter(g => g.type !== 'debtFree'); window.__horizon.refresh(); });   // a mortgage goal is only offered when there isn't one
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Mortgage-free")');
    await page.click('#gwNext');
    await page.locator('#gwBody input[aria-label="Share of surplus to overpay"]').fill('50');
    await expect(page.locator('#gwStatus')).toContainText('1 change', { timeout: 15000 });
    await page.locator('#gwSave input[value="scenario"]').check();
    await page.click('#gwNext');
    await expect(page.locator('#scenarioSelect option')).toHaveCount(2);
    const ws = await page.evaluate(() => window.__horizon.ws);
    expect(ws.scenarios[0].plan.strategy.overpayPct).toBe(0);
    expect(ws.scenarios[1].plan.strategy.overpayPct).toBe(50);
    expect(ws.scenarios[1].plan.goals.length).toBe(3);
  });

  test('edit and remove a goal', async ({ page }) => {
    await openGoal(page, '£1M by');
    await page.click('.goal-hero button:has-text("Edit goal")');
    await expect(page.locator('#gwTitle')).toHaveText('Set the target');
    await page.locator('#gwBody input[aria-label="Goal amount"]').fill('2m');
    await page.click('#gwNext');
    await page.click('#gwNext');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('£2M by');
    await page.click('.goal-hero button:has-text("Remove")');
    await expect(page.locator('#view-home')).toBeVisible();
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(2);
    await expect(page.locator('#ovGoalStrip')).not.toContainText('£2M by');
  });

  test('a goal tab tries changes on its own levers and applies them', async ({ page }) => {
    await openGoal(page, '£1M by');
    await expect(page.locator('#gpApply')).toBeDisabled();
    await page.locator('#gpLevers input[aria-label="Spending before retirement"]').fill('90');
    await expect(page.locator('#gpStatus')).toContainText('1 change', { timeout: 15000 });
    await expect(page.locator('#gpImpact')).toContainText('Chance the money lasts');
    await expect(page.locator('#gpImpact')).toContainText('▲');
    await page.click('#gpApply');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.spendNowPct)).toBe(90);
    await expect(page.locator('#gpApply')).toBeDisabled();
  });
  test('money: every page has its inputs, a prediction and a table, and accounts add up', async ({ page }) => {
    for (const [sub, box] of [['assumptions', '#mpAssumptions'], ['income', '#mpIncome'], ['spending', '#mpSpending'], ['saving', '#mpSaving'], ['cashflow', '#mpTax'], ['portfolio', '#mpPortfolio']]) {
      await go(page, `finances/${sub}`);
      await asTable(page.locator(box));
      await expect(page.locator(`${box} .chart-table tbody tr`).first()).toBeVisible();
      await expect(page.locator(`${box} .explain`).first()).toBeVisible();
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
    await editAll(page, 'income');
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
    await editAll(page, 'income');
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
    await editAll(page, 'accounts');
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
    await editAll(page, 'income');
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
    await go(page, 'finances/spending');
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
    await go(page, 'finances/spending');
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
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Passive income")');
    await expect(page.locator('#gwPreview')).toContainText('a year passive income by', { timeout: 15000 });
    await page.click('#gwNext');
    await expect(page.locator('#gwImpact')).toContainText('passive income', { timeout: 15000 });
    await page.click('#gwNext');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('passive income');
    await expect(page.locator('#goalPage canvas').first()).toBeVisible();
    await page.click('#gpTake button:has-text("Work it out")');
    await expect(page.locator('#gpTake .goal-solve')).not.toBeEmpty({ timeout: 20000 });
    await tab(page, 'home');
    await expect(page.locator('#ovGoalStrip .goal-tile:not(.add)')).toHaveCount(5);
    // A goal on its own in the last row is as wide as the others, not the whole row.
    await tab(page, 'home');
    const widths = await page.locator('#ovGoalStrip .goal-tile').evaluateAll(els => els.map(e => Math.round(e.getBoundingClientRect().width)));
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(2);
  });

  test('spare cash setting is in the saving strategy', async ({ page }) => {
    await go(page, 'finances/saving');
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

  test('retirement questionnaire: the spending list plus 50%', async ({ page }) => {
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Plan your retirement")');
    const amount = async name => +(await page.locator(`#gwBody .spend-option:has-text("${name}") .amt`).innerText()).match(/£([\d,]+) a year/)[1].replace(/,/g, '');
    const list = await amount('Keep my spending list');
    const margin = await amount('My list + 50%');
    expect(margin).toBe(Math.round((list * 1.5) / 100) * 100);
    await page.click('#gwBody .spend-option:has-text("My list + 50%")');
    await expect(page.locator('#rqPreview .goal-pct')).toContainText('%', { timeout: 15000 });
    await page.click('#gwNext');
    await expect(page.locator('#gwSave')).toContainText('Saving also updates your plan', { timeout: 15000 });
    await page.click('#gwNext');
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.retireSpending)).toBe(margin);
    // Opening it again finds the same choice.
    await page.locator('button:visible', { hasText: 'Edit retirement plan' }).first().click();
    await expect(page.locator('#gwBody .spend-option:has-text("My list + 50%")')).toHaveAttribute('aria-pressed', 'true');
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
    await expect(page.locator('#gwSave')).toContainText('Saving also updates your plan', { timeout: 15000 });
    await expect(page.locator('#gwSave')).toContainText('Alex retires at 58');
    await page.click('#gwNext');
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.household.people[0].retireAge).toBe(58);
    expect(p.strategy.retireSpending).toBe(43900);
    expect(p.expenses.find(e => e.key === 'life:travel').amount).toBe(5000);
    // Alex's retirement goal moves to 58; the new goal is Sam's.
    expect(p.goals.some(g => g.type === 'retire' && g.owner === 'p1' && g.age === 58)).toBe(true);
    expect(p.goals.some(g => g.type === 'retire' && g.owner === 'p2' && g.age === 55)).toBe(true);
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
    await expect(page.locator('#gwSave')).toContainText('Cash buffer', { timeout: 15000 });
    await page.click('#gwNext');
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.goals.some(g => g.type === 'emergency' && g.months === 6)).toBe(true);
    expect(p.strategy.cashReserve).toBeGreaterThan(15000);
    await expect(page.locator('#goalPage .goal-hero')).toContainText('Emergency fund: 6 months');
    await expect(page.locator('#goalPage')).toContainText('Needed');
  });

  test('plan check items can be marked as sorted and shown again', async ({ page }) => {
    // One card at a time in a carousel; hiding one moves it out, and it can be shown again.
    const cards = page.locator('#ovInsights .sg-card');
    const n = await cards.count();
    expect(n).toBeGreaterThan(3);
    const check = cards.filter({ has: page.locator('button:has-text("Already sorted")') }).first();
    const title = await check.locator('h3').innerText();
    await check.locator('button:has-text("Already sorted")').click();
    await expect(page.locator('#ovInsights .sg-card')).toHaveCount(n - 1);
    await expect(page.locator('#ovInsights .car-track')).not.toContainText(title);
    // Arrows step through the cards.
    const next = page.locator('#ovInsights .car-btn[aria-label="Next"]');
    await next.click();
    await expect.poll(() => page.locator('#ovInsights .car-track').evaluate(t => t.scrollLeft)).toBeGreaterThan(0);
    await page.click('#ovInsights button:has-text("hidden")');
    await expect(page.locator('#ovInsights .car-track')).toContainText(title);
    expect(await page.evaluate(() => window.__horizon.ws.dismissed)).toEqual([]);
  });

  test('mortgage: rate after the fix and keeping the end date', async ({ page }) => {
    await go(page, 'finances/portfolio');
    await editAll(page, 'accounts');
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
    expect(it.startAge).toBe(68);   // USS pays from State Pension age
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
    // £1M by 2036 comes before anyone retires: no retirement changes on its tab.
    await expect(page.locator('#gpMoves')).toContainText('Spend 10% less until retirement');
    await expect(page.locator('#gpMoves')).not.toContainText('Retire 2 years later');
    await expect(page.locator('#gpLevers .explorer-levers')).not.toContainText('retires at');
    await page.locator('#gpMoves .chart-tools button:has-text("Table")').click();
    await expect(page.locator('#gpMoves .table-wrap table')).toBeVisible();
  });

  test('add a named goal from a preset, with its own colour, then remove it', async ({ page }) => {
    await page.click('#ovAddGoal');
    await page.click('.goal-option:has-text("Save for something")');
    await page.click('#gwBody .idea-chip:has-text("House deposit")');
    await expect(page.locator('#gwBody input[aria-label="Goal name"]')).toHaveValue('House deposit');
    await expect(page.locator('.goal-option')).toHaveCount(0);
    await page.locator('#gwBody .swatch').nth(5).click();
    await page.click('#gwNext');
    await page.click('#gwNext');
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

  test('scenarios: every scenario against every goal, and ready-made what-ifs', async ({ page }) => {
    await tab(page, 'scenarios');
    const head = page.locator('#compareResults .sc-table thead');
    await expect(head).toContainText('£1M by', { timeout: 30000 });
    await expect(head).toContainText('Mortgage-free by');
    await expect(head).toContainText('retires at');
    await expect(page.locator('#compareResults .sc-table tbody tr')).toHaveCount(1);
    await expect(page.locator('#ideaGrid .idea-chip')).not.toHaveCount(0);
    await page.locator('#ideaGrid .idea-chip[data-idea="crash"]').click();
    await expect(page.locator('#ideaGrid .idea-chip[data-idea="crash"]')).toBeDisabled();
    const s = await page.evaluate(() => window.__horizon.ws.scenarios.map(x => ({ name: x.name, crash: x.plan.assumptions.crashYear })));
    expect(s).toHaveLength(2);
    expect(s[1].name).toContain('Market crash');
    expect(s[1].crash).toBeGreaterThan(0);
    const rows = page.locator('#compareResults .sc-table tbody tr');
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(rows.nth(1)).toContainText('pts');   // compared with the open scenario
    await expect(page.locator('#scenarioPill')).toBeVisible();
    // Open it from the table; the pill at the top names it.
    await rows.nth(1).locator('button:has-text("Open")').click();
    await expect(page.locator('#scenarioPill')).toContainText('Market crash');
    await expect(page.locator('#compareResults .sc-table tbody tr.open')).toContainText('Market crash', { timeout: 30000 });
    await expect(page.locator('#compareResults')).not.toContainText('null');
  });

  test('goal choices: nothing offered twice, and retirement shows what retiring early costs', async ({ page }) => {
    await page.click('#ovAddGoal');
    const opts = page.locator('#gwBody .goal-option');
    await expect(opts.filter({ hasText: 'Mortgage-free' })).toHaveCount(0);        // already a goal
    await expect(opts.filter({ hasText: 'Financial independence' })).toHaveCount(0); // retirement covers it
    await expect(opts.filter({ hasText: 'Plan your retirement' })).toContainText('Sam’s retirement');
    await expect(opts.filter({ hasText: 'Emergency fund' })).toHaveCount(1);
    await page.click('#gwClose');
    await openGoal(page, 'retires at');
    await expect(page.locator('#gpTradeoffs')).toContainText('No State Pension for 13 years');
    await expect(page.locator('#gpTradeoffs')).toContainText('can’t be drawn until 57');
    await expect(page.locator('#gpFlows canvas')).toBeVisible();
    await expect(page.locator('#gpFlows')).toContainText('ISAs last');
  });

  test('home: what to put away each month, and the guides', async ({ page }) => {
    // What is left to save, and where it goes, sits with money in and out.
    await expect(page.locator('#ovInOut .io-fig.left .io-goes')).toContainText('ISAs');
    await expect(page.locator('#ovInOut .io-fig.pen')).toContainText('Into pensions');
    await expect(page.locator('#ovMonthly')).toHaveCount(0);
    // The example's mortgage ends after both retire, so there is no "from then" line.
    await expect(page.locator('#ovInOut')).not.toContainText('mortgage paid off: about');
    // Guides not done yet are suggestions too; every guide is under "All guides".
    await expect(page.locator('#ovInsights [data-insight="guide-protection"]')).toContainText('Start');
    // Future costs is suggested once (by the plan check), not again as a guide.
    await expect(page.locator('#ovInsights .sg-card', { hasText: 'costs that come later' })).toHaveCount(1);
    await expect(page.locator('#ovInsights [data-insight^="adv-pension"]')).toContainText('Pension for Alex');
    await page.click('#ovInsights summary:has-text("All guides")');
    await expect(page.locator('#ovGuides .guide-tile')).toHaveCount(10);
    // Can I retire at…? Sam at 50, then save it as a scenario.
    await page.click('#ovGuides [data-guide="retire"]');
    await expect(page.locator('#gdTitle')).toHaveText('Who, and when?');
    await page.click('#gdBody [data-who="p2"]');
    await page.locator('#gdBody input[aria-label="Retirement age"]').fill('50');
    await page.click('#gdNext');
    await expect(page.locator('#gdRetire .gd-verdict')).toContainText('chance the money lasts', { timeout: 30000 });
    await expect(page.locator('#gdRetire .gd-table tbody tr')).toHaveCount(3);
    await expect(page.locator('#gdRetire')).toContainText('No State Pension for 18 years');
    await page.click('#gdNext');
    await page.locator('#gdBody input[value="scenario"]').check();
    await page.click('#gdNext');
    await expect(page.locator('#guideDlg')).toBeHidden();
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.name))).toContain('Base plan: Sam retires at 50');
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[1].plan.household.people[1].retireAge)).toBe(50);
    await expect(page.locator('#ovGuides [data-guide="retire"]')).toContainText('Done');
    // Tax year-end check: tick one.
    await page.click('#ovGuides [data-guide="tax"]');
    await expect(page.locator('#gdBody .checklist li').first()).toContainText('ISA allowance');
    await expect(page.locator('#gdBody')).toContainText('Bed and ISA');
    await page.locator('#gdBody .checklist input').first().check();
    await page.click('#gdNext');
    await expect(page.locator('#ovGuides [data-guide="tax"]')).toContainText('1 of');
    // Protection: answer two, see the suggestions.
    await page.click('#ovGuides [data-guide="protection"]');
    await page.click('#gdBody [data-answer="life:no"]');
    await page.click('#gdBody [data-answer="will:yes"]');
    await page.click('#gdNext');
    await expect(page.locator('#gdBody .advice')).toContainText('Life insurance');
    await expect(page.locator('#gdBody .advice')).not.toContainText('Wills');
    await expect(page.locator('#gdBody .advice')).toContainText('clear the mortgage');
    await page.click('#gdNext');
    await expect(page.locator('#ovGuides [data-guide="protection"]')).toContainText('to look at');
    expect(await page.evaluate(() => window.__horizon.ws.guides.protection.answers.will)).toBe('yes');
    await expect(page.locator('main')).not.toContainText('null');
  });

  test('finances: items are plain lines with a summary on top; one opens to edit', async ({ page }) => {
    await go(page, 'finances/income');
    await expect(page.locator('#sum-income')).toContainText('Coming in this year');
    await expect(page.locator('#sec-income .sum-row')).toHaveCount(3);
    await expect(page.locator('#sec-income input[aria-label="Amount"]')).toHaveCount(0);
    await expect(page.locator('#sec-income .sum-row').first()).toContainText('Alex salary');
    await page.locator('#sec-income .sum-row').first().click();
    await expect(page.locator('#sec-income [data-editing] input[aria-label="Amount"]')).toBeVisible();
    await page.locator('#sec-income [data-editing] input[aria-label="Amount"]').fill('70000');
    await settle(page);
    await expect(page.locator('#sum-income')).toContainText('a month');
    await page.click('#sec-income .edit-done button');
    await expect(page.locator('#sec-income .sum-row').first()).toContainText('£5,833 a month');
    await go(page, 'finances/spending');
    await expect(page.locator('#sum-expenses')).toContainText('Spending this year');
    await go(page, 'finances/portfolio');
    await expect(page.locator('#sum-accounts')).toContainText('Net worth');
    // Home: money in and out, with future costs.
    await tab(page, 'home');
    await expect(page.locator('#ovInOut .io-sum')).toContainText('Coming in');
    await expect(page.locator('#ovInOut .io-sum')).toContainText('Left to save');
    await expect(page.locator('#ovInOutLegend')).toContainText('One-off costs');
    await expect(page.locator('#ovInOut canvas')).toBeVisible();
    // Its own inflation switch: in today's money everyday spending is flat; in actual pounds it rises.
    // Actual pounds by default (spending rises with prices); today's money on request.
    await expect(page.locator('#ovInOut')).toContainText('actual pounds of each year');
    await page.click('#ovInOut [data-io="today"]');
    await expect(page.locator('#ovInOut')).toContainText('stay level');
    await page.click('#ovInOut [data-io="actual"]');
    // Where it all goes: tax, spending, the mortgage and each kind of saving, adding up to what comes in.
    await page.click('#ovInOut [data-view="all"]');
    await expect(page.locator('#ovInOutLegend')).toContainText('Tax & NI');
    await expect(page.locator('#ovInOutLegend')).toContainText('Pensions');
    await expect(page.locator('#ovInOutLegend')).toContainText('Coming in before tax');
    await asTable(page.locator('#ovInOut'));
    const cells = await page.locator('#ovInOut .chart-table tbody tr').first().locator('td').allInnerTexts();
    const n = cells.map(c => +c.replace(/[£,]/g, '') || 0);
    // Coming in = tax + spending + mortgage + overpaying + pensions + ISAs + general + cash − from savings.
    expect(Math.abs(n[1] - (n.slice(2, 11).reduce((a, b) => a + b, 0) - n[11]))).toBeLessThan(5);
    await page.click('#ovInOut [data-view="spend"]');
    // A suggested split of what is left, that can be tried as a scenario.
    await expect(page.locator('#ioSplit')).toContainText('Pension for Alex');
    await expect(page.locator('#ioSplit')).toContainText('Lifetime ISA');
    await page.click('#ioSplit button:has-text("Try it as a scenario")');
    await expect(page.locator('#view-scenarios')).toBeVisible();
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.name))).toContain('Base plan: suggested split');
  });

  test('pay progression on a salary', async ({ page }) => {
    await go(page, 'finances/income');
    await editAll(page, 'income');
    const card = page.locator('#sec-income .item').first();
    await expect(card.locator('.pay-prog')).toContainText('Pay progression');
    await card.locator('input[aria-label="Pay rises until age"]').fill('45');
    await settle(page);
    await card.locator('input[aria-label="Pay rise after that age"]').fill('2.5');
    await page.locator('#sec-income .item').first().locator('button:has-text("Add a promotion")').click();
    await settle(page);
    const it = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.income[0]);
    expect(it.growthUntilAge).toBe(45);
    expect(it.growthAfter).toBe(2.5);
    expect(it.raises).toHaveLength(1);
    await expect(page.locator('#sec-income .item').first().locator('.pay-prog .calc')).toContainText('Pay in today’s money');
  });

  test('home chart: by account or by access, and how far ahead to show', async ({ page }) => {
    await expect(page.locator('#ovGroup button[data-by="type"]')).toHaveAttribute('aria-pressed', 'true');
    await page.click('#ovGroup button[data-by="access"]');
    await expect(page.locator('#ovLegend')).toContainText('Available now');
    await expect(page.locator('#ovLegend')).toContainText('Pensions & Lifetime ISAs');
    await expect(page.locator('#ovChartSub')).toContainText('add up to your net worth');
    // Charts stop at 85 by default; the table still has every year.
    const sel = page.locator('#view-home .show-to select').first();
    await expect(sel).toHaveValue('85');
    expect(await page.evaluate(() => { const p = window.__horizon.ws.scenarios[0].plan; return window.Chart.until - (p.startYear + 85 - p.household.people[0].age); })).toBe(0);
    await sel.selectOption('0');
    expect(await page.evaluate(() => window.Chart.until)).toBeNull();
    expect(await page.evaluate(() => window.__horizon.ws.settings.showTo)).toBe(0);
  });

  test('saving & investing: set your own amounts, with suggestions beside them', async ({ page }) => {
    await go(page, 'finances/saving');
    await expect(page.locator('#sec-saving')).toContainText('a month is left over');
    await expect(page.locator('#mpSaving .advice li').first()).toContainText('Emergency fund');
    await expect(page.locator('#mpSaving .advice')).toContainText('Lifetime ISA');
    await expect(page.locator('#mpSaving .advice')).toContainText('Pension for Alex');
    await expect(page.locator('#mpSaving canvas')).toBeVisible();
    // A set ISA amount: the rest goes to cash.
    await page.locator('#sec-saving select[aria-label^="ISAs"]').selectOption('set');
    // One amount per ISA.
    await expect(page.locator('#sec-saving .isa-row')).toHaveCount(2);
    await page.locator('#sec-saving input[aria-label="Sam stocks & shares ISA a month"]').fill('0');
    const isa = page.locator('#sec-saving input[aria-label="Alex stocks & shares ISA a month"]');
    await isa.fill('300');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.accounts.filter(a => a.type === 'isa').map(a => a.monthly))).toEqual([300, 0]);
    await expect(page.locator('[data-flow="isaMonthly"]')).toContainText('£300 a month');
    // The general account (still automatic) takes the rest; set it to nothing and the rest stays in cash.
    await expect(page.locator('[data-flow="giaMonthly"]')).not.toContainText('£0 a month');
    await page.locator('#sec-saving select[aria-label^="General investment"]').selectOption('set');
    await page.locator('#sec-saving input[aria-label="General investment account a month"]').fill('0');
    await settle(page);
    await expect(page.locator('[data-flow="cash"]')).toContainText('goes to cash');
    // A Lifetime ISA can be added from here.
    await page.click('#sec-saving button:has-text("Lifetime ISA for Alex")');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.accounts.some(a => a.type === 'lisa' && a.owner === 'p1'))).toBe(true);
    // A suggestion opens its comparison.
    await page.locator('#mpSaving .advice button:has-text("Compare pension or ISA")').click();
    await expect(page.locator('#cmpGrid [data-compare="pension-isa"]')).toHaveAttribute('aria-pressed', 'true');
  });

  test('scenarios: compare two choices, reached from a suggestion on Home', async ({ page }) => {
    // The Lifetime ISA suggestion leads to the salary sacrifice comparison.
    await page.locator('#ovInsights [data-insight="lisa"] button:has-text("Compare the options")').click();
    await expect(page.locator('#view-scenarios')).toBeVisible();
    await expect(page.locator('#cmpGrid [data-compare="sacrifice-lisa"]')).toHaveAttribute('aria-pressed', 'true');
    const rows = page.locator('#cmpResult .cmp-table tbody tr');
    await expect(rows).toHaveCount(3, { timeout: 30000 });
    await expect(rows.nth(0)).toContainText('As now');
    await expect(rows.nth(1)).toContainText('Lifetime ISA');
    await expect(rows.nth(2)).toContainText('Salary sacrifice');
    await expect(rows.nth(2)).toContainText('for £4,000 less take-home pay');
    await expect(rows.nth(1)).toContainText('pts');
    await expect(page.locator('#cmpResult thead')).toContainText('Savings & pensions when Alex retires');
    // Nothing is saved until asked.
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.length)).toBe(1);
    await page.click('#cmpKeep');
    await expect(page.locator('#cmpKeep')).toBeDisabled();
    const names = await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.name));
    expect(names).toEqual(['Base plan', 'Base plan: Lifetime ISA', 'Base plan: Salary sacrifice']);
    await expect(page.locator('#compareResults .sc-table tbody tr')).toHaveCount(3, { timeout: 30000 });
    // Another comparison; options that match the plan already are left out.
    await page.click('#cmpGrid [data-compare="overpay-invest"]');
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(rows.nth(1)).toContainText('Overpay with all of it');
    await page.click('#cmpGrid [data-compare="overpay-invest"]');
    await expect(page.locator('#cmpResult')).toBeEmpty();
    await expect(page.locator('#view-scenarios')).not.toContainText('null');
  });
  test('what you leave behind: estate, inheritance tax, and ideas to try as scenarios', async ({ page }) => {
    await page.click('#ovInsights summary:has-text("All guides")');
    await page.click('#ovGuides [data-guide="estate"]');
    await expect(page.locator('#gdTitle')).toHaveText('What the plan leaves');
    const cells = page.locator('#gdBody .gd-table tbody tr');
    await expect(cells.filter({ hasText: 'Estate' })).toContainText('£');
    await expect(cells.filter({ hasText: 'Inheritance tax at 40%' })).toBeVisible();
    await expect(page.locator('#gdIntro')).toContainText('pounds the estate is about');
    await page.click('#gdNext');
    await expect(page.locator('#gdTitle')).toHaveText('Ways to pass on more');
    await expect(page.locator('#gdBody .advice')).toContainText('Give from surplus income');
    await page.locator('#gdBody .advice li', { hasText: 'Enjoy more of it' }).locator('button').click();
    await expect(page.locator('#gdBody .advice li', { hasText: 'Enjoy more of it' }).locator('button')).toHaveText('Added to Scenarios');
    await page.click('#gdNext');
    await expect(page.locator('#guideDlg')).toBeHidden();
    expect(await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.name))).toContain('Base plan: Spend 20% more in retirement');
    await expect(page.locator('#ovGuides [data-guide="estate"]')).toContainText('Done');
  });

  test('pensions first: a switch on the saving page and a comparison', async ({ page }) => {
    await go(page, 'finances/saving');
    const sw = page.locator('#sec-saving label.switch', { hasText: 'Pensions first' }).locator('input');
    await expect(sw).not.toBeChecked();
    await sw.check();
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.pensionFirst)).toBe(true);
    await expect(page.locator('#sec-saving [data-flow="toPension"]')).not.toBeEmpty();
    await sw.uncheck();
    await settle(page);
    // Keep income under £100,000: nobody in the example gets there.
    await page.locator('#sec-saving label.switch', { hasText: 'Keep income under £100,000' }).locator('input').check();
    await expect(page.locator('#sec-saving [data-flow="sacrificed"]')).toContainText('Nobody’s income reaches £100,000');
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.stayUnder100k)).toBe(true);
    await tab(page, 'scenarios');
    await page.click('#cmpGrid [data-compare="after-isa"]');
    const rows = page.locator('#cmpResult .cmp-table tbody tr');
    await expect(rows).toHaveCount(2, { timeout: 30000 });
    await expect(rows.nth(0)).toContainText('General account (as now)');
    await expect(rows.nth(1)).toContainText('Pensions first');
  });

  test('"i" explanations and suggestion markers', async ({ page }) => {
    // An "i" beside a heading explains it; Escape closes it.
    const info = page.locator('#homePortfolio .info-btn[aria-label="About: Available or locked away"]').first();
    await info.click();
    await expect(page.locator('#infoPop')).toBeVisible();
    await expect(page.locator('#infoPop')).toContainText('Lifetime ISAs (from 60');
    await expect(info).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Escape');
    await expect(page.locator('#infoPop')).toBeHidden();
    // A field with a suggestion has a marker that opens it, with its action.
    await go(page, 'finances/saving');
    const tip = page.locator('#sec-saving .tip-btn[aria-label^="Suggestion: A Lifetime ISA"]');
    await expect(tip).toBeVisible();
    await tip.click();
    await expect(page.locator('#infoPop')).toContainText('A Lifetime ISA adds a 25% bonus');
    await page.locator('#infoPop button:has-text("Compare the options")').click();
    await expect(page.locator('#cmpGrid [data-compare="sacrifice-lisa"]')).toHaveAttribute('aria-pressed', 'true');
    // Saying it is sorted removes the marker.
    await go(page, 'finances/saving');
    await page.locator('#sec-saving .tip-btn[aria-label^="Suggestion: A Lifetime ISA"]').click();
    await page.locator('#infoPop button:has-text("Already sorted")').click();
    await expect(page.locator('#sec-saving .tip-btn[aria-label^="Suggestion: A Lifetime ISA"]')).toHaveCount(0);
    // Inputs keep their own names.
    await expect(page.locator('#sec-saving input[aria-label="Sam stocks & shares ISA a month"], #sec-saving select[aria-label^="ISAs"]').first()).toBeVisible();
  });

  test('home: what to do, and when', async ({ page }) => {
    const todo = page.locator('#ovTodo');
    await expect(todo.locator('h2')).toContainText('What to do, and when');
    // Now: this month's ISA amounts, split between the ISAs.
    const isa = todo.locator('.todo-item.now', { hasText: 'a month into ISAs' });
    await expect(isa).toContainText('into Alex stocks & shares ISA');
    const m = await page.evaluate(() => Math.round(window.__horizon.model.monthly.isa));
    await expect(isa.locator('strong')).toContainText(`£${m.toLocaleString('en-GB')} a month`);
    // Dated items in order, and every-year reminders.
    const whens = await todo.locator('.todo-item .todo-when').allInnerTexts();
    const years = whens.filter(w => /^\d{4}$/.test(w)).map(Number);
    expect(years).toEqual([...years].sort((a, b) => a - b));
    await expect(todo).toContainText('By 5 April');
    // Retirement: when each person stops, and later the State Pension to claim.
    await todo.locator('summary').click();
    await expect(todo).toContainText('Alex retires at');
    await expect(todo).toContainText('claim the State Pension');
    await todo.locator('.todo-item', { hasText: 'By 5 April' }).locator('button').click();
    await expect(page.locator('#guideDlg')).toBeVisible();
  });

  test('questions about your plan: asked one at a time, applied to the plan', async ({ page }) => {
    // Suggested on Home while unanswered.
    const card = page.locator('#ovInsights [data-insight="guide-questions"]');
    await expect(card).toContainText('questions about your plan');
    await card.locator('button:has-text("Answer them")').click();
    await expect(page.locator('#gdTitle')).toHaveText('How does Alex pay into the workplace pension?');
    await expect(page.locator('#gdBody .q-rec').first()).toHaveText('Recommended');
    await page.click('#gdBody [data-q="pension-how-p1:sacrifice"]');
    await page.click('#gdNext');
    await expect(page.locator('#gdTitle')).toHaveText('How much goes into Alex’s pension each month?');
    // Skip ahead to the shares question and pick the growth mix.
    for (let i = 0; i < 12; i++) {
      if ((await page.locator('#gdTitle').innerText()).startsWith('How much of your investments')) break;
      await page.click('#gdNext');
    }
    await page.click('#gdBody [data-q="mix:growth"]');
    while ((await page.locator('#gdNext').innerText()) !== 'Save answers') await page.click('#gdNext');
    await page.click('#gdNext');
    await expect(page.locator('#guideDlg')).toBeHidden();
    const p = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(p.income.find(i => i.owner === 'p1' && i.kind === 'salary').sacrifice).toBe(true);
    expect([p.assumptions.stockPctNow, p.assumptions.stockPctRetire]).toEqual([100, 80]);
    expect(await page.evaluate(() => Object.keys(window.__horizon.ws.guides.questions.answers))).toContain('mix');
  });

  test('home portfolio: today or years ahead', async ({ page }) => {
    const box = page.locator('#homePortfolio');
    const today = await box.locator('.hero-value').innerText();
    await box.locator('[data-ahead="10"]').click();
    await expect(box.locator('.hero-label')).toContainText('Expected net worth in');
    await expect(box.locator('.pf-row.head')).toContainText('(expected)');
    await expect(box.locator('.delta')).toContainText('in today’s money');
    expect(await box.locator('.hero-value').innerText()).not.toBe(today);
    // The donut and the sums follow: net worth = own − owe, for that year.
    const nums = await box.locator('#pfSum dd').allInnerTexts();
    const v = t => +t.replace(/[^0-9]/g, '') * (t.includes('−') ? -1 : 1);
    expect(Math.abs(v(nums[0]) + v(nums[2]) - v(nums[3]))).toBeLessThan(2);
    expect(v(nums[3])).toBe(v(await box.locator('.hero-value').innerText()));
    await box.locator('[data-ahead="retire"]').click();
    await expect(box.locator('#pfTitle')).toHaveText('Where you’ll be');
    await box.locator('[data-ahead="0"]').click();
    await expect(box.locator('.hero-value')).toHaveText(today);
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
    await page.click('#sec-accounts summary:has-text("Add an account")');
    await page.click('#sec-accounts button:has-text("+ Lifetime ISA")');
    await settle(page);
    const row = await page.evaluate(() => window.__horizon.model.proj.rows[0]);
    expect(row.toLisa).toBe(4000);
    expect(row.lisaBonus).toBe(1000);
    const item = page.locator('#sec-accounts .item').last();
    await expect(item).toContainText('Pay in each year');
    await item.locator('details.more summary').click();
    // The example owns a home, so a first home is not offered.
    await expect(item.locator('select').filter({ hasText: 'A first home' })).toHaveCount(0);
    await expect(item).toContainText('Withdrawals before 60');
    await tab(page, 'home');
    await openGoal(page, '£1M by');
    await expect(page.locator('#gpYear')).toContainText('Lifetime ISAs');
  });

  test('higher-rate relief on extra pension saving can be switched off', async ({ page }) => {
    await page.evaluate(() => { window.__horizon.ws.scenarios[0].plan.household.people[0].extraPension = 200; window.__horizon.refresh(); });
    const on = await page.evaluate(() => window.__horizon.model.proj.rows[0].pensionRelief);
    expect(on).toBeGreaterThan(0);
    await go(page, 'finances/saving');
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
    expect(Object.keys(data.settings).sort()).toEqual(['confidence', 'inOutReal', 'inOutView', 'lastSaved', 'realDollars', 'runs', 'seed', 'showTo', 'theme']);
    expect(data.settings.lastSaved).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    await expect(page.locator('#savedNote')).toContainText('Last saved to a file');
    await expect(page.locator('#view-home')).not.toContainText('Saved to a file');
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
    await page.locator('#view-home [data-inflation] input').first().uncheck();
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
    await openGroups(page);
    await expect(page.locator('#homePortfolio .pf-row.single', { hasText: 'Property' })).toContainText('£320,000');
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
    await openGroups(page);
    await expect(page.locator('#homePortfolio .pf-row.single', { hasText: 'Property' })).toContainText('£320,000');
  });

  test('the inflation switch changes future amounts but not today', async ({ page }) => {
    const host = page.locator('#ovChart');
    await asTable(host);
    const lastRow = () => host.locator('.chart-table tbody tr').last().innerText();
    const firstRow = () => host.locator('.chart-table tbody tr').first().innerText();
    const real = await lastRow();
    const today = await firstRow();
    // Actual pounds by default; the switch shows today's money.
    const sw = page.locator('#view-home [data-inflation] input').first();
    await expect(sw).not.toBeChecked();
    await sw.check();
    await expect.poll(lastRow).not.toBe(real);
    expect(await firstRow()).toBe(today);
    expect(await page.evaluate(() => window.__horizon.ws.settings.realDollars)).toBe(true);
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
    const m = await page.evaluate(() => window.MARKET_DATA.suggested);
    // Already the same: it says so rather than offering a button that changes nothing.
    await page.evaluate(v => { const a = window.__horizon.ws.scenarios[0].plan.assumptions; a.inflation = v.inflation.value; a.cashRate = v.cashRate.value; a.bondReturn = v.bondReturn.value; window.__horizon.refresh(); }, m);
    await settle(page);
    await expect(page.locator('#sec-market .market-same')).toContainText('already uses these');
    // Different: it says what will change, and the boxes show the new values.
    const box = page.locator('#sec-market input[aria-label="Inflation"], #sec-market .fields input').first();
    await box.fill('4');
    await settle(page);
    await expect(page.locator('#sec-market .add-row')).toContainText(`Inflation 4% → ${m.inflation.value}%`);
    await page.click('#sec-market button:has-text("Use suggested values")');
    await settle(page);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.assumptions.inflation)).toBe(m.inflation.value);
    await expect(page.locator('#sec-market .fields input').first()).toHaveValue(String(m.inflation.value));
    await expect(page.locator('#sec-market')).toContainText('In shares by retirement');
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

  // Elements reaching past the right edge (outside anything that scrolls sideways on purpose).
  const cropped = page => page.evaluate(() => {
    const W = window.innerWidth;
    const scrolls = el => { for (let a = el.parentElement; a; a = a.parentElement) { const o = getComputedStyle(a).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') return true; } return false; };
    const out = [];
    for (const el of document.querySelectorAll('main *, dialog[open] *, header *')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height || el.closest('[hidden]')) continue;
      if (r.right > W + 1 && !scrolls(el)) out.push(`${el.tagName.toLowerCase()}.${String(el.className).split(' ')[0]} ${Math.round(r.right - W)}px`);
    }
    return out.slice(0, 5);
  });

  test('every page fits a phone screen', async ({ page }) => {
    const tracker = await openApp(page);
    const goals = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.goals.map(g => g.id));
    for (const name of ['home', ...goals.map(g => `goal/${g}`), 'finances/portfolio', 'finances/income', 'finances/spending', 'finances/saving', 'finances/cashflow', 'finances/assumptions', 'finances/history', 'scenarios']) {
      await go(page, name);
      await page.waitForTimeout(500);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${name} overflows by ${overflow}px`).toBeLessThanOrEqual(0);
      expect(await cropped(page), `${name}: cut off on the right`).toEqual([]);
    }
    // A comparison open on Scenarios.
    await page.click('#cmpGrid [data-compare="sacrifice-lisa"]');
    await expect(page.locator('#cmpResult .cmp-table tbody tr')).toHaveCount(3, { timeout: 30000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(0);
    expect(await cropped(page), 'comparison: cut off on the right').toEqual([]);
    expect(tracker.problems).toEqual([]);
  });

  test('every dialog fits a phone screen', async ({ page }) => {
    const tracker = await openApp(page);
    const check = async name => {
      await page.waitForTimeout(300);
      expect(await cropped(page), `${name}: cut off on the right`).toEqual([]);
    };
    await go(page, 'finances/portfolio');
    await page.click('#updateBtn');
    await check('update balances');
    await page.click('#udCancel');
    await tab(page, 'home');
    await page.click('#ovAddGoal');
    await check('goal wizard: choose');
    await page.click('.goal-option:has-text("Plan your retirement")');
    await check('retirement questionnaire');
    await page.click('#gwNext');
    await expect(page.locator('#gwImpact')).toContainText('Chance', { timeout: 20000 });
    await check('goal wizard: levers');
    await page.click('#gwClose');
    await go(page, 'finances/spending');
    await page.click('#lifeBtn');
    await check('life check-up');
    await page.click('#lwClose');
    await page.click('#notifyBtn');
    await check('notifications');
    await page.click('#notifyBtn');
    await go(page, 'finances/spending');
    await page.click('#sec-expenses button:has-text("Spending check-up")');
    await check('spending check-up');
    for (let i = 0; i < 7; i++) await page.click('#wizNext');
    await check('spending check-up: compare');
    await page.click('#wizClose');
    await page.evaluate(() => window.__horizon.openReview());
    for (let i = 0; i < 6; i++) { await check(`review step ${i + 1}`); await page.click('#rvNext'); }
    await expect(page.locator('#rvBody .impact table')).toHaveCount(0);
    await check('review: update scenarios');
    expect(tracker.problems).toEqual([]);
  });
});
