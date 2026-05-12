'use strict';

const path = require('path');

// Load .env if present (tiny parser, no dep)
try {
  const fs = require('fs');
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    const txt = fs.readFileSync(envPath, 'utf8');
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  }
} catch (_) {}

module.exports = {
  port: parseInt(process.env.PORT || '3000', 10),
  adminToken: process.env.ADMIN_TOKEN || 'admin',
  dbPath: process.env.DB_PATH || path.join(__dirname, '..', 'data', 'adtrack.db'),
  trustProxy: process.env.TRUST_PROXY !== '0',
};
