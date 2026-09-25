export function parseCrawlOptions(body = {}) {
  let url;
  try { url = new URL(body.seedUrl); } catch { throw new Error('Enter a valid http:// or https:// website URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
  }
  const integer = (key, fallback, min, max) => {
    const value = body[key] === undefined || body[key] === '' ? fallback : Number(body[key]);
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const mode = body.mode || 'http';
  const conflictMode = body.conflictMode || 'extend';
  if (!['http', 'auto', 'browser'].includes(mode)) throw new Error('Invalid crawl mode.');
  if (!['extend', 'override', 'ignore'].includes(conflictMode)) throw new Error('Invalid rule conflict mode.');
  return { seedUrl: url.href, mode, conflictMode,
    maxPages: integer('maxPages', 50, 1, 500), maxDepth: integer('maxDepth', 3, 0, 10),
    respectRobots: body.respectRobots === undefined || body.respectRobots === true || body.respectRobots === 'true' };
}
