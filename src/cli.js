#!/usr/bin/env node
/**
 * CLI runner.
 *
 *   node src/cli.js --task "Search for notebook and report the price" \
 *                   --url file://$PWD/demo/site/index.html --max-steps 6
 */
import { runWorkflow } from './agent.js';

const args = process.argv.slice(2);
const get = (flag, fallback) => {
  const i = args.indexOf(`--${flag}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};

const task = get('task');
const startUrl = get('url');
const maxSteps = Number(get('max-steps', 8));
const budgetMs = Number(get('budget-ms', process.env.AGENT_BUDGET_MS || 0));

if (!task) {
  console.error('Usage: node src/cli.js --task "<what to do>" [--url <start url>] [--max-steps 8]');
  process.exit(1);
}

const paint = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
};

const { meta, steps, dir } = await runWorkflow({
  task,
  startUrl,
  maxSteps,
  budgetMs,
  onEvent: ({ type, step }) => {
    if (type !== 'step') return;
    const head = `${paint.dim(`#${step.n}`)} ${paint.cyan(step.action.padEnd(8))}`;
    const ok = step.ok ? paint.green('ok') : paint.red('failed');
    console.log(`${head} ${ok} ${step.selector || ''} ${step.value ? `"${step.value}"` : ''}`);
    if (step.thought) console.log(`   ${paint.dim(step.thought)}`);
    if (step.error) console.log(`   ${paint.red(step.error)}`);
  },
});

console.log(`\n${paint.bold('status')} ${meta.status}   ${paint.bold('steps')} ${steps.length}`);
console.log(`${paint.bold('screenshots')} ${dir}`);
if (meta.report) console.log(`${paint.bold('report')} ${meta.report}`);
