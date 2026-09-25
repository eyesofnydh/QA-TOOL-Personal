export function normalizeUrl(rawUrl, base) {
  try {
    const u = new URL(rawUrl, base);
    if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password) return null;
    u.hash = '';
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    if (u.search) {
      const params = [...u.searchParams.entries()].sort(([a], [b]) => a.localeCompare(b));
      u.search = '';
      for (const [k, v] of params) u.searchParams.append(k, v);
    }
    return u.toString();
  } catch {
    return null;
  }
}

export function isSameHost(urlStr, hostname) {
  try {
    const strip = (h) => h.replace(/^www\./, '');
    return strip(new URL(urlStr).hostname) === strip(hostname);
  } catch {
    return false;
  }
}

export function extractLinks($, baseUrl) {
  const links = new Set();
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    const normalized = normalizeUrl(href, baseUrl);
    if (normalized) links.add(normalized);
  });
  return [...links];
}
