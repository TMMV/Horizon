// A tiny local web server for Horizon (no dependencies, Node 18+).
//
//   node scripts/serve.mjs [--open] [--port 8765]
//
// Serves this folder on http://localhost:8765 (only to this computer) and optionally opens
// the browser. The port stays the same every time on purpose: the browser keeps your plan
// per address, so a different port would look like an empty plan.

import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export const DEFAULT_PORT = 8765;
const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.ico': 'image/x-icon', '.md': 'text/markdown; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

// Never serve personal files, tooling or dot-folders, even to this computer.
const BLOCKED = /^(private|node_modules|test-results|playwright-report|\.[^/]*)(\/|$)/;

export function makeServer(root = ROOT) {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
      if (rel === '' || rel.endsWith('/')) rel += 'index.html';
      const file = normalize(join(root, rel));
      if (!file.startsWith(root + sep) || BLOCKED.test(rel.split(sep).join('/'))) {
        res.writeHead(403, { 'Content-Type': 'text/plain' }).end('Not allowed');
        return;
      }
      const info = await stat(file).catch(() => null);
      if (!info || !info.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(await readFile(file));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Bad request');
    }
  });
}

function openBrowser(url) {
  const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '""', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { stdio: 'ignore', detached: true }).unref(); } catch { /* open it by hand */ }
}

// Is Horizon already running on this port (e.g. started earlier)?
async function isHorizon(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    return res.ok && (await res.text()).includes('<title>Horizon');
  } catch { return false; }
}

async function main() {
  const args = process.argv.slice(2);
  const i = args.indexOf('--port');
  const port = i >= 0 ? parseInt(args[i + 1], 10) : DEFAULT_PORT;
  const open = args.includes('--open');
  const url = `http://localhost:${port}/`;
  const server = makeServer();
  server.on('error', async err => {
    if (err.code === 'EADDRINUSE' && await isHorizon(url)) {
      console.log(`Horizon is already running at ${url}`);
      if (open) openBrowser(url);
      process.exit(0);
    }
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${port} is used by another program. Try: node scripts/serve.mjs --open --port 8766 (your plan is saved per address, so keep using the same one).`
      : err.message);
    process.exit(1);
  });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Horizon is running at ${url}`);
    console.log('Only this computer can see it. Keep this window open while you use it; press Ctrl+C to stop.');
    if (open) openBrowser(url);
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
