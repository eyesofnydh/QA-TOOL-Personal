import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: '14092', AUTH_USER: '', AUTH_PASS: '' }, stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server startup failed'); })]);
  browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const report = { generatedAt: new Date().toISOString(), seedUrl: 'https://example.com/',
    summary: { checkedPages: 1, pagesCrawled: 1, robotsSkippedCount: 0, score: 85, counts: { FAIL: 0, WARNING: 0, INFO: 0 } },
    pages: [{ url: 'https://example.com/', status: 200 }], issues: [] };
  await page.route('**/api/crawl', (route) => route.fulfill({ json: { crawlId: 'ui-check' } }));
  await page.route('**/api/crawl/ui-check/events', (route) => route.fulfill({
    contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(report)}\n\n`
  }));
  await page.goto('http://127.0.0.1:14092');
  assert.equal(await page.locator('#mode').inputValue(), 'http');
  await page.locator('#seedUrl').fill('https://example.com');
  await page.locator('#maxDepth').fill('0');
  await page.locator('#startBtn').click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#scoreVal').textContent(), '85');
  await page.reload();
  await page.locator('#historyPanel summary').click();
  await page.getByRole('button', { name: 'Open report', exact: true }).click();
  await page.locator('#results').waitFor({ state: 'visible' });
  // A running crawl saved before refresh reconnects and stores the completed report.
  await page.evaluate(() => localStorage.setItem('seo-audit-active-v1', JSON.stringify({ crawlId: 'ui-check', seedUrl: 'https://example.com/' })));
  await page.reload();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.equal(await page.evaluate(() => localStorage.getItem('seo-audit-active-v1')), null);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#newCrawlBtn').click();
  await page.locator('#historyPanel summary').click();
  await page.locator('#clearHistoryBtn').click();
  assert.match(await page.locator('#historyList').textContent(), /Completed reports/);
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: crawl results, saved history, refresh recovery, mobile controls, no browser errors.');
} finally {
  await browser?.close();
  server.kill();
}
