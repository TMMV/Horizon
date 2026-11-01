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

async function tab(page, name) {
  await page.click(`.tabs button[data-tab="${name}"]`);
  await page.waitForTimeout(150);
}

// Wait for the debounced recompute after an edit.
async function settle(page) {
  await page.waitForTimeout(400);
}

module.exports = { APP_URL, openApp, tab, settle };
