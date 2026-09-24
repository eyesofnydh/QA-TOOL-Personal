import { assertSafeUrl } from './security.js';

const MAX_REDIRECTS = 5;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5MB response-size cap

export async function fetchHttp(urlStr, { timeoutMs = 10000 } = {}) {
  let currentUrl = urlStr;
  const chain = [];
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertSafeUrl(currentUrl); // re-validate on every hop
    const start = Date.now();
    let res;
    try {
      res = await fetch(currentUrl, {
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'SEO-Audit-Bot/1.0 (+local-audit-tool)' }
      });
    } catch (e) {
      return { finalUrl: currentUrl, status: 0, error: e.message, chain, responseTimeMs: Date.now() - start };
    }
    const responseTimeMs = Date.now() - start;

    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) {
        return { finalUrl: currentUrl, status: res.status, chain, responseTimeMs, error: 'Redirect with no Location header' };
      }
      const nextUrl = new URL(location, currentUrl).toString();
      if (chain.some((c) => c.from === nextUrl) || nextUrl === currentUrl) {
        return { finalUrl: currentUrl, status: res.status, chain, responseTimeMs, error: 'Redirect loop detected' };
      }
      chain.push({ from: currentUrl, to: nextUrl, status: res.status });
      currentUrl = nextUrl;
      continue;
    }

    const contentType = res.headers.get('content-type') || '';
    const xRobotsTag = res.headers.get('x-robots-tag') || '';
    let body = '';
    if (contentType.includes('text/html')) {
      const reader = res.body?.getReader?.();
      if (reader) {
        let received = 0;
        const chunks = [];
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          received += value.length;
          chunks.push(value);
          if (received > MAX_BODY_BYTES) break;
        }
        body = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString('utf-8');
      } else {
        body = await res.text();
      }
    }
    return {
      finalUrl: currentUrl,
      status: res.status,
      contentType,
      xRobotsTag,
      body,
      chain,
      responseTimeMs,
      redirected: chain.length > 0
    };
  }
  return { finalUrl: currentUrl, status: 0, error: 'Too many redirects', chain };
}

let browserPromise = null;
async function getBrowser() {
  if (!browserPromise) {
    browserPromise = (async () => {
      const { chromium } = await import('playwright');
      return chromium.launch({ headless: true });
    })();
  }
  return browserPromise;
}

export async function fetchRendered(urlStr, { timeoutMs = 15000 } = {}) {
  await assertSafeUrl(urlStr);
  const start = Date.now();
  const browser = await getBrowser();
  const page = await browser.newPage();
  try {
    const response = await page.goto(urlStr, { waitUntil: 'networkidle', timeout: timeoutMs });
    const body = await page.content();
    const status = response ? response.status() : 0;
    const headers = response ? response.headers() : {};
    return {
      finalUrl: page.url(),
      status,
      contentType: headers['content-type'] || 'text/html',
      xRobotsTag: headers['x-robots-tag'] || '',
      body,
      chain: [],
      responseTimeMs: Date.now() - start,
      rendered: true
    };
  } finally {
    await page.close();
  }
}

function looksJsRendered(body) {
  if (!body) return true;
  const textOnly = body
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (textOnly.length < 150) return true;
  if (/<div[^>]+id=["'](root|app|__next)["'][^>]*>\s*<\/div>/i.test(body)) return true;
  return false;
}

// Auto mode: try plain HTTP first; if the page looks like an empty SPA shell,
// fall back to a real browser render via Playwright.
export async function autoFetch(urlStr, options = {}) {
  const httpResult = await fetchHttp(urlStr, options);
  if (httpResult.error || !httpResult.body) return { ...httpResult, mode: 'http' };
  if (looksJsRendered(httpResult.body)) {
    try {
      const rendered = await fetchRendered(httpResult.finalUrl, options);
      return { ...rendered, mode: 'browser-fallback' };
    } catch (e) {
      return { ...httpResult, mode: 'http', renderFallbackError: e.message };
    }
  }
  return { ...httpResult, mode: 'http' };
}
