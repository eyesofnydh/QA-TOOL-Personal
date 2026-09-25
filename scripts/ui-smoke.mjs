import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: '14092', AUTH_USER: '', AUTH_PASS: '' }, stdio: ['ignore', 'pipe', 'pipe']
});
let browser;
try {
  await Promise.race([once(server.stdout, 'data'), once(server, 'exit').then(() => { throw new Error('Server startup failed'); })]);
  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  await mkdir('test-results', { recursive: true });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const report = { generatedAt: new Date().toISOString(), seedUrl: 'https://example.com/',
    summary: { checkedPages: 3, pagesCrawled: 3, robotsSkippedCount: 0, score: 85, counts: { FAIL: 1, WARNING: 2, INFO: 0 } },
    pages: [{ url: 'https://example.com/', status: 200, analysis: { title: 'A better website starts here', metaDescription: 'Practical tools and ideas for building a better website.', indexability: { index: true, follow: true }, og: {}, breadcrumb: {}, headings: [], h1Count: 1 } },
      { url: 'https://example.com/missing', status: 404 }, { url: 'https://example.com/about', finalUrl: 'https://example.com/team', redirected: true, status: 200 }],
    issues: [
      { severity: 'FAIL', category: 'Technical', url: 'https://example.com/missing', issue: 'HTTP error', recommendation: 'Fix the broken page or redirect it to a relevant page.', expected: '200', actual: '404' },
      ...['/', '/about'].map((path) => ({ severity: 'WARNING', category: 'Metadata', url: `https://example.com${path}`, issue: 'Missing og:image', recommendation: 'Add a social sharing image to help your pages stand out.', expected: 'Present', actual: 'Missing' }))
    ] };
  await page.route('**/api/crawl', (route) => route.fulfill({ json: { crawlId: 'ui-check' } }));
  await page.route('**/api/crawl/ui-check/events', (route) => route.fulfill({
    contentType: 'text/event-stream', body: `event: done\ndata: ${JSON.stringify(report)}\n\n`
  }));
  await page.goto('http://127.0.0.1:14092');
  assert.equal(await page.locator('#mode').inputValue(), 'http');
  await page.locator('[data-preset="quick"]').click();
  assert.equal(await page.locator('#maxPages').inputValue(), '20');
  assert.equal(await page.locator('#maxDepth').inputValue(), '2');
  await page.locator('[data-preset="standard"]').click();
  await page.screenshot({ path: 'test-results/setup-desktop.png', fullPage: true });
  await page.locator('#seedUrl').fill('https://example.com');
  await page.locator('#maxDepth').fill('0');
  await page.locator('#startBtn').click();
  await page.locator('#results').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#scoreVal').textContent(), '85');
  await page.screenshot({ path: 'test-results/results-desktop.png', fullPage: true });
  assert.match(await page.locator('.priority-item').first().textContent(), /HTTP error/);
  assert.match(await page.locator('.priority-item').nth(1).textContent(), /2 pages/);
  await page.locator('.priority-item').first().click();
  assert.equal(await page.locator('#issuesBody tr').count(), 1);
  await page.locator('#clearFiltersBtn').click();
  assert.equal(await page.locator('#issuesBody tr').count(), 3);
  await page.locator('[data-tab="pages"]').click();
  await page.locator('#pageStatus').selectOption('broken');
  assert.equal(await page.locator('#pagesBody tr').count(), 1);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#exportPagesBtn').click();
  const download = await downloadPromise;
  const csv = await readFile(await download.path(), 'utf8');
  assert.match(csv, /example.com\/missing/);
  assert.doesNotMatch(csv, /example.com\/about/);
  await page.locator('#pageStatus').selectOption('');
  await page.locator('[data-detail="https://example.com/"]').click();
  assert.match(await page.locator('.search-preview').textContent(), /A better website starts here/);
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.locator('#drawerCopy').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Escape');
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
  await page.screenshot({ path: 'test-results/results-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Results must not overflow the phone viewport');
  await page.locator('#newCrawlBtn').click();
  await page.screenshot({ path: 'test-results/setup-mobile.png', fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, 'Setup must not overflow the phone viewport');
  await page.locator('#historyPanel summary').click();
  await page.locator('#clearHistoryBtn').click();
  assert.match(await page.locator('#historyList').textContent(), /Completed reports/);
  assert.deepEqual(errors, []);
  console.log('UI smoke passed: presets, priorities, page filters, filtered CSV download, search preview, keyboard focus, history, refresh recovery, mobile layout, no browser errors.');
} finally {
  await browser?.close();
  server.kill();
}
