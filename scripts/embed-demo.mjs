#!/usr/bin/env node
/**
 * Build the standalone dashboard.
 *
 *   node scripts/embed-demo.mjs [runId]
 *
 * Takes public/index.html (the template the server serves) and writes ./index.html
 * with a real recorded run — screenshots inlined as data URLs — so the page can be
 * opened straight from disk, attached to a ticket, or served by GitHub Pages.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUNS = path.join(ROOT, 'runs');

async function pickRun(explicit) {
  if (explicit) return explicit;
  const ids = (await fs.readdir(RUNS)).filter((d) => !d.startsWith('.'));
  const runs = [];
  for (const id of ids) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(RUNS, id, 'meta.json'), 'utf8'));
      runs.push(meta);
    } catch {
      /* skip broken run */
    }
  }
  runs.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
  const completed = runs.find((r) => r.status === 'completed' && r.steps > 0);
  const chosen = completed || runs[0];
  if (!chosen) throw new Error('No runs in runs/ — run the CLI once first.');
  return chosen.runId;
}

const runId = await pickRun(process.argv[2]);
const dir = path.join(RUNS, runId);
const meta = JSON.parse(await fs.readFile(path.join(dir, 'meta.json'), 'utf8'));
const steps = JSON.parse(await fs.readFile(path.join(dir, 'steps.json'), 'utf8').catch(() => '[]'));

// Inline every screenshot as a data URL.
let inlined = 0;
for (const step of steps) {
  if (!step.screenshot) continue;
  const file = path.join(ROOT, step.screenshot);
  step.shotName = path.basename(step.screenshot);
  try {
    const buf = await fs.readFile(file);
    step.screenshot = `data:image/png;base64,${buf.toString('base64')}`;
    inlined += 1;
  } catch {
    delete step.screenshot;
  }
}

const payload = { ...meta, steps };
const template = await fs.readFile(path.join(ROOT, 'public', 'index.html'), 'utf8');
if (!template.includes('/*__DEMO_RUN__*/')) throw new Error('Template token /*__DEMO_RUN__*/ not found in public/index.html');

const out = template.replace('/*__DEMO_RUN__*/ null', JSON.stringify(payload));
const target = path.join(ROOT, 'index.html');
await fs.writeFile(target, out);

const kb = (n) => Math.round(n / 1024) + ' KB';
console.log(`embedded run ${runId} · ${steps.length} steps · ${inlined} screenshots`);
console.log(`wrote ${path.relative(ROOT, target)} (${kb(Buffer.byteLength(out))})`);
