'use strict';

const express = require('express');
const { db, nanoid } = require('./db');
const { evaluate, getIP } = require('./filter');
const config = require('./config');

const router = express.Router();

const getBySlug = db.prepare(`SELECT * FROM campaigns WHERE slug = ? AND status = 'active'`);
const getByApiKey = db.prepare(`SELECT * FROM campaigns WHERE api_key = ? AND status = 'active'`);
const getById = db.prepare(`SELECT * FROM campaigns WHERE id = ?`);
const insertVisit = db.prepare(`
  INSERT INTO visits (id, campaign_id, ts, ip, country, ua, device, os, browser, language, referrer, decision, reason, click_subid)
  VALUES (@id, @campaign_id, @ts, @ip, @country, @ua, @device, @os, @browser, @language, @referrer, @decision, @reason, @click_subid)
`);
const insertConv = db.prepare(`
  INSERT INTO conversions (click_id, campaign_id, ts, payout, status, tx_id, raw)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);
const getClickCamp = db.prepare(`SELECT campaign_id FROM visits WHERE id = ?`);

function loadBlacklists() {
  const rows = db.prepare(`SELECT kind, value FROM blacklist`).all();
  return {
    blacklistIPs: rows.filter(r => r.kind === 'ip').map(r => r.value),
    blacklistUA:  rows.filter(r => r.kind === 'ua').map(r => r.value),
  };
}

function renderMacros(str, ctx) {
  if (!str) return '';
  return str.replace(/\{(\w+)\}/g, (_, k) => (ctx[k] == null ? '' : encodeURIComponent(String(ctx[k]))));
}

// Append passed-through GET params to a URL.
function appendParams(url, params) {
  if (!url) return url;
  const keys = Object.keys(params || {});
  if (keys.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  const qs = keys.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  return url + sep + qs;
}

// ============== EXTERNAL CHECK ENDPOINT ==============
// Called from the user's own PHP script on their server to ask our API
// whether the visitor should see the money page or the safe page.
//
//   GET /api/check?key=<api_key>&ip=...&ua=...&referrer=...&lang=...
// Returns:
//   { ok: true, decision: 'money'|'safe', reason: string|null,
//     target_url: '...', target_mode: 'redirect'|'frame'|'include',
//     bot_url: '...' }
router.get('/api/check', (req, res) => {
  const key = req.query.key || '';
  const camp = getByApiKey.get(key);
  if (!camp) return res.status(401).json({ ok: false, error: 'invalid_key' });

  // build a fake request-like object forwarding headers from query
  const fakeReq = {
    headers: {
      'user-agent': req.query.ua || '',
      'accept-language': req.query.lang || '',
      'referer': req.query.referrer || '',
      'cf-ipcountry': (req.query.country || '').toUpperCase(),
      'x-forwarded-for': req.query.ip || getIP(req),
    },
    ip: req.query.ip || getIP(req),
    connection: {},
  };

  const { blacklistIPs, blacklistUA } = loadBlacklists();
  const d = evaluate(fakeReq, camp, { blacklistIPs, blacklistUA });

  // log the visit
  const id = nanoid(12);
  insertVisit.run({
    id, campaign_id: camp.id, ts: Date.now(),
    ip: d.visitor.ip, country: d.visitor.country, ua: d.visitor.ua,
    device: d.visitor.device, os: d.visitor.os, browser: d.visitor.browser,
    language: d.visitor.language, referrer: d.visitor.referrer,
    decision: d.decision, reason: d.reason,
    click_subid: req.query.subid || null,
  });

  // Build final target url with tracked params if enabled.
  let finalTarget = camp.target_url || '';
  if (camp.track_params) {
    // forward any extra query params (except our internal ones)
    const skip = new Set(['key', 'ip', 'ua', 'referrer', 'lang', 'country', 'subid']);
    const pass = {};
    for (const k of Object.keys(req.query)) if (!skip.has(k)) pass[k] = req.query[k];
    finalTarget = appendParams(finalTarget, pass);
  }

  res.json({
    ok: true,
    decision: d.decision,
    reason: d.reason,
    target_url: finalTarget,
    target_mode: camp.target_mode || 'redirect',
    bot_url: camp.bot_url || '',
    click_id: id,
  });
});

// ============== HOSTED TRACKER (optional) ==============
// GET /c/:slug – runs the tracker directly on this server, for users
// who prefer not to host the PHP themselves.
function handleHosted(camp, req, res) {
  const { blacklistIPs, blacklistUA } = loadBlacklists();
  const d = evaluate(req, camp, { blacklistIPs, blacklistUA });
  const id = nanoid(12);
  insertVisit.run({
    id, campaign_id: camp.id, ts: Date.now(),
    ip: d.visitor.ip, country: d.visitor.country, ua: d.visitor.ua,
    device: d.visitor.device, os: d.visitor.os, browser: d.visitor.browser,
    language: d.visitor.language, referrer: d.visitor.referrer,
    decision: d.decision, reason: d.reason,
    click_subid: camp.conversion_param ? (req.query[camp.conversion_param] || null) : null,
  });
  if (d.decision === 'safe') {
    if (camp.bot_url) return res.redirect(302, camp.bot_url);
    return res.status(200).send('<!doctype html><html><head><title>Welcome</title></head><body><h1>Welcome</h1></body></html>');
  }
  let url = camp.target_url || '';
  if (!url) return res.status(500).send('No target URL configured');
  if (camp.track_params) {
    const pass = {}; for (const k of Object.keys(req.query)) pass[k] = req.query[k];
    url = appendParams(url, pass);
  }
  res.redirect(302, url);
}

router.get('/c/:slug', (req, res) => {
  const camp = getBySlug.get(req.params.slug);
  if (!camp) return res.status(404).send('Campaign not found');
  return handleHosted(camp, req, res);
});

// ============== CONVERSION POSTBACK ==============
// Pattern expected:  /v1/postback?clickid=XXX&payout=10&status=approved&tx=123
router.get('/v1/postback', (req, res) => {
  const clickid = req.query.clickid || req.query.click_id || req.query.subid;
  if (!clickid) return res.status(400).json({ ok: false, error: 'clickid required' });
  const row = getClickCamp.get(clickid);
  if (!row) return res.status(404).json({ ok: false, error: 'click not found' });
  const payout = parseFloat(req.query.payout || '0') || 0;
  const status = (req.query.status || 'approved').toLowerCase();
  const tx = req.query.tx || null;
  insertConv.run(clickid, row.campaign_id, Date.now(), payout, status, tx, JSON.stringify(req.query));
  res.json({ ok: true });
});

// ============== DOWNLOAD PHP ==============
// Generates an unbranded PHP cloaker that uses the /api/check endpoint.
router.get('/api/campaigns/:id/download.php', (req, res) => {
  // require admin token here too (allow both header or query)
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== config.adminToken) {
    return res.status(401).send('unauthorized');
  }
  const camp = getById.get(req.params.id);
  if (!camp) return res.status(404).send('not found');

  // user points the script to THIS server, so figure out our base URL
  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  const php = buildPhpScript({
    base, apiKey: camp.api_key,
    conversionParam: camp.conversion_param || 'clickid',
  });
  res.set('Content-Type', 'application/x-httpd-php');
  res.set('Content-Disposition', `attachment; filename="cloak.php"`);
  res.send(php);
});

function buildPhpScript(cfg) {
  // Chosen to look like a generic cloaker script; no product names
  // or service references appear anywhere.
  return `<?php
/**
 * Traffic filter. Drop into your web root and rename as you wish.
 * Also drop a 'bot.html' (or any safe page) next to it.
 */

$ENDPOINT    = ${phpStr(cfg.base + '/api/check')};
$API_KEY     = ${phpStr(cfg.apiKey)};
$CONV_PARAM  = ${phpStr(cfg.conversionParam)};
$BOT_PAGE    = __DIR__ . '/bot.html'; // local fallback safe page
$TIMEOUT_S   = 3;

function client_ip() {
  foreach (['HTTP_CF_CONNECTING_IP','HTTP_X_FORWARDED_FOR','HTTP_X_REAL_IP','REMOTE_ADDR'] as $h) {
    if (!empty($_SERVER[$h])) {
      $ip = explode(',', $_SERVER[$h])[0];
      return trim(preg_replace('/^::ffff:/', '', $ip));
    }
  }
  return '';
}

$ip       = client_ip();
$ua       = isset($_SERVER['HTTP_USER_AGENT']) ? $_SERVER['HTTP_USER_AGENT'] : '';
$lang     = isset($_SERVER['HTTP_ACCEPT_LANGUAGE']) ? $_SERVER['HTTP_ACCEPT_LANGUAGE'] : '';
$referer  = isset($_SERVER['HTTP_REFERER']) ? $_SERVER['HTTP_REFERER'] : '';
$country  = isset($_SERVER['HTTP_CF_IPCOUNTRY']) ? $_SERVER['HTTP_CF_IPCOUNTRY'] : '';
$subid    = isset($_GET[$CONV_PARAM]) ? $_GET[$CONV_PARAM] : '';

// Forward every incoming GET parameter so the target URL keeps them.
$passthrough = [];
foreach ($_GET as $k => $v) { $passthrough[$k] = is_array($v) ? implode(',', $v) : $v; }

$query = array_merge($passthrough, [
  'key'      => $API_KEY,
  'ip'       => $ip,
  'ua'       => $ua,
  'lang'     => $lang,
  'referrer' => $referer,
  'country'  => $country,
  'subid'    => $subid,
]);
$url = $ENDPOINT . '?' . http_build_query($query);

$ch = curl_init($url);
curl_setopt_array($ch, [
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_TIMEOUT        => $TIMEOUT_S,
  CURLOPT_CONNECTTIMEOUT => $TIMEOUT_S,
  CURLOPT_FOLLOWLOCATION => false,
]);
$body = curl_exec($ch);
$err  = curl_error($ch);
curl_close($ch);

$data = $body ? json_decode($body, true) : null;

if (!$data || empty($data['ok'])) {
  // API failure: be safe, show the bot page.
  show_bot();
  exit;
}

if (!empty($data['decision']) && $data['decision'] === 'money' && !empty($data['target_url'])) {
  $target = $data['target_url'];
  $mode   = isset($data['target_mode']) ? $data['target_mode'] : 'redirect';

  if ($mode === 'frame') {
    echo '<!doctype html><html><head><meta charset="utf-8"><title></title>';
    echo '<style>html,body,iframe{margin:0;padding:0;height:100%;width:100%;border:0}</style>';
    echo '</head><body><iframe src="' . htmlspecialchars($target, ENT_QUOTES) . '"></iframe></body></html>';
  } elseif ($mode === 'include') {
    // Proxy fetch and stream through
    $ctx = stream_context_create(['http' => [
      'timeout' => $TIMEOUT_S + 2,
      'header'  => "User-Agent: {$ua}\\r\\n",
    ]]);
    $html = @file_get_contents($target, false, $ctx);
    if ($html !== false) {
      echo $html;
    } else {
      header('Location: ' . $target, true, 302);
    }
  } else {
    // default redirect
    header('Location: ' . $target, true, 302);
  }
  exit;
}

// fallback: show the bot/safe page
show_bot();

function show_bot() {
  global $BOT_PAGE, $data;
  if (!empty($data['bot_url']) && filter_var($data['bot_url'], FILTER_VALIDATE_URL)) {
    header('Location: ' . $data['bot_url'], true, 302);
    exit;
  }
  if (file_exists($BOT_PAGE)) {
    readfile($BOT_PAGE);
  } else {
    echo '<!doctype html><html><head><title>Welcome</title></head><body>';
    echo '<h1>Welcome</h1><p>Thanks for visiting.</p></body></html>';
  }
}
`;
}

function phpStr(s) {
  const safe = String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${safe}'`;
}

module.exports = router;
