const db = require("./db");

// --- bounties (shared cache of pump.fun data) ------------------------------

function upsertBounty(scraped, source) {
  const existing = db.prepare("SELECT * FROM bounties WHERE id = ?").get(scraped.id);
  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(
      `INSERT INTO bounties (id, url, title, description, reward_text, reward_usd, winners_count,
        submissions_count, status, stage, outcome, source, raw_summary, deadline_text,
        last_checked_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      scraped.id, scraped.url, scraped.title, scraped.description ?? null, scraped.rewardText,
      scraped.rewardUsd ?? null, scraped.winnersCount ?? null, scraped.submissionsCount ?? null,
      scraped.status, scraped.stage, scraped.outcome ?? null, source || "manual",
      scraped.summary, scraped.deadlineText, now, now
    );
    db.prepare(
      "INSERT INTO stage_history (bounty_id, status, stage, summary) VALUES (?, ?, ?, ?)"
    ).run(scraped.id, scraped.status, scraped.stage, scraped.summary);
    return { isNew: true, changed: true, previousStage: null };
  }

  const changed = existing.stage !== scraped.stage || existing.status !== scraped.status;

  const sql = changed
    ? `UPDATE bounties SET title=?, description=?, reward_text=?, reward_usd=?, winners_count=?, submissions_count=?,
       status=?, stage=?, outcome=?, raw_summary=?, deadline_text=?, last_checked_at=?, last_changed_at=? WHERE id=?`
    : `UPDATE bounties SET title=?, description=?, reward_text=?, reward_usd=?, winners_count=?, submissions_count=?,
       status=?, stage=?, outcome=?, raw_summary=?, deadline_text=?, last_checked_at=? WHERE id=?`;

  const params = [
    scraped.title, scraped.description ?? existing.description, scraped.rewardText,
    scraped.rewardUsd ?? null, scraped.winnersCount ?? null, scraped.submissionsCount ?? null,
    scraped.status, scraped.stage, scraped.outcome ?? null, scraped.summary,
    scraped.deadlineText, now,
  ];
  if (changed) params.push(now);
  params.push(scraped.id);

  db.prepare(sql).run(...params);

  if (changed) {
    db.prepare(
      "INSERT INTO stage_history (bounty_id, status, stage, summary) VALUES (?, ?, ?, ?)"
    ).run(scraped.id, scraped.status, scraped.stage, scraped.summary);
  }

  // NOTE: `source` is intentionally never overwritten after creation. If a
  // bounty was first discovered by the poller and someone later re-tracks
  // it manually, it should stay 'discovered' - and vice versa. This is
  // what keeps a user's own manual tracking from polluting everyone else's
  // Discover feed.

  return { isNew: false, changed, previousStage: existing.stage, wasEndingSoonNotified: Boolean(existing.ending_soon_notified) };
}

function markEndingSoonNotified(bountyId) {
  db.prepare("UPDATE bounties SET ending_soon_notified = 1 WHERE id = ?").run(bountyId);
}

function getBounty(id) {
  return db.prepare("SELECT * FROM bounties WHERE id = ?").get(id);
}

function allBounties() {
  return db.prepare("SELECT * FROM bounties ORDER BY discovered_at DESC").all();
}

function stageHistory(bountyId) {
  return db
    .prepare(
      "SELECT status, stage, summary, changed_at FROM stage_history WHERE bounty_id = ? ORDER BY changed_at ASC"
    )
    .all(bountyId);
}

// --- trackers (per-user: "my tracked bounties") ----------------------------

function trackForOwner(ownerKey, bountyId, notify = 1) {
  db.prepare(
    `INSERT INTO trackers (owner_key, bounty_id, notify) VALUES (?, ?, ?)
     ON CONFLICT(owner_key, bounty_id) DO NOTHING`
  ).run(ownerKey, bountyId, notify ? 1 : 0);
}

function untrackForOwner(ownerKey, bountyId) {
  db.prepare("DELETE FROM trackers WHERE owner_key = ? AND bounty_id = ?").run(ownerKey, bountyId);
}

function setNotify(ownerKey, bountyId, notify) {
  db.prepare("UPDATE trackers SET notify = ? WHERE owner_key = ? AND bounty_id = ?").run(
    notify ? 1 : 0,
    ownerKey,
    bountyId
  );
}

function listTrackedForOwner(ownerKey) {
  return db
    .prepare(
      `SELECT b.*, t.notify AS notify
       FROM bounties b
       JOIN trackers t ON t.bounty_id = b.id
       WHERE t.owner_key = ?
       ORDER BY t.created_at DESC`
    )
    .all(ownerKey);
}

function isTracked(ownerKey, bountyId) {
  return Boolean(
    db.prepare("SELECT 1 FROM trackers WHERE owner_key = ? AND bounty_id = ?").get(ownerKey, bountyId)
  );
}

function notifiableTrackersFor(bountyId) {
  return db
    .prepare("SELECT owner_key FROM trackers WHERE bounty_id = ? AND notify = 1")
    .all(bountyId)
    .map((r) => r.owner_key);
}

function trackedBountyIds() {
  return db.prepare("SELECT DISTINCT bounty_id FROM trackers").all().map((r) => r.bounty_id);
}

// --- discovery feed (only bounties the POLLER found organically) ----------

const SORTS = {
  newest: "b.discovered_at DESC",
  reward: "b.reward_usd DESC",
  active: "b.submissions_count DESC",
  // "ending soon" needs numeric hours, computed in JS by the caller since
  // deadline_text is free text, not a real datetime column.
};

function listDiscoverForOwner(ownerKey, sort = "newest") {
  const mine = new Set(listTrackedForOwner(ownerKey).map((b) => b.id));
  const orderBy = SORTS[sort] || SORTS.newest;
  const rows = db
    .prepare(
      `SELECT b.* FROM bounties b WHERE b.source = 'discovered' ORDER BY ${orderBy} LIMIT 60`
    )
    .all();
  const viewed = new Set(
    db.prepare("SELECT bounty_id FROM discovery_views WHERE owner_key = ?").all(ownerKey).map((r) => r.bounty_id)
  );
  return rows
    .filter((b) => !mine.has(b.id))
    .map((b) => ({ ...b, is_new: !viewed.has(b.id) }));
}

function markDiscoveryViewed(ownerKey, bountyId) {
  db.prepare(
    "INSERT INTO discovery_views (owner_key, bounty_id) VALUES (?, ?) ON CONFLICT(owner_key, bounty_id) DO NOTHING"
  ).run(ownerKey, bountyId);
}

function unseenDiscoverCount(ownerKey) {
  const mine = new Set(listTrackedForOwner(ownerKey).map((b) => b.id));
  const rows = db.prepare("SELECT id FROM bounties WHERE source = 'discovered'").all();
  const viewed = new Set(
    db.prepare("SELECT bounty_id FROM discovery_views WHERE owner_key = ?").all(ownerKey).map((r) => r.bounty_id)
  );
  return rows.filter((b) => !mine.has(b.id) && !viewed.has(b.id)).length;
}

// --- new-bounty broadcast opt-in --------------------------------------------

function subscribeNewBounties(ownerKey) {
  db.prepare(
    "INSERT INTO new_bounty_subscribers (owner_key) VALUES (?) ON CONFLICT(owner_key) DO NOTHING"
  ).run(ownerKey);
}
function unsubscribeNewBounties(ownerKey) {
  db.prepare("DELETE FROM new_bounty_subscribers WHERE owner_key = ?").run(ownerKey);
}
function isSubscribedToNewBounties(ownerKey) {
  return Boolean(db.prepare("SELECT 1 FROM new_bounty_subscribers WHERE owner_key = ?").get(ownerKey));
}
function allNewBountySubscribers() {
  return db.prepare("SELECT owner_key FROM new_bounty_subscribers").all().map((r) => r.owner_key);
}

// --- in-app notification center (Alerts tab) --------------------------------

function addNotification(ownerKey, type, bountyId, title, message) {
  db.prepare(
    "INSERT INTO notifications (owner_key, type, bounty_id, title, message) VALUES (?, ?, ?, ?, ?)"
  ).run(ownerKey, type, bountyId || null, title, message || null);
}

function listNotifications(ownerKey, limit = 50) {
  return db
    .prepare("SELECT * FROM notifications WHERE owner_key = ? ORDER BY created_at DESC LIMIT ?")
    .all(ownerKey, limit);
}

function unreadNotificationCount(ownerKey) {
  const row = db
    .prepare("SELECT COUNT(*) AS c FROM notifications WHERE owner_key = ? AND read = 0")
    .get(ownerKey);
  return row ? row.c : 0;
}

function markNotificationRead(ownerKey, id) {
  db.prepare("UPDATE notifications SET read = 1 WHERE owner_key = ? AND id = ?").run(ownerKey, id);
}

function markAllNotificationsRead(ownerKey) {
  db.prepare("UPDATE notifications SET read = 1 WHERE owner_key = ?").run(ownerKey);
}

module.exports = {
  upsertBounty,
  markEndingSoonNotified,
  getBounty,
  allBounties,
  stageHistory,
  trackForOwner,
  untrackForOwner,
  setNotify,
  listTrackedForOwner,
  isTracked,
  notifiableTrackersFor,
  trackedBountyIds,
  listDiscoverForOwner,
  markDiscoveryViewed,
  unseenDiscoverCount,
  subscribeNewBounties,
  unsubscribeNewBounties,
  isSubscribedToNewBounties,
  allNewBountySubscribers,
  addNotification,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
};
