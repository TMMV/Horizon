// @ts-check
// Captures every view in light and dark, desktop and phone, into screenshots/.
// Run with `npm run screenshots`, then look at them. Uses only the fictional example plan.
const { test, expect } = require('@playwright/test');
const path = require('path');
const { openApp, tab, go } = require('./helpers');

const OUT = path.resolve(__dirname, '../../screenshots');
const VIEWS = ['home', 'goal', 'retirement', 'finances/portfolio', 'finances/income', 'finances/spending', 'finances/cashflow', 'finances/assumptions', 'finances/history', 'scenarios'];

async function prepare(page) {
  // A check-in history so the Review tab has something to show, figures from a few months
  // ago (so Home shows estimates) and one balance updated since.
  await page.evaluate(() => {
    const E = window.Engine;
    const h = window.__horizon;
    const p = h.ws.scenarios[0].plan;
    const d = new Date(); d.setMonth(d.getMonth() - 5);
    p.asOf = E.todayISO(d);
    p.accounts[1].latest = { value: Math.round(p.accounts[1].balance * 1.09), date: E.todayISO(new Date(Date.now() - 20 * 864e5)) };
    const prev = E.rollForward(p, -2);
    const mid = E.rollForward(p, -1);
    for (const a of prev.accounts) if (a.type !== 'debt' && a.type !== 'property') a.balance *= 0.78;
    for (const a of mid.accounts) if (a.type !== 'debt' && a.type !== 'property') a.balance *= 0.9;
    p.life = { children: [{ name: '', age: 6 }] };
    h.ws.checkins = [
      E.makeCheckin(prev, 'Base plan', `${prev.startYear}-11-01`),
      E.makeCheckin(mid, 'Base plan', `${mid.startYear}-11-01`),
      E.makeCheckin(p, 'Base plan', p.asOf),
    ];
    h.refresh();
  });
}

for (const scheme of ['light', 'dark']) {
  test.describe(`${scheme} desktop`, () => {
    test.use({ colorScheme: scheme, viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    test(`all tabs (${scheme})`, async ({ page }) => {
      const { problems } = await openApp(page);
      await prepare(page);
      for (const name of VIEWS) {
        if (name === 'goal') await page.locator('.tab-list .goal-tab').first().click();
        else if (name === 'retirement') await page.locator('.tab-list .goal-tab', { hasText: 'Retirement' }).click();
        else await go(page, name);
        if (name === 'scenarios') {
          // Two what-ifs, so the comparison has something to compare.
          await page.locator('#ideaGrid .idea-chip').nth(0).click();
          await page.locator('#ideaGrid .idea-chip').nth(1).click();
          await expect(page.locator('#compareResults .sc-table tbody tr')).toHaveCount(3, { timeout: 30000 });
        }
        if (name === 'home') {
          await expect(page.locator('#ovGoalStrip .gt-driver').first()).not.toHaveClass(/muted/, { timeout: 30000 });
        }
        if (name === 'retirement') await expect(page.locator('#histTiles')).toBeVisible({ timeout: 15000 });
        if (name === 'goal') {
          await expect(page.locator('#gpMoves .divbar').first()).toBeVisible({ timeout: 30000 });
          await expect(page.locator('#gpHistory .goal-pct')).toBeVisible({ timeout: 15000 });
        }
        await page.waitForTimeout(300);
        await page.screenshot({ path: path.join(OUT, `${scheme}-${name.replace('/', '-')}.png`), fullPage: true });
      }
      await go(page, 'finances/portfolio');
      await page.click('#updateBtn');
      await page.locator('#udBody .rv-row').nth(4).locator('input').fill('70000');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${scheme}-update-balances.png`) });
      await page.click('#udCancel');
      await go(page, 'finances/spending');
      await page.click('#sec-expenses button:has-text("Spending check-up")');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${scheme}-wizard.png`) });
      await page.click('#wizClose');
      await go(page, 'home');
      await page.click('#ovAddGoal');
      await page.click('.goal-option:has-text("Mortgage-free")');
      await page.click('#gwNext');
      await page.locator('#gwBody input[aria-label="Share of surplus to overpay"]').fill('40');
      await expect(page.locator('#gwImpact')).toContainText('▲', { timeout: 15000 });
      await page.screenshot({ path: path.join(OUT, `${scheme}-goal-wizard.png`) });
      await page.click('#gwClose');
      await page.click('#ovAddGoal');
      await page.click('.goal-option:has-text("Plan your retirement")');
      await page.click('#gwBody .spend-option:has-text("Moderate")');
      await page.locator('#gwBody input[aria-label="Extra travel a year"]').fill('6000');
      await expect(page.locator('#rqPreview canvas')).toBeVisible({ timeout: 15000 });
      await page.click('#rqPreview button:has-text("Earliest age")');
      await expect(page.locator('#rqPreview .rq-answers')).toContainText('could spend', { timeout: 30000 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${scheme}-retirement-questionnaire.png`) });
      await page.click('#gwClose');
      await page.click('#ovAddGoal');
      await page.click('.goal-option:has-text("Emergency fund")');
      await expect(page.locator('#gwPreview .goal-pct')).toBeVisible({ timeout: 15000 });
      await page.screenshot({ path: path.join(OUT, `${scheme}-emergency-goal.png`) });
      await page.click('#gwClose');
      await go(page, 'finances/spending');
      await page.click('#lifeBtn');
      await page.locator('#lwBody input[aria-label="Number of children"]').fill('2');
      await page.locator('#lwBody input[aria-label="Child 1 age"]').fill('7');
      await page.locator('#lwBody input[aria-label="Child 2 age"]').fill('4');
      await page.screenshot({ path: path.join(OUT, `${scheme}-life-checkup.png`) });
      await page.click('#lwClose');

      // Every chart has a table view.
      await go(page, 'home');
      await page.locator('#ovChart .chart-tools button:has-text("Table")').click();
      await page.locator('#ovChart').scrollIntoViewIfNeeded();
      await page.locator('#ovChart').locator('..').screenshot({ path: path.join(OUT, `${scheme}-chart-table.png`) });
      await page.locator('#ovChart .chart-tools button:has-text("Chart")').click();

      // Spending check-up with typical ranges.
      await go(page, 'finances/spending');
      await page.click('#sec-expenses button:has-text("Spending check-up")');
      await page.locator('#wizBody .wiz-q').filter({ hasText: 'Gas & electricity' }).locator('input').fill('240');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${scheme}-wizard-guides.png`) });
      for (let i = 0; i < 7; i++) await page.click('#wizNext');
      await page.locator('#wizCompare').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${scheme}-wizard-compare.png`) });
      await page.click('#wizClose');

      // Notifications, then the yearly review.
      await page.click('#notifyBtn');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${scheme}-notifications.png`) });
      await page.click('#notifyBtn');
      await go(page, 'finances/history');
      await page.click('#reviewBtn');
      await page.click('#rvBody .goal-option >> nth=0');
      await page.waitForTimeout(150);
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-start.png`) });
      await page.click('#rvNext');
      const row = page.locator('#rvBody .rv-row').nth(1);
      const was = Number((await row.locator('input').inputValue()).replace(/,/g, ''));
      await row.locator('input').fill(String(Math.round(was + 12000)));
      const row0 = page.locator('#rvBody .rv-row').nth(0);
      await row0.locator('input').fill(String(Math.round(Number((await row0.locator('input').inputValue()).replace(/,/g, '')) - 3000)));
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-balances.png`) });
      for (let i = 0; i < 3; i++) await page.click('#rvNext');
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-markets.png`) });
      await page.click('#rvNext');
      await expect(page.locator('#rvBody .impact table')).toBeVisible({ timeout: 30000 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-results.png`) });
      await page.locator('#rvBody .rv-goals').scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-results-2.png`) });
      await page.click('#rvNext');
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-save.png`) });
      await page.click('#rvSave');
      await expect(page.locator('#reviewWiz')).toBeHidden({ timeout: 30000 });
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(OUT, `${scheme}-review-after.png`), fullPage: true });
      expect(problems).toEqual([]);
    });
  });
}

test.describe('phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  test('home, a goal, finances and the review on a phone', async ({ page }) => {
    const { problems } = await openApp(page);
    await prepare(page);
    await page.screenshot({ path: path.join(OUT, 'phone-home.png'), fullPage: true });
    await page.locator('#ovGoalStrip .goal-tile').first().click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'phone-goal.png'), fullPage: true });
    await go(page, 'finances/portfolio');
    await page.screenshot({ path: path.join(OUT, 'phone-finances.png') });
    await go(page, 'finances/spending');
    await page.screenshot({ path: path.join(OUT, 'phone-spending.png') });
    await go(page, 'finances/cashflow');
    await page.screenshot({ path: path.join(OUT, 'phone-cashflow.png') });
    await go(page, 'finances/history');
    await page.click('#reviewBtn');
    await page.click('#rvNext');
    await page.screenshot({ path: path.join(OUT, 'phone-review.png') });
    expect(problems).toEqual([]);
  });
});
