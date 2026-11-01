'use strict';
const path = require('path');
const { pathToFileURL } = require('url');

const APP_URL = pathToFileURL(path.resolve(__dirname, '../../index.html')).href;

// Opens the app with error and network tracking. Any page error fails the test via
// `assertClean`; any request that is not a local file is recorded as a privacy breach.
async function openApp(page, hash = '') {
  const problems = [];
  const external = [];
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`console: ${m.text()}`); });
  page.on('request', r => { if (!/^(file|data|blob):/.test(r.url())) external.push(r.url()); });
  page.on('dialog', d => d.accept());
  await page.goto(APP_URL + (hash ? `#${hash}` : ''));
  await page.waitForFunction(() => window.__horizon && window.__horizon.model);
  return { problems, external };
}

// A top-level section, by clicking its tab.
async function tab(page, name) {
  await page.click(`.tabs button[data-tab="${name}"]`);
  await page.waitForTimeout(150);
}

// Any page by its address: "money/income", "goal/<id>", "outlook"...
async function go(page, route) {
  const [top, sub] = route.split('/');
  if (top === 'money' && sub) {
    if (!(await page.locator('#view-money').isVisible())) await tab(page, 'money');
    await page.click(`#moneyNav a[href="#money/${sub}"]`);
    await page.waitForTimeout(150);
    return;
  }
  await page.evaluate(r => window.__horizon.navigate(r), route);
  await page.waitForTimeout(150);
}

// Open a goal's own page from the Goals list.
async function openGoal(page, text) {
  await tab(page, 'goals');
  await page.locator('#goalList .gl-row', { hasText: text }).first().click();
  await page.waitForTimeout(150);
}

// Wait for the debounced recompute after an edit.
async function settle(page) {
  await page.waitForTimeout(400);
}

module.exports = { APP_URL, openApp, tab, go, openGoal, settle };
