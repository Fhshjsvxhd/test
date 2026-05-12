'use strict';

// Known bot/crawler user-agent tokens (case-insensitive substring match)
exports.BOT_UA_TOKENS = [
  'bot', 'spider', 'crawler', 'crawling', 'scraper', 'slurp', 'bingpreview',
  'facebookexternalhit', 'facebot', 'twitterbot', 'linkedinbot', 'whatsapp',
  'telegrambot', 'discordbot', 'pinterest', 'yandex', 'baidu', 'duckduckbot',
  'applebot', 'googlebot', 'mediapartners', 'adsbot', 'adsbot-google',
  'headless', 'phantomjs', 'selenium', 'puppeteer', 'playwright', 'cypress',
  'ahrefs', 'semrush', 'mj12bot', 'dotbot', 'petalbot', 'bytespider',
  'archive.org_bot', 'ia_archiver', 'curl', 'wget', 'python-requests',
  'go-http-client', 'okhttp', 'java/', 'libwww-perl', 'httpclient',
  'lighthouse', 'pagespeed', 'gtmetrix', 'pingdom', 'uptimerobot',
  'newrelic', 'monitis', 'siteuptime', 'check_http'
];

// Known datacenter / crawler ASN numbers (strings)
// (sample, extendable from UI)
exports.DEFAULT_BOT_ASNS = new Set([
  'AS15169',  // Google
  'AS8075',   // Microsoft / Bing
  'AS16509',  // Amazon AWS
  'AS14618',  // Amazon
  'AS14061',  // DigitalOcean
  'AS16276',  // OVH
  'AS24940',  // Hetzner
  'AS63949',  // Linode / Akamai
  'AS13335',  // Cloudflare
  'AS32934',  // Facebook
  'AS13238',  // Yandex
  'AS45102',  // Alibaba
  'AS396982', // Google Cloud
]);

// CIDR-ish prefixes of well-known crawler datacenters
// We only do a fast startsWith check for IPv4.
exports.BOT_IP_PREFIXES = [
  '66.249.',    // Googlebot
  '64.233.',
  '72.14.',
  '216.239.',
  '157.55.',    // Bingbot
  '207.46.',
  '40.77.',
  '40.94.',
  '13.66.',
  '199.16.',    // Twitter
  '199.59.',
  '173.252.',   // Facebook
  '31.13.',
  '157.240.',
  '5.255.',     // Yandex
  '141.8.',
  '100.43.',
  '180.76.',    // Baidu
];
