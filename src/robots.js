export async function fetchRobots(origin) {
  const robotsUrl = origin + '/robots.txt';
  const rules = { disallow: [], allow: [], sitemaps: [] };
  try {
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return { exists: false, status: res.status, rules };
    const text = await res.text();
    let applicable = false;
    for (const rawLine of text.split('\n')) {
      const line = rawLine.split('#')[0].trim();
      if (!line) continue;
      const sepIdx = line.indexOf(':');
      if (sepIdx === -1) continue;
      const key = line.slice(0, sepIdx).trim().toLowerCase();
      const value = line.slice(sepIdx + 1).trim();
      if (key === 'user-agent') {
        applicable = value === '*';
      } else if (key === 'disallow' && applicable) {
        if (value) rules.disallow.push(value);
      } else if (key === 'allow' && applicable) {
        if (value) rules.allow.push(value);
      } else if (key === 'sitemap') {
        rules.sitemaps.push(value);
      }
    }
    return { exists: true, status: res.status, rules, raw: text };
  } catch (e) {
    return { exists: false, status: null, rules, error: e.message };
  }
}

// Longest-match wins; an Allow at least as specific as a Disallow overrides it.
export function isAllowedByRobots(pathWithQuery, rules) {
  let allowMatch = -1;
  let disallowMatch = -1;
  for (const p of rules.allow || []) if (pathWithQuery.startsWith(p)) allowMatch = Math.max(allowMatch, p.length);
  for (const p of rules.disallow || []) if (pathWithQuery.startsWith(p)) disallowMatch = Math.max(disallowMatch, p.length);
  if (disallowMatch === -1) return true;
  return allowMatch >= disallowMatch;
}
