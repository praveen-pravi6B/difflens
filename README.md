<div align="center">

<img src="logo.png" width="104" height="104" alt="DiffLens" width="104" />

# DiffLens

### Compare. Understand. Ship with confidence.

Compare a local web app against staging and see exactly what changed — visually, in the text, and in the markup.

<p>
  <strong>Visual diff</strong> · <strong>Content diff</strong> · <strong>Markup diff</strong>
</p>

</div>

---

## Why DiffLens?

DiffLens is a local web app for reviewing changes between a local build and a staging environment. It renders both pages in Chromium at the same **1920 × 1080** viewport, then produces three independent comparisons:

| Comparison | What you get |
| --- | --- |
| **Visual** | Full-page pixel comparison. Changed pixels are highlighted over a faded local screenshot. Inspect side-by-side, slider-overlay, or diff-only views. |
| **Content** | Visible text compared line by line, with word-level highlights for modified lines. Staging is the baseline; local is the candidate. |
| **Markup** | DOM elements matched by rendered CSS path, including added and removed nodes, text changes, and tracked attribute changes such as `href`, `src`, and `alt`. |

Every comparison also produces a **self-contained HTML report** with embedded screenshots and a **JSON result**.

## Features

- **Consistent browser rendering** — both pages use Chromium with a fixed viewport and isolated browser contexts.
- **Three independent diff layers** — visual, content, and markup comparisons.
- **Useful diagnostics** — capture console and network diagnostics alongside page snapshots.
- **Authentication support** — configure per-side headers, cookies, and Basic Auth.
- **Live mode** — mirror interactions between local and staging pages in a single split-view tab.
- **Shareable output** — export a standalone HTML report and JSON data.
- **Local-first workflow** — runs on your machine and binds to `127.0.0.1` by default.

## Quick start

### Requirements

- Node.js 20 or later
- macOS, Linux, or Windows
- Approximately 150 MB for the Chromium browser build

### Install and run

```bash
git clone <your-repository-url>
cd difflens
npm install
npm run setup:browser   # Download Chromium once
npm start
```

Open **http://127.0.0.1:4173** and select **Try the demo**. The bundled demo pages contain intentional differences so you can explore all three comparison layers.

### Compare your own pages

Enter the two URLs in the app:

- **Local** — for example, `http://localhost:3000`
- **Staging** — for example, `https://staging.example.com`

Select **Compare pages**, or use `⌘ + Enter` on macOS / `Ctrl + Enter` on Windows and Linux.

## How it works

1. DiffLens loads both URLs in parallel, using isolated browser contexts so cookies and storage are not shared between sides.
2. It blocks service workers, freezes animations and transitions, waits for fonts and images, and scrolls the page to trigger lazy-loaded content.
3. It captures visible text (`innerText`), element snapshots, console and network diagnostics, and screenshots.
4. It calculates the three diffs:
   - **Visual:** `pixelmatch` compares screenshots and identifies changed regions.
   - **Content:** `diff` compares lines; adjacent delete/add pairs are presented as word-level modifications.
   - **Markup:** elements are matched by CSS path, with moves caused only by sibling changes filtered out.
5. Results are written to `.artifacts/<id>/`. The directory contains screenshots, text snapshots, and `result.json`. The latest 40 runs are retained.

### Baseline direction

- **Staging is the baseline.**
- **Local is the candidate.**
- Additions are things that are **new in local**; removals are things **missing from local**.
- Domain-only differences are normalized by default. For example, equivalent links on `localhost` and the staging host are not reported as different solely because their origins differ.

## Comparison options

The following options are available in the app's **Options** panel.

| Option | Default | Description |
| --- | --- | --- |
| Wait after load | `1500 ms` | Additional settling time for client-side rendering, fonts, and animations. |
| Pixel threshold | `0.12` | `pixelmatch` sensitivity: `0.01` is strict; `1` is loose. |
| Ignore selectors | None | Comma-separated CSS selectors hidden before capture, such as `.cookie-banner, [data-testid="clock"]`. |
| Local / staging headers | None | JSON object containing extra HTTP headers, such as `{"Authorization":"Bearer …"}`. |
| Local / staging cookies | None | JSON array of Playwright cookies. |
| Full-page screenshots | On | Turn off to capture only the 1920 × 1080 viewport. Useful when vertical shifts on long pages inflate the pixel diff. |
| Ignore whitespace-only changes | On | Ignore indentation-only content changes. |
| Compare attributes | On | Include `href`, `src`, `alt`, `aria-*`, form attributes, and other tracked attributes. |
| Ignore domain differences | On | Normalize each page's own origin/host before comparing links. |
| Standard Chrome user agent | On | Use a standard Chrome user agent instead of the headless signature. |
| Scroll for lazy content | On | Scroll the page to trigger lazy-loaded sections. |

Per-side headers and cookies are useful for pages behind authentication or feature flags.

## Live mode

Live mirroring displays both pages in **one Chromium tab**, using two sandboxed iframes.

- **Layout:** the overall viewport is 1920 × 1080. Local appears on the left (`x = 0`, width `960`); staging appears on the right (`x = 960`, width `960`). Each page receives a 960 × 1080 viewport.
- **Interaction:** clicking or scrolling in either pane mirrors the action in the other pane.
- **Element matching:** the mirror resolves elements using this order: `id` → `aria-label` → `name` → `href` → `role` → text → CSS path.
- **Navigation:** mirrored link clicks use the matching element's own `href` on each side, allowing navigation in either direction.
- **Iframe response headers:** `X-Frame-Options` and CSP `frame-ancestors` restrictions are stripped per document through Playwright routing so target pages can be embedded.
- **Custom headers:** Basic Auth and configured headers are applied only to the matching origin.
- **Session limits:** up to 2 concurrent live sessions, a 5-minute idle timeout, and a 20-second no-client grace period.

### Live mode limitations

- Links with `target="_blank"` are blocked by the iframe sandbox and reported as errors.
- Top-level navigation, such as pasting a new URL into the embedded page, is blocked.
- Pages that cannot be embedded after the supported header handling may not work in live mode.

## Authentication and privacy

### Per-side Basic Auth

DiffLens supports preemptive Basic Auth independently for local and staging.

- Enter credentials in the UI.
- Authentication is configured per origin; the same origin can have different credentials on each side.
- In live mode, the `Authorization: Basic <base64>` header is sent only to the matching origin.
- In static comparison mode, credentials are passed to Playwright through `httpCredentials`.
- Passwords are not persisted to `localStorage`, sent to the server, or included in exported artifacts.
- The UI stores only the username for display. The password field is cleared after the session ends.
- If authentication fails, the affected side reports the `401` response; the other side continues independently.

### Security note

DiffLens fetches the URLs you provide, including internal hosts. It binds to `127.0.0.1` by default. **Do not expose it to an untrusted network** without adding authentication and appropriate SSRF protections. Only `http://` and `https://` URLs are accepted.

## Scripts

```bash
npm start               # Start at http://127.0.0.1:4173
npm run dev             # Restart on file changes
npm run setup:browser   # Install Chromium for Playwright
npm run smoke            # Run the end-to-end smoke test
```

Environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `4173` | HTTP server port. |
| `HOST` | `127.0.0.1` | Server bind address. |
| `SMOKE_PORT` | `4399` | Port used by the smoke test. |

The smoke test starts the server, compares the bundled demo pages, and verifies screenshots, artifacts, the HTML report, JSON export, live-session checks, and per-side authentication isolation.

## API

| Method | Endpoint | Description |
| --- | --- | --- |
| `GET` | `/api/health` | App, engine, and viewport status. |
| `GET` | `/api/demo-targets` | Absolute URLs for the bundled demo pages. |
| `POST` | `/api/compare` | Run a comparison. Body: `{ localUrl, stagingUrl, ...options }`. Returns the full result. |
| `GET` | `/api/result/:id` | Read a stored result. Add `?download=1` to download JSON. |
| `GET` | `/api/report/:id` | Download the self-contained HTML report. |
| `GET` | `/artifacts/:id/:file` | Retrieve screenshots or `result.json` for a run. |

`POST /api/compare` accepts these options:

`settleMs`, `pixelThreshold`, `ignoreSelectors`, `localHeaders`, `stagingHeaders`, `localCookies`, `stagingCookies`, `fullPage`, `ignoreWhitespace`, `compareAttributes`, `normalizeOrigins`, `standardUserAgent`, and `scrollPage`.

Only one comparison runs at a time. Concurrent comparison requests receive HTTP `429`.

## Project structure

```text
difflens/
├── server.js              # Express server, API, artifact retention
├── lib/
│   ├── browser.js         # Chromium engine and fixed viewport
│   ├── capture.js         # Navigation, settling, text/DOM, screenshots
│   ├── diff-visual.js     # Pixel diff and changed regions
│   ├── diff-content.js    # Line and word diff
│   ├── diff-markup.js     # Element and attribute diff
│   ├── compare.js         # Orchestration and result assembly
│   ├── report.js          # Standalone HTML report
│   └── util.js            # URL/header/cookie validation and normalization
├── public/                # Web UI
├── demo/                  # Local and staging demo pages
├── scripts/               # Browser installer and smoke test
├── assets/
│   └── logo.svg
└── .artifacts/            # Generated screenshots and results (gitignored)
```

## Design decisions

### Why Chromium?

DiffLens began as an experiment with [Lightpanda](https://lightpanda.io). Lightpanda is useful for fast DOM and content extraction, but version 1.0.3 does not provide graphical rendering: CSS is used for visibility rather than layout and paint, so screenshots are unstyled. Because visual comparison requires a real rendering engine, DiffLens uses the Chromium build installed for Playwright. **Lightpanda is not required and is not used.**

### Why a fixed viewport?

Both pages must render at the same dimensions for a meaningful comparison. DiffLens uses:

- Viewport: `1920 × 1080`
- Device scale factor: `1`
- Locale: `en-US`
- Colour scheme: `light`
- Reduced motion: enabled

## Limitations and troubleshooting

| Issue | What to try |
| --- | --- |
| Chromium is not installed | Run `npm run setup:browser`. |
| Port `4173` is already in use | Run `PORT=4174 npm start`. |
| A comparison is already running | Wait for the current run to finish; comparisons are serialized. |
| Screenshots are blank | The target may block headless browsers or render content in canvas. Check the Diagnostics tab and warnings banner. |
| Pixel diff is unexpectedly large | Disable full-page capture or ignore animated/rotating elements. |
| Dynamic content differs | Timestamps, A/B tests, live counters, and carousels can change between captures. Use ignore selectors or adjust the settle delay. |
| Long-page pixel diff is noisy | Vertical layout shifts can move everything below a changed section. Try viewport-only capture, or inspect the content and markup tabs. |
| Canvas, WebGL, or video content differs | These cannot be meaningfully compared as text or DOM. |
| The site serves different content to Chromium | Bot protection may behave differently for headless browsers. The standard Chrome user-agent option may help, but is not guaranteed. |
| Authenticated page fails | Check per-side headers, cookies, or Basic Auth. Cookie domains must match the target. |
| A live-mode page will not embed | Check for iframe restrictions and the live-mode limitations above. |

## Contributing

Issues, ideas, and pull requests are welcome. When reporting a comparison problem, include the relevant diagnostics and note whether it occurs in static comparison or live mode. **Do not include passwords, session cookies, or other secrets** in issue reports.

## License

Add the repository's chosen license and license file before publishing or distributing the project.

---

<div align="center">

**DiffLens** · Compare with clarity. Ship with confidence.

</div>
