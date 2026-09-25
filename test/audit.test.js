import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { parseCrawlOptions } from '../src/crawlOptions.js';
import { assertSafeUrl, isPrivateIp } from '../src/security.js';
import { runCrawl } from '../src/crawler.js';
import { evaluateCustomRules } from '../src/customRules.js';
import { fetchRobots } from '../src/robots.js';
import { parseRuleFiles } from '../src/ruleFileParser.js';
import XLSX from 'xlsx';

const origin = 'https://93.184.216.34';
const html = (links = '') => `<html><head><title>Approved title</title></head><body><h1>Heading</h1>${links}</body></html>`;
const response = (body) => new Response(body, { headers: { 'content-type': 'text/html' } });

test('crawl options preserve depth zero and reject invalid limits and URLs', () => {
  assert.equal(parseCrawlOptions({ seedUrl: origin, maxDepth: '0' }).maxDepth, 0);
  for (const maxPages of [-1, 'NaN', 501, 1.5]) {
    assert.throws(() => parseCrawlOptions({ seedUrl: origin, maxPages }));
  }
  for (const seedUrl of ['file:///etc/passwd', 'https://user:pass@example.com', 'wrong']) {
    assert.throws(() => parseCrawlOptions({ seedUrl }));
  }
});

test('blocks IPv4 and IPv6 internal addresses including mapped IPv4', async () => {
  for (const ip of ['127.0.0.1', '100.64.0.1', '::1', '::', '::ffff:7f00:1', 'fe90::1']) {
    assert.equal(isPrivateIp(ip), true, ip);
  }
  await assert.rejects(assertSafeUrl('http://[::ffff:127.0.0.1]'), /Blocked/);
  assert.equal(isPrivateIp('93.184.216.34'), false);
});

test('crawl discovers unique pages without duplicate links consuming its limit', async (t) => {
  const seen = [];
  t.mock.method(globalThis, 'fetch', async (url) => {
    const path = new URL(url).pathname;
    seen.push(path);
    return response(html(path === '/' ? '<a href="/a">A</a><a href="/b">B</a>'
      : path === '/a' ? '<a href="/b">B</a><a href="/c">C</a>' : ''));
  });
  const report = await runCrawl({ seedUrl: origin, mode: 'http', maxPages: 4, maxDepth: 2, respectRobots: false }, () => {});
  assert.deepEqual(seen, ['/', '/a', '/b', '/c']);
  assert.equal(report.pages.length, 4);
});

test('depth zero fetches only the seed', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(html('<a href="/next">Next</a>')));
  const report = await runCrawl({ seedUrl: origin, mode: 'http', maxPages: 10, maxDepth: 0, respectRobots: false }, () => {});
  assert.equal(report.pages.length, 1);
});

test('custom metadata checks analyse directly fetched pages', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => response(html()));
  const result = await evaluateCustomRules([{ url: origin, expectedTitle: 'Approved title' }], []);
  assert.equal(result.results[0].checks[0].pass, true);
  assert.equal(result.issues.length, 0);
});

test('robots redirects cannot fetch private addresses', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response('', { status: 302, headers: { location: 'http://127.0.0.1/secret' } });
  });
  const robots = await fetchRobots(origin);
  assert.equal(calls, 1);
  assert.equal(robots.exists, false);
  assert.match(robots.error, /Blocked/);
});

test('patched spreadsheet parser reads CSV and XLSX rule uploads', async () => {
  const rows = [['URL', 'Title'], [origin, 'Approved title']];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), 'Rules');
  for (const file of [
    { filename: 'rules.csv', buffer: Buffer.from(`URL,Title\n${origin},Approved title`) },
    { filename: 'rules.xlsx', buffer: XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) }
  ]) {
    const parsed = await parseRuleFiles([file], origin);
    assert.equal(parsed.rules.length, 1);
    assert.equal(parsed.rules[0].expectedTitle, 'Approved title');
  }
});

test('health, authentication, validation and late error subscribers work end to end', async (t) => {
  const child = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PORT: '14091', AUTH_USER: 'tester', AUTH_PASS: 'with:colon' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  t.after(() => child.kill());
  await Promise.race([
    once(child.stdout, 'data'),
    once(child, 'exit').then(([code]) => { throw new Error(`Server exited: ${code}`); }),
    new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Server startup timed out')), 10000); timer.unref(); })
  ]);
  const base = 'http://127.0.0.1:14091';
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  assert.equal((await fetch(base)).status, 401);
  const headers = { authorization: `Basic ${Buffer.from('tester:with:colon').toString('base64')}`, 'content-type': 'application/json' };
  assert.equal((await fetch(base, { headers })).status, 200);
  const invalid = await fetch(`${base}/api/crawl`, { method: 'POST', headers, body: JSON.stringify({ seedUrl: origin, maxDepth: -1 }) });
  assert.equal(invalid.status, 400);
  const started = await fetch(`${base}/api/crawl`, { method: 'POST', headers, body: JSON.stringify({ seedUrl: 'http://127.0.0.1', maxDepth: 0 }) });
  const { crawlId } = await started.json();
  assert.ok(crawlId);
  const stream = await fetch(`${base}/api/crawl/${crawlId}/events`, { headers, signal: AbortSignal.timeout(5000) });
  const events = await stream.text();
  assert.match(events, /event: crawl-error/);
  assert.match(events, /Blocked/);
  const status = await (await fetch(`${base}/api/crawl/${crawlId}`, { headers })).json();
  assert.equal(status.status, 'error');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
});
