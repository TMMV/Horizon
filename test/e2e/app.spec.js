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
    // The new account opens scrolled into view with its name ready to type; Remove sits after Done.
    const added = page.locator('#sec-accounts [data-editing]').last();
    await expect(added.locator('input.name')).toBeFocused();
    await expect(added.locator('.edit-done button').last()).toHaveText('Remove');
    await added.locator('button[aria-label^="Remove"]').click();
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
    // Each account's estimate is rounded to the pound, so the total can be a pound or two off.
    await expect(page.locator('#rvBody .rv-delta')).toContainText(/\+£(9,99[89]|10,00[0-2])/);
    await expect(page.locator('#rvBody .divbar')).not.toHaveCount(0);
    // Why: parts that add up, and saying what was paid in splits markets from saving.
    await expect(page.locator('#rvExplain')).toContainText('Why you are where you are');
    await page.fill('#rvPaidIn', '1000');
    await expect(page.locator('#rvExplain')).toContainText('Markets');
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
    await expect(page.locator('#progTable tbody tr').first().locator('td').nth(4)).toContainText(/\+£(9,99[89]|10,00[0-2])/);
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
    const next = page.locator('#ovInsights .car-btn[aria-label="Next suggestion"]');
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
    await db.locator('select[aria-label="Scheme"]').selectOption('uss');
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
    await expect(rows.nth(1)).toContainText('points');   // compared with the main plan
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
    await expect(page.locator('#gpFlows')).toContainText('ISAs keep growing');
  });

  test('home: what to put away each month, and the guides', async ({ page }) => {
    // What is left to save, and where it goes, sits with money in and out.
    await expect(page.locator('#ovInOut .io-fig.left .io-goes')).toContainText('ISAs');
    await expect(page.locator('#ovInOut .io-fig.pen')).toContainText('Into pensions');
    await expect(page.locator('#ovMonthly')).toHaveCount(0);
    // The example's mortgage ends after both retire, so there is no "from then" line.
    await expect(page.locator('#ovInOut')).not.toContainText('mortgage paid off: about');
    // Guides not done yet are suggestions too; every guide is under "All guides".
    await expect(page.locator('#ovInsights [data-insight="guide-protection"]')).toContainText('Open this guide');
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
    await page.click('#sec-income .edit-done button.primary');
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
    await card.locator('input[aria-label="Pay rises until age"]').blur();
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
    // Charts run to the end of the plan by default; stopping them at 85 is a choice. The table
    // still has every year.
    const sel = page.locator('#view-home .show-to select').first();
    await expect(sel).toHaveValue('0');
    expect(await page.evaluate(() => window.Chart.until)).toBeNull();
    await sel.selectOption('85');
    expect(await page.evaluate(() => { const p = window.__horizon.ws.scenarios[0].plan; return window.Chart.until - (p.startYear + 85 - p.household.people[0].age); })).toBe(0);
    // Never before a goal: a goal at 90 keeps its year in view.
    expect(await page.evaluate(() => {
      const H = window.__horizon, p = H.ws.scenarios[0].plan;
      p.goals.push({ id: 'late', type: 'netWorth', amount: 1, year: p.startYear + 90 - p.household.people[0].age, measure: 'all', basis: 'nominal', confidence: 50 });
      H.refresh();
      return window.Chart.until - (p.startYear + 90 - p.household.people[0].age);
    })).toBe(0);
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
    await expect(rows.nth(1)).toContainText('points');
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
    await page.locator('#sec-saving select[aria-label="Keep income under a line"]').selectOption('100000');
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
    await expect(page.locator('#ovDo h2')).toContainText('What to do, and when');
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
    await todo.locator('.todo-item[data-when="Every year"]', { hasText: 'By 5 April' }).locator('button').click();
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

  test('money set aside: shown on Home, checked in the yearly review', async ({ page }) => {
    // A yearly cost to follow as a budget.
    await page.evaluate(() => {
      const w = window.__horizon;
      const p = w.ws.scenarios[0].plan;
      p.expenses.push({ id: 'e-trips', name: 'Trips', amount: 3000, freq: 'year', inflationLinked: true, startRef: 'now', endRef: 'end' });
      w.refresh();
    });
    await go(page, 'finances/saving');
    const ed = page.locator('#reservesEdit');
    await ed.locator('button:has-text("+ Emergency fund")').click();
    await ed.locator('button:has-text("+ Yearly budget")').click();
    await expect(page.locator('#reservesEdit .reserve-item')).toHaveCount(2);
    await page.locator('#reservesEdit .reserve-item').nth(1).locator('select[aria-label="For"]').selectOption('e-trips');
    await tab(page, 'home');
    const box = page.locator('#homePortfolio');
    await expect(box.locator('#pfReserves .pf-res-row')).toHaveCount(2);
    await expect(box.locator('#pfReserves')).toContainText('available until spent');
    await expect(box.locator('#pfSum')).toContainText('free to use');
    await box.locator('.pf-row.access.now .pf-class-btn').click();
    await expect(box.locator('.pf-res-tag').first()).toContainText('Emergency fund');
    await expect(box.locator('.pf-res-tag').first()).toContainText('free');
    await expect(page.locator('#ovTodo')).toContainText('what is left of the trips budget');
    // The review asks how it went, and keeps what is left of the budget.
    await go(page, 'finances/history');
    const year = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.startYear);
    await page.click('#reviewBtn');
    await page.click(`#rvBody .goal-option:has-text("Start ${year + 1}")`);
    await page.click('#rvNext');
    const rr = page.locator('#rvReserves');
    await expect(rr.locator('.rv-reserve')).toHaveCount(2);
    await expect(page.locator('#rvBody .rv-split').first()).toContainText('Expected: Emergency fund');
    await rr.locator('input[aria-label="Trips spent"]').fill('2000');
    await rr.locator('button:has-text("Keep it for next year")').click();
    for (let i = 0; i < 5; i++) await page.click("#rvNext");
    await page.click('#rvSave');
    await expect(page.locator('#reviewWiz')).toBeHidden({ timeout: 30000 });
    const left = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.reserves.find(r => r.kind === 'budget').left);
    expect(left).toBe(1000);
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

test.describe('getting started', () => {
  test('first visit: the guide sets up a plan from blank, one part at a time', async ({ page }) => {
    const { problems } = await openApp(page, '', { setup: true });
    const panel = page.locator('#setupPanel');
    await expect(panel).toBeVisible();
    await expect(panel.locator('#setupTitle')).toHaveText('Set up your own plan');
    // Every question has its "i".
    await expect(panel.locator('.st-ask .info-btn')).toHaveCount(4);
    await panel.locator('.st-ask .info-btn').first().click();
    await expect(page.locator('#infoPop')).toBeVisible();
    await page.keyboard.press('Escape');
    await panel.locator('.st-choice', { hasText: 'Yes, start my own plan' }).click();
    await panel.locator('input[aria-label="Figures as at"]').fill('2026-03-01');
    await panel.locator('.st-choice', { hasText: 'England' }).click();
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect((await plan()).accounts).toHaveLength(0);
    expect((await plan()).asOf).toBe('2026-03-01');
    expect((await plan()).household.region).toBe('ruk');
    // People: a couple, on the real page.
    await page.click('#setupNext');
    await expect(panel.locator('#setupTitle')).toHaveText('Who is the plan for?');
    await expect(page.locator('#sec-household')).toHaveClass(/setup-focus/);
    await panel.locator('.st-choice', { hasText: 'Me and a partner' }).click();
    await page.locator('#sec-household .people .item').nth(0).locator('input.name').fill('Robin');
    await page.locator('#sec-household .people .item').nth(1).locator('input.name').fill('Kim');
    await expect(panel.locator('.st-field .info-btn')).not.toHaveCount(0);
    // Pay: one click adds it and opens it to fill in.
    await page.click('#setupNext');
    await panel.locator('.st-adds button', { hasText: 'Robin’s pay' }).click();
    // Pay starts as a year's amount before tax; a year's pay typed "a month" is caught.
    const pay = page.locator('[data-editing]').last();
    await expect(pay.locator('select[aria-label="Frequency"]')).toHaveValue('year');
    await pay.locator('select[aria-label="Frequency"]').selectOption('month');
    await pay.locator('input[aria-label="Amount"]').fill('52000');
    await expect(pay.locator('.warn-hint')).toContainText('£52,000 a month is £624,000 a year');
    await pay.locator('.warn-hint button', { hasText: 'Did you mean a year?' }).click();
    await page.locator('[data-editing] .edit-done button.primary').click();
    await expect(panel.locator('.st-have')).toContainText('Robin: £52,000 a year');
    // Accounts: a bank account and an ISA for Kim.
    await panel.locator('.st-jump').selectOption({ label: '5. Bank and savings' });
    await expect(page).toHaveURL(/finances\/portfolio/);
    await panel.locator('.st-adds button', { hasText: 'Cash & savings' }).click();
    await page.locator('[data-editing] label.field:has-text("Balance") input').fill('8000');
    await page.locator('[data-editing] .edit-done button.primary').click();
    await page.click('#setupNext');
    await panel.locator('.st-adds button', { hasText: /^\+ ISA$/ }).click();
    await page.locator('[data-editing] select').first().selectOption('p2');
    await page.locator('[data-editing] label.field:has-text("Balance") input').fill('12000');
    await page.locator('[data-editing] .edit-done button.primary').click();
    const p = await plan();
    expect(p.accounts.map(a => [a.type, a.owner, a.balance, a.basis])).toEqual([['cash', 'joint', 8000, 8000], ['isa', 'p2', 12000, 12000]]);
    // Closing keeps the place; Home offers to carry on.
    await page.locator('#setupPanel button[aria-label^="Close the guide"]').click();
    await expect(panel).toBeHidden();
    await go(page, 'home');
    await expect(page.locator('#ovNeeds [data-notify="setup"]')).toContainText('step 6 of');
    await page.locator('#ovNeeds [data-notify="setup"] button', { hasText: 'Carry on' }).click();
    await expect(panel.locator('#setupTitle')).toHaveText('ISAs and investments');
    // The last step: finish.
    await panel.locator('.st-jump').selectOption({ label: '17. Save a copy' });
    await page.click('#setupNext');
    await expect(panel).toBeHidden();
    await expect(page.locator('#ovNeeds [data-notify="setup"]')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('starting out: a student loan, renting, a home bought later and help from family', async ({ page }) => {
    const { problems } = await openApp(page, '', { setup: true });
    const panel = page.locator('#setupPanel');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    const ed = () => page.locator('[data-editing]').last();
    await panel.locator('.st-choice', { hasText: 'Yes, start my own plan' }).click();
    await panel.locator('.st-choice', { hasText: 'Just starting out' }).click();
    await expect(panel.locator('.st-choice', { hasText: 'Just starting out' })).toHaveAttribute('aria-pressed', 'true');
    await panel.locator('.st-choice', { hasText: 'England' }).click();
    // People: typing the age moves the State Pension age with it; a student loan under More options.
    await page.click('#setupNext');
    await expect(panel.locator('.st-tip')).toContainText('Starting out');
    const card = page.locator('#sec-household .people .item').first();
    const age = card.locator('label.field:has-text("Age now") input');
    await age.fill('62');
    await age.blur();
    await expect.poll(async () => (await plan()).household.people[0].statePensionAge).toBe(67);
    await age.fill('24');
    await age.blur();
    await expect.poll(async () => (await plan()).household.people[0].statePensionAge).toBe(68);
    await panel.locator('button', { hasText: 'Open “More options”' }).click();
    await card.locator('select[aria-label="Student loan plan"]').selectOption('plan2');
    await card.locator('label.field:has-text("Student loan owed") input').fill('40000');
    await expect(card.locator('[data-loan]')).toContainText('add your pay');
    // Pay before tax: the loan's repayments show on the person.
    await page.click('#setupNext');
    await panel.locator('.st-adds button', { hasText: 'Your pay' }).click();
    await ed().locator('input[aria-label="Amount"]').fill('35000');
    await ed().locator('select[aria-label="Frequency"]').selectOption('year');
    await ed().locator('label.field:has-text("Tax") select').first().selectOption('uk');
    await ed().locator('.edit-done button.primary').click();
    const p1 = await plan();
    expect(p1.household.people[0]).toMatchObject({ loanPlan: 'plan2', loanBalance: 40000 });
    expect(p1.household.people[0].loanEndYear).toBeGreaterThan(2040);
    // Home: renting, with a flat to buy later; it is listed but not counted yet.
    await panel.locator('.st-jump').selectOption({ label: '8. Your home and mortgage' });
    await panel.locator('.st-choice', { hasText: 'Renting' }).click();
    await expect(panel.locator('.st-field', { hasText: 'Amount owed' })).toHaveCount(0);
    await panel.locator('.st-adds button', { hasText: 'A home I’ll buy later' }).click();
    await ed().locator('label.field:has-text("Price today") input').fill('200000');
    await ed().locator('input[aria-label="Year you buy it"]').fill('2030');
    await expect(ed().locator('[data-buy]')).toContainText('In 2030 it costs about');
    await expect(ed().locator('[data-buy]')).toContainText('lenders usually stop at about 4.5 times');
    await expect(ed().locator('.tag.est')).toHaveText('buying in 2030');
    await ed().locator('.edit-done button.primary').click();
    await expect(panel.locator('.st-have')).toContainText('buying in 2030');
    // Rent, until the year of the purchase.
    await panel.locator('.st-adds button', { hasText: 'Rent (in spending)' }).click();
    await expect(page).toHaveURL(/finances\/spending/);
    await ed().locator('input[aria-label="Rent amount"]').fill('850');
    await ed().locator('select[aria-label="Ends"]').selectOption('year');
    await ed().locator('input[aria-label="Year it stops"]').fill('2030');
    await ed().locator('.edit-done button.primary').click();
    await expect(page.locator('#sec-expenses .sum-row', { hasText: 'Rent' })).toContainText('last paid in 2029');
    // Your own situation: a gift from family for the deposit, with a note, in the year of the purchase.
    await panel.locator('.st-jump').selectOption({ label: '11. Your own situation' });
    await expect(panel.locator('.st-group[open]')).not.toHaveCount(0);
    await expect(panel.locator('.st-recipe .info-btn')).not.toHaveCount(0);
    await panel.locator('.st-recipe', { hasText: 'Help from family towards a deposit' }).locator('.st-adds button').click();
    const gift = (await plan()).events[0];
    expect(gift).toMatchObject({ kind: 'income', year: 2030, note: 'From family; a gift, not a loan' });
    await expect(page.locator('#sec-events [data-editing] textarea[aria-label="Note"]')).toHaveValue('From family; a gift, not a loan');
    await page.locator('#sec-events [data-editing] .edit-done button.primary').click();
    await expect(page.locator('#sec-events .sum-row')).toContainText('“From family; a gift, not a loan”');
    // The plan: the flat is bought in 2030 with a mortgage, rent stops and the loan is repaid from pay.
    const rows = await page.evaluate(() => window.__horizon.model.proj.rows.map(r => ({ year: r.year, property: r.property, debt: r.debt, homeBuy: r.homeBuy, loan: r.studentLoan })));
    const at = y => rows.find(r => r.year === y);
    expect(at(2030).homeBuy).toBeGreaterThan(15000);
    expect(at(2031).property).toBeGreaterThan(200000);
    expect(at(2031).debt).toBeGreaterThan(150000);
    expect(at(2027).loan).toBeGreaterThan(300);
    await go(page, 'home');
    await openGroups(page);
    await expect(page.locator('#homePortfolio [data-account]')).toContainText('buying in 2030: not counted yet');
    expect(problems).toEqual([]);
  });
});

test.describe('closer to retirement', () => {
  test('putting off the State Pension and buying an annuity with part of a pot', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/assumptions');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan);
    const card = page.locator('#sec-household .people .item').first();
    await card.locator('details.more > summary', { hasText: 'More options' }).click();
    const defer = card.locator('input[aria-label="Years to put off the State Pension"]');
    await defer.fill('2');
    await defer.blur();
    await expect(card.locator('label.field:has-text("Put off the State Pension")')).toContainText('more');
    const p0 = await plan();
    expect(p0.household.people[0].spDefer).toBe(2);
    const spAge = p0.household.people[0].statePensionAge;
    // The first person's State Pension now starts two years after State Pension age.
    await expect.poll(() => page.evaluate(() => Array.from(window.__horizon.model.proj.pre.people[0].statePension).findIndex(v => v > 0)))
      .toBe(spAge + 2 - p0.household.people[0].age);
    // An annuity: from the income page, with its working.
    await go(page, 'finances/income');
    await page.locator('#sec-income .add-row button', { hasText: '+ Annuity' }).click();
    const ed = page.locator('[data-editing]').last();
    await ed.locator('input[aria-label="Pot spent on the annuity"]').fill('100000');
    await ed.locator('input[aria-label="Annuity income a year"]').fill('6500');
    await expect(ed.locator('[data-annuity]')).toContainText('a rate of 6.5%');
    await ed.locator('.edit-done button.primary').click();
    const a = (await plan()).income.find(i => i.kind === 'annuity');
    expect(a).toMatchObject({ cost: 100000, amount: 6500, tax: 'uk', inflationLinked: false });
    const bought = await page.evaluate(() => window.__horizon.model.proj.rows.reduce((s, r) => s + (r.annuityBought || 0), 0));
    expect(bought).toBeGreaterThan(100000);
    expect(problems).toEqual([]);
  });
});

test.describe('fixes from the pretend-user tests', () => {
  test('typing a year keeps the cursor; a defined benefit scheme takes the pay’s contributions; copies get their own names', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/spending');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan);
    // A year typed digit by digit (the section used to redraw after the first one).
    await page.locator('#sec-expenses .sum-row').first().click();
    await page.locator('#sec-expenses [data-editing] select[aria-label="Ends"]').selectOption('year');
    const year = page.locator('#sec-expenses [data-editing] input[aria-label="Year it stops"]');
    await year.click();
    await year.press('Control+a');
    await page.keyboard.type('2035', { delay: 30 });
    await expect(year).toHaveValue('2035');
    await expect(page.locator('#sec-expenses [data-editing] .timing-year small')).toHaveText('Not paid in 2035: 2034 is the last year.');
    expect((await plan()).expenses[0].toYear).toBe(2035);
    // A defined benefit pension for someone whose pay has pot contributions: one click stops the double count.
    await go(page, 'finances/income');
    await page.locator('#sec-income .add-row button', { hasText: '+ Defined benefit pension' }).click();
    const db = page.locator('#sec-income [data-editing]').last();
    await expect(db.locator('.db-pay')).toContainText('counted twice');
    await db.locator('.db-pay button').click();
    expect((await plan()).income.filter(i => i.kind === 'salary' && i.owner === 'p1').every(i => i.pensionTo === 'db')).toBe(true);
    await expect(page.locator('#sec-income [data-editing] .db-pay')).toHaveCount(0);
    // Copies of a scenario get their own names.
    await go(page, 'scenarios');
    await page.click('#dupScenario');
    await page.click('#dupScenario');
    const names = await page.evaluate(() => window.__horizon.ws.scenarios.map(s => s.name));
    expect(new Set(names).size).toBe(names.length);
    expect(names.some(n => / \(copy 2\)$/.test(n))).toBe(true);
    expect(problems).toEqual([]);
  });

  test('Home: set aside never shows more than the account holds', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      const bank = p.accounts.find(a => a.type === 'cash');
      p.reserves = [{ id: 'ef', kind: 'emergency', name: 'Emergency fund', accountId: bank.id, amount: bank.balance + 5000 }];
      window.__horizon.refresh();
    });
    await expect(page.locator('#pfReserves .pf-res-head')).toContainText('still to put aside');
    expect(problems).toEqual([]);
  });
  test('pension advice uses income after salary sacrifice; looking ahead, each pension shows its own pot', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/saving');
    // Alex (Scotland): £62,000 with 5% salary sacrifice, so about £58,900 is taxed and about £15,240
    // is above where 42% starts (£43,663), not £18,337 from pay before the sacrifice.
    await expect(page.locator('#view-finances')).toContainText(/Alex pays 42% tax on the top £15,2\d\d of income/);
    // Looking ahead, each person's pension account is their own pot from the projection.
    const ok = await page.evaluate(() => {
      const H = window.__horizon, p = H.ws.scenarios.find(s => s.id === H.ws.activeId).plan, pr = H.model.proj;
      const RV = window.Review, b = RV.expectedBalances(p, 10, pr).byId;
      return p.accounts.filter(a => a.type === 'pension').every(a => Math.abs(b[a.id] - pr.out.persons[window.Engine.personIndex(p, a.owner)].pension[10]) < 1);
    });
    expect(ok).toBe(true);
    expect(problems).toEqual([]);
  });

  test('the split is another way to split the same money, with your emergency fund and pay line', async ({ page }) => {
    const { problems } = await openApp(page);
    const split = page.locator('#ioSplit');
    await expect(split.locator('.io-split-head')).toContainText('Another way to split it');
    await expect(split.locator('.io-split-head')).toContainText(/Your plan puts the £[\d,]+ a month left over into/);
    await expect(split.locator('li', { hasText: 'Pension for Alex' })).toContainText(/of take-home pay puts about £[\d,]+ into the pension, with 42% relief/);
    // An emergency fund that counts ISAs: no cash step, the ISA line says it.
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      p.income.find(i => i.owner === 'p2' && i.kind === 'salary').amount += 1500;   // more left over, so the ISA line shows
      p.goals.push({ id: 'em', type: 'emergency', name: '', months: 6, counts: 'investments', year: p.startYear + 1, confidence: 80 });
      window.__horizon.refresh();
    });
    await expect(split.locator('li b', { hasText: /^Emergency fund$/ })).toHaveCount(0);
    await expect(split.locator('li', { hasText: 'Stocks & shares ISAs (Alex and Sam)' })).toContainText('emergency fund');
    // Pay kept just under £60,000 with children: more pension is an option, not a step.
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      const pay = p.income.find(i => i.owner === 'p1' && i.kind === 'salary');
      pay.amount = 63000; pay.pensionMode = 'pct'; pay.employeePension = 5; pay.sacrifice = true;   // £59,850 taxed
      p.life = { ...(p.life || {}), children: [{ name: 'Robin', age: 4 }] };
      window.__horizon.refresh();
    });
    await expect(split).not.toContainText('Pension for Alex');
    await expect(split.locator('.io-split-option')).toContainText('Alex’s pay is at £60,000, where the Child Benefit charge starts');
    expect(problems).toEqual([]);
  });

  test('each person’s ISA is their own: one not opened yet shows under their name', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      p.accounts = p.accounts.filter(a => !(a.type === 'isa' && a.owner === 'p2'));
      window.__horizon.refresh();
    });
    await page.click('#homePortfolio [data-ahead="5"]');
    await page.click('#homePortfolio [data-access="now"] .pf-class-btn');
    await page.click('#homePortfolio [data-type="isa"] .pf-toggle');
    const row = page.locator('#homePortfolio [data-to-open="isa:p2"]');
    await expect(row).toBeVisible();
    await expect(row).toContainText('Sam stocks & shares ISA');
    // Alex's ISA and Sam's to open add up to the ISA total.
    const sums = await page.evaluate(() => {
      const H = window.__horizon, p = H.ws.scenarios.find(s => s.id === H.ws.activeId).plan;
      const b = window.Review.expectedBalances(p, 5, H.model.proj);
      const alex = p.accounts.find(a => a.type === 'isa');
      return [b.byId[alex.id] + b.missing.find(m => m.type === 'isa' && m.owner === 'p2').value, H.model.proj.rows[5].isa];
    });
    expect(Math.abs(sums[0] - sums[1])).toBeLessThan(1);
    expect(problems).toEqual([]);
  });

  test('pay into a defined benefit scheme can also pay into a pot; the goal subtitle names its person', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/income');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      p.income.find(i => i.owner === 'p1' && i.kind === 'salary').pensionTo = 'db';
      window.__horizon.refresh();
    });
    await page.locator('#sec-income .sum-row', { hasText: 'Alex salary' }).click();
    const item = page.locator('#sec-income [data-editing]');
    await item.locator('summary', { hasText: 'More options' }).click();
    await expect(item.locator('.pot-alongside')).toContainText('Also into a pension pot');
    await item.locator('.pot-alongside button', { hasText: 'Add The Match (1% + 1%)' }).click();
    const pay = (await plan()).income.find(i => i.owner === 'p1' && i.kind === 'salary');
    expect(pay.potEmployee).toBeGreaterThan(40);
    expect(pay.potEmployer).toBe(pay.potEmployee);
    // A retirement goal for the second person names them, not the first.
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios.find(s => s.id === window.__horizon.ws.activeId).plan;
      p.goals.push({ id: 'samret', type: 'retire', owner: 'p2', age: 58, confidence: 85 });
      window.__horizon.refresh();
    });
    await go(page, 'goal/samret');
    await expect(page.locator('main')).toContainText(/Sam retires at 58 \(\d{4}\), with 85% confidence wanted/);
    expect(problems).toEqual([]);
  });
});

test.describe('round 2 fixes', () => {
  test('names follow the owner; the main plan can’t be deleted; the guide’s button says Next step', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/portfolio');
    await page.click('#sec-accounts summary:has-text("Add an account")');
    await page.click('#sec-accounts button:has-text("+ ISA")');
    const added = page.locator('#sec-accounts [data-editing]').last();
    await added.locator('input.name').fill('Alex ISA 2');
    await added.locator('select').filter({ has: page.locator('option[value="p2"]') }).first().selectOption('p2');
    await expect(page.locator('#sec-accounts [data-editing]').last().locator('input.name')).toHaveValue('Sam ISA 2');
    await go(page, 'scenarios');
    await expect(page.locator('button', { hasText: 'Delete this scenario' })).toBeDisabled();
    await page.click('#dupScenario');
    await expect(page.locator('button', { hasText: 'Delete this scenario' })).toBeEnabled();
    await page.evaluate(() => window.__horizon.openSetup());
    await expect(page.locator('#setupNext')).toHaveText('Next step');
    await expect(page.locator('#ovGoalStrip .car-btn').last()).toHaveAttribute('aria-label', 'Next goal');
    expect(problems).toEqual([]);
  });

  test('a mortgage payment is checked against the years left; an ISA can be a cash ISA; an inherited pension', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/portfolio');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    // £420,000 at 4.6% and £2,350 a month takes about 26 years, not the 21 on the statement.
    await page.evaluate(() => {
      const H = window.__horizon, m = H.ws.scenarios[0].plan.accounts.find(a => a.type === 'debt');
      Object.assign(m, { balance: 420000, rate: 4.6, payment: 2350, termYears: 21, fixedUntil: 0 });
      H.refresh();
    });
    await page.locator('#sec-accounts .sum-row', { hasText: 'Mortgage' }).first().click();
    const ed = page.locator('#sec-accounts [data-editing]');
    await expect(ed.locator('[data-payoff]')).toContainText(/paid off in about 205\d/);
    await expect(ed.locator('[data-payoff]')).toContainText(/To clear it in 21 years the payment would be about £2,[67]\d\d a month/);
    await ed.locator('.edit-done button.primary').click();
    // An ISA held as cash.
    await page.locator('#sec-accounts .sum-row', { hasText: 'Sam' }).filter({ hasText: 'ISA' }).first().click();
    await page.locator('#sec-accounts [data-editing] select[aria-label="Held as"]').selectOption('cash');
    await expect(page.locator('#sec-accounts [data-editing]')).toContainText('counts as cash for an emergency fund');
    expect((await plan()).accounts.find(a => a.type === 'isa' && a.owner === 'p2').holding).toBe('cash');
    await page.locator('#sec-accounts [data-editing] .edit-done button.primary').click();
    // An inherited pension.
    await page.locator('#sec-accounts .sum-row', { hasText: 'pension' }).first().click();
    const pen = page.locator('#sec-accounts [data-editing]');
    await pen.locator('summary', { hasText: 'More options' }).click().catch(() => {});
    await pen.locator('label.switch', { hasText: 'Inherited from someone who died before 75' }).click();
    await expect(pen).toContainText('Tax-free to take out, at any age');
    expect((await plan()).accounts.filter(a => a.type === 'pension').some(a => a.inherited)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('keeping income under £100,000 says when the pension allowance can’t get there', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/saving');
    await page.evaluate(() => {
      const H = window.__horizon, p = H.ws.scenarios[0].plan;
      const pay = p.income.find(i => i.owner === 'p1' && i.kind === 'salary');
      pay.amount = 200000; pay.freq = 'year'; pay.tax = 'uk';
      p.strategy.stayUnder100k = true;
      H.refresh();
    });
    await expect(page.locator('[data-flow="sacrificed"]')).toContainText(/It only gets Alex to about £1\d\d,\d\d\d of income .*annual allowance caps/);
    await expect(page.locator('#view-finances')).toContainText('the 30 hours of free childcare');
    expect(problems).toEqual([]);
  });

  test('already retired: retirement is now, a pension being paid is one amount, the State Pension a week', async ({ page }) => {
    const { problems } = await openApp(page, '', { setup: true });
    const panel = page.locator('#setupPanel');
    await panel.locator('.st-choice', { hasText: 'Yes, start my own plan' }).click();
    await panel.locator('.st-choice', { hasText: 'Already retired' }).click();
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    let q = await plan();
    expect(q.household.people[0].retireAge).toBe(q.household.people[0].age);
    expect(q.assumptions.stockPctNow).toBe(60);
    await page.click('#setupNext');
    await expect(panel).toContainText('Set to your age now, as you are retired.');
    await page.keyboard.press('Escape');
    // The State Pension typed a week fills in the year.
    await go(page, 'finances/assumptions');
    await page.locator('#sec-household summary', { hasText: 'More options' }).first().click();
    const week = page.locator('#sec-household input[aria-label="State Pension a week"]').first();
    await week.fill('230');
    await week.blur();
    q = await plan();
    expect(q.household.people[0].statePension).toBe(11960);
    // A council pension already being paid: one amount a year now.
    await go(page, 'finances/income');
    await page.locator('#sec-income .add-row button', { hasText: '+ Defined benefit pension' }).click();
    const db = page.locator('#sec-income [data-editing]').last();
    await db.locator('label.switch', { hasText: 'Already being paid' }).click();
    await expect(page.locator('#sec-income [data-editing]').last()).toContainText('Paid now (£ a year)');
    await expect(page.locator('#sec-income [data-editing]').last()).not.toContainText('Added each year you keep working');
    expect(problems).toEqual([]);
  });

  test('a banner says which scenario is open; the table compares with the main plan and renames live', async ({ page }) => {
    const { problems } = await openApp(page);
    await expect(page.locator('#scenBanner')).toBeHidden();
    await go(page, 'scenarios');
    await page.click('#dupScenario');
    await expect(page.locator('#scenBanner')).toBeVisible();
    await expect(page.locator('#scenBanner')).toContainText('You’re looking at the scenario “Base plan (copy)”');
    const name = page.locator('#sec-scenario input[aria-label="Scenario name"]');
    await name.fill('Retire later');
    await expect(page.locator('#compareResults')).toContainText('compare with your main plan, Base plan');
    await expect(page.locator('#compareResults tr[data-scenario] th strong', { hasText: 'Retire later' })).toHaveCount(1);
    await expect(page.locator('#compareResults tr', { hasText: 'Main plan' })).toContainText('Base plan');
    // The main plan's row has no Delete.
    await expect(page.locator('#compareResults tr', { hasText: 'Main plan' }).locator('button', { hasText: 'Delete' })).toHaveCount(0);
    await page.click('#backToMain');
    await expect(page.locator('#scenBanner')).toBeHidden();
    expect(await page.evaluate(() => window.__horizon.ws.activeId === window.__horizon.ws.scenarios[0].id)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('typing in one field and clicking the next keeps both; an expense’s More stays open', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/assumptions');
    const card = page.locator('#sec-household .people .item').first();
    const age = card.locator('input[aria-label="Age now"], .fields input[type="number"]').first();
    await age.click();
    await age.fill('41');
    await card.locator('.fields input[type="number"]').nth(1).click();
    await page.keyboard.press('Control+a');
    await page.keyboard.type('62');
    await page.keyboard.press('Tab');
    await expect.poll(() => page.evaluate(() => window.__horizon.ws.scenarios[0].plan.household.people[0].retireAge)).toBe(62);
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.household.people[0].age)).toBe(41);
    // Spending: Starts → In year… keeps the More panel open with its year box.
    await go(page, 'finances/spending');
    await page.locator('#sec-expenses .sum-row').first().click();
    await page.locator('#sec-expenses [data-editing] details summary').first().click();
    await page.locator('#sec-expenses [data-editing] select[aria-label="Starts"]').selectOption('year');
    await expect(page.locator('#sec-expenses [data-editing] input[aria-label="First year"]')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('a bonus and share awards on pay, a month for a cost, a move to a smaller home and equity release', async ({ page }) => {
    const { problems } = await openApp(page, 'finances/income');
    const plan = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    await page.locator('#sec-income .sum-row', { hasText: 'Alex salary' }).click();
    const pay = page.locator('#sec-income [data-editing]');
    await pay.locator('summary', { hasText: 'More options' }).click();
    await pay.locator('input[aria-label="Bonus a year"]').fill('8000');
    await pay.locator('input[aria-label="Share awards a year"]').fill('5000');
    await pay.locator('input[aria-label="Share awards a year"]').blur();
    await page.locator('#sec-income [data-editing] .edit-done button.primary').click();
    await page.locator('#sec-income .sum-row', { hasText: 'Alex salary' }).click();
    // More options remembers it was open.
    const gia = (await plan()).accounts.find(a => a.type === 'gia');
    await page.locator('#sec-income [data-editing] select[aria-label="Shares kept or sold"]').selectOption(gia.id);
    let q = await plan();
    const it = q.income.find(i => i.name === 'Alex salary');
    expect(it.bonus).toBe(8000);
    expect(it.sharesTo).toBe(gia.id);
    await expect(page.locator('#sec-income .sum-row', { hasText: 'Alex salary' })).toHaveCount(0);   // still open
    await page.locator('#sec-income [data-editing] .edit-done button.primary').click();
    await expect(page.locator('#sec-income .sum-row', { hasText: 'Alex salary' })).toContainText('+ £8,000 bonus a year');
    // A cost to the end of August.
    await go(page, 'finances/spending');
    await page.locator('#sec-expenses .sum-row').first().click();
    const ex = page.locator('#sec-expenses [data-editing]');
    await ex.locator('select[aria-label="Ends"]').selectOption('year');
    await page.locator('#sec-expenses [data-editing] select[aria-label="Last month paid"]').selectOption('8');
    await expect(page.locator('#sec-expenses [data-editing] .timing-year small')).toContainText(/Paid to the end of August \d{4}: 8 months that year/);
    await page.locator('#sec-expenses [data-editing] .edit-done button.primary').click();
    // The home: equity release and a move.
    await go(page, 'finances/portfolio');
    await page.locator('#sec-accounts .sum-row', { hasText: 'Property' }).first().click();
    const home = page.locator('#sec-accounts [data-editing]');
    await home.locator('summary', { hasText: 'More options' }).click().catch(() => {});
    await expect(home.locator('.equity-release')).toContainText('Equity release (a lifetime mortgage)');
    await home.locator('.move-home input[aria-label="Year to move"]').fill('2040');
    await home.locator('.move-home button', { hasText: 'Set up the move' }).click();
    q = await plan();
    expect(q.accounts.some(a => a.type === 'property' && a.buyYear === 2040 && a.deposit === 100)).toBe(true);
    expect(q.events.some(e => /Moving/.test(e.name) && e.year === 2040)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('the steps can be added to a calendar, each on its date with a reminder', async ({ page }) => {
    const { problems } = await openApp(page);
    // Voluntary NI after stopping work is a step, with how to pay it.
    await page.evaluate(() => { const H = window.__horizon, x = H.ws.scenarios[0].plan.household.people[0]; x.niYears = 9; x.niVoluntary = true; H.refresh(); });
    await page.locator('#ovTodo summary', { hasText: 'Later on' }).click();
    await expect(page.locator('#ovTodo')).toContainText(/Alex: pay voluntary NI for \d+ years/);
    await expect(page.locator('#ovTodo')).toContainText('Pay voluntary Class 3 National Insurance');
    const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#todoCalendar')]);
    expect(dl.suggestedFilename()).toBe('horizon-plan-steps.ics');
    const text = require('fs').readFileSync(await dl.path(), 'utf8');
    expect(text.startsWith('BEGIN:VCALENDAR')).toBe(true);
    expect(text).toContain('RRULE:FREQ=YEARLY');
    expect(text).toContain('BEGIN:VALARM');
    expect(text.match(/BEGIN:VEVENT/g).length).toBeGreaterThan(5);
    expect(text.split('\r\n').every(l => l.length <= 75)).toBe(true);
    expect(problems).toEqual([]);
  });

  test('a goal that leaves out pensions says what it counts, next to what Home shows', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const H = window.__horizon, p = H.ws.scenarios[0].plan;
      p.goals.push({ id: 'nwx', type: 'netWorth', amount: 500000, year: p.startYear + 5, measure: 'noPension', basis: 'nominal', confidence: 80 });
      H.refresh();
    });
    await go(page, 'goal/nwx');
    await expect(page.locator('main')).toContainText(/net worth excluding pensions is about £[\d,]+ in \d{4}, against £500,000; with pensions it is £[\d,]+, the figure Home shows/);
    expect(problems).toEqual([]);
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

test.describe('review of 13 November', () => {
  test('a household that has stopped work sees no working-years settings or advice', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios[0].plan;
      p.household.people.forEach((x, i) => { x.age = 72 - i; x.retireAge = x.age; x.statePensionAge = 66; });
      p.income = p.income.filter(i => i.kind !== 'salary');
      p.income.push({ id: 'db', name: 'Council pension', kind: 'dbpension', owner: 'p1', tax: 'uk', amount: 9000, freq: 'year', startRef: 'now', startAge: 60, endRef: 'end', inflationLinked: true, growth: 0, raises: [] });
      p.accounts = p.accounts.filter(a => a.type !== 'debt');
      // Saved as a file would be: the plan is tidied when it is opened again.
      localStorage.setItem('horizon-uk-v3', JSON.stringify(window.__horizon.ws));
    });
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    // Pensions can be drawn, so they are not "locked away".
    await expect(page.locator('#homePortfolio')).not.toContainText('Locked away');
    await expect(page.locator('#homePortfolio')).toContainText('Can be drawn now');
    await expect(page.locator('#view-home')).not.toContainText('Can you retire earlier?');
    await expect(page.locator('#view-home')).not.toContainText('What will retirement cost?');
    // The steps say what to take from savings now, though nobody is about to retire.
    await expect(page.locator('#ovTodo')).toContainText(/Take about .* a month from savings|Savings no longer needed/);
    // The retirement goal: no "what retiring then means", the pension is being paid.
    await openGoal(page, 'money lasts to');
    await expect(page.locator('#view-goal')).toContainText('has retired; the money is to last to');
    await expect(page.locator('#gpTradeoffs')).toHaveCount(0);
    await expect(page.locator('.rq-facts')).toContainText('being paid now');
    await expect(page.locator('.rq-facts')).toContainText('Retired');
    await expect(page.locator('#view-goal')).not.toContainText('Retire 2 years later');
    // Saving: nothing about pay.
    await go(page, 'finances/saving');
    await expect(page.locator('#sec-saving')).not.toContainText('Extra into');
    await expect(page.locator('#sec-saving')).not.toContainText('Above £100,000');
    await expect(page.locator('#sec-strategy')).not.toContainText('Spending before retirement');
    await go(page, 'finances/income');
    await expect(page.locator('#sec-income')).toContainText('being paid now');
    expect(problems).toEqual([]);
  });

  test('pension advice stays within the annual allowance', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios[0].plan;
      const pay = p.income.find(i => i.kind === 'salary' && i.owner === 'p1');
      pay.amount = 260000; pay.shares = 30000;
      window.__horizon.refresh();
    });
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    await go(page, 'finances/saving');
    const order = page.locator('#view-finances', { hasText: 'Suggested order' });
    await expect(order).toContainText('annual allowance has room for');
    // 5% + 5% of £260,000 already goes in: room for £34,000 a year, £2,833 a month.
    await expect(order).toContainText('up to £2,833 a month');
    await go(page, 'finances/income');
    await expect(page.locator('#sec-income')).toContainText('+ £30,000 share awards a year');
    // Keeping income under £60,000: the £100,000 question is not asked (a "no" would undo it).
    const asked = await page.evaluate(() => {
      const ws = window.__horizon.ws;
      ws.scenarios[0].plan.strategy.stayUnderLine = 60000;
      localStorage.setItem('horizon-uk-v3', JSON.stringify(ws));
      return true;
    });
    expect(asked).toBe(true);
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    await page.evaluate(() => window.__horizon.navigate('home'));
    await page.locator('[data-insight="guide-questions"] button.primary').click();
    for (let k = 0; k < 25; k++) {
      await expect(page.locator('#gdTitle')).not.toContainText('above £100,000');
      if ((await page.locator('#gdNext').innerText()) !== 'Next') break;
      await page.locator('#gdNext').click();
    }
    expect(problems).toEqual([]);
  });
});

test.describe('round 3 user tests', () => {
  test('a blank plan: plain “you”, a buffer that follows spending, and steps that agree with the goal', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.click('#dataMenu summary');
    await page.click('#blankBtn');
    await page.waitForFunction(() => window.__horizon.ws.scenarios[0].plan.household.people[0].name === 'You');
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios[0].plan;
      p.household.people[0].age = 46; p.household.people[0].retireAge = 63;
      p.accounts.push({ id: 'bank', name: 'Bank', type: 'cash', owner: 'joint', balance: 2100 });
      p.income.push({ id: 'pay', name: 'My pay', kind: 'salary', owner: 'p1', tax: 'none', amount: 1750, freq: 'month', endRef: 'retire' });
      p.expenses.push({ id: 'rent', name: 'Rent', amount: 520, freq: 'month' }, { id: 'food', name: 'Food', amount: 380, freq: 'month' }, { id: 'bus', name: 'Bus pass', amount: 62, freq: 'month' });
      p.goals.push({ id: 'ret', type: 'retire', person: 'p1', age: 63, confidence: 85 });
      localStorage.setItem('horizon-uk-v3', JSON.stringify(window.__horizon.ws));
    });
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    // The buffer is three months of the spending listed, not £15,000.
    expect(await page.evaluate(() => window.__horizon.ws.scenarios[0].plan.strategy.cashReserve)).toBe(2900);
    await go(page, 'home');
    const home = page.locator('#view-home');
    await expect(home).toContainText('Is your spending list complete?');
    await expect(home).not.toContainText(/You is|You’s|You retires|You has/);
    // Home's step and the goal's "this year" say the same thing.
    await expect(page.locator('#ovTodo')).toContainText(/into savings|into ISAs/);
    await openGoal(page, 'Retire at 63');
    const goal = page.locator('#view-goal');
    await expect(goal).not.toContainText('Nothing left over to invest');
    await expect(goal).not.toContainText(/You is|You’s|You retires|You has/);
    await expect(goal).toContainText(/you retire at 63|You retire at 63/);
    // Typing a buffer of your own stops it following the spending.
    await go(page, 'finances/saving');
    const buf = page.locator('#sec-strategy input[aria-label="Cash buffer to keep"]');
    await buf.fill('5000');
    await buf.blur();
    await page.waitForTimeout(700);
    expect(await page.evaluate(() => { const s = window.__horizon.ws.scenarios[0].plan.strategy; return [s.cashReserve, s.autoBuffer]; })).toEqual([5000, false]);
    expect(problems).toEqual([]);
  });

  test('a pension from a letter is not cut; the guide does not add the same empty item twice', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios[0].plan;
      p.income.push({ id: 'old', name: 'Old job pension', kind: 'dbpension', dbScheme: 'other', owner: 'p1', tax: 'uk', amount: 3200, freq: 'year', startAge: 65, dbAccrual: 0 });
      localStorage.setItem('horizon-uk-v3', JSON.stringify(window.__horizon.ws));
    });
    await page.reload();
    await page.waitForFunction(() => window.__horizon && window.__horizon.model);
    await go(page, 'finances/income');
    const calc = page.locator('[data-calc="old"]');
    if (!(await calc.count())) await page.locator('#sec-income').getByText('Old job pension').first().click();
    await expect(page.locator('[data-calc="old"]')).toContainText('= £3,200 a year');
    await expect(page.locator('[data-calc="old"]')).not.toContainText('before the Normal Pension Age');
    await expect(page.locator('#sec-income')).toContainText('The scheme’s full pension age');
    // The guide: "+ Other income" twice leaves one empty item, not two.
    const count = () => page.evaluate(() => window.__horizon.ws.scenarios[0].plan.income.filter(i => i.kind === 'other' && !(i.amount > 0)).length);
    const before = await count();
    await page.evaluate(() => window.__horizon.openSetup(3));
    await page.locator('#setupPanel').getByRole('button', { name: '+ Other income' }).click();
    await page.locator('#setupPanel').getByRole('button', { name: '+ Other income' }).click();
    expect(await count()).toBe(before + 1);
    expect(problems).toEqual([]);
  });
});

test.describe('quick start', () => {
  test('a first visit asks a few plain questions and ends on a plan with the answer in words', async ({ page }) => {
    const { problems } = await openApp(page, '', { quick: true });
    const body = page.locator('#qsBody');
    const fill = (label, v) => body.locator(`input[aria-label="${label}"]`).fill(String(v));
    const pick = t => body.locator('.qs-choice', { hasText: t }).first().click();
    const next = () => page.click('#qsNext');
    // The example is labelled as one, and the welcome screen has one main button.
    await expect(page.locator('#quickDlg')).toBeVisible();
    await expect(page.locator('#exampleBanner')).toContainText('example household');
    await expect(body).toContainText('Will my money be OK?');
    await page.click('#qsStart');
    // An age is needed: said in words, and nothing moves on.
    await next();
    await expect(body.locator('.qs-err')).toContainText('Please type your age');
    await fill('Your age', 27);
    await next();
    // Nothing chosen: asked to choose.
    await next();
    await expect(body.locator('.qs-err')).toContainText('Please choose');
    await pick('What lands in the bank');
    await expect(body).toContainText('How do you know your pay?');
    await fill('Take-home pay a month', 1850);
    await next();
    await pick('Not sure');
    await expect(body).toContainText('Leave them: 5% and 3% are the usual amounts');
    await next();
    await fill('Bank and savings', 1400);
    await next();
    await pick('Renting');
    await fill('Rent a month', 475);
    await next();
    await page.click('#qsAddDebt');
    await body.locator('.qs-debt select').selectOption('overdraft');
    await fill('Amount owed', 300);
    await next();
    // Spending: a figure that leaves a lot unspent is questioned; "what is left" works it out instead.
    await pick('I know roughly what I spend');
    await fill('Spending a month', 500);
    await expect(body.locator('#qsLeft')).toContainText('this figure is too low');
    await pick('what is left at the end');
    await fill('Left over a month', 50);
    await expect(body.locator('#qsLeft')).toContainText('a month goes on everything else');
    await next();
    await expect(page.locator('#qsNext')).toHaveText('Show me my plan');
    await next();
    await expect(page.locator('#quickDlg')).toBeHidden();
    // The plan: theirs, not the example; the answer in words comes first.
    await expect(page.locator('#exampleBanner')).toBeHidden();
    const short = page.locator('#homeShort');
    await expect(short).toContainText('In short');
    await expect(short).toContainText(/Retire at \d+\?/);
    await expect(short).toContainText('of 100 futures tried');
    await expect(short).toContainText('This month');
    const plan = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(plan.household.people.map(x => x.age)).toEqual([27]);
    expect(plan.income[0].amount).toBe(1850);
    expect(plan.expenses.map(e => e.name)).toEqual(['Rent', 'Everything else']);
    expect(plan.accounts.map(a => a.name).sort()).toEqual(['Bank and savings', 'My pension', 'Overdraft']);
    // No mortgage: nothing on Home calls the overdraft one.
    await expect(page.locator('#view-home')).not.toContainText(/mortgage paid off/i);
    // "Make it more exact" opens the full guide.
    await short.getByRole('button', { name: 'Make it more exact' }).click();
    await expect(page.locator('#setupPanel')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('the quick start fits a phone screen and can be left for the example', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { problems } = await openApp(page, '', { quick: true });
    const over = () => page.evaluate(() => [...document.querySelectorAll('#quickDlg *')].filter(el => { const r = el.getBoundingClientRect(); return r.width && r.right > window.innerWidth + 1; }).length);
    expect(await over()).toBe(0);
    await page.click('#qsStart');
    await page.locator('#qsBody .qs-choice', { hasText: 'Me and a partner' }).click();
    expect(await over()).toBe(0);
    await page.click('#qsClose');
    await expect(page.locator('#quickDlg')).toBeHidden();
    await expect(page.locator('#exampleBanner')).toBeVisible();
    // The banner's button brings the questions back.
    await page.click('#exampleStart');
    await expect(page.locator('#qsBody')).toContainText('Will my money be OK?');
    expect(problems).toEqual([]);
  });
});

test.describe('the dossier', () => {
  test('the plan written out year by year, opened from Home, shortened, and closed again', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.click('#shortDossier');
    const doc = page.locator('#docBody');
    await expect(doc.locator('h1')).toHaveText('Alex and Sam’s plan, year by year');
    await expect(page.locator('main')).toBeHidden();
    // One block for every year of the plan, each with the same parts.
    const years = await page.evaluate(() => window.__horizon.model.proj.rows.length - 1);
    await expect(doc.locator('.doc-year')).toHaveCount(years);
    const first = doc.locator('.doc-year').first();
    for (const part of ['Money coming in', 'What comes off first', 'Money going out', 'What is left, and where to put it', 'Pensions', 'Mortgage and loans', 'Where you should be at the end of the year']) await expect(first).toContainText(part);
    await expect(first).toContainText('To do this year');
    await expect(first).toContainText(/a month comes in after tax and pension/);
    // The year someone stops work says so, and says what to draw instead.
    const stop = doc.locator('#doc-2043');
    await expect(stop).toContainText('Alex stops work this year, at 55');
    await expect(stop).toContainText('What to take from savings and pensions');
    for (const id of ['doc-short', 'doc-read', 'doc-assume', 'doc-dates', 'doc-range', 'doc-words']) await expect(doc.locator(`#${id}`)).toHaveCount(1);
    await expect(doc.locator('#doc-dates')).toContainText('Fixed rate on Mortgage ends');
    // Fewer years on request.
    await page.selectOption('#docYears', { label: 'The next five years' });
    await expect(doc.locator('.doc-year')).toHaveCount(5);
    // Print styles: only the document, and each year starts a page.
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('.doc-bar')).toBeHidden();
    expect(await doc.locator('.doc-year').nth(1).evaluate(el => getComputedStyle(el).breakBefore)).toBe('page');
    await page.emulateMedia({ media: 'screen' });
    await page.click('#docClose');
    await expect(page.locator('#dossier')).toBeHidden();
    await expect(page.locator('main')).toBeVisible();
    expect(problems).toEqual([]);
  });

  test('the dossier has pictures: the whole plan in charts, and each year at a glance', async ({ page }) => {
    const { problems } = await openApp(page);
    // The plan has its own place in the row of pages, and a box of its own on Home.
    await expect(page.locator('#homeShort .short-plan')).toContainText('Your plan, year by year');
    await page.click('#tabDossier');
    const doc = page.locator('#docBody');
    const pics = doc.locator('#doc-pictures');
    for (const title of ['What you own and owe, year by year', 'Money in and money out, each year', 'Pension pots', 'What is still owed', 'How far off it could be']) await expect(pics).toContainText(title);
    await expect(pics.locator('svg.doc-svg')).toHaveCount(5);
    await expect(pics.locator('svg.doc-svg').first()).toContainText('Alex retires');
    // Every year: a bar of where the money goes (its shares add up), the year marked on the whole plan, and what is owned.
    const first = doc.locator('.doc-year').first();
    await expect(first.locator('.doc-glance')).toContainText('The year at a glance');
    const widths = await first.locator('.doc-glance .doc-barline i').evaluateAll(els => els.map(el => parseFloat(el.style.width)));
    expect(widths.length).toBeGreaterThan(2);
    expect(Math.abs(widths.reduce((a, b) => a + b, 0) - 100)).toBeLessThan(0.01);
    await expect(first.locator('.doc-glance svg circle')).toHaveCount(1);
    await expect(first).toContainText('What you own at the end of 2026, by kind');
    expect(problems).toEqual([]);
  });

  test('what to do now, before the tax year ends and next year; and what would get a missed goal there', async ({ page }) => {
    const { problems } = await openApp(page);
    // Home's steps have a group for this tax year and say what to set up next year.
    const todo = page.locator('#ovTodo');
    await expect(todo.locator('.todo-item[data-when="This tax year"]').first()).toContainText(/By (31 January|5 April) \d{4}/);
    await expect(todo.locator('.todo-item[data-when="2027"]').filter({ hasText: 'Set the monthly amounts for the year' })).toContainText(/£[\d,]+ a month into ISAs \(£[\d,]+ last year\)/);
    await expect(todo.locator('.todo-item[data-when="2027"]').filter({ hasText: 'start looking at new deals' })).toContainText('The fixed rate ends in 2028');
    // Goals on track have nothing to add.
    await expect(page.locator('#homeShort .short-goal', { hasText: 'retires at 55' }).locator('.ways')).toHaveCount(0);
    // Make the example miss: stop work six years sooner.
    await page.evaluate(() => {
      const H = window.__horizon, pl = H.ws.scenarios.find(s => s.id === H.ws.activeId).plan;
      for (const q of pl.household.people) q.retireAge -= 6;
      for (const g of pl.goals) if (g.type === 'retire') g.age -= 6;
      H.refresh();
    });
    const ways = page.locator('#homeShort .short-goal', { hasText: 'retires at 49' }).locator('.ways');
    await expect(ways).toContainText('What would get you there', { timeout: 20000 });
    await expect(ways).toContainText(/Spend about £[\d,]+ a month less from now until work stops/);
    await expect(ways).toContainText(/Stop work \d+ years? later/);
    // The plan opens with the same answers and a sheet to act on.
    await page.click('#tabDossier');
    const doc = page.locator('#docBody');
    await expect(doc.locator('#doc-short .ways').first()).toContainText('What would get you there', { timeout: 20000 });
    const sheet = doc.locator('#doc-do');
    await expect(sheet.locator('.doc-box h3')).toHaveText(['Now', 'Before the tax year ends', 'Next year (2027)', 'Every year']);
    await expect(sheet).toContainText('Pay £');
    await expect(sheet).toContainText('use this year’s ISA allowance');
    await expect(sheet).toContainText('Set the monthly amounts for the year');
    // Every later year has something to do; the amounts are not listed twice in 2027.
    await expect(doc.locator('#doc-2027 .doc-box.todo li').filter({ hasText: 'Set the monthly amounts' })).toHaveCount(1);
    await expect(doc.locator('#doc-2031 .doc-box.todo')).toContainText('Set the monthly amounts for the year');
    // The short version: only the answers, the sheet and the dates.
    await page.selectOption('#docYears', '-1');
    await expect(doc.locator('h1')).toContainText('what to do');
    await expect(doc.locator('.doc-year')).toHaveCount(0);
    await expect(doc.locator('#doc-do')).toBeVisible();
    await expect(doc.locator('#doc-dates')).toBeVisible();
    await page.selectOption('#docYears', '5');
    await expect(doc.locator('.doc-year')).toHaveCount(5);
    expect(problems).toEqual([]);
  });

  test('the dossier on a narrow screen: nothing runs off the page or into the next column', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const { problems } = await openApp(page);
    await page.evaluate(() => window.__horizon.openDossier());
    await page.selectOption('#docYears', { label: 'The next five years' });
    const over = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth, out = [];
      if (document.documentElement.scrollWidth > vw + 1) out.push('page scrolls sideways');
      for (const el of document.querySelectorAll('#docBody *')) {
        if (el.closest('.doc-scroll')) continue;
        const r = el.getBoundingClientRect();
        if (r.width && r.right > vw + 1) out.push(`${el.tagName} runs off: ${(el.textContent || '').slice(0, 30)}`);
        if (el.tagName === 'TD' && el.scrollWidth > el.clientWidth + 1) out.push(`cell overflows: ${el.textContent.slice(0, 30)}`);
      }
      return out;
    });
    expect(over).toEqual([]);
    // Charts are drawn for the narrow column, not shrunk from a wide one.
    expect(await page.locator('#doc-pictures svg.doc-svg').first().evaluate(el => el.viewBox.baseVal.width)).toBeLessThan(400);
    expect(problems).toEqual([]);
  });

  test('an amount goal: charts stop a few years after its date, and history has its own chart', async ({ page }) => {
    const { problems } = await openApp(page);
    const goal = await page.evaluate(() => { const g = window.__horizon.ws.scenarios[0].plan.goals.find(x => x.type === 'netWorth'); return { id: g.id, year: g.year }; });
    await page.evaluate(id => window.__horizon.navigate(`goal/${id}`), goal.id);
    await expect(page.locator('#gpHistoryChart')).toBeVisible({ timeout: 20000 });
    await expect(page.locator('#gpHistory')).toContainText('compare it with “How it’s tracking”');
    await expect(page.locator('#view-goal')).toContainText('simulated futures drawn from your assumptions');
    // The table view of the tracking chart ends within a few years of the target (or of when it is expected).
    await page.locator('#view-goal').getByRole('button', { name: 'Table' }).first().click();
    const last = await page.locator('#view-goal table.data').first().locator('tbody tr').last().locator('td, th').first().innerText();
    expect(Number(last)).toBeLessThan(goal.year + 12);
    expect(Number(last)).toBeGreaterThanOrEqual(goal.year);
    expect(problems).toEqual([]);
  });
});

test.describe('the guide beside the page', () => {
  test('each step shows only the part of the page it is about, and the whole page on request', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => window.__horizon.openSetup(1));
    await expect(page.locator('#setupPanel')).toBeVisible();
    await expect(page.locator('#sec-household')).toBeVisible();
    // The markets section and the charts beside it are put away while this step is open.
    await expect(page.locator('#sec-market')).toBeHidden();
    await expect(page.locator('#setupPanel')).toContainText('shows only the part this step is about');
    await page.click('#setupWhole');
    await expect(page.locator('#sec-market')).toBeVisible();
    await page.click('#setupWhole');
    await expect(page.locator('#sec-market')).toBeHidden();
    // Another step, another part.
    await page.click('#setupNext');
    await expect(page.locator('#sec-income')).toBeVisible();
    await expect(page.locator('#sec-household')).toBeHidden();
    // Closing the guide brings everything back.
    await page.locator('#setupPanel button[aria-label^="Close the guide"]').click();
    await expect(page.locator('#setupPanel')).toBeHidden();
    await go(page, 'finances/assumptions');
    await expect(page.locator('#sec-market')).toBeVisible();
    await expect(page.locator('#sec-household')).toBeVisible();
    expect(await page.locator('.setup-away').count()).toBe(0);
    expect(problems).toEqual([]);
  });

  test('the quick start asks about a set pension, children, a student loan and a home to buy', async ({ page }) => {
    const { problems } = await openApp(page, '', { quick: true });
    const body = page.locator('#qsBody');
    const fill = (label, v) => body.locator(`input[aria-label="${label}"]`).fill(String(v));
    const pick = t => body.locator('.qs-choice', { hasText: t }).first().click();
    const next = () => page.click('#qsNext');
    await page.click('#qsStart');
    await fill('Your age', 46);
    await next();
    await pick('By the hour');
    await fill('Hourly rate', 12.9);
    await fill('Hours a week', 38);
    await next();
    await pick('Yes');
    await fill('Pension paying a set amount', 3200);
    await fill('Age the set pension starts', 65);
    await next();
    await fill('Money for children', 510);
    await fill('Age of the youngest child', 15);
    await next();
    await pick('Renting');
    await fill('Rent a month', 520);
    await next();
    await body.locator('.qs-check', { hasText: 'A student loan comes off my pay' }).click();
    await expect(body).toContainText('Plan 4');
    await next();
    await pick('what is left at the end');
    await fill('Left over a month', 100);
    await next();
    await body.locator('.qs-check', { hasText: 'Could I buy a home?' }).click();
    await fill('Home price today', 130000);
    await next();
    await expect(page.locator('#quickDlg')).toBeHidden();
    const plan = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(plan.income.find(i => i.kind === 'dbpension').amount).toBe(3200);
    expect(plan.income.find(i => i.name === 'Money for the children').toYear).toBe(plan.startYear + 3);
    expect(plan.household.people[0].loanPlan).toBe('plan4');
    const home = plan.accounts.find(a => a.type === 'property');
    expect(home.buyYear).toBe(plan.startYear + 5);
    expect(plan.expenses.find(e => e.name === 'Rent').toYear).toBe(home.buyYear);
    expect(problems).toEqual([]);
  });

  test('the quick start asks about a public-service pension, working for yourself, a rented-out property and State Pension years', async ({ page }) => {
    const { problems } = await openApp(page, '', { quick: true });
    const body = page.locator('#qsBody');
    const fill = (label, v) => body.locator(`input[aria-label="${label}"]`).fill(String(v));
    const pick = t => body.locator('.qs-choice', { hasText: t }).first().click();
    const next = () => page.click('#qsNext');
    await page.click('#qsStart');
    await pick('Me and a partner');
    await fill('Your first name', 'Cal');
    await fill('Your age', 38);
    await fill('Partner’s first name', 'Ash');
    await fill('Partner’s age', 36);
    await next();
    // Cal works for himself: no question about a pension at work.
    await expect(page.locator('#qsTitle')).toHaveText('Your own pay');
    await pick('I work for myself');
    await fill('Made in a year before tax', 50000);
    await next();
    await expect(body).not.toContainText('Does money come off');
    await expect(body).toContainText('nothing goes into a pension unless you pay it in');
    await expect(body.locator('input[aria-label="Own pension payments a month"]')).toBeVisible();
    await fill('Pension pots so far', 9000);
    await next();
    // Ash is in the NHS scheme: the year joined gives an estimate on the spot.
    await pick('A yearly salary');
    await fill('Salary a year', 41000);
    await next();
    await pick('Yes');
    await pick('NHS');
    await next();
    await expect(body.locator('.qs-err')).toContainText('the year Ash joined');
    await fill('Year joined the scheme', 2017);
    await expect(body).toContainText(/About £[\d,]+ a year of pension built up so far \(9 years\)/);
    await fill('National Insurance years so far', 14);
    await next();
    await next();
    await pick('own, with a mortgage');
    await fill('Home value', 340000);
    await fill('Mortgage left', 215000);
    await fill('Mortgage payment a month', 1340);
    await body.locator('.qs-check', { hasText: 'also own a property that is rented out' }).click();
    await next();
    await expect(body.locator('.qs-err')).toContainText('what the rented-out property is worth');
    await fill('Rented-out property value', 180000);
    await fill('Rent received a month', 850);
    await fill('Mortgage left on the rented-out property', 110000);
    await fill('Mortgage payment on the rented-out property', 480);
    await next();
    await expect(body).toContainText('Not the mortgages: they are already in.');
    await next();
    // The rent and the business are in what is left.
    await pick('I know roughly what I spend');
    await fill('Spending a month', 3250);
    await expect(body.locator('#qsLeft')).toContainText('to save');
    await next();
    await next();
    await expect(page.locator('#quickDlg')).toBeHidden();
    const plan = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    expect(plan.income.find(i => i.kind === 'self').amount).toBe(50000);
    const db = plan.income.find(i => i.kind === 'dbpension');
    expect(db.dbScheme).toBe('nhs');
    expect(db.amount).toBeGreaterThan(5000);
    expect(plan.income.find(i => i.kind === 'salary').pensionTo).toBe('db');
    expect(plan.household.people[1].niYears).toBe(14);
    expect(plan.income.find(i => i.kind === 'rental').amount).toBe(850);
    expect(plan.accounts.find(a => a.name === 'Mortgage on the rented-out property').rate).toBe(5.23);
    // Nothing goes into Cal's pension: a step says what paying in would cost and build.
    const step = page.locator('#ovTodo li', { hasText: 'Cal: decide how much to pay into a pension' });
    await expect(step).toContainText(/For example, £[\d,]+ a month: the government adds £[\d,]+ of tax relief/);
    await expect(step).toContainText(/builds a pension of about £[\d,]+ in today’s money/);
    expect(problems).toEqual([]);
  });

  test('a goal shows one chance: “Try changes” starts from the figure at the top of the page', async ({ page }) => {
    const { problems } = await openApp(page);
    const goals = await page.evaluate(() => window.__horizon.model.goals.map(r => ({ id: r.goal.id, type: r.goal.type, title: r.title, pc: Math.round(r.probability * 100) })));
    const ret = goals.find(g => g.type === 'retire');
    await page.evaluate(id => window.__horizon.navigate(`goal/${id}`), ret.id);
    const table = page.locator('#gpImpact table');
    await expect(table).toBeVisible({ timeout: 20000 });
    for (const g of goals) await expect(table.locator('tr', { hasText: g.title }).locator('td').nth(1)).toContainText(`${g.pc}%`);
    // The mortgage goal's tile says the same year as its summary.
    const debt = goals.find(g => g.type === 'debtFree');
    await page.evaluate(id => window.__horizon.navigate(`goal/${id}`), debt.id);
    await expect(page.locator('main')).toContainText(/nothing is owed from 20\d\d/);
    expect(problems).toEqual([]);
  });

  test('with two mortgages, the goal can follow one of them, which is then overpaid first', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const p = window.__horizon.ws.scenarios[0].plan;
      p.accounts.push({ id: 'flat-loan', name: 'Flat mortgage', type: 'debt', owner: 'joint', balance: 90000, rate: 5.5, payment: 413 });
      window.__horizon.refresh();
    });
    await settle(page);
    await openGoal(page, 'Mortgage-free by');
    await page.click('.goal-hero button:has-text("Edit goal")');
    const which = page.locator('#gwBody select[aria-label="Which mortgage or loan"]');
    await expect(which.locator('option')).toHaveText(['Everything owed', 'Mortgage', 'Flat mortgage']);
    await which.selectOption({ label: 'Mortgage' });
    await page.click('#gwNext');
    await page.click('#gwNext');
    await expect(page.locator('#goalPage .goal-hero')).toContainText('Mortgage paid off by');
    await expect(page.locator('#goalPage')).toContainText('Mortgage: still owed');
    const plan = await page.evaluate(() => window.__horizon.ws.scenarios[0].plan);
    const g = plan.goals.find(x => x.type === 'debtFree');
    expect(g.debtId).toBe(plan.accounts.find(a => a.name === 'Mortgage').id);
    expect(problems).toEqual([]);
  });

  test('costs that come later: a car and home repairs are suggestions until ticked', async ({ page }) => {
    const { problems } = await openApp(page);
    await page.evaluate(() => {
      const H = window.__horizon, pl = H.ws.scenarios.find(s => s.id === H.ws.activeId).plan;
      pl.life = null;
      pl.expenses = pl.expenses.filter(e => !(e.key || '').startsWith('life:'));
      pl.events = pl.events.filter(e => !(e.id || '').startsWith('life:'));
      H.refresh();
      H.navigate('finances/spending');
    });
    await page.click('#lifeBtn');
    const wiz = page.locator('#lifeWiz');
    await expect(wiz.locator('.wiz-total')).toContainText('adds £0 over');
    await page.click('#lwNext');
    await expect(page.locator('#lwTitle')).toHaveText('Cars');
    await expect(wiz.locator('input[aria-label="Cost of each replacement"]')).toHaveCount(0);
    await wiz.locator('.lw-ask').click();
    await expect(wiz.locator('input[aria-label="Cost of each replacement"]')).toBeVisible();
    await expect(wiz.locator('.wiz-total')).not.toContainText('adds £0 over');
    await page.click('#lwNext');
    await expect(page.locator('#lwTitle')).toHaveText('Home');
    await expect(wiz.locator('input[aria-label="Major repairs or renovation"]')).toHaveCount(0);
    for (let k = 0; k < 3; k++) await page.click('#lwNext');
    // The review lists the cars by year and no repairs.
    await expect(wiz.locator('#lwBody')).toContainText('Replace car');
    await expect(wiz.locator('#lwBody')).not.toContainText('Major home repairs');
    expect(problems).toEqual([]);
  });
});
