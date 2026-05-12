'use strict';

const UAParser = require('ua-parser-js');

// ========= Known bot signatures =========
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

// Datacenter / hosting ASN-like IP prefixes (simplified startsWith check)
const DATACENTER_IP_PREFIXES = [
  '66.249.',   '64.233.',   '72.14.',    '216.239.',  // Google
  '157.55.',   '207.46.',   '40.77.',    '40.94.',    '13.66.',  // MS/Bing
  '199.16.',   '199.59.',   // Twitter
  '173.252.',  '31.13.',    '157.240.',  '69.63.',    // Facebook
  '5.255.',    '141.8.',    '100.43.',   // Yandex
  '180.76.',   // Baidu
  '3.',        '13.',       '18.',       '52.',       '54.',  // AWS (broad)
  '34.',       '35.',       '104.154.', '104.196.',   // GCP
  '20.',       '40.',       '51.',       '52.',       // Azure
  '167.99.',   '159.65.',   '165.227.',  '138.68.',   // DigitalOcean
  '51.75.',    '51.77.',    '51.89.',    '51.91.',    '51.195.', // OVH
  '95.216.',   '116.202.',  '135.181.',  '136.243.',  '142.132.', '168.119.', '188.34.', // Hetzner
  '45.33.',    '45.56.',    '45.79.',    '172.104.',  '172.105.',  // Linode
];

// Known datacenter ASNs via CF headers (string match)
const DATACENTER_ASNS = new Set([
  'AS15169','AS8075','AS16509','AS14618','AS14061','AS16276','AS24940',
  'AS63949','AS13335','AS32934','AS13238','AS45102','AS396982','AS14907',
  'AS209242','AS132203','AS212238','AS53831',
]);

// Heuristic: VPN-ish / proxy providers ASN
const VPN_ASNS = new Set([
  'AS9009',    // M247
  'AS20473',   // Choopa
  'AS53667',   // PONYNET
  'AS39351',   // 31173
  'AS200651',  // FlokiNET
]);

// ========= helpers =========

function getIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const raw = xf || req.ip || (req.connection && req.connection.remoteAddress) || '';
  // Strip the IPv4-mapped-IPv6 prefix ::ffff:  so that 193.235.207.157 shows
  // instead of ::ffff:193.235.207.157. Also normalise lowercase.
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
  for (const t of tokens) if (t && lc.includes(t.toLowerCase())) return t;
  return null;
}

function parseList(s) {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function parseLines(s) {
  if (!s) return [];
  return String(s).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
}

function ipInPrefixes(ip, prefixes) {
  if (!ip) return null;
  for (const p of prefixes) if (ip.startsWith(p)) return p;
  return null;
}

// ========= main decision function =========

/**
 * @returns {Object} { decision: 'money'|'safe', reason: string|null, visitor: {...} }
 */
function evaluate(req, flow) {
  const ua = req.headers['user-agent'] || '';
  const ip = getIP(req);
  const parser = new UAParser(ua);
  const uaRes = parser.getResult();

  const device = (uaRes.device.type || 'desktop').toLowerCase(); // mobile|desktop|tablet
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

  // If no flow, allow
  if (!flow) return { decision: 'money', reason: null, visitor };

  const block = (reason) => ({ decision: 'safe', reason, visitor });

  // 1. Empty UA
  if (flow.block_empty_ua && (!ua || ua.length < 10)) return block('empty_user_agent');

  // 2. Known bot tokens
  if (flow.block_bots) {
    const hit = matchAny(ua, BOT_UA_TOKENS);
    if (hit) return block(`bot:${hit}`);
  }

  // 3. Headless / automation
  if (flow.block_headless) {
    const hit = matchAny(ua, HEADLESS_TOKENS);
    if (hit) return block(`headless:${hit}`);
  }

  // 4. Missing Accept-Language
  if (flow.block_no_lang && !acceptLang) return block('no_language_header');

  // 5. Custom UA blacklist
  const uaBlack = parseLines(flow.blacklist_ua);
  if (uaBlack.length) {
    const hit = matchAny(ua, uaBlack);
    if (hit) return block(`custom_ua:${hit}`);
  }

  // 6. IP blacklist
  const ipBlack = parseLines(flow.blacklist_ips);
  if (ipBlack.includes(ip)) return block('ip_blacklisted');

  // 7. Datacenter IP prefixes
  if (flow.block_datacenter) {
    const hit = ipInPrefixes(ip, DATACENTER_IP_PREFIXES);
    if (hit) return block(`datacenter_ip:${hit}`);
    if (g.asn && DATACENTER_ASNS.has(g.asn)) return block(`datacenter_asn:${g.asn}`);
  }

  // 8. VPN / proxy ASN
  if (flow.block_vpn_proxy && g.asn && VPN_ASNS.has(g.asn)) {
    return block(`vpn_asn:${g.asn}`);
  }

  // 9. Require referrer
  if (flow.require_referrer && !referrer) return block('no_referrer');

  // 10. Country filter
  const countriesMode = flow.countries_mode || 'any';
  const countries = parseList(flow.countries);
  if (countriesMode === 'allow' && countries.length > 0) {
    if (!g.country || !countries.includes(g.country)) return block(`country_not_allowed:${g.country || '?'}`);
  } else if (countriesMode === 'block' && countries.length > 0) {
    if (g.country && countries.includes(g.country)) return block(`country_blocked:${g.country}`);
  }

  // 11. Device filter
  const devices = parseList(flow.devices);
  if (devices.length > 0 && !devices.includes(device)) return block(`device_not_allowed:${device}`);

  // 12. OS filter
  const oses = parseList(flow.os_list).map(x => x.toLowerCase());
  if (oses.length > 0 && !oses.some(x => os.includes(x))) return block(`os_not_allowed:${os || '?'}`);

  // 13. Browser filter
  const browsers = parseList(flow.browsers).map(x => x.toLowerCase());
  if (browsers.length > 0 && !browsers.some(x => browser.includes(x))) return block(`browser_not_allowed:${browser || '?'}`);

  // 14. Language filter
  const languages = parseList(flow.languages).map(x => x.toLowerCase());
  if (languages.length > 0 && !languages.includes(lang)) return block(`language_not_allowed:${lang || '?'}`);

  // 15. Schedule
  if (flow.schedule_enabled) {
    const now = new Date();
    const day = now.getDay() === 0 ? 7 : now.getDay(); // 1..7 (Mon..Sun)
    const days = parseList(flow.schedule_days);
    if (days.length && !days.includes(day)) return block('schedule_day');
    const hm = now.toTimeString().slice(0, 5); // HH:MM
    if (flow.schedule_from && flow.schedule_to) {
      if (hm < flow.schedule_from || hm > flow.schedule_to) return block('schedule_time');
    }
  }

  return { decision: 'money', reason: null, visitor };
}

module.exports = { evaluate, getIP };
