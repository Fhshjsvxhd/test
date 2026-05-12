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
CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  api_key         TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  tag             TEXT DEFAULT '',
  status          TEXT DEFAULT 'active',

  -- targets
  target_url      TEXT DEFAULT '',    -- money page URL
  target_mode     TEXT DEFAULT 'redirect',  -- redirect | frame | include
  bot_url         TEXT DEFAULT '',    -- safe page (URL or local filename)

  -- behaviour
  track_params        INTEGER DEFAULT 1,  -- pass GET params to target
  disable_extra_bl    INTEGER DEFAULT 0,  -- disable extra vpn/proxy blacklists
  allow_pr_chrome     INTEGER DEFAULT 0,  -- allow protected/restricted chrome (PR Chrome)
  conversion_param    TEXT DEFAULT 'clickid',

  -- filters
  block_bots          INTEGER DEFAULT 1,
  block_datacenter    INTEGER DEFAULT 1,
  block_vpn_proxy     INTEGER DEFAULT 1,
  block_headless      INTEGER DEFAULT 1,
  block_empty_ua      INTEGER DEFAULT 1,
  block_no_lang       INTEGER DEFAULT 1,
  require_referrer    INTEGER DEFAULT 0,

  -- targeting
  geo                 TEXT DEFAULT '[]',  -- JSON array of country codes (empty = any)
  geo_mode            TEXT DEFAULT 'allow', -- allow | block
  language            TEXT DEFAULT '',    -- single lang like 'en' or empty

  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS visits (
  id          TEXT PRIMARY KEY,
  campaign_id INTEGER NOT NULL,
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
  reason      TEXT,
  click_subid TEXT,   -- value of the conversion_param from URL
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_visits_camp_ts ON visits(campaign_id, ts);
CREATE INDEX IF NOT EXISTS idx_visits_ts ON visits(ts);

CREATE TABLE IF NOT EXISTS conversions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id    TEXT,
  campaign_id INTEGER,
  ts          INTEGER NOT NULL,
  payout      REAL DEFAULT 0,
  status      TEXT DEFAULT 'approved',
  tx_id       TEXT,
  raw         TEXT
);
CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversions(ts);
CREATE INDEX IF NOT EXISTS idx_conv_click ON conversions(click_id);

CREATE TABLE IF NOT EXISTS blacklist (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  kind        TEXT NOT NULL,    -- 'ip' | 'ua'
  value       TEXT NOT NULL,
  note        TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bl_kind ON blacklist(kind);
`);

// Drop the old "flows" tables if they existed from an earlier version so
// the new schema is the single source of truth. Keep data-bearing tables,
// not schema-only ones.
try {
  const t = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='flows'`).get();
  if (t) {
    db.exec(`DROP TABLE IF EXISTS flows`);
  }
} catch (_) {}

module.exports = { db, nanoid };
