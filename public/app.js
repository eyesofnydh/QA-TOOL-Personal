const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let report = null;
let batchQueue = [];
let selectedFiles = [];
let sortState = { issues: null, pages: null };
let crawlStarting = false;
let activeSource = null;
const storage = {
  get(key, fallback) { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
  remove(key) { try { localStorage.removeItem(key); } catch {} }
};
const HISTORY_KEY = 'seo-audit-history-v1';
const ACTIVE_KEY = 'seo-audit-active-v1';
let history = storage.get(HISTORY_KEY, []);
if (!Array.isArray(history)) history = [];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const presets = { quick: [20, 2], standard: [50, 3], deep: [200, 5] };
$$('[data-preset]').forEach((button) => button.onclick = () => {
  const [pages, depth] = presets[button.dataset.preset];
  $('#maxPages').value = pages;
  $('#maxDepth').value = depth;
  syncPresets();
});
function syncPresets() {
  $$('[data-preset]').forEach((button) => {
    const [pages, depth] = presets[button.dataset.preset];
    const selected = Number($('#maxPages').value) === pages && Number($('#maxDepth').value) === depth;
    button.classList.toggle('is-selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
['#maxPages', '#maxDepth'].forEach((selector) => $(selector).addEventListener('input', syncPresets));
function goToSetup(showHistory = false) {
  if (activeSource || crawlStarting) return toast('Your audit is still running. Reports will be available when it finishes.');
  $('#results').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#newCrawlBtn').classList.add('hidden');
  if (showHistory) { $('#historyPanel').open = true; $('#historyPanel').scrollIntoView({ behavior: 'smooth' }); }
  else window.scrollTo({ top: 0, behavior: 'smooth' });
}
$('#navAudit').onclick = () => goToSetup();
$('#navHistory').onclick = () => goToSetup(true);

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(t._t);
  t._t = setTimeout(() => t.classList.add('hidden'), 2200);
}

/* ============ file picker ============ */
const dz = $('#dropzone');
const fileInput = $('#ruleFiles');
dz.addEventListener('click', () => fileInput.click());
dz.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
dz.addEventListener('dragover', (e) => { e.preventDefault(); dz.classList.add('drag'); });
dz.addEventListener('dragleave', () => dz.classList.remove('drag'));
dz.addEventListener('drop', (e) => {
  e.preventDefault(); dz.classList.remove('drag');
  addFiles([...e.dataTransfer.files]);
});
fileInput.addEventListener('change', () => addFiles([...fileInput.files]));

function addFiles(files) {
  for (const f of files) if (!selectedFiles.some((x) => x.name === f.name && x.size === f.size)) selectedFiles.push(f);
  renderFileList();
}
function renderFileList() {
  const ul = $('#fileList');
  ul.innerHTML = selectedFiles.map((f, i) => `
    <li><span class="fname">${esc(f.name)}</span>
      <span class="fsize">${(f.size / 1024).toFixed(0)} KB</span>
      <button class="linkbtn" data-rm="${i}">Remove</button></li>`).join('');
  ul.querySelectorAll('[data-rm]').forEach((b) => {
    b.onclick = () => { selectedFiles.splice(Number(b.dataset.rm), 1); renderFileList(); };
  });
}

/* ============ rule preview ============ */
$('#previewBtn').addEventListener('click', async () => {
  if (!selectedFiles.length) return toast('Add a file first');
  const fd = new FormData();
  selectedFiles.forEach((f) => fd.append('ruleFiles', f));
  fd.append('seedUrl', $('#seedUrl').value.trim() || 'https://example.com');
  const box = $('#rulePreview');
  box.classList.remove('hidden');
  box.textContent = 'Reading files…';
  try {
    const data = await (await fetch('/api/preview-rules', { method: 'POST', body: fd })).json();
    if (data.error) return void (box.textContent = data.error);
    let html = '';
    if (data.warnings?.length) html += `<div class="warnbox" style="margin-bottom:10px">${data.warnings.map(esc).join('<br>')}</div>`;
    if (!data.total) {
      html += `<p class="muted">Nothing usable was found. The file needs a column headed URL, Address, or Affected URLs.</p>`;
    } else {
      html += `<p style="margin-bottom:8px"><strong>${data.total}</strong> rule${data.total === 1 ? '' : 's'} read. Showing ${data.rules.length}.</p>`;
      html += data.rules.map((r) => {
        const f = Object.entries(r).filter(([k]) => !['url', 'source'].includes(k))
          .map(([k, v]) => `<span class="k">${esc(k)}:</span> ${esc(String(v).slice(0, 90))}`).join(' &nbsp;·&nbsp; ');
        return `<div class="r"><div class="mono">${esc(r.url)}</div>${f ? `<div>${f}</div>` : '<div class="muted">no expectations set</div>'}</div>`;
      }).join('');
    }
    box.innerHTML = html;
  } catch (e) { box.textContent = e.message; }
});

/* ============ crawl ============ */
$('#seedUrl').addEventListener('keydown', (e) => { if (e.key === 'Enter') startCrawl(); });
$('#startBtn').addEventListener('click', startCrawl);
$('#newCrawlBtn').addEventListener('click', () => {
  $('#results').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  $('#newCrawlBtn').classList.add('hidden');
  window.scrollTo({ top: 0 });
});

function logLine(text) {
  const ul = $('#crawlLog');
  const li = document.createElement('li');
  li.textContent = text;
  ul.prepend(li);
  while (ul.children.length > 12) ul.lastChild.remove();
}

async function startCrawl() {
  if (crawlStarting || activeSource) return;
  const seedUrl = $('#seedUrl').value.trim();
  if (!seedUrl) { $('#seedUrl').focus(); return toast('Enter a URL to crawl'); }
  if (!$('#seedUrl').reportValidity() || !$('#maxPages').reportValidity() || !$('#maxDepth').reportValidity()) return;
  crawlStarting = true;
  $('#startBtn').disabled = true;
  $('#newCrawlBtn').classList.add('hidden');

  const fd = new FormData();
  fd.append('seedUrl', seedUrl);
  fd.append('mode', $('#mode').value);
  fd.append('maxPages', $('#maxPages').value || '50');
  fd.append('maxDepth', $('#maxDepth').value === '' ? '3' : $('#maxDepth').value);
  fd.append('respectRobots', $('#respectRobots').checked ? 'true' : 'false');
  fd.append('conflictMode', $('#conflictMode').value);
  selectedFiles.forEach((f) => fd.append('ruleFiles', f));

  $('#setup').classList.add('hidden');
  $('#results').classList.add('hidden');
  $('#progress').classList.remove('hidden');
  $('#crawlLog').innerHTML = '';
  $('#progressTarget').textContent = seedUrl;
  $('#progressBar').style.width = '0%';
  $('#progressPercent').textContent = '0';
  $('#statFound').textContent = '0';
  $('#statCrawled').textContent = '0';
  batchQueue = [];

  let res;
  try {
    res = await (await fetch('/api/crawl', { method: 'POST', body: fd })).json();
  } catch (e) {
    return failSetup(`Couldn't reach the server: ${e.message}`);
  }
  if (res.error) return failSetup(res.error);
  if (res.warnings?.length) res.warnings.forEach(logLine);
  if (res.parsedRules) logLine(`${res.parsedRules} custom rule(s) loaded`);

  crawlStarting = false;
  $('#startBtn').disabled = false;
  const active = { crawlId: res.crawlId, seedUrl };
  storage.set(ACTIVE_KEY, active);
  connectCrawl(active);
}

function connectCrawl(active) {
  activeSource?.close();
  const src = new EventSource(`/api/crawl/${encodeURIComponent(active.crawlId)}/events`);
  activeSource = src;
  src.addEventListener('progress', (e) => {
    const d = JSON.parse(e.data);
    $('#statFound').textContent = d.pagesFound;
    $('#statCrawled').textContent = d.pagesCrawled;
    $('#progressPercent').textContent = d.percent;
    $('#progressBar').style.width = `${d.percent}%`;
    if (d.current) logLine(d.current);
  });
  src.addEventListener('done', (e) => {
    report = JSON.parse(e.data);
    src.close();
    activeSource = null;
    storage.remove(ACTIVE_KEY);
    saveReport(report);
    render();
  });
  src.addEventListener('crawl-error', (e) => {
    let msg = 'The crawl stopped unexpectedly.';
    try { msg = JSON.parse(e.data).message; } catch {}
    src.close();
    activeSource = null;
    storage.remove(ACTIVE_KEY);
    failSetup(msg);
  });
  src.addEventListener('error', async () => {
    if (activeSource !== src) return;
    logLine('Connection interrupted. Reconnecting to your crawl…');
    try {
      const response = await fetch(`/api/crawl/${encodeURIComponent(active.crawlId)}`);
      if (activeSource !== src) return;
      if (response.status === 404 || response.status === 401) {
        src.close(); activeSource = null; storage.remove(ACTIVE_KEY);
        failSetup(response.status === 404 ? 'The server restarted or this crawl expired. Start a new crawl.' : 'Please refresh and sign in again.');
      }
    } catch { /* EventSource retries automatically after temporary network failures. */ }
  });
}

function failSetup(msg) {
  crawlStarting = false;
  $('#startBtn').disabled = false;
  $('#progress').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  toast(msg);
}

/* ============ render ============ */
function render() {
  $('#setup').classList.add('hidden');
  $('#progress').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#newCrawlBtn').classList.remove('hidden');
  window.scrollTo({ top: 0 });
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'issues'));
  $$('.tabpanel').forEach((p) => p.classList.toggle('hidden', p.id !== 'panel-issues'));

  const s = report.summary;
  $('#reportContext').textContent = `${report.seedUrl || report.pages[0]?.url || 'Website audit'} · ${new Date(report.generatedAt).toLocaleString()}`;
  ['#issueSearch', '#filterSeverity', '#filterRuleType', '#pageSearch', '#pageStatus'].forEach((selector) => $(selector).value = '');
  sortState = { issues: null, pages: null };
  $$('.grid th').forEach((th) => th.classList.remove('asc', 'desc'));
  batchQueue = [];
  $('#banner').innerHTML = s.checkedPages === 0
    ? `<div class="bannerbox"><strong>Nothing was analysed.</strong> robots.txt blocked every URL the crawler tried
       (${s.robotsSkippedCount} skipped). Start a new crawl with “Follow robots.txt rules” switched off to audit it anyway.</div>`
    : '';

  $('#scoreVal').textContent = s.score === null ? '—' : s.score;
  const arc = $('#scoreArc');
  const pct = s.score === null ? 0 : s.score;
  arc.style.strokeDashoffset = String(327 - (327 * pct) / 100);
  arc.setAttribute('stroke', pct >= 80 ? 'var(--pass)' : pct >= 50 ? 'var(--warn)' : 'var(--fail)');

  $('#failVal').textContent = s.counts.FAIL || 0;
  $('#warnVal').textContent = s.counts.WARNING || 0;
  $('#infoVal').textContent = s.counts.INFO || 0;
  $('#pagesVal').textContent = s.pagesCrawled;

  report._issuesByUrl = {};
  for (const i of report.issues) (report._issuesByUrl[i.url] ||= []).push(i);

  const cats = [...new Set(report.issues.map((i) => i.category))].sort();
  $('#filterCategory').innerHTML = '<option value="">Any category</option>' + cats.map((c) => `<option>${esc(c)}</option>`).join('');

  $('#tabIssuesCount').textContent = report.issues.length;
  $('#tabPagesCount').textContent = report.pages.filter((p) => p.status !== 'skipped-robots').length;

  const ct = $$('.tab').find((t) => t.dataset.tab === 'custom');
  if (report.customRules) {
    ct.hidden = false;
    $('#tabCustomCount').textContent = report.customRules.ruleCount;
    renderCustom();
  } else ct.hidden = true;

  renderIssues();
  renderPages();
  renderPriorities();
}

function renderPriorities() {
  const groups = new Map();
  const rank = { FAIL: 0, WARNING: 1, INFO: 2 };
  for (const issue of report.issues) {
    const key = JSON.stringify([issue.severity, issue.category, issue.issue]);
    if (!groups.has(key)) groups.set(key, { ...issue, urls: new Set() });
    groups.get(key).urls.add(issue.url);
  }
  const top = [...groups.values()].sort((a, b) => rank[a.severity] - rank[b.severity] || b.urls.size - a.urls.size).slice(0, 4);
  $('#priorityList').innerHTML = top.length ? top.map((item, index) => `
    <button class="priority-item" data-priority="${index}"><span class="priority-number">${String(index + 1).padStart(2, '0')}</span>
      <span class="priority-copy"><strong>${esc(item.issue)}</strong><span>${esc(item.recommendation)}</span></span>
      <span class="priority-count"><span class="sev sev-${esc(item.severity)}">${item.urls.size} page${item.urls.size === 1 ? '' : 's'}</span><span aria-hidden="true">↗</span></span></button>`).join('')
    : '<div class="empty">No issues flagged in this audit. Review your page details to see what was checked.</div>';
  $$('[data-priority]').forEach((button) => button.onclick = () => {
    const item = top[Number(button.dataset.priority)];
    $('#issueSearch').value = item.issue;
    $('#filterSeverity').value = item.severity;
    $('#filterCategory').value = item.category;
    $('#filterRuleType').value = '';
    $('.tab[data-tab="issues"]').click();
    renderIssues();
    $('#panel-issues').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
}
$('#clearFiltersBtn').onclick = () => {
  ['#issueSearch', '#filterSeverity', '#filterCategory', '#filterRuleType'].forEach((selector) => $(selector).value = '');
  renderIssues();
};

/* ---- issues ---- */
function visibleIssues() {
  const q = $('#issueSearch').value.trim().toLowerCase();
  const sev = $('#filterSeverity').value, cat = $('#filterCategory').value, rt = $('#filterRuleType').value;
  let list = report.issues.filter((i) =>
    (!sev || i.severity === sev) && (!cat || i.category === cat) && (!rt || (i.ruleType || 'Standard') === rt) &&
    (!q || `${i.url} ${i.issue} ${i.category} ${i.actual}`.toLowerCase().includes(q)));
  const st = sortState.issues;
  if (st) {
    list = [...list].sort((a, b) => String(a[st.key]).localeCompare(String(b[st.key])) * (st.dir === 'asc' ? 1 : -1));
  } else {
    const rank = { FAIL: 0, WARNING: 1, INFO: 2 };
    list = [...list].sort((a, b) => rank[a.severity] - rank[b.severity]);
  }
  return list;
}
function renderIssues() {
  const list = visibleIssues();
  $('#issueShown').textContent = `${list.length} of ${report.issues.length}`;
  $('#issuesEmpty').classList.toggle('hidden', list.length > 0);
  if (!list.length) {
    $('#issuesEmpty').textContent = report.issues.length
      ? 'No issues match these filters. Try clearing the search.'
      : 'No issues found on the pages that were crawled.';
  }
  $('#issuesBody').innerHTML = list.map((i) => `
    <tr class="rowbar rowbar-${i.severity} clickable" data-url="${esc(i.url)}">
      <td><span class="sev sev-${i.severity}">${i.severity === 'INFO' ? 'Review' : i.severity === 'WARNING' ? 'Warning' : 'Failing'}</span></td>
      <td>${esc(i.category)}<div class="tag">${esc(i.ruleType || 'Standard')}</div></td>
      <td class="cell-url">${esc(i.url)}</td>
      <td>${esc(i.issue)}<div class="tag">${esc(i.recommendation)}</div></td>
      <td class="cell-clip">${esc(i.expected)}</td>
      <td class="cell-clip">${esc(i.actual)}</td>
    </tr>`).join('');
  $$('#issuesBody tr').forEach((tr) => tr.onclick = () => openDrawer(tr.dataset.url));
}
['#issueSearch', '#filterSeverity', '#filterCategory', '#filterRuleType'].forEach((s) => {
  document.addEventListener('input', (e) => { if (e.target.matches(s)) renderIssues(); });
});

/* ---- pages ---- */
function visiblePages() {
  const q = $('#pageSearch').value.trim().toLowerCase();
  const status = $('#pageStatus').value;
  let list = report.pages.filter((p) => p.status !== 'skipped-robots')
    .filter((p) => !status || (status === 'broken' && (!p.status || p.status >= 400 || p.error))
      || (status === 'redirected' && (p.redirected || p.redirectChain?.length))
      || (status === 'noindex' && p.analysis?.indexability?.index === false)
      || (status === 'issues' && report._issuesByUrl[p.url]?.length))
    .filter((p) => !q || `${p.url} ${p.analysis?.title || ''}`.toLowerCase().includes(q));
  const st = sortState.pages;
  if (st) {
    const val = (p) => ({
      url: p.url, status: p.status, title: p.analysis?.title || '', h1: p.analysis?.h1Count ?? -1,
      index: p.analysis?.indexability.index ? 1 : 0, issues: (report._issuesByUrl[p.url] || []).length
    })[st.key];
    list = [...list].sort((a, b) => {
      const x = val(a), y = val(b);
      const r = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return r * (st.dir === 'asc' ? 1 : -1);
    });
  }
  return list;
}
function renderPages() {
  batchQueue = [];
  $('#selectAllCb').checked = false;
  $('#batchStatus').textContent = '';
  const list = visiblePages();
  $('#pagesEmpty').classList.toggle('hidden', list.length > 0);
  $('#pagesEmpty').textContent = 'No pages match that search.';
  $('#pagesBody').innerHTML = list.map((p) => {
    const n = (report._issuesByUrl[p.url] || []).length;
    const worst = (report._issuesByUrl[p.url] || []).some((i) => i.severity === 'FAIL') ? 'FAIL'
      : n ? 'WARNING' : '';
    const ok = p.status >= 200 && p.status < 300;
    return `<tr class="rowbar rowbar-${worst}">
      <td><input type="checkbox" class="rowCb" value="${esc(p.url)}" /></td>
      <td class="cell-url clickable" data-url="${esc(p.url)}">${esc(p.url)}</td>
      <td><span class="pill ${ok ? 'pill-ok' : 'pill-bad'}">${p.status}</span></td>
      <td class="cell-clip">${esc(p.analysis?.title || '—')}</td>
      <td class="num">${p.analysis?.h1Count ?? '—'}</td>
      <td>${p.analysis ? (p.analysis.indexability.index ? 'Yes' : '<span class="pill pill-mute">No</span>') : '—'}</td>
      <td class="num">${n || '—'}</td>
      <td><button class="linkbtn" data-detail="${esc(p.url)}">Details</button></td>
    </tr>`;
  }).join('');
  $$('#pagesBody [data-url],#pagesBody [data-detail]').forEach((el) => {
    el.onclick = () => openDrawer(el.dataset.url || el.dataset.detail);
  });
}
$('#pageSearch').addEventListener('input', renderPages);
$('#pageStatus').addEventListener('change', renderPages);
$('#selectAllCb').addEventListener('change', (e) => {
  $$('.rowCb').forEach((cb) => cb.checked = e.target.checked); batchQueue = [];
});
$$('[data-select]').forEach((btn) => btn.onclick = () => {
  const m = btn.dataset.select;
  $$('.rowCb').forEach((cb) => {
    cb.checked = m === 'all' ? true : m === 'none' ? false : (report._issuesByUrl[cb.value] || []).length > 0;
  });
  batchQueue = [];
  const n = $$('.rowCb:checked').length;
  $('#batchStatus').textContent = n ? `${n} page${n === 1 ? '' : 's'} selected` : '';
});
$('#openBatchBtn').addEventListener('click', () => {
  if (!batchQueue.length) {
    batchQueue = $$('.rowCb:checked').map((cb) => cb.value);
    if (!batchQueue.length) return toast('Select some pages first');
  }
  const batch = batchQueue.splice(0, Number($('#batchSize').value));
  batch.forEach((u) => { if (/^https?:\/\//i.test(u)) window.open(u, '_blank', 'noopener,noreferrer'); });
  $('#batchStatus').textContent = batchQueue.length
    ? `${batchQueue.length} left — click again for the next batch`
    : 'All selected pages opened';
});

/* ---- custom rules ---- */
function renderCustom() {
  const c = report.customRules;
  const w = $('#customWarnings');
  w.classList.toggle('hidden', !c.warnings?.length);
  w.innerHTML = (c.warnings || []).map(esc).join('<br>');
  const rows = [];
  for (const r of c.results) {
    if (!r.checks.length) {
      rows.push(`<tr><td class="cell-url">${esc(r.url)}</td><td>${r.status ?? '—'}</td>
        <td colspan="4" class="muted">No expectations were set for this URL</td></tr>`);
      continue;
    }
    r.checks.forEach((ch, idx) => rows.push(`<tr class="rowbar ${ch.pass ? '' : 'rowbar-FAIL'}">
      <td class="cell-url clickable" data-url="${esc(r.url)}">${idx === 0 ? esc(r.url) : ''}</td>
      <td>${idx === 0 ? (r.status ?? '—') : ''}</td>
      <td>${esc(ch.name)}</td>
      <td class="cell-clip">${esc(ch.expected)}</td>
      <td class="cell-clip">${esc(ch.actual)}</td>
      <td><span class="pill ${ch.pass ? 'pill-ok' : 'pill-bad'}">${ch.pass ? 'Pass' : 'Fail'}</span></td>
    </tr>`));
  }
  $('#customBody').innerHTML = rows.join('');
  $$('#customBody [data-url]').forEach((el) => el.onclick = () => openDrawer(el.dataset.url));
}

/* ---- sorting ---- */
$$('.grid th[data-sort]').forEach((th) => {
  th.onclick = () => {
    const panel = th.closest('.tabpanel').id === 'panel-pages' ? 'pages' : 'issues';
    const key = th.dataset.sort;
    const cur = sortState[panel];
    sortState[panel] = cur && cur.key === key && cur.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' };
    th.closest('thead').querySelectorAll('th').forEach((h) => h.classList.remove('asc', 'desc'));
    th.classList.add(sortState[panel].dir);
    panel === 'pages' ? renderPages() : renderIssues();
  };
});

/* ---- tabs ---- */
$$('.tab').forEach((tab) => tab.onclick = () => {
  $$('.tab').forEach((t) => t.classList.remove('is-active'));
  tab.classList.add('is-active');
  $$('.tabpanel').forEach((p) => p.classList.add('hidden'));
  $(`#panel-${tab.dataset.tab}`).classList.remove('hidden');
});
$$('[data-jump]').forEach((btn) => btn.onclick = () => {
  $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === 'issues'));
  $$('.tabpanel').forEach((p) => p.classList.add('hidden'));
  $('#panel-issues').classList.remove('hidden');
  $('#filterSeverity').value = btn.dataset.jump;
  renderIssues();
  $('#panel-issues').scrollIntoView({ behavior: 'smooth', block: 'start' });
});

/* ---- drawer ---- */
let drawerReturnFocus = null;
function openDrawer(url) {
  drawerReturnFocus = document.activeElement;
  const p = report.pages.find((x) => x.url === url) || null;
  const issues = report._issuesByUrl[url] || [];
  $('#drawerUrl').textContent = url;
  $('#drawerOpen').href = /^https?:\/\//i.test(url) ? url : '#';
  $('#drawerSpeedResult').innerHTML = '';
  const a = p?.analysis;
  const rows = (pairs) => pairs.map(([k, v]) =>
    `<div class="drow"><dt>${esc(k)}</dt><dd class="mono">${v === '' || v == null ? '<span class="muted">not set</span>' : esc(v)}</dd></div>`).join('');

  let html = `<div class="dsec"><h3>Response</h3>${rows([
    ['Status', p ? p.status : 'not crawled'],
    ['Response time', p?.responseTimeMs ? `${p.responseTimeMs} ms` : ''],
    ['Fetch mode', p?.mode || ''],
    ['Fetch error', p?.error || ''],
    ['Browser fallback warning', p?.renderFallbackError || ''],
    ['Final URL', p?.finalUrl !== p?.url ? p?.finalUrl : ''],
    ['Redirects', p?.redirectChain?.length ? p.redirectChain.map((c) => `${c.status} → ${c.to}`).join('\n') : '']
  ])}</div>`;

  if (a) {
    html += `<div class="dsec"><h3>Search result preview</h3><div class="search-preview"><span>${esc(p.finalUrl || url)}</span><strong>${esc(a.title || 'This page has no title')}</strong><p>${esc(a.metaDescription || 'No meta description is set. Search engines may choose text from the page.')}</p></div><p class="hint">Illustrative preview. Search engines may rewrite titles and descriptions.</p></div>`;
    html += `<div class="dsec"><h3>Metadata</h3>${rows([
      ['Title', a.title], ['Title length', `${a.titleLength} chars`],
      ['Description', a.metaDescription], ['Description length', `${a.metaDescriptionLength} chars`],
      ['Canonical', a.canonical], ['Robots', a.metaRobots], ['X-Robots-Tag', a.xRobotsTag],
      ['Indexable', `${a.indexability.index ? 'INDEX' : 'NOINDEX'} / ${a.indexability.follow ? 'FOLLOW' : 'NOFOLLOW'}`]
    ])}</div>`;

    html += `<div class="dsec"><h3>Open Graph</h3>${rows([
      ['og:title', a.og?.title], ['og:description', a.og?.description],
      ['og:image', a.og?.image], ['og:url', a.og?.url]
    ])}</div>`;

    if (a.headings?.length) {
      const tree = a.headings.map((h) => `${'  '.repeat(h.level - 1)}${'└─ '.repeat(h.level > 1 ? 1 : 0)}H${h.level}  ${h.text || '(empty)'}`).join('\n');
      html += `<div class="dsec"><h3>Heading structure</h3><div class="tree">${esc(tree)}</div></div>`;
    }

    html += `<div class="dsec"><h3>Structured data</h3>${rows([
      ['Schema types', (a.schemaTypes || []).join(', ')],
      ['Breadcrumb', `${a.breadcrumb.visible ? 'visible' : 'none visible'} / ${a.breadcrumb.schema ? 'schema present' : 'no schema'}`]
    ])}</div>`;

    html += `<div class="dsec"><h3>Images</h3>${rows([
      ['Total', a.images], ['Missing alt', a.missingAlt], ['Empty alt', a.emptyAlt]
    ])}</div>`;
  }

  html += `<div class="dsec"><h3>Issues on this page (${issues.length})</h3>` +
    (issues.length ? issues.map((i) => `<div class="dissue dissue-${i.severity}">
      <strong>${esc(i.issue)}</strong>
      Expected ${esc(i.expected)} · found ${esc(i.actual)}<br>${esc(i.recommendation)}</div>`).join('')
      : '<p class="muted sm">Nothing flagged here.</p>') + '</div>';

  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.remove('hidden');
  $('#drawerScrim').classList.remove('hidden');
  document.body.style.overflow = 'hidden';
  $('#drawerClose').focus();
}
function closeDrawer() {
  $('#drawer').classList.add('hidden'); $('#drawerScrim').classList.add('hidden');
  document.body.style.overflow = '';
  drawerReturnFocus?.focus();
}
$('#drawer').addEventListener('keydown', (event) => {
  if (event.key !== 'Tab') return;
  const focusable = [...$('#drawer').querySelectorAll('button, a[href]')];
  const first = focusable[0], last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});
$('#drawerClose').onclick = closeDrawer;
$('#drawerScrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#drawerCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#drawerUrl').textContent); toast('URL copied'); }
  catch { toast('Copy failed — select the URL manually'); }
};
$('#drawerSpeed').onclick = async () => {
  const url = $('#drawerUrl').textContent;
  if (!/^https?:\/\//i.test(url)) { toast('Can only measure http(s) URLs'); return; }
  const btn = $('#drawerSpeed');
  const out = $('#drawerSpeedResult');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Measuring…';
  out.innerHTML = '<div class="dsec"><p class="muted sm">Loading the page in a real browser — this can take a few seconds…</p></div>';
  try {
    const res = await fetch('/api/pagespeed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Measurement failed');
    const ms = (v) => (v == null ? '' : `${v} ms`);
    const kb = (b) => (b == null ? '' : `${(b / 1024).toFixed(0)} KB`);
    const rowsHtml = [
      ['Time to first byte', ms(data.ttfbMs)],
      ['First contentful paint', ms(data.firstContentfulPaintMs)],
      ['DOM content loaded', ms(data.domContentLoadedMs)],
      ['Fully loaded', ms(data.loadMs)],
      ['Requests', data.requestCount],
      ['Transferred', kb(data.transferBytes)]
    ].map(([k, v]) => `<div class="drow"><dt>${esc(k)}</dt><dd class="mono">${v === '' || v == null ? '<span class="muted">n/a</span>' : esc(v)}</dd></div>`).join('');
    out.innerHTML = `<div class="dsec"><h3>Page speed (lab)</h3>${rowsHtml}<p class="hint">Measured by loading the page in a headless browser on the server. Reflects the server's network and CPU, not a real end user's.</p></div>`;
  } catch (e) {
    out.innerHTML = `<div class="dsec"><p class="muted sm">Could not measure: ${esc(e.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
};

/* ---- export ---- */
function csvCell(value) {
  let text = String(value ?? '');
  if (/^\s*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
  return `"${text.replace(/"/g, '""')}"`;
}
$('#exportPagesBtn').onclick = () => {
  if (!report) return;
  const rows = [['URL', 'Status', 'Final URL', 'Title', 'Description', 'H1 count', 'Indexable', 'Issues'],
    ...visiblePages().map((p) => [p.url, p.status, p.finalUrl || p.url, p.analysis?.title, p.analysis?.metaDescription,
      p.analysis?.h1Count, p.analysis ? (p.analysis.indexability.index ? 'Yes' : 'No') : '', report._issuesByUrl[p.url]?.length || 0])];
  download('site-audit-pages.csv', '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n'), 'text/csv;charset=utf-8');
};
function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
$('#exportJsonBtn').onclick = () => report && download('site-audit.json', JSON.stringify(report, null, 2), 'application/json');
$('#exportCsvBtn').onclick = () => {
  if (!report) return;
  const head = ['Severity', 'Rule type', 'Category', 'URL', 'Issue', 'Expected', 'Found', 'Recommendation'];
  const rows = report.issues.map((i) => [i.severity, i.ruleType || 'Standard', i.category, i.url, i.issue, i.expected, i.actual, i.recommendation].map(csvCell).join(','));
  download('site-audit-issues.csv', '\uFEFF' + [head.map(csvCell).join(','), ...rows].join('\r\n'), 'text/csv;charset=utf-8');
};

function saveReport(value) {
  const { _issuesByUrl, ...clean } = value;
  history = [clean, ...history.filter((r) => r.generatedAt !== clean.generatedAt)].slice(0, 5);
  while (history.length && !storage.set(HISTORY_KEY, history)) history.pop();
  if (!history.length) toast('Browser storage is full or unavailable. Export this report to keep it.');
  renderHistory();
}

function renderHistory() {
  $('#historyList').innerHTML = history.length ? history.map((r, index) => `
    <div class="panel-row"><div><strong>${esc(r.seedUrl || r.pages?.[0]?.url || 'Site audit')}</strong>
      <p class="hint">${esc(new Date(r.generatedAt).toLocaleString())} · ${esc(r.summary?.pagesCrawled)} pages · Score ${esc(r.summary?.score ?? '—')}</p>
    </div><button class="btn btn-ghost" data-history="${index}">Open report</button></div>`).join('')
    : '<p class="muted">Completed reports will appear here.</p>';
  $$('[data-history]').forEach((button) => button.onclick = () => {
    report = history[Number(button.dataset.history)];
    render();
  });
}
$('#clearHistoryBtn').onclick = () => { history = []; storage.remove(HISTORY_KEY); renderHistory(); };
renderHistory();

const savedCrawl = storage.get(ACTIVE_KEY, null);
if (savedCrawl?.crawlId) {
  $('#setup').classList.add('hidden');
  $('#progress').classList.remove('hidden');
  $('#progressTarget').textContent = savedCrawl.seedUrl;
  logLine('Reconnecting to your previous crawl…');
  connectCrawl(savedCrawl);
}
