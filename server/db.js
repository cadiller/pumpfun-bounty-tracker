const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const db = new DatabaseSync(path.join(__dirname, "..", "data.sqlite"));
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS bounties (
  id TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  title TEXT,
  reward_text TEXT,
  reward_usd REAL,
  winners_count INTEGER,
  submissions_count INTEGER,
  split_text TEXT,
  description TEXT,
  deliverables TEXT,
  status TEXT NOT NULL DEFAULT 'unknown',   -- coarse: open|ended|ruled|paid|closed|unknown
  stage TEXT,                                -- fine: live|submissions_closed|decision_posted|dispute_window|finalizing_payout|claimable|closed_no_winner|unknown
  outcome TEXT,                              -- once resolved: 'paid' | 'refunded' | null
  raw_summary TEXT,
  deadline_text TEXT,
  discovered_at TEXT NOT NULL DEFAULT (datetime('now')),
  broadcast_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_checked_at TEXT,
  last_changed_at TEXT
);

-- One row per status/stage change, used both for the "history" view and
-- for deciding when to notify.
CREATE TABLE IF NOT EXISTS stage_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bounty_id TEXT NOT NULL,
  status TEXT,
  stage TEXT,
  summary TEXT,
  changed_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (bounty_id) REFERENCES bounties(id)
);

-- Replaces the old global "subscribers" table. Every row here is one
-- person's (owner_key) tracking of one bounty. Deleting a row here is a
-- real delete - it disappears from that person's list everywhere
-- (website, Mini App, bot) because they all read from this same table.
CREATE TABLE IF NOT EXISTS trackers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_key TEXT NOT NULL,     -- 'tg:<telegram_user_id>' or 'web:<anonymous_uid>'
  bounty_id TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_key, bounty_id),
  FOREIGN KEY (bounty_id) REFERENCES bounties(id)
);

-- People who opted in to "tell me about brand new bounties" alerts.
CREATE TABLE IF NOT EXISTS new_bounty_subscribers (
  owner_key TEXT PRIMARY KEY,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Fallback linking flow for plain-browser (non-Mini-App) visitors who want
-- their web session tied to their Telegram chat for notifications.
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

// Migration for databases created before these columns existed.
for (const stmt of [
  "ALTER TABLE bounties ADD COLUMN outcome TEXT",
  "ALTER TABLE bounties ADD COLUMN split_text TEXT",
  "ALTER TABLE bounties ADD COLUMN description TEXT",
  "ALTER TABLE bounties ADD COLUMN deliverables TEXT",
]) {
  try {
    db.exec(stmt);
  } catch (_) {
    /* column already exists - fine */
  }
}

module.exports = db;
