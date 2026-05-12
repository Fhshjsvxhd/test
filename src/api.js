'use strict';

const express = require('express');
const { db, nanoid } = require('./db');
const config = require('./config');

const router = express.Router();

// auth middleware
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== config.adminToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// ============ FLOWS CRUD ============

// Every writable field with its DB type. Used to coerce values into
// SQLite-compatible types (number | string | bigint | Buffer | null).
const FIELD_TYPES = {
  slug:             'text',
  name:             'text',
  domain:           'text',
  status:           'text',

  safe_mode:        'text',
  safe_url:         'text',
  safe_html:        'text',
  money_mode:       'text',
  money_url:        'text',
  money_html:       'text',

  block_bots:       'int',
  block_datacenter: 'int',
  block_vpn_proxy:  'int',
  block_headless:   'int',
  require_js:       'int',
  require_referrer: 'int',
  block_empty_ua:   'int',
  block_no_lang:    'int',

  countries_mode:   'text',
  countries:        'json',
  devices:          'json',
  os_list:          'json',
  browsers:         'json',
  languages:        'json',

  blacklist_ips:    'text',
  blacklist_ua:     'text',

  schedule_enabled: 'int',
  schedule_days:    'json',
  schedule_from:    'text',
  schedule_to:      'text',

  limit_clicks_per_ip: 'int',
  limit_window_min:    'int',
};

/**
 * Coerce an arbitrary JS value into something SQLite can bind.
 */
function coerce(type, v) {
  // undefined or null -> always use a safe default instead of null,
  // because the DB columns have NOT-NULL-like defaults.
  if (v === undefined || v === null) {
    if (type === 'int') return 0;
    if (type === 'json') return '[]';
    return '';
  }

  if (type === 'int') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
    if (typeof v === 'string') {
      const trimmed = v.trim();
      if (trimmed === '' || trimmed === 'null' || trimmed === 'undefined') return 0;
      const n = parseInt(trimmed, 10);
      return Number.isFinite(n) ? n : 0;
    }
    return 0;
  }

  if (type === 'json') {
    if (typeof v === 'string') return v === '' ? '[]' : v;
    try { return JSON.stringify(v); } catch { return '[]'; }
  }

  // text
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'bigint') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  try { return JSON.stringify(v); } catch { return ''; }
}

function coerceBody(body, { partial = false } = {}) {
  const out = {};
  for (const [field, type] of Object.entries(FIELD_TYPES)) {
    if (partial && !(field in body)) continue;
    out[field] = coerce(type, body[field]);
  }
  return out;
}

router.get('/flows', (req, res) => {
  const rows = db.prepare(`
    SELECT f.*,
      (SELECT COUNT(*) FROM visits v WHERE v.flow_id = f.id) AS total_visits,
      (SELECT COUNT(*) FROM visits v WHERE v.flow_id = f.id AND v.decision='money') AS real_visits,
      (SELECT COUNT(*) FROM visits v WHERE v.flow_id = f.id AND v.decision='safe')  AS blocked_visits
    FROM flows f ORDER BY f.id DESC
  `).all();
  res.json({ ok: true, rows });
});

router.get('/flows/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM flows WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false });
  res.json({ ok: true, row });
});

router.post('/flows', (req, res) => {
  try {
    const data = coerceBody(req.body, { partial: false });

    // defaults
    if (!data.slug) data.slug = nanoid(8).toLowerCase();
    if (!data.name) data.name = 'New flow';
    if (!data.safe_mode)      data.safe_mode = 'url';
    if (!data.money_mode)     data.money_mode = 'url';
    if (!data.status)         data.status = 'active';
    if (!data.countries_mode) data.countries_mode = 'any';

    data.created_at = Date.now();
    data.updated_at = Date.now();

    const cols = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO flows (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
    ).run(data);
    res.json({ ok: true, id: info.lastInsertRowid, slug: data.slug });
  } catch (e) {
    console.error('POST /flows error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.put('/flows/:id', (req, res) => {
  try {
    const data = coerceBody(req.body, { partial: true });
    if (Object.keys(data).length === 0) return res.json({ ok: true });
    data.updated_at = Date.now();
    const sets = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    data.id = parseInt(req.params.id, 10);
    db.prepare(`UPDATE flows SET ${sets} WHERE id = @id`).run(data);
    res.json({ ok: true });
  } catch (e) {
    console.error('PUT /flows error:', e);
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.post('/flows/:id/duplicate', (req, res) => {
  const row = db.prepare(`SELECT * FROM flows WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false });
  delete row.id;
  row.slug = nanoid(8).toLowerCase();
  row.name = (row.name || 'Flow') + ' (copy)';
  row.domain = '';
  row.created_at = Date.now();
  row.updated_at = Date.now();
  const cols = Object.keys(row);
  const info = db.prepare(
    `INSERT INTO flows (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
  ).run(row);
  res.json({ ok: true, id: info.lastInsertRowid });
});

router.delete('/flows/:id', (req, res) => {
  db.prepare(`DELETE FROM flows WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ============ STATS ============

router.get('/stats/overview', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const row = db.prepare(`
    SELECT
      COUNT(*)                                       AS total,
      SUM(CASE WHEN decision='money' THEN 1 ELSE 0 END) AS real,
      SUM(CASE WHEN decision='safe'  THEN 1 ELSE 0 END) AS blocked,
      COUNT(DISTINCT ip)                             AS unique_ips,
      COUNT(DISTINCT country)                        AS countries
    FROM visits WHERE ts >= ?
  `).get(since);
  res.json({ ok: true, ...row });
});

router.get('/stats/timeline', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10), 720);
  const since = Date.now() - hours * 3600 * 1000;
  const bucket = hours <= 24 ? 3600 * 1000 : 3600 * 1000 * 24;
  const rows = db.prepare(`
    SELECT (ts / ${bucket}) * ${bucket} AS t,
           SUM(CASE WHEN decision='money' THEN 1 ELSE 0 END) AS real,
           SUM(CASE WHEN decision='safe'  THEN 1 ELSE 0 END) AS blocked
    FROM visits WHERE ts >= ? GROUP BY t ORDER BY t
  `).all(since);
  res.json({ ok: true, bucket, rows });
});

router.get('/stats/reasons', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const rows = db.prepare(`
    SELECT
      substr(reason, 1, instr(reason || ':', ':') - 1) AS category,
      COUNT(*) AS count
    FROM visits
    WHERE decision='safe' AND reason IS NOT NULL AND ts >= ?
    GROUP BY category ORDER BY count DESC LIMIT 20
  `).all(since);
  res.json({ ok: true, rows });
});

router.get('/stats/countries', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const rows = db.prepare(`
    SELECT country, COUNT(*) AS total,
           SUM(CASE WHEN decision='money' THEN 1 ELSE 0 END) AS real,
           SUM(CASE WHEN decision='safe'  THEN 1 ELSE 0 END) AS blocked
    FROM visits WHERE ts >= ? AND country IS NOT NULL
    GROUP BY country ORDER BY total DESC LIMIT 25
  `).all(since);
  res.json({ ok: true, rows });
});

router.get('/visits', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const flowId = req.query.flow_id ? parseInt(req.query.flow_id, 10) : null;
  const decision = req.query.decision;
  const params = [];
  let where = '1=1';
  if (flowId) { where += ' AND v.flow_id = ?'; params.push(flowId); }
  if (decision === 'money' || decision === 'safe') { where += ' AND v.decision = ?'; params.push(decision); }
  params.push(limit);
  const rows = db.prepare(`
    SELECT v.*, f.name AS flow_name, f.slug AS flow_slug
    FROM visits v JOIN flows f ON f.id = v.flow_id
    WHERE ${where}
    ORDER BY v.ts DESC LIMIT ?
  `).all(...params);
  res.json({ ok: true, rows });
});

// ============ META ============

router.get('/meta/countries', (req, res) => {
  res.json({ ok: true, rows: require('./countries.json') });
});

module.exports = router;
