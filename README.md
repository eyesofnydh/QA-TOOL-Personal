# SEO + Website QA Audit Tool (Local MVP)

A real, runnable crawler + SEO/QA auditor. This is the **MVP tier**: crawler →
pages → HTTP status → title/meta → H1–H6 → indexability, plus a dashboard,
issue list, and "open pages" batch launcher. It does not yet include every
feature from the full spec (schema/breadcrumb deep checks, custom rule file
uploads, crawl history/diffing, PDF/Excel export, Postgres) — see "Not built
yet" below. The architecture (crawler → parsers → rule engine → issues) is
laid out so those can be added without rewriting what's here.

## Requirements

- Node.js 18 or newer (needed for built-in `fetch`)
- Internet access from this machine to reach whatever site you're auditing

## Setup

```bash
cd seo-audit-tool
npm install
```

Playwright (used only for "Auto" and "Browser" crawl modes, to render
JS-heavy pages) needs its browser binary downloaded once:

```bash
npx playwright install chromium
```

If that step fails or you don't need JS rendering, you can skip it — just use
**Crawl Mode: HTTP only** in the UI. The app still runs fine; it just won't
be able to render JavaScript-heavy pages.

## Run

```bash
npm start
```

Then open **http://localhost:4000** in your browser.

## Using it

1. Enter a website URL (e.g. `https://example.com`).
2. Choose a crawl mode:
   - **Auto** — tries plain HTTP first; if a page looks like an empty
     JS-app shell, it re-fetches that page with a real headless browser.
   - **HTTP only** — fastest, no JS rendering.
   - **Browser only** — every page rendered with Playwright (slower).
3. Set max pages / max depth (kept small at first — try 20–50 pages while
   you get a feel for it before running a full site).
4. Click **Start Crawl** and watch live progress.
5. Review the dashboard, sort through the issues table, tick pages, and use
   **Open Next Batch** to pop them open a batch at a time (this avoids
   popup-blocker issues — the browser will only allow a handful of
   `window.open()` calls per user click, which is why it's batched).
6. **Export JSON** downloads the full report.

## What's actually checked right now

- Crawl: internal link discovery, URL normalization/dedupe, depth tracking,
  HTTP status, redirect chains + loop detection, robots.txt respect,
  concurrency limit, per-request timeout, 5MB response cap.
- SEO: title (missing/duplicate/length), meta description
  (missing/duplicate), canonical presence, H1 (missing/multiple/empty),
  heading-level hierarchy jumps, meta-robots + X-Robots-Tag indexability,
  image alt-text coverage, JSON-LD schema type detection, a basic
  visible-breadcrumb-vs-BreadcrumbList-schema check.
- Security: blocks requests to localhost, private IP ranges (10/8, 172.16/12,
  192.168/16, 127/8, link-local incl. the 169.254.169.254 cloud metadata
  address), and re-validates on every redirect hop — this is not exhaustive
  SSRF hardening for a public-facing service, just baseline protection for a
  tool that fetches user-supplied URLs.

## Not built yet (from the full spec)

These are straightforward to add on top of this base, but aren't in yet:

- Custom rule file uploads (JSON/CSV/Excel/PDF/DOCX) and custom schema
  validation
- Thank-you/error page pattern configuration and soft-404 detection
- Sitemap.xml parsing and sitemap-vs-crawl comparison
- Full breadcrumb link-validity checking
- CSV/Excel/PDF export (only JSON export exists right now)
- Persistent storage + crawl history + crawl-to-crawl diffing (current
  results live in server memory only and are lost on restart)
- A dedicated page-detail view (right now page-level detail is only in the
  exported JSON, not a UI panel)

## Going live (hosting it publicly instead of locally)

This app can crawl **any** URL it's given, so once it's reachable on the
public internet, it needs a password — otherwise anyone can point your
server at arbitrary sites and use it as an open crawling proxy. That's
already built in via `AUTH_USER`/`AUTH_PASS` env vars (Basic Auth) plus a
per-IP rate limit on starting crawls; both are no-ops until you set them.

### Deploy to Render (recommended — free tier, handles Docker + Playwright)

1. Push this folder to a GitHub repo.
2. On [render.com](https://render.com), **New → Blueprint**, point it at
   the repo. It'll read `render.yaml` automatically, which is set to the
   **Free** instance type.
3. When prompted, set `AUTH_USER` and `AUTH_PASS` to whatever login you want.
4. Deploy. Render builds the `Dockerfile` (which already includes Chromium
   for Playwright — no extra `playwright install` step needed) and gives you
   a `https://your-app.onrender.com` URL.
5. Visiting it will prompt for the username/password you set.

Render's free instance is 512 MB RAM / 0.1 CPU. HTTP-mode crawls run fine on
it. Auto/Browser mode (real Chromium via Playwright) is memory-hungry —
expect it to be slow, and it may occasionally run out of memory on a
JS-heavy site. If that happens, either stick to HTTP mode on the free tier,
or bump `plan: free` to `plan: starter` in `render.yaml` (a paid tier with
more RAM) before redeploying.

### Deploy to Railway or Fly.io

Same idea — both read the `Dockerfile` directly. Set `AUTH_USER` and
`AUTH_PASS` as environment variables/secrets in their dashboard or CLI, and
deploy. No `render.yaml`-equivalent is required; they build from the
`Dockerfile` by default.

### Deploy with plain Docker anywhere (a VPS, etc.)

```bash
docker build -t site-audit-console .
docker run -d -p 4000:4000 \
  -e AUTH_USER=youruser \
  -e AUTH_PASS=yourpassword \
  -e NODE_ENV=production \
  site-audit-console
```

### Before you actually make it public, know the trade-offs

- **It's still a live crawler pointed at arbitrary sites** — the SSRF
  protections here (blocking localhost/private IPs) are baseline, not a
  substitute for running this against sites you trust or have permission to
  audit. Don't hand the URL out further than you're comfortable with.
- **Concurrent crawls cost real memory** — each Playwright-rendered page is
  a full Chromium tab. Free/starter tiers (Render's included) will choke
  under more than one or two crawls running at once; that's fine for solo
  use, less fine if several people share the link.
- **Reports are still in-memory only** — restarting the server (a deploy,
  a crash, a free-tier idle-then-wake cycle) loses past results. Export to
  JSON/CSV before closing the tab if you want to keep something.
- **This is still the MVP tier** from the original scope — see "Not built
  yet" above. Going live doesn't add features, it just changes where it runs.

## Extending it

- Add new checks in `src/seoChecks.js` (per-page) or `src/crawler.js`
  (`buildReport`, for cross-page checks like duplicates).
- Add a new crawl mode or fetcher in `src/fetcher.js`.
- Swap in-memory job storage in `server.js` for a database once you need
  history across restarts.
