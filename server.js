import express from 'express';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runCrawl } from './src/crawler.js';
import { parseRuleFiles } from './src/ruleFileParser.js';
import { parseCrawlOptions } from './src/crawlOptions.js';

const app = express();
app.set('trust proxy', 1); // needed on Render/Railway so req.ip is the real client, not the proxy
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

/* ---------- basic auth (only enforced if AUTH_USER/AUTH_PASS are set) ---------- */
const AUTH_USER = process.env.AUTH_USER;
const AUTH_PASS = process.env.AUTH_PASS;
if (process.env.NODE_ENV === 'production' && !(AUTH_USER && AUTH_PASS)) {
  console.warn('WARNING: no AUTH_USER/AUTH_PASS set. This app is a URL crawler open to the public internet with no password. Set both env vars.');
}
app.use((req, res, next) => {
  if (!AUTH_USER || !AUTH_PASS) return next(); // no auth configured (local dev default)
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme === 'Basic' && encoded) {
    const credentials = Buffer.from(encoded, 'base64').toString('utf-8');
    const separator = credentials.indexOf(':');
    const user = credentials.slice(0, separator);
    const pass = credentials.slice(separator + 1);
    if (user === AUTH_USER && pass === AUTH_PASS) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="Site Audit Console"');
  res.status(401).send('Authentication required.');
});

/* ---------- simple in-memory rate limit: N crawls per IP per window ---------- */
const RATE_LIMIT_MAX = Number(process.env.RATE_LIMIT_MAX || 10);
const RATE_LIMIT_WINDOW_MS = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateBuckets = new Map(); // ip -> { count, resetAt }
function rateLimit(req, res, next) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateBuckets.set(ip, bucket);
  }
  bucket.count++;
  if (bucket.count > RATE_LIMIT_MAX) {
    const retryAfterSec = Math.ceil((bucket.resetAt - now) / 1000);
    res.set('Retry-After', String(retryAfterSec));
    return res.status(429).json({ error: `Too many crawls from this IP. Try again in ${Math.ceil(retryAfterSec / 60)} min.` });
  }
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(ip);
}, 60 * 1000).unref();

app.use(express.json());
app.use(express.static('public'));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 10 }
});

const jobs = new Map();
const MAX_ACTIVE_CRAWLS = Math.max(1, Number(process.env.MAX_ACTIVE_CRAWLS) || 1);
let preparingCrawls = 0;

app.post('/api/crawl', rateLimit, upload.array('ruleFiles'), async (req, res) => {
  let options;
  try { options = parseCrawlOptions(req.body); }
  catch (e) { return res.status(400).json({ error: e.message }); }
  const { seedUrl, conflictMode } = options;
  if (preparingCrawls + [...jobs.values()].filter((j) => j.status === 'running').length >= MAX_ACTIVE_CRAWLS) {
    return res.status(503).set('Retry-After', '30').json({ error: 'The server is already running a crawl. Try again when it finishes.' });
  }
  preparingCrawls++;

  let customRules = null;
  if (req.files && req.files.length && conflictMode !== 'ignore') {
    try {
      const files = req.files.map((f) => ({ buffer: f.buffer, filename: f.originalname }));
      customRules = await parseRuleFiles(files, seedUrl);
    } catch (e) {
      preparingCrawls--;
      return res.status(400).json({ error: `Could not parse rule files: ${e.message}` });
    }
  }

  const id = randomUUID();
  const emitter = new EventEmitter();
  preparingCrawls--;
  jobs.set(id, { emitter, report: null, status: 'running', progress: null, error: null });
  res.json({
    crawlId: id,
    parsedRules: customRules ? customRules.rules.length : 0,
    warnings: customRules ? customRules.warnings : []
  });

  runCrawl(
    { ...options, customRules },
    (event, data) => {
      const job = jobs.get(id);
      if (!job) return;
      if (event === 'progress') job.progress = data;
      if (event === 'done') {
        job.report = data;
        job.status = 'done';
      }
      job.emitter.emit(event, data);
    }
  ).catch((err) => {
    const job = jobs.get(id);
    if (!job) return;
    job.status = 'error';
    job.error = { message: err.message };
    job.emitter.emit('crawl-error', job.error);
  });
});

app.post('/api/preview-rules', upload.array('ruleFiles'), async (req, res) => {
  if (!req.files || !req.files.length) return res.json({ rules: [], warnings: ['No files uploaded.'] });
  try {
    const files = req.files.map((f) => ({ buffer: f.buffer, filename: f.originalname }));
    const parsed = await parseRuleFiles(files, req.body.seedUrl || 'https://example.com');
    res.json({ rules: parsed.rules.slice(0, 200), total: parsed.rules.length, warnings: parsed.warnings, globals: parsed.globals });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/crawl/:id/events', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive'
  });
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  res.flushHeaders();
  if (job.status === 'done') { send('done', job.report); return res.end(); }
  if (job.status === 'error') { send('crawl-error', job.error); return res.end(); }
  const onProgress = (d) => send('progress', d);
  const onDone = (d) => { send('done', d); res.end(); };
  const onError = (d) => { send('crawl-error', d); res.end(); };
  job.emitter.on('progress', onProgress);
  job.emitter.on('done', onDone);
  job.emitter.on('crawl-error', onError);
  if (job.progress) send('progress', job.progress);
  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15000);
  res.on('close', () => {
    clearInterval(heartbeat);
    job.emitter.off('progress', onProgress);
    job.emitter.off('done', onDone);
    job.emitter.off('crawl-error', onError);
  });
});

app.get('/api/crawl/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'This crawl is no longer on the server. It may have restarted. Start a new crawl.' });
  res.json({ status: job.status, progress: job.progress, error: job.error });
});

app.get('/api/crawl/:id/report', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job || !job.report) return res.status(404).json({ error: 'Report not ready' });
  res.json(job.report);
});

const PORT = process.env.PORT || 4000;

// Keep at most the most recent 50 jobs in memory (public deploys get many short-lived visitors).
const JOB_LIMIT = 50;
function pruneJobs() {
  if (jobs.size <= JOB_LIMIT) return;
  const oldest = [...jobs.keys()].filter((id) => jobs.get(id).status !== 'running').slice(0, jobs.size - JOB_LIMIT);
  oldest.forEach((id) => jobs.delete(id));
}
setInterval(pruneJobs, 60 * 1000).unref();

app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  const status = err instanceof multer.MulterError ? 400 : err.status || 500;
  res.status(status).json({ error: status < 500 ? err.message : 'The server could not complete this request.' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`SEO Audit Tool running at http://localhost:${PORT}`));
