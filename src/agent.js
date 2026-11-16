/**
 * The workflow.
 *
 *   task ──▶ snapshot page ──▶ Pollinations (legacy) decides ONE action
 *        ──▶ Playwright performs it ──▶ screenshot saved ──▶ repeat
 *
 * Every iteration is persisted to runs/<runId>/steps.json so the dashboard
 * (and any CI job) can replay the run action by action, with its screenshot.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BrowserSession } from './browser.js';
import { chat, parseJsonReply } from './pollinations.js';

const SYSTEM_PROMPT = `You are a browser automation planner. You see a snapshot of a web page and must choose exactly ONE next action to make progress on the user's task.

Reply with a single JSON object and nothing else:
{
  "thought": "one short sentence of reasoning",
  "action": "goto" | "click" | "type" | "press" | "select" | "scroll" | "wait" | "extract" | "done",
  "selector": "CSS selector, use the provided [data-pba-idx=\\"N\\"] values when possible",
  "value": "text to type / url / key / option / pixels",
  "report": "final answer for the user, only when action is done"
}

Rules:
- Prefer selectors from the ELEMENTS list. Never invent an index.
- One action per reply. Do not repeat an action that already failed, and never repeat the same action twice in a row.
- Use "extract" when you need to read a result. If an earlier step already extracted the content you need, reply "done" and put the answer in "report".
- "report" must be the short answer for the user (e.g. "Notebook costs ₹349"), never a dump of the page text.
- Keep selector strings short and valid CSS.`;

const ALLOWED = new Set(['goto', 'click', 'type', 'press', 'select', 'scroll', 'wait', 'extract', 'done']);

function buildUserPrompt({ task, snapshot, history, repeatWarning }) {
  const elements = snapshot.elements
    .map((e) => `${e.selector} <${e.tag}${e.type ? ` type=${e.type}` : ''}> "${e.name}"`)
    .join('\n');
  const done = history.length
    ? history
        .map((h) => {
          const base = `${h.n}. ${h.action} ${h.selector || ''} ${h.value ? `= "${String(h.value).slice(0, 60)}"` : ''} → ${h.ok ? 'ok' : `failed: ${h.error}`}`;
          const got = h.extracted ? `\n   returned: "${String(h.extracted).replace(/\s+/g, ' ').slice(0, 500)}"` : '';
          return base + got;
        })
        .join('\n')
    : '(nothing yet)';
  const warning = repeatWarning
    ? `\nWARNING: the last action (${repeatWarning}) was already repeated. Choose a DIFFERENT action — if you have the information you need, reply "done" with a "report".\n`
    : '';
  return `TASK: ${task}

CURRENT PAGE
url: ${snapshot.url}
title: ${snapshot.title}

VISIBLE TEXT
${snapshot.text || '(empty)'}

ELEMENTS
${elements || '(none)'}

ACTIONS ALREADY TAKEN
${done}
${warning}
What is the single next action? Reply with JSON only.`;
}

function normaliseAction(parsed) {
  const action = String(parsed.action || '').toLowerCase().trim();
  if (!ALLOWED.has(action)) throw new Error(`Model returned unsupported action "${parsed.action}"`);
  return {
    action,
    selector: parsed.selector ? String(parsed.selector).trim() : '',
    value: parsed.value !== undefined ? parsed.value : '',
    thought: String(parsed.thought || '').slice(0, 400),
    report: parsed.report ? String(parsed.report).slice(0, 4000) : '',
  };
}

export async function runWorkflow({
  task,
  startUrl,
  maxSteps = 8,
  budgetMs = Number(process.env.AGENT_BUDGET_MS || 0), // 0 = no wall-clock limit
  runsDir = 'runs',
  runId = `run-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}-${crypto.randomBytes(2).toString('hex')}`,
  onEvent = () => {},
  headless = true,
}) {
  const startedAtMs = Date.now();
  const overBudget = () => budgetMs > 0 && Date.now() - startedAtMs > budgetMs;
  const dir = path.resolve(runsDir, runId);
  await fs.mkdir(dir, { recursive: true });

  const meta = {
    runId,
    task,
    startUrl,
    maxSteps,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    status: 'running',
    engine: 'playwright',
    model: process.env.POLLINATIONS_MODEL || 'openai-fast',
    api: 'pollinations legacy (text.pollinations.ai)',
    steps: 0,
    report: '',
  };
  const steps = [];
  const save = async () => {
    await fs.writeFile(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
    await fs.writeFile(path.join(dir, 'steps.json'), JSON.stringify(steps, null, 2));
  };
  const emit = (event) => {
    try {
      onEvent(event);
    } catch {
      /* a broken listener must not kill the run */
    }
  };

  const session = new BrowserSession({ runId, runsDir });
  emit({ type: 'run:start', meta });

  try {
    await session.start();

    // Step 0 — navigate and prove we are on the page.
    if (startUrl) {
      await session.page.goto(startUrl, { waitUntil: 'domcontentloaded' });
      const screenshot = await session.shot('open');
      const snap = await session.snapshot();
      steps.push({
        n: 0,
        action: 'goto',
        selector: '',
        value: startUrl,
        thought: 'Open the starting URL.',
        ok: true,
        url: snap.url,
        title: snap.title,
        screenshot,
        ts: new Date().toISOString(),
      });
      meta.steps = steps.length;
      await save();
      emit({ type: 'step', step: steps[0] });
    }

    let finalReport = '';
    for (let n = 1; n <= maxSteps; n++) {
      if (overBudget()) {
        meta.stoppedReason = 'time budget reached';
        break;
      }
      const snapshot = await session.snapshot();
      const last = steps.at(-1);
      const beforeLast = steps.at(-2);
      const repeatWarning =
        last && beforeLast && last.action === beforeLast.action && last.selector === beforeLast.selector
          ? `${last.action} on ${last.selector || 'body'}`
          : '';
      let action;
      try {
        const reply = await chat({
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: buildUserPrompt({ task, snapshot, history: steps, repeatWarning }) },
          ],
          json: true,
          temperature: 0.2,
        });
        action = normaliseAction(parseJsonReply(reply.text));
      } catch (err) {
        steps.push({
          n,
          action: 'plan',
          ok: false,
          error: `planner failed: ${err.message}`,
          thought: 'Pollinations did not return a usable action.',
          screenshot: await session.shot('planner-error'),
          url: snapshot.url,
          title: snapshot.title,
          ts: new Date().toISOString(),
        });
        meta.steps = steps.length;
        await save();
        emit({ type: 'step', step: steps.at(-1) });
        continue;
      }

      if (action.action === 'done') {
        finalReport = action.report || action.thought || 'Task complete.';
        steps.push({
          n,
          action: 'done',
          selector: '',
          value: '',
          thought: action.thought,
          ok: true,
          screenshot: await session.shot('done'),
          url: snapshot.url,
          title: snapshot.title,
          ts: new Date().toISOString(),
        });
        meta.steps = steps.length;
        await save();
        emit({ type: 'step', step: steps.at(-1) });
        break;
      }

      const step = {
        n,
        action: action.action,
        selector: action.selector,
        value: typeof action.value === 'object' ? JSON.stringify(action.value) : action.value,
        thought: action.thought,
        ok: true,
        url: snapshot.url,
        title: snapshot.title,
        ts: new Date().toISOString(),
      };
      try {
        const result = await session.execute(action);
        if (result.extracted) step.extracted = result.extracted;
        if (result.extracted && !finalReport) finalReport = result.extracted;
      } catch (err) {
        step.ok = false;
        step.error = String(err.message || err).slice(0, 300);
      }
      step.screenshot = await session.shot(`${step.action}-${step.ok ? 'ok' : 'failed'}`);
      const after = await session.snapshot();
      step.url = after.url;
      step.title = after.title;
      steps.push(step);
      meta.steps = steps.length;
      await save();
      emit({ type: 'step', step });
    }

    meta.status = 'completed';
    meta.report =
      finalReport ||
      (meta.stoppedReason
        ? 'Stopped when the run time budget ran out; see the steps above.'
        : 'Reached the step limit without an explicit final answer.');
  } catch (err) {
    meta.status = 'failed';
    meta.error = String(err.message || err);
  } finally {
    await session.close().catch(() => {});
    meta.finishedAt = new Date().toISOString();
    meta.steps = steps.length;
    await save();
    emit({ type: 'run:end', meta });
  }

  return { meta, steps, dir };
}
