# 📊 DiffLens

Compare a **local web app** against **staging** and see exactly what changed — visually, in the text, and in the markup.

<p align="center">
  <img src="https://github.com/praveen-pravi6B/difflens/blob/main/assets/logo.png?raw=true" alt="DiffLens Logo" width="120">
</p>

DiffLens renders both pages with **Chromium at 1920×1080** (the standard desktop screen), then produces three independent diffs:

DiffLens renders both pages with **Chromium at 1920×1080** (the standard desktop screen), then produces three independent diffs:

| Layer | What it shows |
| --- | --- |
| **Visual** | Full-page pixel diff. Changed pixels glow pink over a faded local screenshot. Side-by-side, slider overlay and diff-only views. |
| **Content** | Visible text compared line by line, with word-level highlights for edits. Staging is the baseline; local is the candidate. |
| **Markup** | Elements matched by rendered CSS path, with new nodes, removed nodes, text changes and attribute changes (`href`, `src`, `alt`, …). |

Each run also exports a **self-contained HTML report** (screenshots embedded) and a **JSON result**.

## Requirements

- Node.js 20+
- macOS, Linux or Windows
- ~150 MB for the Chromium build

## Quick start

```bash
cd difflens
npm install
npm run setup:browser   # downloads Chromium once
npm start
```

Open <http://127.0.0.1:4173> and click **Try the demo**. The bundled demo pages are two versions of a landing page with deliberate differences, so you can see every layer immediately.

Then replace the URLs with your own:

- **Local** — e.g. `http://localhost:3000`
- **Staging** — e.g. `https://staging.example.com`

Press **Compare pages** (or `⌘`/`Ctrl` + `Enter`).

## How it works

1. Both URLs are loaded **in parallel in isolated browser contexts**, so cookies and storage never leak between sides.
2. Service workers are blocked, animations and transitions are frozen, fonts and images are awaited, and the page is scrolled to trigger lazy content.
3. Each side is captured: visible text (`innerText`), element snapshots (path, tag, own text, tracked attributes), console/network diagnostics, and a screenshot.
4. Diffs run:
   - **Pixel** — `pixelmatch` over the two screenshots; changed regions are detected and listed.
   - **Content** — `diff` line comparison; adjacent delete/add pairs become word-level modified lines.
   - **Markup** — nodes matched by CSS path; nodes that only moved because a sibling changed are filtered out.
5. Results are stored under `.artifacts/<id>/` (screenshots, text, `result.json`) and the latest 40 runs are retained.

### Baseline direction

- **Staging = baseline**, **local = candidate**.
- Additions are **new in local**; removals are **missing from local**.
- Domain-only differences are normalised by default, so `http://localhost:3000/about` and `https://staging.example.com/about` are not reported as different links.

## Options

Available under **Options** in the UI:

| Option | Default | Purpose |
| --- | --- | --- |
| Wait after load | `1500 ms` | Extra settle time for client-side rendering, fonts and animations. |
| Pixel threshold | `0.12` | `pixelmatch` sensitivity (`0.01` strict – `1` loose). |
| Ignore selectors | none | Comma-separated CSS selectors hidden before capture, e.g. `.cookie-banner, [data-testid="clock"]`. |
| Local / staging headers | none | JSON object of extra HTTP headers, e.g. `{"Authorization":"Bearer …"}`. |
| Local / staging cookies | none | JSON array of Playwright cookies, e.g. `[{"name":"session","value":"…","domain":"localhost"}]`. |
| Full-page screenshots | on | Off captures only the 1920×1080 viewport — useful when long pages shift vertically and inflate the pixel diff. |
| Ignore whitespace-only changes | on | Ignores indentation-only content changes. |
| Compare attributes | on | Include `href`, `src`, `alt`, `aria-*`, form attributes, etc. |
| Ignore domain differences | on | Normalises each side's own origin/host before diffing. |
| Standard Chrome user agent | on | Sends a normal Chrome UA instead of the headless signature. |
| Scroll for lazy content | on | Scrolls the page to trigger lazy-loaded sections. |

Per-side headers and cookies are useful for pages behind a login or feature flag.

## Scripts

```bash
npm start               # run on http://127.0.0.1:4173
npm run dev             # restart on file changes
npm run setup:browser   # install Chromium for playwright-core
npm run smoke           # end-to-end test against the demo pages
```

Environment variables: `PORT` (default `4173`), `HOST` (default `127.0.0.1`).

The smoke test boots the server on port `4399` (override with `SMOKE_PORT`), compares the demo pages, and verifies screenshots, artifacts, the HTML report and the JSON export.

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/health` | App, engine and viewport status. |
| `GET /api/demo-targets` | Absolute URLs of the bundled demo pages. |
| `POST /api/compare` | Run a comparison. Body: `{ localUrl, stagingUrl, ...options }`. Returns the full result. |
| `GET /api/result/:id` | Re-read a stored result. Add `?download=1` to download JSON. |
| `GET /api/report/:id` | Download the self-contained HTML report. |
| `GET /artifacts/:id/:file` | Screenshots and `result.json` for a run. |

`POST /api/compare` accepts `settleMs`, `pixelThreshold`, `ignoreSelectors`, `localHeaders`, `stagingHeaders`, `localCookies`, `stagingCookies`, `fullPage`, `ignoreWhitespace`, `compareAttributes`, `normalizeOrigins`, `standardUserAgent` and `scrollPage`. One comparison runs at a time; concurrent requests get HTTP `429`.

## Project layout

```
difflens/
├── server.js              Express server, API, artifact retention
├── lib/
│   ├── browser.js         Chromium engine + fixed 1920×1080 viewport
│   ├── capture.js         Navigation, settling, text/DOM extraction, screenshots
│   ├── diff-visual.js     Pixel diff, changed regions
│   ├── diff-content.js    Line and word diff
│   ├── diff-markup.js     Element/attribute diff
│   ├── compare.js         Orchestration and result assembly
│   ├── report.js          Standalone HTML report
│   └── util.js            URL/header/cookie validation, normalisation
├── public/                UI
├── demo/                  Demo local + staging pages
├── scripts/               Browser installer, smoke test
└── .artifacts/            Generated screenshots and results (gitignored)
```

## Design notes

**Why Chromium?** DiffLens started as a probe of [Lightpanda](https://lightpanda.io). Lightpanda is excellent for fast DOM/content extraction, but version 1.0.3 has no graphical rendering: CSS is used only for visibility, not layout or paint, and screenshots come out unstyled. A real visual diff needs a rendering engine, so the app uses the Chromium build shipped with Playwright. Lightpanda is not required and is not used.

**Why a fixed viewport?** Comparisons are only meaningful when both pages render at the same size. DiffLens always uses 1920×1080, device scale factor 1, `en-US`, light colour scheme and reduced motion.

## Limitations

- **Dynamic content** (timestamps, A/B tests, live counters, carousels) will show as differences. Use ignore selectors or a longer settle delay.
- **Full-page pixel diffs on long pages** are sensitive to vertical layout shifts: adding one paragraph moves everything below it, producing large pink bands. Turn off full-page capture for a stable viewport diff, or read the content/markup tabs for precise changes.
- **Canvas/WebGL and video** cannot be meaningfully compared as text or DOM.
- **Bot protection** can serve different markup to headless Chromium. The standard UA option helps but is not a guarantee.
- **Auth**: use per-side headers/cookies. Cookie domains must match the target.
- **Security**: DiffLens fetches whatever URL you give it (including internal hosts). It binds to `127.0.0.1` by default — do not expose it to an untrusted network without adding authentication and SSRF protections.
- Only `http://` and `https://` URLs are accepted.

## Live mode (single-tab split view)

Live mirroring runs **both pages inside a single Chromium tab** using two sandboxed iframes — no second tab is created.

- **Layout**: 1920×1080 viewport, local pane on the left (x=0, width=960), staging pane on the right (x=960, width=960). Each page has its own 960×1080 viewport.
- **Interaction**: Clicking or scrolling either page automatically performs the same action on the other page. Element resolution uses id → aria-label → name → href → role → text → CSS path.
- **Navigation**: Link clicks are mirrored by clicking the same element in the other iframe, so each side follows its own `href`. Navigation is naturally bi-directional.
- **Sandbox / header limitations**: 
  - The iframe `sandbox` attribute blocks `target="_blank"` popups and top-level navigation.
  - `X-Frame-Options` and `Content-Security-Policy: frame-ancestors 'none'` headers on the target pages are **stripped per-document** via Playwright routing, so the iframes can embed them. Basic Auth and any custom headers configured per-side are applied only to the matching origin.
- **Basic Auth**: Per-origin preemptive Basic Auth credentials are never leaked to the other side. Passwords are never stored in `localStorage` or sent to the server. Only the username may persist in the UI for the current session.
- **Session limits**: Max 2 concurrent live sessions; 5-minute idle timeout; 20-second no-client grace period.

### Limitations in live mode

- `target="_blank"` links open in a blocked sub-window and are reported as errors.
- Top-level navigation (e.g. pasting a new URL) is blocked by the iframe sandbox.
- Pages with frame-breaking CSP that do not strip `X-Frame-Options`/`frame-ancestors` cannot be embedded.

## Per-side Basic Auth

DiffLens supports **preemptive Basic Auth on each side independently**.

- Credentials are entered in the UI as username and password fields.
- Per-side auth is configured per-origin; the same origin on both sides can have different credentials.
- Auth is sent preemptively via the `Authorization: Basic <base64>` header **only** to the matching origin — it never leaks to the other side.
- Passwords are **never** persisted to `localStorage`, sent to the server, or included in any exported artifact.
- The UI persistently stores only the username (for display); the password field is cleared after the session ends.
- If credentials are wrong, the page returns `401` and the session reports the failure on its own side only; the other side continues unaffected.

### Basic Auth in static comparison

When running a comparison (not live mode), per-side Basic Auth is passed through Playwright's `httpCredentials` and the resulting screenshots and diffs reflect the authenticated state on each side separately.

### Basic Auth in live mode

In live sessions, the same per-origin preemptive auth is applied. The CDP screencast and click/wheel mirroring operate over the authenticated render of each side. The UI shows a per-origin authorization header only on the matching side.

## Scripts (temporarily removed)

Some experimental scripts under `scripts/` have been removed to keep the repo focused. The core smoke test at `scripts/smoke.js` remains and now includes live-session checks and per-side auth isolation verification.

## Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Chromium is not installed` | Run `npm run setup:browser`. |
| `Port 4173 is already in use` | `PORT=4174 npm start`. |
| `A comparison is already running` | Wait for the current run to finish (runs are serialised). |
| Screenshots are blank | The site may block headless browsers or render in canvas. Check the Diagnostics tab and the warnings banner. |
| Pixel diff looks huge | Disable full-page capture, or ignore animated/rotating selectors. |
