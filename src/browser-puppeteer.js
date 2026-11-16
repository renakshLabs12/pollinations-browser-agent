/**
 * Puppeteer engine — same interface as src/browser.js, so the workflow can run on
 * either browser driver. Pick it with BROWSER_ENGINE=puppeteer (or --engine puppeteer).
 *
 * Every state-changing call still returns a screenshot path.
 */
import fs from 'node:fs/promises';
import path from 'node:path';

let puppeteer = null;
async function loadPuppeteer() {
  if (puppeteer) return puppeteer;
  try {
    puppeteer = (await import('puppeteer')).default;
  } catch {
    puppeteer = (await import('puppeteer-core')).default; // when Chrome is provided by the system
  }
  return puppeteer;
}

const CHROMIUM_CANDIDATES = [
  process.env.PUPPETEER_EXECUTABLE_PATH,
  process.env.CHROMIUM_PATH,
  '/usr/local/bin/chromium',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
].filter(Boolean);

async function resolveExecutable() {
  for (const candidate of CHROMIUM_CANDIDATES) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  return undefined; // let Puppeteer use the Chrome it downloaded
}

const slug = (s) =>
  String(s || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'step';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class BrowserSession {
  constructor({ runId, runsDir = 'runs', viewport = { width: 1366, height: 800 } } = {}) {
    this.runId = runId;
    this.dir = path.resolve(runsDir, runId);
    this.viewport = viewport;
    this.shotIndex = 0;
    this.browser = null;
    this.page = null;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });
    const pptr = await loadPuppeteer();
    const executablePath = await resolveExecutable();
    this.browser = await pptr.launch({
      headless: process.env.HEADFUL === '1' ? false : true,
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      defaultViewport: this.viewport,
    });
    this.page = await this.browser.newPage();
    await this.page.setViewport(this.viewport);
    await this.page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pollinations-browser-agent',
    );
    this.page.setDefaultTimeout(15000);
    return this;
  }

  async shot(label) {
    this.shotIndex += 1;
    const name = `${String(this.shotIndex).padStart(2, '0')}-${slug(label)}.png`;
    await this.page.screenshot({ path: path.join(this.dir, name) });
    return `runs/${this.runId}/${name}`;
  }

  async snapshot({ maxText = 2200, maxElements = 60 } = {}) {
    return this.page.evaluate(
      ({ maxText, maxElements }) => {
        const SELECTOR = 'a,button,input,textarea,select,[role="button"],[role="link"],[onclick]';
        const nodes = Array.from(document.querySelectorAll(SELECTOR));
        const visible = nodes.filter((el) => {
          const r = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          return r.width > 1 && r.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
        });
        visible.slice(0, maxElements).forEach((el, i) => el.setAttribute('data-pba-idx', String(i)));
        const elements = visible.slice(0, maxElements).map((el, i) => ({
          i,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute('type') || undefined,
          name: (
            el.getAttribute('aria-label') ||
            el.getAttribute('placeholder') ||
            el.innerText ||
            el.value ||
            el.getAttribute('name') ||
            ''
          )
            .trim()
            .replace(/\s+/g, ' ')
            .slice(0, 70),
          selector: `[data-pba-idx="${i}"]`,
        }));
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, maxText);
        return { url: location.href, title: document.title, text, elements };
      },
      { maxText, maxElements },
    );
  }

  async execute(action) {
    const page = this.page;
    const selector = action.selector || '';
    switch (action.action) {
      case 'goto':
        await page.goto(action.value || action.url, { waitUntil: 'domcontentloaded' });
        break;
      case 'click':
        await page.waitForSelector(selector, { timeout: 15000 });
        await page.click(selector);
        break;
      case 'type':
        await page.waitForSelector(selector, { timeout: 15000 });
        await page.click(selector, { clickCount: 3 }).catch(() => {});
        await page.type(selector, String(action.value ?? ''), { delay: 12 });
        break;
      case 'press':
        if (selector) {
          await page.waitForSelector(selector, { timeout: 15000 });
          await page.focus(selector);
        }
        await page.keyboard.press(action.value || 'Enter');
        break;
      case 'select':
        await page.select(selector, String(action.value ?? ''));
        break;
      case 'scroll':
        await page.mouse.wheel({ deltaY: Number(action.value) || 600 });
        break;
      case 'wait':
        await sleep(Math.min(Number(action.value) || 1000, 10000));
        break;
      case 'extract': {
        const text = await page.evaluate((sel) => {
          const el = sel ? document.querySelector(sel) : document.body;
          return (el?.innerText || '').trim();
        }, selector);
        return { extracted: text.slice(0, 2000) };
      }
      case 'done':
        return { done: true };
      default:
        throw new Error(`Unsupported action: ${action.action}`);
    }
    await sleep(400); // let the UI settle before the screenshot
    return {};
  }

  async close() {
    await this.browser?.close().catch(() => {});
  }
}
