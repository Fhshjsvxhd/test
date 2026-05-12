'use strict';

const express = require('express');
const { db, nanoid } = require('./db');
const config = require('./config');

const router = express.Router();

// auth
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== config.adminToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// ---------- field types & coercion ----------
const FIELD_TYPES = {
  name:             'text',
  tag:              'text',
  status:           'text',
  target_url:       'text',
  target_mode:      'text',
  bot_url:          'text',
  track_params:     'int',
  disable_extra_bl: 'int',
  allow_pr_chrome:  'int',
  conversion_param: 'text',
  block_bots:       'int',
  block_datacenter: 'int',
  block_vpn_proxy:  'int',
  block_headless:   'int',
  block_empty_ua:   'int',
  block_no_lang:    'int',
  require_referrer: 'int',
  geo:              'json',
  geo_mode:         'text',
  language:         'text',
};

function coerce(type, v) {
  if (v === undefined || v === null) {
    if (type === 'int') return 0;
    if (type === 'json') return '[]';
    return '';
  }
  if (type === 'int') {
    if (typeof v === 'boolean') return v ? 1 : 0;
    if (typeof v === 'number') return Number.isFinite(v) ? Math.trunc(v) : 0;
    if (typeof v === 'string') { const n = parseInt(v, 10); return Number.isFinite(n) ? n : 0; }
    return 0;
  }
  if (type === 'json') {
    if (typeof v === 'string') return v === '' ? '[]' : v;
    try { return JSON.stringify(v); } catch { return '[]'; }
  }
  if (typeof v === 'string') return v;
  try { return String(v); } catch { return ''; }
}

function coerceBody(body, partial) {
  const out = {};
  for (const [f, t] of Object.entries(FIELD_TYPES)) {
    if (partial && !(f in body)) continue;
    out[f] = coerce(t, body[f]);
  }
  return out;
}

// ---------- CAMPAIGNS ----------
router.get('/campaigns', (req, res) => {
  const rows = db.prepare(`
    SELECT c.*,
      (SELECT COUNT(*) FROM visits v WHERE v.campaign_id = c.id) AS total_visits,
      (SELECT COUNT(*) FROM visits v WHERE v.campaign_id = c.id AND v.decision='money') AS real_visits,
      (SELECT COUNT(*) FROM visits v WHERE v.campaign_id = c.id AND v.decision='safe')  AS blocked_visits,
      (SELECT COUNT(*) FROM conversions co WHERE co.campaign_id = c.id) AS conv_count
    FROM campaigns c ORDER BY c.id DESC
  `).all();
  res.json({ ok: true, rows });
});

router.get('/campaigns/:id', (req, res) => {
  const row = db.prepare(`SELECT * FROM campaigns WHERE id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ ok: false });
  res.json({ ok: true, row });
});

router.post('/campaigns', (req, res) => {
  try {
    const data = coerceBody(req.body, false);
    if (!data.name) data.name = 'New campaign';
    if (!data.target_mode) data.target_mode = 'redirect';
    if (!data.geo_mode) data.geo_mode = 'allow';
    if (!data.conversion_param) data.conversion_param = 'clickid';
    if (!data.status) data.status = 'active';

    data.slug = nanoid(8).toLowerCase();
    data.api_key = nanoid(32);

    // Palladium-style credentials baked into the generated PHP so
    // marketing-net fingerprints can't tell the script apart from the
    // real thing by payload shape.
    const rnd = () => nanoid(20);
    data.client_id      = String(Math.floor(1000 + Math.random() * 9000));
    data.client_company = rnd();
    const raw = data.client_id + data.client_company + rnd() + Date.now().toString(16);
    data.client_secret  = Buffer.from(raw).toString('base64');

    data.created_at = Date.now();
    data.updated_at = Date.now();

    const cols = Object.keys(data);
    const info = db.prepare(
      `INSERT INTO campaigns (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
    ).run(data);
    res.json({ ok: true, id: info.lastInsertRowid, slug: data.slug });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.put('/campaigns/:id', (req, res) => {
  try {
    const data = coerceBody(req.body, true);
    if (Object.keys(data).length === 0) return res.json({ ok: true });
    data.updated_at = Date.now();
    const sets = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    data.id = parseInt(req.params.id, 10);
    db.prepare(`UPDATE campaigns SET ${sets} WHERE id = @id`).run(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

router.delete('/campaigns/:id', (req, res) => {
  db.prepare(`DELETE FROM campaigns WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- STATS ----------
router.get('/stats/overview', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const totals = db.prepare(`
    SELECT COUNT(*) AS total,
      SUM(CASE WHEN decision='money' THEN 1 ELSE 0 END) AS real,
      SUM(CASE WHEN decision='safe'  THEN 1 ELSE 0 END) AS blocked,
      COUNT(DISTINCT ip) AS unique_ips,
      COUNT(DISTINCT country) AS countries
    FROM visits WHERE ts >= ?
  `).get(since);
  const convs = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(payout),0) AS revenue
    FROM conversions WHERE ts >= ?
  `).get(since);
  res.json({ ok: true, ...totals, conversions: convs.count || 0, revenue: +(convs.revenue || 0).toFixed(2) });
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
    SELECT substr(reason, 1, instr(reason || ':', ':') - 1) AS category, COUNT(*) AS count
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
  const campId = req.query.campaign_id ? parseInt(req.query.campaign_id, 10) : null;
  const decision = req.query.decision;
  const params = [];
  let where = '1=1';
  if (campId) { where += ' AND v.campaign_id = ?'; params.push(campId); }
  if (decision === 'money' || decision === 'safe') { where += ' AND v.decision = ?'; params.push(decision); }
  params.push(limit);
  const rows = db.prepare(`
    SELECT v.*, c.name AS campaign_name, c.slug AS campaign_slug
    FROM visits v JOIN campaigns c ON c.id = v.campaign_id
    WHERE ${where}
    ORDER BY v.ts DESC LIMIT ?
  `).all(...params);
  res.json({ ok: true, rows });
});

// ---------- CONVERSIONS ----------
router.get('/conversions', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '100', 10), 500);
  const rows = db.prepare(`
    SELECT co.*, c.name AS campaign_name
    FROM conversions co LEFT JOIN campaigns c ON c.id = co.campaign_id
    ORDER BY co.ts DESC LIMIT ?
  `).all(limit);
  res.json({ ok: true, rows });
});

// ---------- BLACKLIST ----------
router.get('/blacklist', (req, res) => {
  const rows = db.prepare(`SELECT * FROM blacklist ORDER BY id DESC`).all();
  res.json({ ok: true, rows });
});
router.post('/blacklist', (req, res) => {
  try {
    const kind = req.body.kind === 'ua' ? 'ua' : 'ip';
    const value = (req.body.value || '').trim();
    if (!value) return res.status(400).json({ ok: false, error: 'value required' });
    const note = (req.body.note || '').trim();
    const info = db.prepare(
      `INSERT INTO blacklist (kind, value, note, created_at) VALUES (?, ?, ?, ?)`
    ).run(kind, value, note, Date.now());
    res.json({ ok: true, id: info.lastInsertRowid });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});
router.delete('/blacklist/:id', (req, res) => {
  db.prepare(`DELETE FROM blacklist WHERE id = ?`).run(req.params.id);
  res.json({ ok: true });
});

// ---------- META ----------
router.get('/meta/countries', (req, res) => {
  res.json({ ok: true, rows: require('./countries.json') });
});

module.exports = router;
