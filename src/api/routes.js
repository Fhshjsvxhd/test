'use strict';

const express = require('express');
const db = require('../db');
const config = require('../config');

const router = express.Router();

// ---------- auth ----------
router.use((req, res, next) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== config.adminToken) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  next();
});

// ---------- OVERVIEW / STATS ----------
router.get('/stats/overview', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const totals = db.prepare(`
    SELECT
      COUNT(*)                                    AS clicks,
      SUM(CASE WHEN cloaked = 0 THEN 1 ELSE 0 END) AS real_clicks,
      SUM(CASE WHEN cloaked = 1 THEN 1 ELSE 0 END) AS cloaked,
      SUM(CASE WHEN is_bot  = 1 THEN 1 ELSE 0 END) AS bots,
      COALESCE(SUM(cost), 0)                      AS cost
    FROM clicks WHERE ts >= ?
  `).get(since);

  const conv = db.prepare(`
    SELECT COUNT(*) AS count, COALESCE(SUM(payout), 0) AS revenue
    FROM conversions WHERE ts >= ?
  `).get(since);

  const profit = (conv.revenue || 0) - (totals.cost || 0);
  const cr = totals.real_clicks > 0 ? (conv.count / totals.real_clicks) * 100 : 0;
  const roi = totals.cost > 0 ? (profit / totals.cost) * 100 : 0;

  res.json({
    ok: true,
    since,
    clicks: totals.clicks || 0,
    real: totals.real_clicks || 0,
    cloaked: totals.cloaked || 0,
    bots: totals.bots || 0,
    conversions: conv.count || 0,
    revenue: +(conv.revenue || 0).toFixed(2),
    cost: +(totals.cost || 0).toFixed(2),
    profit: +profit.toFixed(2),
    cr: +cr.toFixed(2),
    roi: +roi.toFixed(2),
  });
});

// Hourly stats for sparkline/chart
router.get('/stats/timeline', (req, res) => {
  const hours = Math.min(parseInt(req.query.hours || '24', 10), 168);
  const since = Date.now() - hours * 3600 * 1000;
  const bucketMs = 3600 * 1000;
  const rows = db.prepare(`
    SELECT (ts / ${bucketMs}) * ${bucketMs} AS bucket,
           COUNT(*) AS clicks,
           SUM(CASE WHEN cloaked=1 THEN 1 ELSE 0 END) AS cloaked
    FROM clicks WHERE ts >= ?
    GROUP BY bucket ORDER BY bucket
  `).all(since);
  res.json({ ok: true, buckets: rows });
});

// Per-campaign breakdown
router.get('/stats/campaigns', (req, res) => {
  const since = parseInt(req.query.since || (Date.now() - 24 * 3600 * 1000), 10);
  const rows = db.prepare(`
    SELECT c.id, c.slug, c.name, c.status,
           COUNT(cl.id) AS clicks,
           SUM(CASE WHEN cl.cloaked = 0 THEN 1 ELSE 0 END) AS real_clicks,
           SUM(CASE WHEN cl.cloaked = 1 THEN 1 ELSE 0 END) AS cloaked,
           COALESCE(SUM(cl.cost), 0) AS cost,
           (SELECT COUNT(*) FROM conversions co JOIN clicks cc ON co.click_id = cc.id
             WHERE cc.campaign_id = c.id AND co.ts >= ?) AS conversions,
           (SELECT COALESCE(SUM(co.payout),0) FROM conversions co JOIN clicks cc ON co.click_id = cc.id
             WHERE cc.campaign_id = c.id AND co.ts >= ?) AS revenue
    FROM campaigns c
    LEFT JOIN clicks cl ON cl.campaign_id = c.id AND cl.ts >= ?
    GROUP BY c.id ORDER BY clicks DESC
  `).all(since, since, since);
  res.json({ ok: true, rows });
});

// Real-time feed
router.get('/clicks/recent', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '50', 10), 500);
  const rows = db.prepare(`
    SELECT cl.id, cl.ts, cl.campaign_id, c.slug, c.name AS campaign_name,
           cl.ip, cl.country, cl.device, cl.os, cl.browser,
           cl.cloaked, cl.cloak_reason, cl.is_bot, cl.sub1
    FROM clicks cl JOIN campaigns c ON c.id = cl.campaign_id
    ORDER BY cl.ts DESC LIMIT ?
  `).all(limit);
  res.json({ ok: true, rows });
});

// ---------- GENERIC CRUD HELPERS ----------
function crud(table, fields, { orderBy = 'id DESC' } = {}) {
  const r = express.Router();

  r.get('/', (req, res) => {
    const rows = db.prepare(`SELECT * FROM ${table} ORDER BY ${orderBy}`).all();
    res.json({ ok: true, rows });
  });

  r.get('/:id', (req, res) => {
    const row = db.prepare(`SELECT * FROM ${table} WHERE id = ?`).get(req.params.id);
    if (!row) return res.status(404).json({ ok: false });
    res.json({ ok: true, row });
  });

  r.post('/', (req, res) => {
    const data = {};
    for (const f of fields) data[f] = req.body[f] ?? null;
    data.created_at = Date.now();
    const cols = Object.keys(data);
    const stmt = db.prepare(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(c => '@' + c).join(',')})`
    );
    const info = stmt.run(data);
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  r.put('/:id', (req, res) => {
    const data = {};
    for (const f of fields) if (f in req.body) data[f] = req.body[f];
    if (Object.keys(data).length === 0) return res.json({ ok: true });
    const sets = Object.keys(data).map(k => `${k} = @${k}`).join(', ');
    data.id = req.params.id;
    db.prepare(`UPDATE ${table} SET ${sets} WHERE id = @id`).run(data);
    res.json({ ok: true });
  });

  r.delete('/:id', (req, res) => {
    db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(req.params.id);
    res.json({ ok: true });
  });

  return r;
}

router.use('/campaigns', crud('campaigns', [
  'slug', 'name', 'source', 'cost_model', 'cost_value',
  'white_landing_id', 'money_offer_id', 'prelander_id',
  'cloaker_rule_id', 'status',
]));

router.use('/offers', crud('offers', ['name', 'url', 'payout', 'country']));

router.use('/landings', crud('landings', ['name', 'kind', 'template']));

router.use('/cloaker-rules', crud('cloaker_rules', [
  'name', 'allow_countries', 'block_countries', 'block_ips', 'block_asns',
  'block_ua', 'allow_devices', 'require_referrer', 'block_vpn',
  'block_bots', 'min_js_check',
]));

// List available landing templates from disk
router.get('/templates', (req, res) => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', '..', 'landings');
  let files = [];
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.html')); } catch {}
  res.json({ ok: true, templates: files });
});

module.exports = router;
