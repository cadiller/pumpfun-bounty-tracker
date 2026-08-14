const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "..", "data.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,               -- pump.fun bounty id - the stable dedupe key
  url TEXT NOT NULL,
  title TEXT,
  description TEXT,                  -- fuller deliverables/requirements text
  reward_text TEXT,
  reward_usd REAL,
  winners_count INTEGER,
  submissions_count INTEGER,
  status TEXT NOT NULL DEFAULT 'unknown',
  stage TEXT,
  outcome TEXT,                      -- 'paid' | 'refunded' | null
  source TEXT NOT NULL DEFAULT 'manual', -- 'manual' (a user pasted it) | 'discovered' (poller found it)
  raw_summary TEXT,
  deadline_text TEXT,
  ending_soon_notified INTEGER NOT NULL DEFAULT 0,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  broadcast_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_changed_at TEXT
);

CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty_id TEXT NOT NULL,
  status TEXT,
  stage TEXT,
  summary TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bounty_id) REFERENCES bounties(id)
);

-- One row per person's tracking of one bounty. Deleting a row here is a
-- real delete - it disappears from that person's list everywhere (website,
-- Mini App, bot) since they all read this same table by owner_key.
CREATE TABLE IF NOT EXISTS trackers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  bounty_id TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_key, bounty_id),
  FOREIGN KEY (bounty_id) REFERENCES bounties(id)
);

-- Per-person "have I seen this discovered bounty" state, so the NEW badge
-- clears for you personally without affecting anyone else.
CREATE TABLE IF NOT EXISTS discovery_views (
  owner_key TEXT NOT NULL,
  bounty_id TEXT NOT NULL,
  viewed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (owner_key, bounty_id)
);

-- In-app notification center (Alerts tab). Separate from the Telegram DM -
-- this is what powers the unread badge and the Alerts feed itself.
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,
  type TEXT NOT NULL,          -- 'new_bounty' | 'status_change' | 'ending_soon' | 'paid'
  bounty_id TEXT,
  title TEXT NOT NULL,
  message TEXT,
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS new_bounty_subscribers (
  owner_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS link_codes (
  code TEXT PRIMARY KEY,
  telegram_chat_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS link_owner (
  code TEXT PRIMARY KEY,
  uid TEXT NOT NULL
);
`);

// Migrations for databases created before these columns/tables existed.
// Each is wrapped individually so one already-applied migration doesn't
// block the rest.
const migrations = [
  "ALTER TABLE bounties ADD COLUMN outcome TEXT",
  "ALTER TABLE bounties ADD COLUMN description TEXT",
  "ALTER TABLE bounties ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
  "ALTER TABLE bounties ADD COLUMN ending_soon_notified INTEGER NOT NULL DEFAULT 0",
];
for (const sql of migrations) {
  try {
    db.exec(sql);
  } catch (_) {
    /* column already exists - fine */
  }
}

module.exports = db;
