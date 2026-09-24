import XLSX from 'xlsx';
import { normalizeUrl } from './urlUtils.js';

/**
 * Column-name aliases. Uploaded sheets never use consistent headers, so we
 * match loosely: lowercase, strip non-alphanumerics, then look for a known key.
 */
const FIELD_ALIASES = {
  url: ['url', 'urls', 'pageurl', 'affectedurl', 'affectedurls', 'sourceurl', 'oldurl', 'from', 'address', 'link', 'page', '404url', '404urls'],
  redirectTo: ['redirectto', 'redirect', 'redirection', 'redirections', 'targeturl', 'newurl', 'destination', 'to', 'redirecturl', 'suggestedredirect', 'liveurl'],
  expectedTitle: ['expectedtitle', 'metatitle', 'title', 'newtitle', 'updatedtitle', 'proposedtitle', 'seotitle', 'titletag'],
  expectedDescription: ['expecteddescription', 'metadescription', 'description', 'newdescription', 'updateddescription', 'proposeddescription', 'seodescription', 'metadesc'],
  expectedH1: ['expectedh1', 'h1', 'h1tag', 'newh1', 'requiredh1'],
  expectedCanonical: ['expectedcanonical', 'canonical', 'canonicalurl'],
  expectedSchema: ['expectedschema', 'schema', 'schematype', 'structureddata'],
  index: ['index', 'indexability', 'indexable', 'robots'],
  breadcrumb: ['breadcrumb', 'breadcrumbs', 'breadcrumbrequired']
};

function normalizeHeader(h) {
  return String(h || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function mapHeaders(headerRow) {
  const mapping = {};
  headerRow.forEach((raw, idx) => {
    const norm = normalizeHeader(raw);
    if (!norm) return;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (aliases.includes(norm)) {
        if (mapping[field] === undefined) mapping[field] = idx;
        return;
      }
    }
  });
  return mapping;
}

/**
 * Header rows are often not row 0 — sheets have titles, blank rows, notes.
 * Scan the first 15 rows and pick the one that maps the most known fields.
 */
function findHeaderRow(rows) {
  let best = { index: -1, mapping: {}, score: 0 };
  const limit = Math.min(rows.length, 15);
  for (let i = 0; i < limit; i++) {
    const mapping = mapHeaders(rows[i] || []);
    const score = Object.keys(mapping).length;
    if (score > best.score) best = { index: i, mapping, score };
  }
  return best;
}

function cleanCell(v) {
  if (v === undefined || v === null) return '';
  return String(v).trim();
}

function parseSheetRows(rows, sourceName, baseUrl) {
  const { index: headerIdx, mapping } = findHeaderRow(rows);
  if (headerIdx === -1 || mapping.url === undefined) {
    return { rules: [], warning: `${sourceName}: could not find a URL column. Expected a header like "URL", "Address" or "Affected URLs".` };
  }

  const rules = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r] || [];
    const rawUrl = cleanCell(row[mapping.url]);
    if (!rawUrl || !/^https?:\/\/|^\//i.test(rawUrl)) continue;
    const url = normalizeUrl(rawUrl, baseUrl) || rawUrl;

    const rule = { url, source: sourceName };
    for (const field of Object.keys(FIELD_ALIASES)) {
      if (field === 'url') continue;
      if (mapping[field] === undefined) continue;
      const val = cleanCell(row[mapping[field]]);
      if (val) rule[field] = field === 'redirectTo' || field === 'expectedCanonical'
        ? (normalizeUrl(val, baseUrl) || val)
        : val;
    }
    if (Object.keys(rule).length > 2) rules.push(rule);
  }
  return { rules, warning: rules.length ? null : `${sourceName}: found a URL column but no usable data rows.` };
}

async function parseWorkbook(buffer, sourceName, baseUrl) {
  const wb = XLSX.read(buffer, { type: 'buffer' });
  const allRules = [];
  const warnings = [];
  for (const sheetName of wb.SheetNames) {
    const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, blankrows: false, defval: '' });
    const label = wb.SheetNames.length > 1 ? `${sourceName} [${sheetName}]` : sourceName;
    const { rules, warning } = parseSheetRows(rows, label, baseUrl);
    allRules.push(...rules);
    if (warning) warnings.push(warning);
  }
  return { rules: allRules, warnings };
}

async function parseDocx(buffer, sourceName, baseUrl) {
  const mammoth = await import('mammoth');
  const { value: text } = await mammoth.extractRawText({ buffer });
  return parseFreeText(text, sourceName, baseUrl);
}

/**
 * Free-text/doc parsing: looks for "Key: value" blocks grouped under a URL line.
 * Handles the schema-spec style ("Expected Schema: Organization / Required: name, url").
 */
function parseFreeText(text, sourceName, baseUrl) {
  const rules = [];
  const globals = { requiredSchemaTypes: [], requiredSchemaProps: [], recommendedSchemaProps: [] };
  let current = null;
  let section = null;

  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const urlMatch = line.match(/^(?:url\s*[:\-]\s*)?(https?:\/\/\S+|\/\S*)$/i);
    if (urlMatch) {
      if (current && Object.keys(current).length > 2) rules.push(current);
      current = { url: normalizeUrl(urlMatch[1], baseUrl) || urlMatch[1], source: sourceName };
      section = null;
      continue;
    }

    const kv = line.match(/^([A-Za-z][A-Za-z0-9 _\-]*)\s*[:\-]\s*(.*)$/);
    if (!kv) {
      if (section && current) current[section] = (current[section] ? current[section] + ' ' : '') + line;
      else if (section === 'requiredSchemaProps') globals.requiredSchemaProps.push(line.replace(/^[-*•]\s*/, ''));
      else if (section === 'recommendedSchemaProps') globals.recommendedSchemaProps.push(line.replace(/^[-*•]\s*/, ''));
      continue;
    }

    const key = normalizeHeader(kv[1]);
    const value = kv[2].trim();

    if (['required', 'requiredproperties', 'requiredprops'].includes(key)) {
      section = 'requiredSchemaProps';
      if (value) globals.requiredSchemaProps.push(...value.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (['recommended', 'recommendedproperties', 'recommendedprops'].includes(key)) {
      section = 'recommendedSchemaProps';
      if (value) globals.recommendedSchemaProps.push(...value.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
      continue;
    }
    if (['expectedschema', 'schema', 'schematype'].includes(key)) {
      if (current) current.expectedSchema = value;
      else if (value) globals.requiredSchemaTypes.push(...value.split(/[,;]/).map((s) => s.trim()).filter(Boolean));
      section = null;
      continue;
    }

    if (!current) continue;
    section = null;
    for (const [field, aliases] of Object.entries(FIELD_ALIASES)) {
      if (field === 'url') continue;
      if (aliases.includes(key)) {
        current[field] = ['redirectTo', 'expectedCanonical'].includes(field) ? (normalizeUrl(value, baseUrl) || value) : value;
        section = field;
        break;
      }
    }
  }
  if (current && Object.keys(current).length > 2) rules.push(current);

  const hasGlobals = globals.requiredSchemaTypes.length || globals.requiredSchemaProps.length || globals.recommendedSchemaProps.length;
  return {
    rules,
    globals: hasGlobals ? globals : null,
    warnings: rules.length || hasGlobals ? [] : [`${sourceName}: no URL rules or schema spec found in the document text.`]
  };
}

async function parseJson(buffer, sourceName, baseUrl) {
  const data = JSON.parse(buffer.toString('utf-8'));
  const list = Array.isArray(data) ? data : Array.isArray(data.rules) ? data.rules : [data];
  const rules = [];
  for (const item of list) {
    if (!item || !item.url) continue;
    rules.push({ ...item, url: normalizeUrl(item.url, baseUrl) || item.url, source: sourceName });
  }
  return { rules, globals: data.schemaSpec || null, warnings: rules.length ? [] : [`${sourceName}: no objects with a "url" field.`] };
}

export async function parseRuleFile({ buffer, filename }, baseUrl) {
  const ext = (filename.split('.').pop() || '').toLowerCase();
  try {
    if (['xlsx', 'xls', 'xlsm', 'csv', 'tsv'].includes(ext)) {
      return await parseWorkbook(buffer, filename, baseUrl);
    }
    if (ext === 'json' || ext === 'jsonld') {
      return await parseJson(buffer, filename, baseUrl);
    }
    if (ext === 'docx') {
      return await parseDocx(buffer, filename, baseUrl);
    }
    if (ext === 'txt' || ext === 'md') {
      return parseFreeText(buffer.toString('utf-8'), filename, baseUrl);
    }
    if (ext === 'pdf') {
      return { rules: [], warnings: [`${filename}: PDF parsing is not supported yet — export the content as CSV, XLSX, DOCX or TXT instead.`] };
    }
    return { rules: [], warnings: [`${filename}: unsupported file type ".${ext}".`] };
  } catch (e) {
    return { rules: [], warnings: [`${filename}: failed to parse (${e.message}).`] };
  }
}

export async function parseRuleFiles(files, baseUrl) {
  const rules = [];
  const warnings = [];
  let globals = null;
  for (const f of files) {
    const res = await parseRuleFile(f, baseUrl);
    rules.push(...(res.rules || []));
    warnings.push(...(res.warnings || []));
    if (res.globals) globals = { ...(globals || {}), ...res.globals };
  }
  // Merge rules that target the same URL across different files.
  const byUrl = new Map();
  for (const r of rules) {
    const key = r.url.replace(/\/+$/, '');
    if (byUrl.has(key)) {
      const existing = byUrl.get(key);
      byUrl.set(key, { ...existing, ...r, source: `${existing.source}; ${r.source}` });
    } else {
      byUrl.set(key, r);
    }
  }
  return { rules: [...byUrl.values()], globals, warnings };
}
