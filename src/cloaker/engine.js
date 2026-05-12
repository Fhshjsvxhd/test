'use strict';

const UAParser = require('ua-parser-js');
const { BOT_UA_TOKENS, DEFAULT_BOT_ASNS, BOT_IP_PREFIXES } = require('./botlists');
const { geoFromHeaders } = require('./geo');

function getIP(req) {
  const xf = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xf || req.ip || req.connection?.remoteAddress || '';
}

function parseJSON(s, fallback) {
  try { return JSON.parse(s); } catch { return fallback; }
}

function matchesAnyToken(haystack, tokens) {
  if (!haystack) return null;
  const lc = haystack.toLowerCase();
  for (const t of tokens) if (t && lc.includes(t)) return t;
  return null;
}

function ipInPrefixes(ip, prefixes) {
  if (!ip) return null;
  for (const p of prefixes) if (ip.startsWith(p)) return p;
  return null;
}

/**
 * Evaluate cloaker rule against request.
 * Returns { cloak: boolean, reason: string|null, visitor: {...} }
 * cloak=true means visitor is suspicious/unwanted and should be sent to the white page.
 */
function evaluate(req, rule) {
  const ua = req.headers['user-agent'] || '';
  const ip = getIP(req);
  const parser = new UAParser(ua);
  const uaResult = parser.getResult();
  const device = (uaResult.device.type || 'desktop').toLowerCase();
  const os = uaResult.os.name || '';
  const browser = uaResult.browser.name || '';
  const referrer = req.headers['referer'] || req.headers['referrer'] || '';
  const geo = geoFromHeaders(req);
  const acceptLang = req.headers['accept-language'] || '';

  const visitor = {
    ip, ua, device, os, browser, referrer,
    country: geo.country, city: geo.city, asn: geo.asn,
    acceptLang,
  };

  // If no rule, let everyone through.
  if (!rule) return { cloak: false, reason: null, visitor };

  const allowCountries = parseJSON(rule.allow_countries, []);
  const blockCountries = parseJSON(rule.block_countries, []);
  const blockIps = parseJSON(rule.block_ips, []);
  const blockAsns = parseJSON(rule.block_asns, []);
  const blockUa = parseJSON(rule.block_ua, []);
  const allowDevices = parseJSON(rule.allow_devices, []);

  // 1. Known bot UA
  if (rule.block_bots) {
    const hit = matchesAnyToken(ua, BOT_UA_TOKENS);
    if (hit) return { cloak: true, reason: `bot_ua:${hit}`, visitor, isBot: true };
  }

  // 2. Custom UA block
  const customUa = matchesAnyToken(ua, blockUa);
  if (customUa) return { cloak: true, reason: `block_ua:${customUa}`, visitor, isBot: true };

  // 3. Empty or too-short UA => suspicious
  if (!ua || ua.length < 15) {
    return { cloak: true, reason: 'ua_missing', visitor, isBot: true };
  }

  // 4. Datacenter/crawler IP prefix
  const prefixHit = ipInPrefixes(ip, BOT_IP_PREFIXES);
  if (prefixHit) return { cloak: true, reason: `dc_ip:${prefixHit}`, visitor, isBot: true };

  // 5. Blocked ASN (built-in + user-provided)
  if (geo.asn) {
    if (rule.block_vpn && DEFAULT_BOT_ASNS.has(geo.asn)) {
      return { cloak: true, reason: `dc_asn:${geo.asn}`, visitor, isBot: true };
    }
    if (blockAsns.includes(geo.asn)) {
      return { cloak: true, reason: `block_asn:${geo.asn}`, visitor, isBot: true };
    }
  }

  // 6. Blocked IPs (exact)
  if (blockIps.includes(ip)) {
    return { cloak: true, reason: 'block_ip', visitor, isBot: false };
  }

  // 7. Geo filters
  if (geo.country) {
    if (blockCountries.includes(geo.country)) {
      return { cloak: true, reason: `geo_block:${geo.country}`, visitor, isBot: false };
    }
    if (allowCountries.length > 0 && !allowCountries.includes(geo.country)) {
      return { cloak: true, reason: `geo_not_allowed:${geo.country}`, visitor, isBot: false };
    }
  } else if (allowCountries.length > 0) {
    return { cloak: true, reason: 'geo_unknown', visitor, isBot: false };
  }

  // 8. Device targeting
  if (allowDevices.length > 0 && !allowDevices.includes(device)) {
    return { cloak: true, reason: `device:${device}`, visitor, isBot: false };
  }

  // 9. Require referrer (stop direct/curl)
  if (rule.require_referrer && !referrer) {
    return { cloak: true, reason: 'no_referrer', visitor, isBot: false };
  }

  // 10. Headless / automation signals
  if (/headless|phantom|electron/i.test(ua)) {
    return { cloak: true, reason: 'headless', visitor, isBot: true };
  }

  // 11. Missing Accept-Language is a strong bot signal
  if (!acceptLang) {
    return { cloak: true, reason: 'no_accept_language', visitor, isBot: true };
  }

  return { cloak: false, reason: null, visitor };
}

module.exports = { evaluate, getIP };
