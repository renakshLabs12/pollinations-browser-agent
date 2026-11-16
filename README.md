# Pollinations Browser Agent

Browser automation that plans its own clicks with the **Pollinations legacy (Classic) API**, runs on
**Puppeteer or Playwright**, and **saves a screenshot after every single action**. It runs locally and
on **GitHub Actions**, where the screenshots and the rebuilt dashboard come back as workflow artifacts.

One loop, four moving parts:

```
task + URL ──▶ page snapshot ──▶ Pollinations picks ONE action (JSON)
            ──▶ Puppeteer / Playwright performs it ──▶ screenshot saved ──▶ repeat
```

The model never touches the browser, and the browser never talks to the model. The snapshot goes in,
one JSON action comes out, the driver executes it, and the frame is captured before the next
iteration — so every run leaves a visual audit trail on disk.

## What you get

| Path | What it is |
|---|---|
| `index.html` | Standalone dashboard with a real recorded run (screenshots inlined). Open it directly. |
| `public/index.html` | The same console, served live by `src/server.js`. |
| `.github/workflows/browser-agent.yml` | The GitHub Actions workflow: dispatch, push or weekly schedule. |
| `src/pollinations.js` | Legacy API client: serial queue, minimum gap, `402 Retry-After`, JSON parsing, proxy support. |
| `src/browser.js` | Playwright engine: page snapshot with `[data-pba-idx]` selectors, action executor, screenshot per call. |
| `src/browser-puppeteer.js` | Puppeteer engine — same interface, so the workflow is driver-agnostic. |
| `src/agent.js` | The workflow loop: plan → act → screenshot → persist to `runs/<id>/`; picks the engine. |
| `src/cli.js` | CLI runner (`--engine`, `--max-steps`, `--budget-ms`). |
| `src/server.js` | Local control server + JSON API + static run artifacts. |
| `scripts/embed-demo.mjs` | Builds the standalone `index.html` from the newest recorded run. |
| `demo/site/index.html` | Offline demo storefront used by the sample run. |
| `runs/<runId>/` | `meta.json`, `steps.json`, `01-open.png`, `02-type-ok.png`, … |

## Quick start

```bash
npm install
npx playwright install chromium      # or: npx puppeteer browsers install chrome
                                     # skip if chromium/google-chrome is already on PATH

# one run from the CLI
node src/cli.js \
  --task "Search the catalogue for 'notebook', add it to the cart, and report its price" \
  --url  file://$PWD/demo/site/index.html \
  --engine puppeteer \
  --max-steps 5 --budget-ms 240000

# or the console + API
npm start            # http://localhost:5173
```

`--budget-ms` stops the loop cleanly when the wall clock runs out — useful because the free Classic
API answers in tens of seconds when its per-IP slot is busy.

Rebuild the standalone page after a new run:

```bash
npm run build                        # newest completed run
node scripts/embed-demo.mjs <runId>  # a specific one
```

## Two browser engines

| Engine | Package | Selected by | Notes |
|---|---|---|---|
| Puppeteer | `puppeteer` | `--engine puppeteer` / `BROWSER_ENGINE=puppeteer` | Uses its own downloaded Chrome, or `PUPPETEER_EXECUTABLE_PATH` |
| Playwright | `playwright` | `--engine playwright` (default) | Uses its own build, or `CHROMIUM_PATH` |

Both implement the same `BrowserSession` interface (`start`, `snapshot`, `execute`, `shot`, `close`), so
the agent loop, the CLI, the server and the dashboard do not care which one is running. If the requested
engine is not installed, the agent logs a warning and falls back to Playwright instead of failing the run.
The engine that actually ran is recorded as `meta.engine` and shown on the dashboard.

## GitHub Actions

`.github/workflows/browser-agent.yml` runs the whole workflow on a GitHub runner.

**Trigger it by hand:** Actions → *browser-agent* → *Run workflow*. Inputs:

| Input | Default | Meaning |
|---|---|---|
| `task` | search/add-to-cart demo | What the agent should do |
| `start_url` | empty → `file://$GITHUB_WORKSPACE/demo/site/index.html` | Where to start |
| `max_steps` | `5` | Action budget |
| `engine` | `puppeteer` | `puppeteer` or `playwright` |

It also runs on pushes to `main` that touch `src/`, `demo/`, `scripts/`, `package.json` or the workflow
itself, and on a weekly schedule (Mondays 04:00 UTC).

What a run produces:

- the console log of every action, with its screenshot path;
- `runs/` uploaded as the **screenshots-run-N** artifact;
- the rebuilt standalone page uploaded as the **dashboard-run-N** artifact;
- a Markdown table of steps in the job summary.

The workflow installs the browser it needs (`npx puppeteer browsers install chrome` or
`npx playwright install --with-deps chromium`), so no browser cache setup is required.

## Actions the agent can choose

`goto` · `click` · `type` · `press` · `select` · `scroll` · `wait` · `extract` · `done`

Every reply is validated against that list before it is executed; an unknown action, a bad selector
or a planner failure is recorded as a failed step (with its screenshot) instead of killing the run.

## Pollinations legacy API used here

The Classic endpoints are deprecated upstream in favour of `gen.pollinations.ai`, but they still
answer and need no key, so they are used deliberately:

| Endpoint | Use |
|---|---|
| `POST https://text.pollinations.ai/openai` | OpenAI-compatible chat — the planner |
| `GET https://text.pollinations.ai/{prompt}` | Simple prompt variant (`simpleText()` in the client) |
| `GET https://text.pollinations.ai/models` | Model discovery |
| `GET https://image.pollinations.ai/prompt/{prompt}` | Legacy image generation (`imageUrl()`) |

Free tier rules handled in `src/pollinations.js`:

- one request at a time per IP → every call goes through a serial queue with `POLLINATIONS_MIN_INTERVAL_MS` (default 4s);
- `402 Payment Required` + `Retry-After` → wait and retry, up to `POLLINATIONS_MAX_ATTEMPTS`;
- Node's `fetch` ignores `HTTP(S)_PROXY` → an undici `ProxyAgent` is installed when a proxy env var is set.

## Local API

```
GET  /api/health           { ok, model, api, engines, activeRuns }
GET  /api/runs             every run on disk, newest first
GET  /api/runs/:id         one run: meta + steps
POST /api/run              { task, startUrl, maxSteps, engine } → { runId, status: "started" }
GET  /runs/...             screenshots
GET  /demo/...             the demo storefront
```

## Configuration

Copy `.env.example` to `.env` (or export the vars yourself):

| Var | Default | Meaning |
|---|---|---|
| `BROWSER_ENGINE` | `playwright` | `playwright` or `puppeteer` |
| `POLLINATIONS_MODEL` | `openai-fast` | Planner model on the Classic API |
| `POLLINATIONS_MIN_INTERVAL_MS` | `4000` | Minimum gap between text calls |
| `POLLINATIONS_MAX_ATTEMPTS` | `4` | Retries on 402/429/5xx |
| `CHROMIUM_PATH` | auto | Chromium/Chrome binary for either engine |
| `PUPPETEER_EXECUTABLE_PATH` | auto | Chrome binary for Puppeteer |
| `AGENT_BUDGET_MS` | `0` | Wall-clock budget for a run (0 = none) |
| `HEADFUL` | `0` | `1` to watch the browser work |
| `PORT` | `5173` | Local server port |

## Notes and limits

- The Classic API is best-effort and rate limited; a planning call can take 30–100s when the free
  slot is busy. Keep `--budget-ms` set for CI-style runs, or point `POLLINATIONS_TEXT_BASE` at
  `gen.pollinations.ai` with your own key for a faster, unthrottled planner.
- Runs are headless by default; pass `HEADFUL=1` to debug a selector.
- Screenshots are viewport-only (1366×800) — enough to prove the action, small enough to keep runs tidy.
- The demo storefront places no real orders.
