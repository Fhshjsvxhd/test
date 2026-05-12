'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS flows (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  domain          TEXT DEFAULT '',
  status          TEXT DEFAULT 'active',

  -- destinations
  safe_mode       TEXT DEFAULT 'url',     -- url | html
  safe_url        TEXT DEFAULT '',        -- external safe site to 302 to (or iframe)
  safe_html       TEXT DEFAULT '',        -- inline HTML returned to bots
  money_mode      TEXT DEFAULT 'url',     -- url | html
  money_url       TEXT DEFAULT '',        -- offer URL (supports macros)
  money_html      TEXT DEFAULT '',        -- inline HTML for real users

  -- filters (all human-friendly booleans and JSON arrays)
  block_bots      INTEGER DEFAULT 1,
  block_datacenter INTEGER DEFAULT 1,
  block_vpn_proxy INTEGER DEFAULT 1,
  block_headless  INTEGER DEFAULT 1,
  require_js      INTEGER DEFAULT 0,
  require_referrer INTEGER DEFAULT 0,
  block_empty_ua  INTEGER DEFAULT 1,
  block_no_lang   INTEGER DEFAULT 1,

  countries_mode  TEXT DEFAULT 'any',     -- any | allow | block
  countries       TEXT DEFAULT '[]',      -- ["US","CA"]
  devices         TEXT DEFAULT '[]',      -- [] = any, else subset of [mobile,desktop,tablet]
  os_list         TEXT DEFAULT '[]',      -- [] = any, else subset
  browsers        TEXT DEFAULT '[]',      -- [] = any
  languages       TEXT DEFAULT '[]',      -- [] = any, else ["en","ru"]

  blacklist_ips   TEXT DEFAULT '',        -- newline-separated
  blacklist_ua    TEXT DEFAULT '',        -- newline-separated substrings

  schedule_enabled INTEGER DEFAULT 0,
  schedule_days    TEXT DEFAULT '[1,2,3,4,5,6,7]',
  schedule_from    TEXT DEFAULT '00:00',
  schedule_to      TEXT DEFAULT '23:59',

  limit_clicks_per_ip INTEGER DEFAULT 0,  -- 0 = unlimited
  limit_window_min    INTEGER DEFAULT 60,

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id          TEXT PRIMARY KEY,
  flow_id     INTEGER NOT NULL,
  ts          INTEGER NOT NULL,
  ip          TEXT,
  country     TEXT,
  ua          TEXT,
  device      TEXT,
  os          TEXT,
  browser     TEXT,
  language    TEXT,
  referrer    TEXT,
  decision    TEXT,   -- 'money' or 'safe'
  reason      TEXT,   -- why blocked (if safe)
  js_verified INTEGER DEFAULT 0,
  FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_visits_flow_ts ON visits(flow_id, ts);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);
CREATE INDEX IF NOT EXISTS idx_visits_ip ON visits(ip);
`);

// migration: older installs may not have these columns
function hasCol(t, c) { return db.prepare(`PRAGMA table_info(${t})`).all().some(x => x.name === c); }
if (!hasCol('flows', 'domain')) db.exec(`ALTER TABLE flows ADD COLUMN domain TEXT DEFAULT ''`);

// one-time cleanup of IPv4-mapped IPv6 prefixes that older versions stored
try {
  const info = db.prepare(
    `UPDATE visits SET ip = substr(ip, 8) WHERE ip LIKE '::ffff:%'`
  ).run();
  if (info && info.changes > 0) {
    console.log(`[migration] cleaned ::ffff: prefix from ${info.changes} visit rows`);
  }
} catch (_) {}

module.exports = { db, nanoid };
