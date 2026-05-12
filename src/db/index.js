'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const config = require('../config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS offers (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  url         TEXT NOT NULL,          -- money page (affiliate link, supports {clickid}, {sub1}...)
  payout      REAL NOT NULL DEFAULT 0,
  country     TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS landings (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK(kind IN ('white','money','prelander')),
  template    TEXT NOT NULL,          -- template filename under /landings
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE, -- public id used in /t/:slug
  name            TEXT NOT NULL,
  source          TEXT DEFAULT '',     -- facebook, google, tiktok...
  cost_model      TEXT DEFAULT 'cpc',  -- cpc, cpm, cpa
  cost_value      REAL DEFAULT 0,
  white_landing_id INTEGER,            -- shown to bots / wrong geo
  money_offer_id  INTEGER,             -- real offer
  prelander_id    INTEGER,             -- optional prelander before money
  cloaker_rule_id INTEGER,
  status          TEXT DEFAULT 'active', -- active, paused, archived
  created_at      INTEGER NOT NULL,
  FOREIGN KEY(white_landing_id) REFERENCES landings(id),
  FOREIGN KEY(money_offer_id) REFERENCES offers(id),
  FOREIGN KEY(prelander_id) REFERENCES landings(id),
  FOREIGN KEY(cloaker_rule_id) REFERENCES cloaker_rules(id)
);

CREATE TABLE IF NOT EXISTS cloaker_rules (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL,
  -- JSON arrays
  allow_countries TEXT DEFAULT '[]',   -- if empty = allow all
  block_countries TEXT DEFAULT '[]',
  block_ips       TEXT DEFAULT '[]',   -- exact or CIDR
  block_asns      TEXT DEFAULT '[]',   -- ["AS15169"]
  block_ua        TEXT DEFAULT '[]',   -- substrings
  allow_devices   TEXT DEFAULT '[]',   -- ["mobile","desktop","tablet"]
  require_referrer INTEGER DEFAULT 0,  -- require non-empty referrer
  block_vpn       INTEGER DEFAULT 1,
  block_bots      INTEGER DEFAULT 1,
  min_js_check    INTEGER DEFAULT 0,   -- require browser JS ping
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS clicks (
  id            TEXT PRIMARY KEY,       -- clickid (nanoid)
  campaign_id   INTEGER NOT NULL,
  ts            INTEGER NOT NULL,
  ip            TEXT,
  country       TEXT,
  city          TEXT,
  ua            TEXT,
  device        TEXT,                   -- mobile/desktop/tablet
  os            TEXT,
  browser       TEXT,
  referrer      TEXT,
  sub1          TEXT, sub2 TEXT, sub3 TEXT, sub4 TEXT, sub5 TEXT,
  cloaked       INTEGER DEFAULT 0,      -- 1 = sent to white page
  cloak_reason  TEXT,                   -- why cloaked
  is_bot        INTEGER DEFAULT 0,
  fingerprint   TEXT,
  destination   TEXT,                   -- final URL
  cost          REAL DEFAULT 0,
  FOREIGN KEY(campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_clicks_campaign_ts ON clicks(campaign_id, ts);
CREATE INDEX IF NOT EXISTS idx_clicks_ts ON clicks(ts);

CREATE TABLE IF NOT EXISTS conversions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id    TEXT NOT NULL,
  ts          INTEGER NOT NULL,
  payout      REAL DEFAULT 0,
  status      TEXT DEFAULT 'approved',  -- approved, pending, rejected
  tx_id       TEXT,
  raw         TEXT,                      -- postback raw query
  FOREIGN KEY(click_id) REFERENCES clicks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_conv_click ON conversions(click_id);
CREATE INDEX IF NOT EXISTS idx_conv_ts ON conversions(ts);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  click_id    TEXT,
  kind        TEXT NOT NULL,            -- view, js_ping, lp_click, form_submit
  ts          INTEGER NOT NULL,
  data        TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_click ON events(click_id);
`;

db.exec(SCHEMA);

module.exports = db;
