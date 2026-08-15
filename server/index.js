require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./db");
const { fetchBountyStatus, extractBountyId } = require("./scraper");
const {
  upsertBounty,
  allBounties,
  stageHistory,
  trackForOwner,
  untrackForOwner,
  setNotify,
  listTrackedForOwner,
  isTracked,
  subscribeNewBounties,
  unsubscribeNewBounties,
  isSubscribedToNewBounties,
} = require("./store");
const { initTelegram } = require("./telegram");
const { startPoller, checkOne } = require("./poller");

const app = express();
app.use(express.json());
// Telegram's in-app WebView can aggressively cache static assets, which
// previously caused it to keep showing an old deployed version even after
// a fresh Railway build went out. Force it to always re-check.
app.use(
  express.static(path.join(__dirname, "..", "public"), {
    etag: false,
    lastModified: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "no-store, must-revalidate"),
  })
);

// --- identify who's asking -------------------------------------------------
//
// Two ways a person can be identified:
//  1. Telegram Mini App: the client sends the raw `initData` string Telegram
//     gives it. We verify its signature with our bot token (Telegram's
//     documented auth flow) and trust the user id inside it. This is the
//     secure, no-linking-needed path and fixes the earlier bug where every
//     visitor saw the same shared list - each Telegram account is now
//     cryptographically its own owner_key.
//  2. Plain browser: falls back to an anonymous per-browser cookie. If that
//     browser has been linked to a Telegram chat (via the "Connect
//     Telegram" flow), we use that chat's owner_key instead so the website
//     and the bot show the same list.

function verifyTelegramInitData(initData, botToken) {
  if (!initData || !botToken) return null;
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get("hash");
    if (!hash) return null;
    params.delete("hash");
    const pairs = [...params.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
    const secretKey = crypto.createHmac("sha256", "WebAppData").update(botToken).digest();
    const computedHash = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");
    if (computedHash !== hash) return null;
    const userJson = params.get("user");
    if (!userJson) return null;
    const user = JSON.parse(userJson);
    return user.id ? String(user.id) : null;
  } catch (_) {
    return null;
  }
}

function chatIdLinkedTo(uid) {
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

app.use((req, res, next) => {
  const initData = req.headers["x-telegram-init-data"];
  const tgId = verifyTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN);
  if (tgId) {
    req.ownerKey = `tg:${tgId}`;
    req.isTelegram = true;
    return next();
  }

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

  const linkedChat = chatIdLinkedTo(uid);
  req.ownerKey = linkedChat ? `tg:${linkedChat}` : `web:${uid}`;
  req.isTelegram = false;
  next();
});

// --- Telegram linking (for plain-browser visitors) -------------------------

app.get("/api/telegram/link", (req, res) => {
  const botUsername = process.env.TELEGRAM_BOT_USERNAME;
  if (!process.env.TELEGRAM_BOT_TOKEN || !botUsername) {
    return res.status(400).json({ error: "Telegram bot not configured on the server." });
  }
  const code = crypto.randomBytes(8).toString("hex");
  db.prepare("INSERT INTO link_codes (code) VALUES (?)").run(code);
  db.prepare("INSERT INTO link_owner (code, uid) VALUES (?, ?)").run(code, req.uid || "");
  res.json({ url: `https://t.me/${botUsername}?start=${code}`, code });
});

app.get("/api/telegram/status", (req, res) => {
  res.json({ connected: req.ownerKey.startsWith("tg:"), ownerKey: req.ownerKey });
});

// --- bounties (scoped to whoever's asking) ---------------------------------

app.get("/api/bounties", (req, res) => {
  res.json(listTrackedForOwner(req.ownerKey));
});

app.post("/api/bounties", async (req, res) => {
  const input = req.body?.url;
  const id = extractBountyId(input);
  if (!id) return res.status(400).json({ error: "That doesn't look like a pump.fun bounty link." });
  try {
    const scraped = await fetchBountyStatus(id);
    upsertBounty(scraped);
    // Telegram-identified owners get notified by default; anonymous
    // web-only visitors start with notify off since we have no chat to
    // message them on until they connect Telegram.
    trackForOwner(req.ownerKey, id, req.ownerKey.startsWith("tg:") ? 1 : 0);
    res.json({ ...scraped, tracked: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// Real delete: removes it from *this* owner's list. Because the Mini App,
// website, and bot all resolve to the same owner_key for the same Telegram
// account, this disappears everywhere for that person at once.
app.delete("/api/bounties/:id", (req, res) => {
  untrackForOwner(req.ownerKey, req.params.id);
  res.json({ ok: true });
});

app.post("/api/bounties/:id/notify", (req, res) => {
  const notify = Boolean(req.body?.notify);
  if (notify && !req.ownerKey.startsWith("tg:")) {
    return res.status(400).json({ error: "Connect Telegram first to enable notifications." });
  }
  setNotify(req.ownerKey, req.params.id, notify);
  res.json({ ok: true });
});

app.post("/api/bounties/:id/refresh", async (req, res) => {
  await checkOne(req.params.id);
  res.json(db.prepare("SELECT * FROM bounties WHERE id = ?").get(req.params.id));
});

app.get("/api/bounties/:id/history", (req, res) => {
  res.json(stageHistory(req.params.id));
});

// --- discovered bounties (anything the poller has seen, not yet tracked
//     by this owner) - lets the site/Mini App show "new bounties to track"

app.get("/api/discover", (req, res) => {
  const mine = new Set(listTrackedForOwner(req.ownerKey).map((b) => b.id));
  const recent = allBounties()
    .filter((b) => !mine.has(b.id))
    .slice(0, 30);
  res.json(recent);
});

// --- opt-in "tell me about brand new bounties" ------------------------------

app.get("/api/new-bounties/status", (req, res) => {
  res.json({ subscribed: isSubscribedToNewBounties(req.ownerKey) });
});

app.post("/api/new-bounties/subscribe", (req, res) => {
  if (!req.ownerKey.startsWith("tg:")) {
    return res.status(400).json({ error: "Connect Telegram first to get new-bounty alerts." });
  }
  subscribeNewBounties(req.ownerKey);
  res.json({ ok: true });
});

app.post("/api/new-bounties/unsubscribe", (req, res) => {
  unsubscribeNewBounties(req.ownerKey);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  initTelegram();
  startPoller();
});
