const db = require("./db");

// --- bounties (shared cache of pump.fun data - not user-specific) --------

function upsertBounty(scraped) {
  const existing = db.prepare("SELECT * FROM bounties WHERE id = ?").get(scraped.id);
  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(
      `INSERT INTO bounties (id, url, title, reward_text, reward_usd, winners_count,
        submissions_count, split_text, description, deliverables, status, stage, outcome,
        raw_summary, deadline_text, last_checked_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      scraped.id, scraped.url, scraped.title, scraped.rewardText,
      scraped.rewardUsd ?? null, scraped.winnersCount ?? null, scraped.submissionsCount ?? 0,
      scraped.splitText ?? null, scraped.description ?? null, scraped.deliverables ?? null,
      scraped.status, scraped.stage, scraped.outcome ?? null, scraped.summary, scraped.deadlineText, now, now
    );
    db.prepare(
      "INSERT INTO stage_history (bounty_id, status, stage, summary) VALUES (?, ?, ?, ?)"
    ).run(scraped.id, scraped.status, scraped.stage, scraped.summary);
    return { isNew: true, changed: true, previousStage: null };
  }

  const changed = existing.stage !== scraped.stage || existing.status !== scraped.status;

  const sql = changed
    ? `UPDATE bounties SET title=?, reward_text=?, reward_usd=?, winners_count=?, submissions_count=?,
       split_text=?, description=?, deliverables=?,
       status=?, stage=?, outcome=?, raw_summary=?, deadline_text=?, last_checked_at=?, last_changed_at=? WHERE id=?`
    : `UPDATE bounties SET title=?, reward_text=?, reward_usd=?, winners_count=?, submissions_count=?,
       split_text=?, description=?, deliverables=?,
       status=?, stage=?, outcome=?, raw_summary=?, deadline_text=?, last_checked_at=? WHERE id=?`;

  const params = [
    scraped.title, scraped.rewardText, scraped.rewardUsd ?? null, scraped.winnersCount ?? null,
    scraped.submissionsCount ?? 0, scraped.splitText ?? null, scraped.description ?? null, scraped.deliverables ?? null,
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

  return { isNew: false, changed, previousStage: existing.stage };
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

// --- trackers (per-user: "my tracked bounties") ---------------------------

function trackForOwner(ownerKey, bountyId, notify = 1) {
  db.prepare(
    `INSERT INTO trackers (owner_key, bounty_id, notify) VALUES (?, ?, ?)
     ON CONFLICT(owner_key, bounty_id) DO NOTHING`
  ).run(ownerKey, bountyId, notify ? 1 : 0);
}

// Real delete - removes this person's tracker row entirely. Since every
// surface (website, Mini App, bot) reads the same trackers table keyed by
// the same owner_key, this disappears everywhere for that person at once.
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

// Everyone (across all owner_keys) tracking a given bounty, with notify=1.
// Used by the poller to know who to message when a bounty's stage changes.
function notifiableTrackersFor(bountyId) {
  return db
    .prepare("SELECT owner_key FROM trackers WHERE bounty_id = ? AND notify = 1")
    .all(bountyId)
    .map((r) => r.owner_key);
}

// --- new-bounty broadcast opt-in ------------------------------------------

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

function trackedBountyIds() {
  return db.prepare("SELECT DISTINCT bounty_id FROM trackers").all().map((r) => r.bounty_id);
}

module.exports = {
  upsertBounty,
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
  subscribeNewBounties,
  unsubscribeNewBounties,
  isSubscribedToNewBounties,
  allNewBountySubscribers,
};
