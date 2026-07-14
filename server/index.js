require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./db");
const { fetchBountyStatus, extractBountyId } = require("./scraper");
const {
  upsertBounty,
  allBounties,
  subscribe,
  unsubscribe,
  history,
} = require("./store");
const { initTelegram } = require("./telegram");
const { startPoller, checkOne } = require("./poller");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// Every browser gets a lightweight anonymous id via cookie so we know which
// bounties "belong" to them and which Telegram chat to notify. No accounts,
// no passwords - just enough state to connect the dots.
app.use((req, res, next) => {
  let uid = req.headers.cookie
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith("uid="))
    ?.split("=")[1];
  if (!uid) {
    uid = crypto.randomBytes(12).toString("hex");
    res.setHeader("Set-Cookie", `uid=${uid}; Path=/; Max-Age=31536000; SameSite=Lax`);
  }
  req.uid = uid;
  next();
});

// --- Telegram linking -------------------------------------------------

// Returns a fresh deep link the browser can open to connect Telegram.
app.get("/api/telegram/link", (req, res) => {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!process.env.TELEGRAM_BOT_TOKEN || !botUsername) {
    return res.status(400).json({ error: "Telegram bot not configured on the server." });
  }
  const code = crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO link_codes (code) VALUES (?)").run(code);
  // Remember which browser this code belongs to, so once Telegram calls
  // back with a chat id we can look it up again from the browser's cookie.
  db.prepare("INSERT INTO link_owner (code, uid) VALUES (?, ?)").run(code, req.uid);

  res.json({ url: `https://t.me/${botUsername}?start=${code}`, code });
});

app.get("/api/telegram/status", (req, res) => {
  const row = db
    .prepare(
      `SELECT lc.telegram_chat_id FROM link_owner lo
       JOIN link_codes lc ON lc.code = lo.code
       WHERE lo.uid = ? AND lc.telegram_chat_id IS NOT NULL
       ORDER BY lc.created_at DESC LIMIT 1`
    )
    .get(req.uid);
  res.json({ connected: Boolean(row), chatId: row?.telegram_chat_id || null });
});

function chatIdForUid(uid) {
  const row = db
    .prepare(
      `SELECT lc.telegram_chat_id FROM link_owner lo
       JOIN link_codes lc ON lc.code = lo.code
       WHERE lo.uid = ? AND lc.telegram_chat_id IS NOT NULL
       ORDER BY lc.created_at DESC LIMIT 1`
    )
    .get(uid);
  return row?.telegram_chat_id || null;
}

// --- Bounties -----------------------------------------------------------

app.get("/api/bounties", (req, res) => {
  const chatId = chatIdForUid(req.uid);
  const rows = allBounties().map((b) => ({
    ...b,
    subscribed: chatId
      ? Boolean(
          db
            .prepare(
              "SELECT 1 FROM subscribers WHERE bounty_id = ? AND telegram_chat_id = ?"
            )
            .get(b.id, chatId)
        )
      : false,
  }));
  res.json(rows);
});

app.post("/api/bounties", async (req, res) => {
  const input = req.body?.url;
  const id = extractBountyId(input);
  if (!id) {
    return res.status(400).json({ error: "That doesn't look like a pump.fun bounty link." });
  }
  try {
    const status = await fetchBountyStatus(id);
    upsertBounty(status);

    const chatId = chatIdForUid(req.uid);
    if (chatId) subscribe(id, chatId);

    res.json({ ...status, subscribed: Boolean(chatId) });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.post("/api/bounties/:id/subscribe", (req, res) => {
  const chatId = chatIdForUid(req.uid);
  if (!chatId) return res.status(400).json({ error: "Connect Telegram first." });
  subscribe(req.params.id, chatId);
  res.json({ ok: true });
});

app.post("/api/bounties/:id/unsubscribe", (req, res) => {
  const chatId = chatIdForUid(req.uid);
  if (chatId) unsubscribe(req.params.id, chatId);
  res.json({ ok: true });
});

app.post("/api/bounties/:id/refresh", async (req, res) => {
  const bounty = db.prepare("SELECT * FROM bounties WHERE id = ?").get(req.params.id);
  if (!bounty) return res.status(404).json({ error: "Not tracked." });
  await checkOne(bounty);
  res.json(db.prepare("SELECT * FROM bounties WHERE id = ?").get(req.params.id));
});

app.get("/api/bounties/:id/history", (req, res) => {
  res.json(history(req.params.id));
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  initTelegram();
  startPoller();
});
