'use strict';

const express = require('express');
const { db, nanoid } = require('./db');
const { evaluate, getIP } = require('./filter');

const router = express.Router();

const getFlowBySlug = db.prepare(`SELECT * FROM flows WHERE slug = ? AND status = 'active'`);
const getFlowByDomain = db.prepare(`SELECT * FROM flows WHERE domain = ? AND status = 'active' LIMIT 1`);
const getFlowById = db.prepare(`SELECT * FROM flows WHERE id = ?`);
const getVisit = db.prepare(`SELECT * FROM visits WHERE id = ?`);

const insertVisit = db.prepare(`
  INSERT INTO visits (id, flow_id, ts, ip, country, ua, device, os, browser, language, referrer, decision, reason, js_verified)
  VALUES (@id, @flow_id, @ts, @ip, @country, @ua, @device, @os, @browser, @language, @referrer, @decision, @reason, @js_verified)
`);

const setVisitJsVerified = db.prepare(`UPDATE visits SET js_verified = 1 WHERE id = ?`);

const countRecentClicksByIp = db.prepare(`
  SELECT COUNT(*) AS c FROM visits
  WHERE ip = ? AND flow_id = ? AND ts >= ?
`);

// ---------- helpers ----------

function renderMacros(str, ctx) {
  if (!str) return '';
  return str.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] == null ? '' : encodeURIComponent(String(ctx[k]))));
}

function normalizeHost(h) {
  if (!h) return '';
  return h.toLowerCase().split(':')[0].replace(/^www\./, '');
}

// ---------- SAFE page responses ----------

const DEFAULT_SAFE_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Welcome</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:680px;margin:60px auto;padding:0 24px;color:#2d3748;line-height:1.7}
h1{color:#2b6cb0} a{color:#2b6cb0}</style></head>
<body><h1>Welcome</h1>
<p>Thanks for visiting. This site shares articles about healthy living, productivity and mindful routines.</p>
<p>Check back soon for new content.</p></body></html>`;

function serveSafe(flow, res) {
  if (flow.safe_mode === 'url' && flow.safe_url) {
    return res.redirect(302, flow.safe_url);
  }
  if (flow.safe_mode === 'html' && flow.safe_html) {
    res.set('Cache-Control', 'no-store');
    return res.send(flow.safe_html);
  }
  res.set('Cache-Control', 'no-store');
  res.send(DEFAULT_SAFE_HTML);
}

function serveMoney(flow, visitor, visitId, req, res) {
  const ctx = {
    clickid: visitId,
    country: visitor.country || '',
    device: visitor.device,
    os: visitor.os,
    browser: visitor.browser,
    // raw query string sub params, common macros
    ...req.query,
  };

  if (flow.money_mode === 'html' && flow.money_html) {
    const html = (flow.money_html || '').replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx[k] == null ? '' : String(ctx[k])));
    res.set('Cache-Control', 'no-store');
    return res.send(html);
  }
  if (flow.money_mode === 'url' && flow.money_url) {
    const url = renderMacros(flow.money_url, ctx);
    return res.redirect(302, url);
  }
  res.status(500).send('Flow has no money destination configured');
}

// ---------- core handler ----------

function handle(flow, req, res) {
  // Rate limit by IP
  if (flow.limit_clicks_per_ip > 0) {
    const windowMs = (flow.limit_window_min || 60) * 60 * 1000;
    const since = Date.now() - windowMs;
    const ip = getIP(req);
    const { c } = countRecentClicksByIp.get(ip, flow.id, since) || { c: 0 };
    if (c >= flow.limit_clicks_per_ip) {
      // treat as safe (don't reveal money page)
      return serveSafe(flow, res);
    }
  }

  const res1 = evaluate(req, flow);
  const visitId = nanoid(12);
  const now = Date.now();

  insertVisit.run({
    id: visitId,
    flow_id: flow.id,
    ts: now,
    ip: res1.visitor.ip,
    country: res1.visitor.country,
    ua: res1.visitor.ua,
    device: res1.visitor.device,
    os: res1.visitor.os,
    browser: res1.visitor.browser,
    language: res1.visitor.language,
    referrer: res1.visitor.referrer,
    decision: res1.decision,
    reason: res1.reason,
    js_verified: 0,
  });

  if (res1.decision === 'safe') return serveSafe(flow, res);

  // If "require JS" is enabled and visitor hasn't verified yet, serve a tiny
  // interstitial that sets a cookie via JS and redirects. Bots without JS won't follow.
  if (flow.require_js && !req.cookies?.cl_js) {
    const target = req.originalUrl;
    res.set('Cache-Control', 'no-store');
    return res.send(`<!doctype html><html><head><meta charset="utf-8"></head><body>
<script>
document.cookie = 'cl_js=1; path=/; max-age=3600';
fetch('/px/${visitId}.gif').finally(function(){location.replace('${target}')});
</script>
<noscript>Please enable JavaScript to continue.</noscript>
</body></html>`);
  }

  return serveMoney(flow, res1.visitor, visitId, req, res);
}

// ---------- routes ----------

// Domain-based entry: GET / on a custom domain triggers its flow
router.use((req, res, next) => {
  if (req.method !== 'GET' || req.path !== '/') return next();
  const host = normalizeHost(req.headers.host);
  if (!host) return next();
  const flow = getFlowByDomain.get(host);
  if (!flow) return next();
  return handle(flow, req, res);
});

// Primary entry: /f/:slug
router.get('/f/:slug', (req, res) => {
  const flow = getFlowBySlug.get(req.params.slug);
  if (!flow) return res.status(404).send('Flow not found');
  return handle(flow, req, res);
});

// Backward-compat: /t/:slug
router.get('/t/:slug', (req, res) => {
  const flow = getFlowBySlug.get(req.params.slug);
  if (!flow) return res.status(404).send('Flow not found');
  return handle(flow, req, res);
});

// Browser-verification pixel (marks JS as verified)
router.get('/px/:visitId.gif', (req, res) => {
  const v = getVisit.get(req.params.visitId);
  if (v) setVisitJsVerified.run(req.params.visitId);
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

module.exports = router;
