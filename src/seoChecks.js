import * as cheerio from 'cheerio';

export function analyzePage(html, { url, status, xRobotsTag }) {
  const $ = cheerio.load(html || '');

  const title = $('title').first().text().trim();
  const metaDescription = $('meta[name="description"]').attr('content')?.trim() || '';
  const canonical = $('link[rel="canonical"]').attr('href') || '';
  const metaRobots = ($('meta[name="robots"]').attr('content') || '').toLowerCase();

  const combinedRobots = `${metaRobots} ${xRobotsTag || ''}`.toLowerCase();
  const noindex = combinedRobots.includes('noindex');
  const nofollow = combinedRobots.includes('nofollow');

  const headings = [];
  $('h1,h2,h3,h4,h5,h6').each((_, el) => {
    headings.push({ level: Number(el.tagName.slice(1)), text: $(el).text().trim() });
  });
  const h1s = headings.filter((h) => h.level === 1);
  const emptyH1s = h1s.filter((h) => !h.text);

  let hierarchyIssue = null;
  let lastLevel = 0;
  for (const h of headings) {
    if (lastLevel && h.level - lastLevel > 1) {
      hierarchyIssue = `Heading jumps from H${lastLevel} to H${h.level}`;
      break;
    }
    lastLevel = h.level;
  }

  const images = [];
  $('img').each((_, el) => {
    images.push({ src: $(el).attr('src') || '', alt: $(el).attr('alt') });
  });
  const missingAlt = images.filter((i) => i.alt === undefined).length;
  const emptyAlt = images.filter((i) => i.alt === '').length;

  const schemaTypes = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const parsed = JSON.parse($(el).contents().text());
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        if (item && item['@type']) schemaTypes.push(item['@type']);
      }
    } catch {
      schemaTypes.push('INVALID_JSON_LD');
    }
  });

  const breadcrumbSchema = schemaTypes.includes('BreadcrumbList');
  const visibleBreadcrumb = $('[class*="breadcrumb" i], nav[aria-label*="breadcrumb" i]').length > 0;

  const og = {
    title: $('meta[property="og:title"]').attr('content') || '',
    description: $('meta[property="og:description"]').attr('content') || '',
    image: $('meta[property="og:image"]').attr('content') || '',
    url: $('meta[property="og:url"]').attr('content') || ''
  };

  // Double slash anywhere after the protocol, e.g. https://site.com//page
  const canonicalDoubleSlash = !!canonical && /^(https?:)?\/\/[^/]+\/\/|[^:]\/\//.test(
    canonical.replace(/^https?:\/\//, 'x://')
  );

  $('script, style, noscript').remove();
  const bodyText = $('body').text().replace(/\s+/g, ' ').trim().slice(0, 20000);

  return {
    og,
    canonicalDoubleSlash,
    bodyText,
    url,
    status,
    title,
    titleLength: title.length,
    metaDescription,
    metaDescriptionLength: metaDescription.length,
    canonical,
    metaRobots,
    xRobotsTag: xRobotsTag || '',
    indexability: { index: !noindex, follow: !nofollow },
    headings,
    h1Count: h1s.length,
    emptyH1Count: emptyH1s.length,
    hierarchyIssue,
    images: images.length,
    missingAlt,
    emptyAlt,
    schemaTypes,
    breadcrumb: { visible: visibleBreadcrumb, schema: breadcrumbSchema }
  };
}
