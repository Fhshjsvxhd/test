'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { nanoid } = require('nanoid');
const db = require('../db');
const { evaluate } = require('../cloaker/engine');
const { render } = require('./tokens');

const router = express.Router();

const LANDINGS_DIR = path.join(__dirname, '..', '..', 'landings');

// -------- prepared statements --------
const getCampaignBySlug = db.prepare('SELECT * FROM campaigns WHERE slug = ? AND status = ?');
const getCampaignByDomain = db.prepare("SELECT * FROM campaigns WHERE domain = ? AND status = 'active' LIMIT 1");
const getRule = db.prepare('SELECT * FROM cloaker_rules WHERE id = ?');
const getLanding = db.prepare('SELECT * FROM landings WHERE id = ?');
const getOffer = db.prepare('SELECT * FROM offers WHERE id = ?');
const getClick = db.prepare('SELECT * FROM clicks WHERE id = ?');

const insertClick = db.prepare(`
  INSERT INTO clicks
    (id, campaign_id, ts, ip, country, city, ua, device, os, browser, referrer,
     sub1, sub2, sub3, sub4, sub5, cloaked, cloak_reason, is_bot, fingerprint, destination, cost)
  VALUES (@id, @campaign_id, @ts, @ip, @country, @city, @ua, @device, @os, @browser, @referrer,
          @sub1, @sub2, @sub3, @sub4, @sub5, @cloaked, @cloak_reason, @is_bot, @fingerprint, @destination, @cost)
`);

const insertEvent = db.prepare(`
  INSERT INTO events (click_id, kind, ts, data) VALUES (?, ?, ?, ?)
`);

const insertConv = db.prepare(`
  INSERT INTO conversions (click_id, ts, payout, status, tx_id, raw) VALUES (?, ?, ?, ?, ?, ?)
`);

// ---------- helpers ----------
function readTemplate(filename) {
  const p = path.join(LANDINGS_DIR, filename);
  if (!fs.existsSync(p)) return null;
  return fs.readFileSync(p, 'utf8');
}

function renderLanding(html, ctx) {
  return html.replace(/\{\{(\w+)\}\}/g, (_, k) => (ctx[k] == null ? '' : String(ctx[k])));
}

function normalizeHost(h) {
  if (!h) return '';
  return h.toLowerCase().split(':')[0].replace(/^www\./, '');
}

// ---------- core click processing ----------
function handleClick(camp, req, res) {
  const rule = camp.cloaker_rule_id ? getRule.get(camp.cloaker_rule_id) : null;
  const decision = evaluate(req, rule);

  const clickid = nanoid(12);
  const now = Date.now();

  let cost = 0;
  if (camp.cost_model === 'cpc') cost = camp.cost_value || 0;

  const click = {
    id: clickid,
    campaign_id: camp.id,
    ts: now,
    ip: decision.visitor.ip,
    country: decision.visitor.country,
    city: decision.visitor.city,
    ua: decision.visitor.ua,
    device: decision.visitor.device,
    os: decision.visitor.os,
    browser: decision.visitor.browser,
    referrer: decision.visitor.referrer,
    sub1: req.query.sub1 || null,
    sub2: req.query.sub2 || null,
    sub3: req.query.sub3 || null,
    sub4: req.query.sub4 || null,
    sub5: req.query.sub5 || null,
    cloaked: decision.cloak ? 1 : 0,
    cloak_reason: decision.reason,
    is_bot: decision.isBot ? 1 : 0,
    fingerprint: null,
    destination: '',
    cost,
  };

  // Cloaked visitors get the white page inline (no redirect).
  if (decision.cloak) {
    const white = camp.white_landing_id ? getLanding.get(camp.white_landing_id) : null;
    click.destination = white ? `white:${white.template}` : 'white:fallback';
    insertClick.run(click);

    let html = white ? readTemplate(white.template) : null;
    if (!html) html = defaultWhiteHtml();
    res.set('Cache-Control', 'no-store');
    return res.send(renderLanding(html, {
      clickid, campaign: camp.name, country: click.country || '',
    }));
  }

  // Real traffic with prelander
  if (camp.prelander_id) {
    const pre = getLanding.get(camp.prelander_id);
    if (pre) {
      click.destination = `prelander:${pre.template}`;
      insertClick.run(click);

      let html = readTemplate(pre.template) || defaultPrelanderHtml();
      const offer = camp.money_offer_id ? getOffer.get(camp.money_offer_id) : null;
      const goUrl = `/go/${clickid}`;
      res.set('Cache-Control', 'no-store');
      return res.send(renderLanding(html, {
        clickid, goUrl, offerName: offer?.name || '', campaign: camp.name,
      }));
    }
  }

  // Direct redirect to money offer
  const offer = camp.money_offer_id ? getOffer.get(camp.money_offer_id) : null;
  if (!offer) {
    click.destination = 'noop';
    insertClick.run(click);
    return res.status(500).send('Campaign has no offer');
  }
  const finalUrl = render(offer.url, { ...click, clickid });
  click.destination = finalUrl;
  insertClick.run(click);
  res.redirect(302, finalUrl);
}

// ---------- domain-based entry (root of a custom domain) ----------
// If the host on the incoming request matches a campaign.domain, treat it as a click.
router.use((req, res, next) => {
  // Only root path for domain routing, and only GET.
  if (req.method !== 'GET' || req.path !== '/') return next();

  const host = normalizeHost(req.headers.host);
  if (!host) return next();

  // Ignore requests to the admin dashboard or known paths (none here; root only).
  const camp = getCampaignByDomain.get(host);
  if (!camp) return next();

  return handleClick(camp, req, res);
});

// ---------- MAIN CLICK HANDLER (slug mode) ----------
// GET /t/:slug?sub1=...&sub2=...
router.get('/t/:slug', (req, res) => {
  const camp = getCampaignBySlug.get(req.params.slug, 'active');
  if (!camp) return res.status(404).send('Campaign not found');
  return handleClick(camp, req, res);
});

// ---------- Prelander -> money ----------
router.get('/go/:clickid', (req, res) => {
  const click = getClick.get(req.params.clickid);
  if (!click) return res.status(404).send('Click not found');
  if (click.cloaked) return res.status(403).send('Blocked');

  const camp = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(click.campaign_id);
  const offer = camp?.money_offer_id ? getOffer.get(camp.money_offer_id) : null;
  if (!offer) return res.status(500).send('No offer');

  const url = render(offer.url, { ...click, clickid: click.id });
  db.prepare('UPDATE clicks SET destination = ? WHERE id = ?').run(url, click.id);
  insertEvent.run(click.id, 'lp_click', Date.now(), null);
  res.redirect(302, url);
});

// ---------- JS pixel / browser ping ----------
router.get('/px/:clickid.gif', (req, res) => {
  const click = getClick.get(req.params.clickid);
  if (click) insertEvent.run(click.id, 'js_ping', Date.now(), JSON.stringify(req.query));
  res.set('Content-Type', 'image/gif');
  res.set('Cache-Control', 'no-store');
  res.end(Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64'));
});

// ---------- S2S postback ----------
router.get('/postback', (req, res) => {
  const clickid = req.query.clickid;
  if (!clickid) return res.status(400).json({ ok: false, error: 'clickid required' });
  const click = getClick.get(clickid);
  if (!click) return res.status(404).json({ ok: false, error: 'click not found' });
  const payout = parseFloat(req.query.payout || '0') || 0;
  const status = (req.query.status || 'approved').toLowerCase();
  const tx = req.query.tx || null;
  insertConv.run(clickid, Date.now(), payout, status, tx, JSON.stringify(req.query));
  res.json({ ok: true });
});

// ---------- fallbacks ----------
function defaultWhiteHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Healthy Living Blog</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:720px;margin:40px auto;padding:0 20px;color:#222}h1{color:#1a7}</style>
</head><body><h1>10 Tips for a Healthier Morning Routine</h1>
<p>Welcome to our lifestyle blog. Here we share tips about nutrition, exercise and mindfulness.</p>
<p>Starting your day with a glass of water, stretching for five minutes, and eating a balanced breakfast can change your energy levels dramatically.</p>
<p>Stay tuned for more articles.</p></body></html>`;
}

function defaultPrelanderHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><title>Continue</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui;max-width:560px;margin:40px auto;padding:0 20px;text-align:center}
.btn{display:inline-block;background:#2563eb;color:#fff;padding:14px 28px;border-radius:10px;text-decoration:none;font-weight:600}</style>
</head><body><h2>You qualify!</h2><p>Tap below to continue to your offer.</p>
<p><a class="btn" href="{{goUrl}}">Continue &rarr;</a></p>
<img src="/px/{{clickid}}.gif" width="1" height="1" alt=""></body></html>`;
}

module.exports = router;
