'use strict';

// Seed a demo cloaker rule, offer, landing and campaign so the tracker works out of the box.
const db = require('./index');

const now = Date.now();

const existing = db.prepare('SELECT COUNT(*) AS c FROM campaigns').get().c;
if (existing > 0) {
  console.log('DB already seeded, skipping.');
  process.exit(0);
}

const ruleId = db.prepare(`
  INSERT INTO cloaker_rules (name, allow_countries, block_countries, block_ips, block_asns, block_ua, allow_devices, require_referrer, block_vpn, block_bots, min_js_check, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`).run(
  'Default Safe',
  JSON.stringify([]),                    // allow all geos
  JSON.stringify([]),
  JSON.stringify([]),
  JSON.stringify(['AS15169','AS8075','AS16509']), // google, microsoft, amazon
  JSON.stringify(['bot','spider','crawler','facebookexternalhit','headless','phantom','slurp','ahrefs','semrush']),
  JSON.stringify(['mobile','desktop','tablet']),
  0, 1, 1, 0,
  now
).lastInsertRowid;

const whiteId = db.prepare(`
  INSERT INTO landings (name, kind, template, created_at) VALUES (?, ?, ?, ?)
`).run('White Blog', 'white', 'white_blog.html', now).lastInsertRowid;

const preId = db.prepare(`
  INSERT INTO landings (name, kind, template, created_at) VALUES (?, ?, ?, ?)
`).run('News Prelander', 'prelander', 'prelander_news.html', now).lastInsertRowid;

const offerId = db.prepare(`
  INSERT INTO offers (name, url, payout, country, created_at) VALUES (?, ?, ?, ?, ?)
`).run('Demo Offer', 'https://example.com/offer?clickid={clickid}&sub1={sub1}', 25.0, 'US', now).lastInsertRowid;

const campId = db.prepare(`
  INSERT INTO campaigns (slug, name, source, cost_model, cost_value, white_landing_id, money_offer_id, prelander_id, cloaker_rule_id, status, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)
`).run('demo', 'Demo Campaign', 'facebook', 'cpc', 0.25, whiteId, offerId, preId, ruleId, now).lastInsertRowid;

console.log('Seeded:', { ruleId, whiteId, preId, offerId, campId });
console.log('Try: http://localhost:3000/t/demo?sub1=test');
