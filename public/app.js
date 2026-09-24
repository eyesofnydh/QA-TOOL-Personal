const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let report = null;
let batchQueue = [];
let selectedFiles = [];
let sortState = { issues: null, pages: null };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  const seedUrl = $('#seedUrl').value.trim();
  if (!seedUrl) { $('#seedUrl').focus(); return toast('Enter a URL to crawl'); }

  const fd = new FormData();
  fd.append('seedUrl', seedUrl);
  fd.append('mode', $('#mode').value);
  fd.append('maxPages', $('#maxPages').value || '50');
  fd.append('maxDepth', $('#maxDepth').value || '3');
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

  const src = new EventSource(`/api/crawl/${res.crawlId}/events`);
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
    render();
  });
  src.addEventListener('error', (e) => {
    let msg = 'The crawl stopped unexpectedly.';
    try { msg = JSON.parse(e.data).message; } catch {}
    src.close();
    failSetup(msg);
  });
}

function failSetup(msg) {
  $('#progress').classList.add('hidden');
  $('#setup').classList.remove('hidden');
  toast(msg);
}

/* ============ render ============ */
function render() {
  $('#progress').classList.add('hidden');
  $('#results').classList.remove('hidden');
  $('#newCrawlBtn').classList.remove('hidden');
  window.scrollTo({ top: 0 });

  const s = report.summary;
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
}

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
  let list = report.pages.filter((p) => p.status !== 'skipped-robots')
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
  batch.forEach((u) => window.open(u, '_blank'));
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
function openDrawer(url) {
  const p = report.pages.find((x) => x.url === url) || null;
  const issues = report._issuesByUrl[url] || [];
  $('#drawerUrl').textContent = url;
  $('#drawerOpen').href = url;
  const a = p?.analysis;
  const rows = (pairs) => pairs.map(([k, v]) =>
    `<div class="drow"><dt>${esc(k)}</dt><dd class="mono">${v === '' || v == null ? '<span class="muted">not set</span>' : esc(v)}</dd></div>`).join('');

  let html = `<div class="dsec"><h3>Response</h3>${rows([
    ['Status', p ? p.status : 'not crawled'],
    ['Response time', p?.responseTimeMs ? `${p.responseTimeMs} ms` : ''],
    ['Fetch mode', p?.mode || ''],
    ['Final URL', p?.finalUrl !== p?.url ? p?.finalUrl : ''],
    ['Redirects', p?.redirectChain?.length ? p.redirectChain.map((c) => `${c.status} → ${c.to}`).join('\n') : '']
  ])}</div>`;

  if (a) {
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
}
function closeDrawer() { $('#drawer').classList.add('hidden'); $('#drawerScrim').classList.add('hidden'); }
$('#drawerClose').onclick = closeDrawer;
$('#drawerScrim').onclick = closeDrawer;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
$('#drawerCopy').onclick = async () => {
  try { await navigator.clipboard.writeText($('#drawerUrl').textContent); toast('URL copied'); }
  catch { toast('Copy failed — select the URL manually'); }
};

/* ---- export ---- */
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
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Severity', 'Rule type', 'Category', 'URL', 'Issue', 'Expected', 'Found', 'Recommendation'];
  const rows = report.issues.map((i) => [i.severity, i.ruleType || 'Standard', i.category, i.url, i.issue, i.expected, i.actual, i.recommendation].map(q).join(','));
  download('site-audit-issues.csv', [head.map(q).join(','), ...rows].join('\n'), 'text/csv');
};
