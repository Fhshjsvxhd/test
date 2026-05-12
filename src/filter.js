'use strict';

const UAParser = require('ua-parser-js');

const BOT_UA_TOKENS = [
  'bot', 'spider', 'crawler', 'crawling', 'scraper', 'slurp',
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot', 'whatsapp',
  'telegrambot', 'discordbot', 'pinterest', 'yandex', 'baidu', 'duckduckbot',
  'applebot', 'googlebot', 'bingbot', 'mediapartners', 'adsbot',
  'ahrefs', 'semrush', 'mj12bot', 'dotbot', 'petalbot', 'bytespider',
  'archive.org_bot', 'ia_archiver', 'curl', 'wget', 'python-requests',
  'go-http-client', 'okhttp', 'java/', 'libwww-perl', 'httpclient',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'newrelic', 'monitis', 'check_http',
];

const HEADLESS_TOKENS = [
  'headless', 'phantomjs', 'selenium', 'puppeteer', 'playwright', 'cypress',
  'electron', 'nightmare', 'slimerjs',
];

const DATACENTER_IP_PREFIXES = [
  '66.249.', '64.233.', '72.14.', '216.239.',
  '157.55.', '207.46.', '40.77.', '40.94.', '13.66.',
  '199.16.', '199.59.',
  '173.252.', '31.13.', '157.240.', '69.63.',
  '5.255.', '141.8.', '100.43.', '180.76.',
];

const DATACENTER_ASNS = new Set([
  'AS15169','AS8075','AS16509','AS14618','AS14061','AS16276','AS24940',
  'AS63949','AS13335','AS32934','AS13238','AS45102','AS396982','AS14907',
]);

const VPN_ASNS = new Set([
  'AS9009','AS20473','AS53667','AS39351','AS200651',
]);

function getIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xf || req.ip || (req.connection && req.connection.remoteAddress) || '';
  return raw.replace(/^::ffff:/i, '').trim();
}

function geo(req) {
  const h = req.headers;
  return {
    country: ((h['cf-ipcountry'] || h['x-country'] || h['x-vercel-ip-country'] || '') + '').toUpperCase() || null,
    asn: ((h['x-asn'] || h['cf-asn'] || '') + '').toUpperCase() || null,
  };
}

function matchAny(haystack, tokens) {
  if (!haystack) return null;
  const lc = haystack.toLowerCase();
  for (const t of tokens) if (t && lc.includes(String(t).toLowerCase())) return t;
  return null;
}

function parseList(s) {
  if (!s) return [];
  try { const v = JSON.parse(s); return Array.isArray(v) ? v : []; } catch { return []; }
}

function ipInPrefixes(ip, prefixes) {
  if (!ip) return null;
  for (const p of prefixes) if (ip.startsWith(p)) return p;
  return null;
}

/**
 * @param {Object} req  Express request
 * @param {Object} camp Campaign row
 * @param {Object} [opts] Optional { blacklistIPs, blacklistUA }
 */
function evaluate(req, camp, opts) {
  opts = opts || {};
  const blacklistIPs = opts.blacklistIPs || [];
  const blacklistUA = opts.blacklistUA || [];

  const ua = req.headers['user-agent'] || '';
  const ip = getIP(req);
  const parser = new UAParser(ua);
  const uaRes = parser.getResult();
  const device = (uaRes.device.type || 'desktop').toLowerCase();
  const os = (uaRes.os.name || '').toLowerCase();
  const browser = (uaRes.browser.name || '').toLowerCase();
  const referrer = req.headers['referer'] || req.headers['referrer'] || '';
  const acceptLang = req.headers['accept-language'] || '';
  const lang = (acceptLang.split(',')[0] || '').toLowerCase().split('-')[0];
  const g = geo(req);

  const visitor = {
    ip, ua, device, os, browser,
    country: g.country, asn: g.asn,
    referrer, language: lang,
  };

  if (!camp) return { decision: 'money', reason: null, visitor };

  const block = (reason) => ({ decision: 'safe', reason, visitor });

  // 1. empty UA
  if (camp.block_empty_ua && (!ua || ua.length < 10)) return block('empty_user_agent');

  // 2. bot UA
  if (camp.block_bots) {
    const hit = matchAny(ua, BOT_UA_TOKENS);
    if (hit) return block(`bot:${hit}`);
  }

  // 3. headless
  if (camp.block_headless) {
    const hit = matchAny(ua, HEADLESS_TOKENS);
    if (hit) return block(`headless:${hit}`);
  }

  // 4. no accept-lang
  if (camp.block_no_lang && !acceptLang) return block('no_language_header');

  // 5. global blacklists
  if (blacklistUA.length) {
    const hit = matchAny(ua, blacklistUA);
    if (hit) return block(`custom_ua:${hit}`);
  }
  if (blacklistIPs.includes(ip)) return block('ip_blacklisted');

  // 6. datacenter
  if (camp.block_datacenter) {
    const hit = ipInPrefixes(ip, DATACENTER_IP_PREFIXES);
    if (hit) return block(`datacenter_ip:${hit}`);
    if (g.asn && DATACENTER_ASNS.has(g.asn)) return block(`datacenter_asn:${g.asn}`);
  }

  // 7. vpn / proxy
  if (camp.block_vpn_proxy && !camp.disable_extra_bl && g.asn && VPN_ASNS.has(g.asn)) {
    return block(`vpn_asn:${g.asn}`);
  }

  // 8. referrer
  if (camp.require_referrer && !referrer) return block('no_referrer');

  // 9. geo
  const geos = parseList(camp.geo);
  if (geos.length > 0 && g.country) {
    if (camp.geo_mode === 'block' && geos.includes(g.country)) return block(`country_blocked:${g.country}`);
    if (camp.geo_mode !== 'block' && !geos.includes(g.country)) return block(`country_not_allowed:${g.country}`);
  } else if (geos.length > 0 && !g.country && camp.geo_mode !== 'block') {
    return block('country_unknown');
  }

  // 10. language
  if (camp.language && camp.language.trim() && lang !== camp.language.toLowerCase()) {
    return block(`language_not_allowed:${lang || '?'}`);
  }

  return { decision: 'money', reason: null, visitor };
}

module.exports = { evaluate, getIP };
