# Site Audit Console

A website crawler with SEO checks, custom rule uploads, page details, issue filters,
CSV/JSON exports, and recent reports saved in your browser.

## Run locally

Requires Node.js 22 or newer.

```sh
npm ci
npx playwright install chromium
npm start
```

Open http://localhost:4000. Chromium is optional for HTTP-only crawls. Use HTTP
mode for lower memory consumption, Auto for selective JavaScript rendering, or
Browser to render every page. A link depth of zero checks only the starting URL.

Environment variables can be set by your shell or hosting provider. To load an
optional local `.env` file on Node 22+, use `node --env-file=.env server.js`.
Do not commit credentials.

## Deploy or update on Render

1. Push the project, including `package-lock.json`, to the connected repository.
2. Create a Blueprint from `render.yaml`, or update your existing Docker service.
3. Set both `AUTH_USER` and `AUTH_PASS` in Render's Environment settings.
4. Set the service health check path to `/healthz` if managing it manually.
5. Deploy the updated commit, then check `/healthz` and run a small HTTP crawl.

The Docker image and exact Playwright package version must stay in sync. The
Docker build uses `npm ci` for reproducible installs. The app binds to `0.0.0.0`
and honors Render's `PORT`. `/healthz` is public; all other routes use Basic Auth
when both credentials are configured.

`MAX_ACTIVE_CRAWLS` defaults to 1 to keep memory use bounded. Browser pages are
processed sequentially. HTTP mode is the default and is the best starting point
on a small instance. Browser mode can still exhaust a small instance on complex
sites; upgrade resources if your workloads require it.

See [Render health checks](https://render.com/docs/health-checks) and
[Playwright Docker setup](https://playwright.dev/docs/docker).

## What's included

- Internal HTTP/HTTPS link discovery with URL deduplication, page and depth limits.
- Basic robots.txt handling, redirect chains, response limits, timeout handling.
- Titles, descriptions, headings, indexability, canonical tags, image alt coverage,
  Open Graph, JSON-LD, breadcrumb detection, and near-duplicate content checks.
- Custom expectations from CSV, TSV, XLSX/XLS/XLSM, JSON, DOCX, TXT, and Markdown.
  Preview uploads before starting. URLs outside the crawl can be fetched directly
  to validate redirect or metadata rules; these extra checks are outside the
  crawl page limit and robots filtering.
- Searchable issues and pages, a page detail drawer, batch opening, CSV and JSON.
- Responsive workspace with Quick (20 pages / depth 2), Standard (50 / 3), and
  Deep (200 / 5) crawl presets. Presets change page/depth limits and preserve your
  selected crawl mode and robots setting.
- A Fix first list groups repeated issues, ranks by severity and affected pages,
  and opens the matching issue filters. This is a prioritization aid, not an SEO
  impact prediction.
- Page filters for broken URLs, redirects, noindex, and pages with issues.
  Export pages CSV downloads only the currently filtered pages; issue CSV still
  includes all issues. Spreadsheet formula-like values are escaped on export.
- An illustrative search-result preview in page details, with keyboard focus
  management for the detail drawer. Search engines may use different snippets.
- Automatic progress reconnection after temporary connection loss or refresh.
- Up to five completed reports saved in this browser, subject to storage limits.
  Use Recent reports to reopen or clear them. Export important reports for backup.
- A server health endpoint, crawl rate limiting, single-crawl admission by default,
  JSON validation/upload errors, and bounded completed-job retention.

## Storage and limits

Running jobs and server reports remain in memory. A Render restart or redeploy
loses these jobs. Refresh recovery works only while the job is still on the same
server. Previously saved browser reports survive server restarts, but are not
shared across devices and disappear if browser storage is cleared. Private
browsing or full storage may prevent saving; export JSON/CSV in that case.

The health score is a heuristic, not a search ranking prediction or a measured
Core Web Vitals score. The crawler does not implement exhaustive robots.txt
semantics, sitemap discovery/comparison, PDF reports, durable database history,
or crawl-to-crawl comparisons yet.

Outbound URL checks block common private and internal addresses. HTTP and robots
redirects are rechecked, and browser requests are screened. This is baseline
protection, not full SSRF isolation: DNS rebinding and browser networking require
network-level egress controls for a broadly exposed untrusted crawling service.
Keep authentication configured and audit sites you are authorized to inspect.

SheetJS is pinned to its official patched distribution because the npm-hosted
`xlsx` release is outdated. See the [official installation instructions](https://docs.sheetjs.com/docs/getting-started/installation/nodejs/).

## Verification

```sh
npm test
npm run test:ui
npm audit
```

The UI smoke test needs Chromium (`npx playwright install chromium`). It tests
results, browser history, refresh recovery, and mobile controls using a fixture
report; regression tests cover the real server and mocked outbound crawl traffic.
Neither suite contacts a live Render deployment.
