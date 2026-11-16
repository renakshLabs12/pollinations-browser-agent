/**
 * Pollinations "legacy" (Classic) API client.
 *
 *   Text (GET)    https://text.pollinations.ai/{prompt}
 *   Text (POST)   https://text.pollinations.ai/            { messages: [...] }
 *   OpenAI compat POST https://text.pollinations.ai/openai
 *   Models        GET  https://text.pollinations.ai/models
 *   Image         GET  https://image.pollinations.ai/prompt/{prompt}
 *
 * The Classic API is free and anonymous but rate limited per IP
 * (~1 request at a time, a few seconds apart). It answers 402 with a
 * `Retry-After` header when you are early, so every call here goes through
 * a serial queue with a minimum gap and a bounded retry.
 *
 * Deprecated by Pollinations in favour of gen.pollinations.ai — kept working
 * here on purpose because the workflow was asked for on the legacy API.
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici';

// Node's built-in fetch ignores HTTP(S)_PROXY. On machines behind a corporate or
// sandbox egress proxy that shows up as "fetch failed", so wire undici's proxy
// agent in when one is configured.
const PROXY =
  process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || '';
if (PROXY && process.env.POLLINATIONS_NO_PROXY !== '1') {
  setGlobalDispatcher(new ProxyAgent(PROXY));
}

const TEXT_BASE = process.env.POLLINATIONS_TEXT_BASE || 'https://text.pollinations.ai';
const IMAGE_BASE = process.env.POLLINATIONS_IMAGE_BASE || 'https://image.pollinations.ai';

/** Minimum gap between two text requests (ms). Classic API: ~3s per IP. */
const MIN_INTERVAL_MS = Number(process.env.POLLINATIONS_MIN_INTERVAL_MS || 4000);
const MAX_ATTEMPTS = Number(process.env.POLLINATIONS_MAX_ATTEMPTS || 4);

let queue = Promise.resolve();
let lastStart = 0;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Serialise calls and keep a minimum gap between request starts. */
function enqueue(fn) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStart);
    if (wait > 0) await sleep(wait);
    lastStart = Date.now();
    return fn();
  });
  // keep the chain alive even when a call rejects
  queue = run.catch(() => {});
  return run;
}

function retryAfterMs(res, attempt) {
  const raw = res.headers.get('retry-after');
  const secs = raw ? Number(raw) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(secs * 1000, 60000);
  return Math.min(5000 * 2 ** attempt, 60000);
}

/**
 * OpenAI-compatible chat call on the legacy endpoint.
 * @returns {Promise<{text: string, raw: any, model: string}>}
 */
export async function chat({
  messages,
  model = process.env.POLLINATIONS_MODEL || 'openai-fast',
  json = false,
  seed,
  temperature,
  referrer = 'pollinations-browser-agent',
  timeoutMs = 90000,
}) {
  const body = { model, messages, private: true, referrer };
  if (json) {
    body.response_format = { type: 'json_object' };
    body.jsonMode = true; // legacy alias still accepted by the Classic API
  }
  if (seed !== undefined) body.seed = seed;
  if (temperature !== undefined) body.temperature = temperature;

  return enqueue(async () => {
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${TEXT_BASE}/openai`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (res.status === 402 || res.status === 429 || res.status >= 500) {
          const wait = retryAfterMs(res, attempt);
          lastErr = new Error(`Pollinations ${res.status} — waiting ${Math.round(wait / 1000)}s`);
          clearTimeout(timer);
          await sleep(wait);
          continue;
        }
        if (!res.ok) {
          const txt = await res.text().catch(() => '');
          throw new Error(`Pollinations ${res.status}: ${txt.slice(0, 300)}`);
        }
        const raw = await res.json();
        const text = raw?.choices?.[0]?.message?.content ?? '';
        return { text: typeof text === 'string' ? text : JSON.stringify(text), raw, model };
      } catch (err) {
        lastErr = err;
        if (attempt === MAX_ATTEMPTS - 1) break;
        await sleep(retryAfterMs({ headers: new Headers() }, attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastErr || new Error('Pollinations request failed');
  });
}

/** Simple GET variant: https://text.pollinations.ai/{prompt}?system=...&json=true */
export async function simpleText(prompt, { system, json = false, model, seed } = {}) {
  const params = new URLSearchParams();
  if (system) params.set('system', system);
  if (json) params.set('json', 'true');
  if (model) params.set('model', model);
  if (seed !== undefined) params.set('seed', String(seed));
  const url = `${TEXT_BASE}/${encodeURIComponent(prompt)}?${params.toString()}`;

  return enqueue(async () => {
    let lastErr;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const res = await fetch(url, { headers: { referrer: 'pollinations-browser-agent' } });
      if (res.status === 402 || res.status === 429) {
        const wait = retryAfterMs(res, attempt);
        lastErr = new Error(`Pollinations ${res.status} — waiting ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      if (!res.ok) throw new Error(`Pollinations ${res.status}`);
      return await res.text();
    }
    throw lastErr || new Error('Pollinations request failed');
  });
}

/** Legacy image generation URL (used by the dashboard for step banners). */
export function imageUrl(prompt, { width = 768, height = 384, seed = 42, model = 'flux', safe = true } = {}) {
  const params = new URLSearchParams({ width: String(width), height: String(height), seed: String(seed), model, safe: String(safe) });
  return `${IMAGE_BASE}/prompt/${encodeURIComponent(prompt)}?${params.toString()}`;
}

export async function listModels() {
  const res = await fetch(`${TEXT_BASE}/models`);
  if (!res.ok) throw new Error(`Pollinations models ${res.status}`);
  return res.json();
}

/** Pull the first JSON object out of a model reply (models love markdown fences). */
export function parseJsonReply(text) {
  if (!text) throw new Error('Empty model reply');
  const cleaned = String(text).replace(/```json/gi, '```').trim();
  const fenced = cleaned.match(/```([\s\S]*?)```/);
  const candidates = [cleaned, fenced?.[1], cleaned.slice(cleaned.indexOf('{'), cleaned.lastIndexOf('}') + 1)];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const parsed = JSON.parse(c.trim());
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      /* try the next candidate */
    }
  }
  throw new Error(`Could not parse JSON from model reply: ${String(text).slice(0, 200)}`);
}
