/**
 * Local control server.
 *
 *   GET  /                 the dashboard (public/index.html)
 *   GET  /api/health       { ok, model, api }
 *   GET  /api/runs         every run on disk, newest first
 *   GET  /api/runs/:id     one run (meta + steps)
 *   POST /api/run          { task, startUrl, maxSteps } → starts a run, returns runId
 *   GET  /runs/...         screenshots
 *   GET  /demo/...         the bundled demo site
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import fss from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runWorkflow } from './agent.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 5173);
const RUNS = path.join(ROOT, 'runs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const running = new Map();

function json(res, code, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

async function serveFile(res, filePath) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'content-length': stat.size,
    });
    fss.createReadStream(filePath).pipe(res);
    return true;
  } catch {
    return false;
  }
}

async function readRun(id) {
  const dir = path.join(RUNS, id);
  const [meta, steps] = await Promise.all([
    fs.readFile(path.join(dir, 'meta.json'), 'utf8').then(JSON.parse),
    fs.readFile(path.join(dir, 'steps.json'), 'utf8').then(JSON.parse).catch(() => []),
  ]);
  return { ...meta, steps };
}

async function listRuns() {
  try {
    const ids = (await fs.readdir(RUNS)).filter((d) => !d.startsWith('.'));
    const runs = await Promise.all(
      ids.map((id) => readRun(id).catch(() => null)),
    );
    return runs.filter(Boolean).sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  } catch {
    return [];
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    if (await serveFile(res, path.join(ROOT, 'public', 'index.html'))) return;
    res.writeHead(404).end('index.html missing');
    return;
  }

  if (pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      api: 'pollinations legacy',
      engines: ['playwright', 'puppeteer'],
      model: process.env.POLLINATIONS_MODEL || 'openai-fast',
      activeRuns: running.size,
    });
  }

  if (pathname === '/api/runs' && req.method === 'GET') {
    return json(res, 200, { runs: await listRuns() });
  }

  if (pathname.startsWith('/api/runs/') && req.method === 'GET') {
    const id = pathname.slice('/api/runs/'.length);
    try {
      return json(res, 200, await readRun(id));
    } catch {
      return json(res, 404, { error: 'run not found' });
    }
  }

  if (pathname === '/api/run' && req.method === 'POST') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let payload = {};
    try {
      payload = JSON.parse(body || '{}');
    } catch {
      return json(res, 400, { error: 'invalid JSON body' });
    }
    const task = String(payload.task || '').trim();
    if (!task) return json(res, 400, { error: 'task is required' });
    const maxSteps = Math.min(Math.max(Number(payload.maxSteps) || 6, 1), 15);
    const runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${Math.random().toString(16).slice(2, 6)}`;

    const engine = payload.engine === 'puppeteer' ? 'puppeteer' : 'playwright';

    running.set(runId, { task, engine, startedAt: new Date().toISOString() });
    runWorkflow({ task, startUrl: payload.startUrl || '', maxSteps, engine, runId })
      .catch(() => {})
      .finally(() => running.delete(runId));

    return json(res, 202, { runId, status: 'started' });
  }

  // static: runs/* and demo/*
  if (pathname.startsWith('/runs/') || pathname.startsWith('/demo/')) {
    const rel = pathname.replace(/^\//, '');
    const filePath = path.join(ROOT, rel);
    if (!filePath.startsWith(ROOT)) return json(res, 403, { error: 'forbidden' });
    if (await serveFile(res, filePath)) return;
    res.writeHead(404).end('not found');
    return;
  }

  json(res, 404, { error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Pollinations Browser Agent → http://localhost:${PORT}`);
  console.log(`Legacy API: ${process.env.POLLINATIONS_TEXT_BASE || 'https://text.pollinations.ai'}`);
});
