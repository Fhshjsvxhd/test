'use strict';

// Lightweight geo lookup that uses CF-IPCountry / X-Country headers if present
// (for real production plug in maxmind mmdb or ipinfo).
function geoFromHeaders(req) {
  const h = req.headers;
  return {
    country: (h['cf-ipcountry'] || h['x-country'] || h['x-vercel-ip-country'] || '').toUpperCase() || null,
    city: h['x-city'] || h['cf-ipcity'] || null,
    asn: (h['x-asn'] || h['cf-asn'] || '').toString().toUpperCase() || null,
  };
}

module.exports = { geoFromHeaders };
