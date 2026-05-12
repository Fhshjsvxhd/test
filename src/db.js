'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const { nanoid } = require('nanoid');
const config = require('./config');

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');

// -----------------------------------------------------------------
// Run migrations BEFORE the CREATE TABLE IF NOT EXISTS statements:
// SQLite won't alter an existing table, so if an older install left
// behind a table with a stale schema we have to drop it first.
// -----------------------------------------------------------------
function tableExists(name) {
  return !!db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name=?`
  ).get(name);
}
function hasCol(table, col) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all().some(x => x.name === col);
  } catch { return false; }
}

try { db.pragma('foreign_keys = OFF'); } catch (_) {}

// Old "flows" table from the previous version — drop outright.
if (tableExists('flows')) {
  try { db.exec('DROP TABLE flows'); } catch (e) { console.warn('drop flows:', e.message); }
}

// visits used to reference flows via flow_id. New visits has campaign_id.
if (tableExists('visits') && !hasCol('visits', 'campaign_id')) {
  try { db.exec('DROP TABLE visits'); } catch (e) { console.warn('drop visits:', e.message); }
}

// conversions from very first schema didn't have campaign_id.
if (tableExists('conversions') && !hasCol('conversions', 'campaign_id')) {
  try { db.exec('DROP TABLE conversions'); } catch (e) { console.warn('drop conversions:', e.message); }
}

// campaigns table from earlier builds: if it exists but doesn't have api_key,
// it's from the old incompatible schema — drop it so the new CREATE runs.
if (tableExists('campaigns') && !hasCol('campaigns', 'api_key')) {
  try { db.exec('DROP TABLE campaigns'); } catch (e) { console.warn('drop campaigns:', e.message); }
}

db.exec(`
CREATE TABLE IF NOT EXISTS campaigns (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  slug            TEXT NOT NULL UNIQUE,
  api_key         TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  tag             TEXT DEFAULT '',
  status          TEXT DEFAULT 'active',

  target_url      TEXT DEFAULT '',
  target_mode     TEXT DEFAULT 'redirect',
  bot_url         TEXT DEFAULT '',

  track_params        INTEGER DEFAULT 1,
  disable_extra_bl    INTEGER DEFAULT 0,
  allow_pr_chrome     INTEGER DEFAULT 0,
  conversion_param    TEXT DEFAULT 'clickid',

  block_bots          INTEGER DEFAULT 1,
  block_datacenter    INTEGER DEFAULT 1,
  block_vpn_proxy     INTEGER DEFAULT 1,
  block_headless      INTEGER DEFAULT 1,
  block_empty_ua      INTEGER DEFAULT 1,
  block_no_lang       INTEGER DEFAULT 1,
  require_referrer    INTEGER DEFAULT 0,

  geo                 TEXT DEFAULT '[]',
  geo_mode            TEXT DEFAULT 'allow',
  language            TEXT DEFAULT '',

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
  decision    TEXT,
  reason      TEXT,
  click_subid TEXT
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
  kind        TEXT NOT NULL,
  value       TEXT NOT NULL,
  note        TEXT DEFAULT '',
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_bl_kind ON blacklist(kind);
`);

try { db.pragma('foreign_keys = ON'); } catch (_) {}

module.exports = { db, nanoid };
