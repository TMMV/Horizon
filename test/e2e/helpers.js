'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const APP_URL = pathToFileURL(path.resolve(__dirname, '../../index.html')).href;

// Opens the app with error and network tracking. Any page error fails the test via
// `assertClean`; any request that is not a local file is recorded as a privacy breach.
async function openApp(page, hash = '', opts = {}) {
  const problems = [];
  const external = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  page.on('dialog', d => d.accept());
  await page.goto(APP_URL + (opts.setup ? '' : '?nosetup') + (hash ? `#${hash}` : ''));
  await page.waitForFunction(() => window.__horizon && window.__horizon.model);
  return { problems, external };
}

// A top-level tab: 'home', 'finances', 'scenarios' (goals have their own, see openGoal).
async function tab(page, name) {
  await page.click(name === 'finances' ? '.tab-list button[data-tab^="finances/"]' : `.tab-list button[data-tab="${name}"]`);
  await page.waitForTimeout(150);
}

// Any page by its address: "finances/income", "goal/<id>", "scenarios"...
async function go(page, route) {
  const [top, sub] = route.split('/');
  if (top === 'finances' && sub) {
    if (!(await page.locator('#view-finances').isVisible())) await tab(page, 'finances');
    await page.click(`#moneyNav a[href="#finances/${sub}"]`);
    await page.waitForTimeout(150);
    return;
  }
  await page.evaluate(r => window.__horizon.navigate(r), route);
  await page.waitForTimeout(150);
}

// Open a goal's own tab from its badge on Home.
async function openGoal(page, text) {
  await tab(page, 'home');
  await page.locator('#ovGoalStrip .goal-tile', { hasText: text }).first().click();
  await page.waitForTimeout(150);
}

// Show a chart's numbers (its Chart/Table switch).
async function asTable(locator) {
  await locator.locator('.chart-tools button:has-text("Table")').first().click();
}

// Wait for the debounced recompute after an edit.
async function settle(page) {
  await page.waitForTimeout(400);
}

// Finances lists show each item as a line; open every one in a section for editing.
async function editAll(page, section) {
  const rows = page.locator(`#sec-${section} .sum-row`);
  for (let i = 0; i < 40 && await rows.count(); i++) { await rows.first().click(); await page.waitForTimeout(20); }
}

// Home portfolio: groups (available now, locked away…) start folded; open them all.
async function openGroups(page) {
  const rows = page.locator('#homePortfolio .pf-row.access:not(.open)');
  for (let i = 0; i < 8 && await rows.count(); i++) { await rows.first().click(); await page.waitForTimeout(30); }
}

module.exports = { APP_URL, openApp, tab, go, openGoal, asTable, settle, editAll, openGroups };
