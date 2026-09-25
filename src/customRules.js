import { fetchHttp } from './fetcher.js';
import { normalizeUrl } from './urlUtils.js';
import { analyzePage } from './seoChecks.js';

function sev(severity, category, url, issue, expected, actual, recommendation, ruleType = 'Custom') {
  return { severity, category, url, issue, expected, actual, recommendation, ruleType };
}

function sameUrl(a, b) {
  if (!a || !b) return false;
  const strip = (u) => String(u).replace(/\/+$/, '').replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();
  return strip(a) === strip(b);
}

function textSimilar(a, b) {
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  return norm(a) === norm(b);
}

/**
 * Checks each custom rule against what the crawl found. Any rule URL that the
 * crawl didn't reach (e.g. the 404 list — those pages aren't linked anymore)
 * gets fetched directly so redirect fixes can still be verified.
 */
export async function evaluateCustomRules(rules, pages, { conflictMode = 'extend' } = {}) {
  const issues = [];
  const results = [];
  const pageByUrl = new Map();
  for (const p of pages) {
    if (p.status === 'skipped-robots') continue;
    pageByUrl.set(String(p.url).replace(/\/+$/, ''), p);
    if (p.finalUrl) pageByUrl.set(String(p.finalUrl).replace(/\/+$/, ''), p);
  }

  for (const rule of rules) {
    const key = String(rule.url).replace(/\/+$/, '');
    let page = pageByUrl.get(key);
    let direct = null;

    // Not found in the crawl — fetch it directly so 404/redirect rules still work.
    if (!page) {
      try {
        direct = await fetchHttp(rule.url);
      } catch (e) {
        direct = { status: 0, error: e.message, chain: [] };
      }
    }

    const status = page ? page.status : direct?.status;
    const finalUrl = page ? page.finalUrl : direct?.finalUrl;
    const chain = (page ? page.redirectChain : direct?.chain) || [];
    const a = page?.analysis || (direct?.body && (direct.contentType || '').includes('text/html')
      ? analyzePage(direct.body, { url: direct.finalUrl || rule.url, status, xRobotsTag: direct.xRobotsTag }) : null);
    const result = { url: rule.url, source: rule.source, status, finalUrl, checks: [] };

    const record = (name, pass, expected, actual) => result.checks.push({ name, pass, expected, actual });

    // --- Redirect / 404 verification ---
    if (rule.redirectTo) {
      const landed = finalUrl || rule.url;
      const redirected = chain.length > 0 || !sameUrl(landed, rule.url);
      if (!redirected && status >= 400) {
        issues.push(sev('FAIL', 'Custom Rules', rule.url, 'Expected redirect not implemented',
          `301 → ${rule.redirectTo}`, `HTTP ${status}, no redirect`,
          `Add a 301 redirect from this URL to ${rule.redirectTo}.`));
        record('Redirect implemented', false, `301 → ${rule.redirectTo}`, `HTTP ${status}`);
      } else if (!sameUrl(landed, rule.redirectTo)) {
        issues.push(sev('FAIL', 'Custom Rules', rule.url, 'Redirect goes to the wrong destination',
          rule.redirectTo, landed, `Update the redirect so it points to ${rule.redirectTo}.`));
        record('Redirect destination', false, rule.redirectTo, landed);
      } else {
        const firstHop = chain[0]?.status;
        if (firstHop && firstHop !== 301) {
          issues.push(sev('WARNING', 'Custom Rules', rule.url, 'Redirect is not a permanent 301',
            '301', String(firstHop), 'Use a 301 for permanent moves so link equity passes.'));
          record('Redirect type', false, '301', String(firstHop));
        } else {
          record('Redirect implemented', true, rule.redirectTo, landed);
        }
        if (chain.length > 1) {
          issues.push(sev('WARNING', 'Custom Rules', rule.url, 'Redirect chain (multiple hops)',
            '1 hop', `${chain.length} hops`, 'Redirect straight to the final URL in one hop.'));
        }
      }
    } else if (status >= 400) {
      issues.push(sev('FAIL', 'Custom Rules', rule.url, 'URL from rule file returns an error',
        '200 OK', `HTTP ${status}`, 'Restore the page or redirect it to the most relevant live page.'));
      record('Page reachable', false, '200', `HTTP ${status}`);
    }

    // --- Metadata ---
    if (rule.expectedTitle) {
      const actual = a?.title || '';
      const pass = textSimilar(actual, rule.expectedTitle);
      record('Meta title', pass, rule.expectedTitle, actual || '(missing)');
      if (!pass) {
        issues.push(sev(actual ? 'WARNING' : 'FAIL', 'Custom Rules', rule.url, 'Meta title does not match the specified title',
          rule.expectedTitle, actual || '(missing)', 'Update the page title to the approved value.'));
      }
    }
    if (rule.expectedDescription) {
      const actual = a?.metaDescription || '';
      const pass = textSimilar(actual, rule.expectedDescription);
      record('Meta description', pass, rule.expectedDescription, actual || '(missing)');
      if (!pass) {
        issues.push(sev(actual ? 'WARNING' : 'FAIL', 'Custom Rules', rule.url, 'Meta description does not match the specified description',
          rule.expectedDescription, actual || '(missing)', 'Update the meta description to the approved value.'));
      }
    }
    if (rule.expectedH1) {
      const h1 = a?.headings?.find((h) => h.level === 1)?.text || '';
      const pass = textSimilar(h1, rule.expectedH1);
      record('H1', pass, rule.expectedH1, h1 || '(missing)');
      if (!pass) {
        issues.push(sev(h1 ? 'WARNING' : 'FAIL', 'Custom Rules', rule.url, 'H1 does not match the specified H1',
          rule.expectedH1, h1 || '(missing)', 'Set the H1 to the approved value.'));
      }
    }
    if (rule.expectedCanonical && a) {
      const actual = a.canonical || '';
      const pass = sameUrl(actual, rule.expectedCanonical);
      record('Canonical', pass, rule.expectedCanonical, actual || '(missing)');
      if (!pass) {
        issues.push(sev('WARNING', 'Custom Rules', rule.url, 'Canonical does not match the specified canonical',
          rule.expectedCanonical, actual || '(missing)', 'Correct the canonical tag.'));
      }
    }
    if (rule.expectedSchema && a) {
      const wanted = String(rule.expectedSchema).split(/[,;/]/).map((s) => s.trim()).filter(Boolean);
      const found = a.schemaTypes || [];
      const missing = wanted.filter((w) => !found.some((f) => String(f).toLowerCase() === w.toLowerCase()));
      record('Schema', missing.length === 0, wanted.join(', '), found.join(', ') || '(none)');
      if (missing.length) {
        issues.push(sev('FAIL', 'Custom Rules', rule.url, 'Required schema type missing',
          wanted.join(', '), found.join(', ') || '(none)', `Add ${missing.join(', ')} structured data to this page.`));
      }
    }
    if (rule.index && a) {
      const wantIndex = !/noindex/i.test(rule.index);
      const pass = a.indexability.index === wantIndex;
      record('Indexability', pass, wantIndex ? 'INDEX' : 'NOINDEX', a.indexability.index ? 'INDEX' : 'NOINDEX');
      if (!pass) {
        issues.push(sev('FAIL', 'Custom Rules', rule.url, 'Indexability does not match the rule',
          wantIndex ? 'INDEX' : 'NOINDEX', a.indexability.index ? 'INDEX' : 'NOINDEX', 'Correct the robots meta / X-Robots-Tag.'));
      }
    }
    if (rule.breadcrumb && /req|yes|true/i.test(rule.breadcrumb) && a) {
      const pass = a.breadcrumb.visible || a.breadcrumb.schema;
      record('Breadcrumb', pass, 'Present', pass ? 'Present' : 'Missing');
      if (!pass) {
        issues.push(sev('WARNING', 'Custom Rules', rule.url, 'Breadcrumb required but not found',
          'Breadcrumb present', 'Missing', 'Add a visible breadcrumb and BreadcrumbList schema.'));
      }
    }

    results.push(result);
  }

  return { issues, results };
}

/** Global schema spec from an uploaded doc, applied to every crawled page. */
export function evaluateSchemaSpec(globals, pages) {
  const issues = [];
  if (!globals) return issues;
  const wantedTypes = globals.requiredSchemaTypes || [];
  if (!wantedTypes.length) return issues;

  for (const p of pages) {
    if (!p.analysis) continue;
    const found = p.analysis.schemaTypes || [];
    const missing = wantedTypes.filter((w) => !found.some((f) => String(f).toLowerCase() === String(w).toLowerCase()));
    if (missing.length) {
      issues.push(sev('WARNING', 'Custom Rules', p.url, 'Schema type from uploaded spec is missing',
        wantedTypes.join(', '), found.join(', ') || '(none)',
        `Add ${missing.join(', ')} structured data.`, 'Custom'));
    }
  }
  return issues;
}
