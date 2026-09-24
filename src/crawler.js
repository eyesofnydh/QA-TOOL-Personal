import * as cheerio from 'cheerio';
import { autoFetch, fetchHttp, fetchRendered } from './fetcher.js';
import { normalizeUrl, isSameHost, extractLinks } from './urlUtils.js';
import { fetchRobots, isAllowedByRobots } from './robots.js';
import { analyzePage } from './seoChecks.js';
import { assertSafeUrl } from './security.js';
import { evaluateCustomRules, evaluateSchemaSpec } from './customRules.js';

const CONCURRENCY = 4;

export async function runCrawl(job, emit) {
  const { seedUrl, mode, maxPages, maxDepth, respectRobots } = job;
  await assertSafeUrl(seedUrl);
  const seed = new URL(seedUrl);
  const hostname = seed.hostname;
  const origin = seed.origin;

  const robots = respectRobots ? await fetchRobots(origin) : { exists: false, rules: { disallow: [], allow: [], sitemaps: [] } };

  const visited = new Set();
  const queue = [{ url: normalizeUrl(seedUrl, seedUrl), depth: 0 }];
  const pages = [];
  let crawled = 0;

  const fetchFn = mode === 'http' ? fetchHttp : mode === 'browser' ? fetchRendered : autoFetch;

  async function worker() {
    while (queue.length && crawled < maxPages) {
      const item = queue.shift();
      if (!item || visited.has(item.url)) continue;
      visited.add(item.url);
      const { url, depth } = item;

      if (respectRobots) {
        let pathWithQuery = '/';
        try {
          const u = new URL(url);
          pathWithQuery = u.pathname + u.search;
        } catch { /* ignore */ }
        if (!isAllowedByRobots(pathWithQuery, robots.rules)) {
          pages.push({ url, depth, status: 'skipped-robots' });
          continue;
        }
      }

      emit('progress', {
        pagesFound: visited.size + queue.length,
        pagesCrawled: crawled,
        current: url,
        percent: Math.min(99, Math.round((crawled / Math.max(maxPages, 1)) * 100))
      });

      let result;
      try {
        result = await fetchFn(url);
      } catch (e) {
        result = { status: 0, error: e.message };
      }
      crawled++;

      const isHtml = (result.contentType || '').includes('text/html');
      const analysis = isHtml && result.body
        ? analyzePage(result.body, { url: result.finalUrl || url, status: result.status, xRobotsTag: result.xRobotsTag })
        : null;

      pages.push({
        url,
        finalUrl: result.finalUrl || url,
        depth,
        status: result.status,
        responseTimeMs: result.responseTimeMs,
        redirected: !!result.redirected,
        redirectChain: result.chain || [],
        mode: result.mode,
        error: result.error,
        analysis
      });

      if (isHtml && result.body && depth < maxDepth && crawled < maxPages) {
        const $ = cheerio.load(result.body);
        const links = extractLinks($, result.finalUrl || url);
        for (const link of links) {
          if (visited.has(link)) continue;
          if (!isSameHost(link, hostname)) continue;
          if (visited.size + queue.length >= maxPages) break;
          queue.push({ url: link, depth: depth + 1 });
        }
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  const report = buildReport(pages, robots);

  if (job.customRules && job.customRules.rules.length) {
    emit('progress', { pagesFound: pages.length, pagesCrawled: pages.length, current: 'Checking custom rules...', percent: 99 });
    const { rules, globals, warnings } = job.customRules;
    const { issues: customIssues, results } = await evaluateCustomRules(rules, pages, { conflictMode: job.conflictMode });
    const schemaIssues = evaluateSchemaSpec(globals, pages);

    if (job.conflictMode === 'override') {
      // Custom rules win: drop standard issues for URLs the rule file covers.
      const covered = new Set(rules.map((r) => String(r.url).replace(/\/+$/, '')));
      report.issues = report.issues.filter((i) => !covered.has(String(i.url).replace(/\/+$/, '')));
    }

    report.issues.push(...customIssues, ...schemaIssues);
    report.customRules = { ruleCount: rules.length, results, warnings, conflictMode: job.conflictMode };

    const counts = { PASS: 0, WARNING: 0, FAIL: 0, INFO: 0 };
    for (const i of report.issues) counts[i.severity] = (counts[i.severity] || 0) + 1;
    const totalChecks = Math.max(report.summary.checkedPages, 1) * 6 + rules.length;
    counts.PASS = Math.max(0, totalChecks - counts.FAIL - counts.WARNING - counts.INFO);
    report.summary.counts = counts;
    report.summary.score = report.summary.checkedPages > 0
      ? Math.max(0, Math.min(100, Math.round(100 - ((counts.FAIL * 2 + counts.WARNING) / totalChecks) * 100)))
      : null;
  }

  emit('progress', { pagesFound: pages.length, pagesCrawled: pages.length, current: '', percent: 100 });
  emit('done', report);
  return report;
}

function sev(severity, category, url, issue, expected, actual, recommendation) {
  return { severity, category, url, issue, expected, actual, recommendation, ruleType: 'Standard' };
}

/** Word-shingle Jaccard similarity — catches near-duplicate pages (e.g. model pages). */
function shingles(text, size = 5) {
  const words = String(text || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(Boolean);
  const set = new Set();
  for (let i = 0; i + size <= words.length; i++) set.add(words.slice(i, i + size).join(' '));
  return set;
}

function findDuplicateContent(pages, threshold = 0.8) {
  const issues = [];
  const candidates = pages
    .filter((p) => p.analysis?.bodyText && p.analysis.bodyText.length > 400)
    .map((p) => ({ url: p.url, set: shingles(p.analysis.bodyText) }));

  const reported = new Set();
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      if (!a.set.size || !b.set.size) continue;
      let inter = 0;
      for (const s of a.set) if (b.set.has(s)) inter++;
      const similarity = inter / (a.set.size + b.set.size - inter);
      if (similarity >= threshold) {
        const key = `${a.url}|${b.url}`;
        if (reported.has(key)) continue;
        reported.add(key);
        issues.push(sev('WARNING', 'Content', a.url, 'Near-duplicate page content',
          'Unique content per page', `${Math.round(similarity * 100)}% similar to ${b.url}`,
          'Differentiate this page with unique, specific content.'));
      }
    }
  }
  return issues;
}

function buildReport(pages, robots) {
  const titleMap = new Map();
  const descMap = new Map();
  for (const p of pages) {
    if (!p.analysis) continue;
    if (p.analysis.title) titleMap.set(p.analysis.title, (titleMap.get(p.analysis.title) || []).concat(p.url));
    if (p.analysis.metaDescription) descMap.set(p.analysis.metaDescription, (descMap.get(p.analysis.metaDescription) || []).concat(p.url));
  }

  const issues = [];
  for (const p of pages) {
    if (p.status === 'skipped-robots') continue;

    if (!p.status || p.status >= 400) {
      issues.push(sev('FAIL', 'Technical', p.url, `HTTP error`, '2xx/3xx', String(p.status || p.error || 'unknown'), 'Fix the broken page or server error.'));
      continue;
    }
    if (p.redirectChain && p.redirectChain.length > 2) {
      issues.push(sev('WARNING', 'Technical', p.url, 'Long redirect chain', '<= 1 redirect', `${p.redirectChain.length} redirects`, 'Point links directly at the final URL.'));
    }

    const a = p.analysis;
    if (!a) continue;

    if (!a.title) issues.push(sev('FAIL', 'Metadata', p.url, 'Missing title', 'Present', 'Missing', 'Add a unique, descriptive <title>.'));
    else if ((titleMap.get(a.title) || []).length > 1) issues.push(sev('WARNING', 'Metadata', p.url, 'Duplicate title', 'Unique per page', `Shared with ${titleMap.get(a.title).length - 1} other page(s)`, 'Give this page a unique title.'));
    if (a.titleLength > 60) issues.push(sev('WARNING', 'Metadata', p.url, 'Title too long', '<= 60 chars', `${a.titleLength} chars`, 'Shorten the title for full display in search results.'));

    if (!a.metaDescription) issues.push(sev('WARNING', 'Metadata', p.url, 'Missing meta description', 'Present', 'Missing', 'Add a meta description.'));
    else if ((descMap.get(a.metaDescription) || []).length > 1) issues.push(sev('WARNING', 'Metadata', p.url, 'Duplicate meta description', 'Unique per page', `Shared with ${descMap.get(a.metaDescription).length - 1} other page(s)`, 'Write a unique description for this page.'));

    if (a.h1Count === 0) issues.push(sev('FAIL', 'Headings', p.url, 'Missing H1', '1', '0', 'Add an H1 heading.'));
    if (a.h1Count > 1) issues.push(sev('WARNING', 'Headings', p.url, 'Multiple H1', '1', String(a.h1Count), 'Use a single H1 per page.'));
    if (a.emptyH1Count > 0) issues.push(sev('WARNING', 'Headings', p.url, 'Empty H1', 'Non-empty text', 'Empty', 'Give the H1 descriptive text.'));
    if (a.hierarchyIssue) issues.push(sev('WARNING', 'Headings', p.url, 'Heading hierarchy jump', 'Sequential levels', a.hierarchyIssue, 'Avoid skipping heading levels.'));

    if (!a.indexability.index) issues.push(sev('INFO', 'Indexability', p.url, 'Page is noindex', 'INDEX', 'NOINDEX', 'Confirm this is intentional.'));
    if (!a.indexability.follow) issues.push(sev('INFO', 'Indexability', p.url, 'Page is nofollow', 'FOLLOW', 'NOFOLLOW', 'Confirm this is intentional.'));

    if (!a.canonical) issues.push(sev('INFO', 'Canonical', p.url, 'Missing canonical tag', 'Present', 'Missing', 'Add a self-referencing canonical tag.'));

    if (a.missingAlt > 0) issues.push(sev('WARNING', 'Images', p.url, 'Images missing alt attribute', '0', String(a.missingAlt), 'Add descriptive alt text to every image.'));

    if (a.breadcrumb.visible && !a.breadcrumb.schema) {
      issues.push(sev('INFO', 'Breadcrumbs', p.url, 'Visible breadcrumb without BreadcrumbList schema', 'Schema present', 'Missing', 'Add BreadcrumbList structured data to match the visible breadcrumb.'));
    }

    if (a.canonicalDoubleSlash) {
      issues.push(sev('FAIL', 'Canonical', p.url, 'Canonical URL contains a double slash', 'Single slashes only', a.canonical, 'Remove the extra slash so the canonical resolves to one clean URL.'));
    }

    if (!a.og.image) {
      issues.push(sev('WARNING', 'Metadata', p.url, 'Missing og:image', 'Present', 'Missing', 'Add an og:image meta tag for correct social sharing previews.'));
    }
    if (!a.og.url) {
      issues.push(sev('WARNING', 'Metadata', p.url, 'Missing og:url', 'Present', 'Missing', 'Add an og:url meta tag pointing at the canonical URL.'));
    }

    if (!a.schemaTypes || a.schemaTypes.length === 0) {
      issues.push(sev('WARNING', 'Schema', p.url, 'No structured data detected', 'At least one schema type', 'None', 'Add relevant schema markup (Organization, WebPage, Product, etc.).'));
    } else if (a.schemaTypes.includes('INVALID_JSON_LD')) {
      issues.push(sev('FAIL', 'Schema', p.url, 'Invalid JSON-LD block', 'Valid JSON', 'Parse error', 'Fix the malformed JSON-LD script.'));
    }
  }

  issues.push(...findDuplicateContent(pages));

  const counts = { PASS: 0, WARNING: 0, FAIL: 0, INFO: 0 };
  for (const i of issues) counts[i.severity] = (counts[i.severity] || 0) + 1;

  const robotsSkippedCount = pages.filter((p) => p.status === 'skipped-robots').length;
  const checkedPages = pages.length - robotsSkippedCount;
  const totalChecks = Math.max(checkedPages, 1) * 6;
  const failWeight = counts.FAIL * 2 + counts.WARNING;
  const score = checkedPages > 0 ? Math.max(0, Math.min(100, Math.round(100 - (failWeight / totalChecks) * 100))) : null;
  counts.PASS = Math.max(0, totalChecks - counts.FAIL - counts.WARNING - counts.INFO);

  return {
    generatedAt: new Date().toISOString(),
    robots: { exists: robots.exists, sitemaps: (robots.rules && robots.rules.sitemaps) || [] },
    summary: { pagesCrawled: pages.length, checkedPages, robotsSkippedCount, score, counts },
    pages,
    issues
  };
}
