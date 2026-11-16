/**
 * Playwright wrapper. Every state-changing call returns a screenshot path, so
 * the workflow always has visual proof of what the browser did.
 */
import { chromium } from 'playwright';
import fs from 'node:fs/promises';
import path from 'node:path';

const CHROMIUM_CANDIDATES = [
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
  return undefined; // fall back to Playwright's own downloaded build
}

const slug = (s) =>
  String(s || 'step')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40) || 'step';

export class BrowserSession {
  constructor({ runId, runsDir = 'runs', viewport = { width: 1366, height: 800 } } = {}) {
    this.runId = runId;
    this.dir = path.resolve(runsDir, runId);
    this.viewport = viewport;
    this.shotIndex = 0;
    this.browser = null;
    this.context = null;
    this.page = null;
  }

  async start() {
    await fs.mkdir(this.dir, { recursive: true });
    const executablePath = await resolveExecutable();
    this.browser = await chromium.launch({
      headless: process.env.HEADFUL === '1' ? false : true,
      executablePath,
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    });
    this.context = await this.browser.newContext({
      viewport: this.viewport,
      deviceScaleFactor: 1,
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 pollinations-browser-agent',
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(15000);
    return this;
  }

  /** Screenshot into runs/<runId>/, returns a repo-relative path. */
  async shot(label) {
    this.shotIndex += 1;
    const name = `${String(this.shotIndex).padStart(2, '0')}-${slug(label)}.png`;
    await this.page.screenshot({ path: path.join(this.dir, name), fullPage: false });
    return `runs/${this.runId}/${name}`;
  }

  /**
   * A compact, model-friendly view of the page: visible text plus a numbered
   * list of interactive elements the model may target.
   */
  async snapshot({ maxText = 2200, maxElements = 60 } = {}) {
    const info = await this.page.evaluate(
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
    return info;
  }

  async execute(action) {
    const page = this.page;
    const selector = action.selector || '';
    switch (action.action) {
      case 'goto':
        await page.goto(action.value || action.url, { waitUntil: 'domcontentloaded' });
        break;
      case 'click':
        await page.locator(selector).first().click({ timeout: 15000 });
        break;
      case 'type':
        await page.locator(selector).first().fill(String(action.value ?? ''), { timeout: 15000 });
        break;
      case 'press':
        await page.locator(selector || 'body').first().press(action.value || 'Enter');
        break;
      case 'select':
        await page.locator(selector).first().selectOption(String(action.value ?? ''));
        break;
      case 'scroll':
        await page.mouse.wheel(0, Number(action.value) || 600);
        break;
      case 'wait':
        await page.waitForTimeout(Math.min(Number(action.value) || 1000, 10000));
        break;
      case 'extract': {
        const text = await page.locator(selector || 'body').first().innerText();
        return { extracted: text.trim().slice(0, 2000) };
      }
      case 'done':
        return { done: true };
      default:
        throw new Error(`Unsupported action: ${action.action}`);
    }
    await page.waitForTimeout(400); // let the UI settle before the screenshot
    return {};
  }

  async close() {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}
