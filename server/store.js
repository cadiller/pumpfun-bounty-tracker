const db = require("./db");

function upsertBounty(status) {
  const existing = db.prepare("SELECT * FROM bounties WHERE id = ?").get(status.id);
  const now = new Date().toISOString();

  if (!existing) {
    db.prepare(
      `INSERT INTO bounties (id, url, title, reward_text, status, raw_summary, deadline_text, last_checked_at, last_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      status.id,
      status.url,
      status.title,
      status.rewardText,
      status.status,
      status.summary,
      status.deadlineText,
      now,
      now
    );
    db.prepare(
      "INSERT INTO status_history (bounty_id, status, summary) VALUES (?, ?, ?)"
    ).run(status.id, status.status, status.summary);
    return { changed: true, previousStatus: null };
  }

  const changed = existing.status !== status.status;

  if (changed) {
    db.prepare(
      `UPDATE bounties SET title=?, reward_text=?, status=?, raw_summary=?, deadline_text=?,
       last_checked_at=?, last_changed_at=? WHERE id=?`
    ).run(
      status.title,
      status.rewardText,
      status.status,
      status.summary,
      status.deadlineText,
      now,
      now,
      status.id
    );
    db.prepare(
      "INSERT INTO status_history (bounty_id, status, summary) VALUES (?, ?, ?)"
    ).run(status.id, status.status, status.summary);
  } else {
    db.prepare(
      `UPDATE bounties SET title=?, reward_text=?, status=?, raw_summary=?, deadline_text=?,
       last_checked_at=? WHERE id=?`
    ).run(
      status.title,
      status.rewardText,
      status.status,
      status.summary,
      status.deadlineText,
      now,
      status.id
    );
  }

  return { changed, previousStatus: existing.status };
}

function subscribe(bountyId, chatId) {
  db.prepare(
    "INSERT OR IGNORE INTO subscribers (bounty_id, telegram_chat_id) VALUES (?, ?)"
  ).run(bountyId, chatId);
}

function unsubscribe(bountyId, chatId) {
  db.prepare(
    "DELETE FROM subscribers WHERE bounty_id = ? AND telegram_chat_id = ?"
  ).run(bountyId, chatId);
}

function listForChat(chatId) {
  return db
    .prepare(
      `SELECT b.* FROM bounties b
       JOIN subscribers s ON s.bounty_id = b.id
       WHERE s.telegram_chat_id = ?
       ORDER BY b.created_at DESC`
    )
    .all(chatId);
}

function allBounties() {
  return db.prepare("SELECT * FROM bounties ORDER BY created_at DESC").all();
}

function subscribersFor(bountyId) {
  return db
    .prepare("SELECT telegram_chat_id FROM subscribers WHERE bounty_id = ?")
    .all(bountyId)
    .map((r) => r.telegram_chat_id);
}

function history(bountyId) {
  return db
    .prepare(
      "SELECT status, summary, changed_at FROM status_history WHERE bounty_id = ? ORDER BY changed_at ASC"
    )
    .all(bountyId);
}

module.exports = {
  upsertBounty,
  subscribe,
  unsubscribe,
  listForChat,
  allBounties,
  subscribersFor,
  history,
};
