'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

test('the local server serves the app and nothing private', async () => {
  const { makeServer, DEFAULT_PORT } = await import(pathToFileURL(path.resolve(__dirname, '../../scripts/serve.mjs')).href);
  assert.equal(DEFAULT_PORT, 8765);
  const server = makeServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(await home.text(), /<title>Horizon/);
    const js = await fetch(`${base}/src/engine.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    assert.equal((await fetch(`${base}/private/HANDOFF.md`)).status, 403);
    assert.equal((await fetch(`${base}/.git/config`)).status, 403);
    assert.equal((await fetch(`${base}/..%2f..%2fwindows/win.ini`)).status, 403);
    assert.equal((await fetch(`${base}/nope.html`)).status, 404);
  } finally {
    server.close();
  }
});
