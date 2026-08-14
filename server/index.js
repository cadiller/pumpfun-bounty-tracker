require("dotenv").config();
const path = require("path");
const crypto = require("crypto");
const express = require("express");

const db = require("./db");
const { fetchBountyStatus, extractBountyId } = require("./scraper");
const {
  upsertBounty,
  getBounty,
  allBounties,
  stageHistory,
  trackForOwner,
  untrackForOwner,
  setNotify,
  listTrackedForOwner,
  isTracked,
  listDiscoverForOwner,
  markDiscoveryViewed,
  unseenDiscoverCount,
  subscribeNewBounties,
  unsubscribeNewBounties,
  isSubscribedToNewBounties,
  listNotifications,
  unreadNotificationCount,
  markNotificationRead,
  markAllNotificationsRead,
} = require("./store");
const { initTelegram } = require("./telegram");
const { startPoller, checkOne } = require("./poller");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "..", "public")));

// --- identify who's asking (see comments below for the auth design) -------

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

// --- Telegram linking (plain-browser visitors) ------------------------------

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

// --- bounties (scoped to whoever's asking) ----------------------------------

app.get("/api/bounties", (req, res) => {
  res.json(listTrackedForOwner(req.ownerKey));
});

// Single bounty detail - full description, history, tracked/notify state
// for whoever's asking. Powers the detail view.
app.get("/api/bounties/:id", (req, res) => {
  const bounty = getBounty(req.params.id);
  if (!bounty) return res.status(404).json({ error: "Not found." });
  const tracked = isTracked(req.ownerKey, req.params.id);
  const notifyRow = tracked
    ? db.prepare("SELECT notify FROM trackers WHERE owner_key = ? AND bounty_id = ?").get(req.ownerKey, req.params.id)
    : null;
  res.json({
    ...bounty,
    tracked,
    notify: notifyRow ? Boolean(notifyRow.notify) : false,
    history: stageHistory(req.params.id),
  });
});

app.post("/api/bounties", async (req, res) => {
  const input = req.body?.url;
  const id = extractBountyId(input);
  if (!id) return res.status(400).json({ error: "That doesn't look like a pump.fun bounty link." });
  try {
    const scraped = await fetchBountyStatus(id);
    // Tagged 'manual' - this user found and pasted it themselves, so it
    // must never show up as a "new discovery" for other people.
    upsertBounty(scraped, "manual");
    trackForOwner(req.ownerKey, id, req.ownerKey.startsWith("tg:") ? 1 : 0);
    markDiscoveryViewed(req.ownerKey, id); // if it happened to already be in Discover for this user
    res.json({ ...scraped, tracked: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

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
  res.json(getBounty(req.params.id));
});

app.get("/api/bounties/:id/history", (req, res) => {
  res.json(stageHistory(req.params.id));
});

// --- discover (only bounties the POLLER found organically) -----------------

app.get("/api/discover", (req, res) => {
  const sort = ["newest", "reward", "active"].includes(req.query.sort) ? req.query.sort : "newest";
  res.json(listDiscoverForOwner(req.ownerKey, sort));
});

app.post("/api/discover/:id/view", (req, res) => {
  markDiscoveryViewed(req.ownerKey, req.params.id);
  res.json({ ok: true });
});

app.get("/api/discover/unseen-count", (req, res) => {
  res.json({ count: unseenDiscoverCount(req.ownerKey) });
});

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

// --- notification center (Alerts tab) ---------------------------------------

app.get("/api/notifications", (req, res) => {
  res.json({
    items: listNotifications(req.ownerKey),
    unread: unreadNotificationCount(req.ownerKey),
  });
});
app.post("/api/notifications/:id/read", (req, res) => {
  markNotificationRead(req.ownerKey, Number(req.params.id));
  res.json({ ok: true });
});
app.post("/api/notifications/read-all", (req, res) => {
  markAllNotificationsRead(req.ownerKey);
  res.json({ ok: true });
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`[server] listening on http://localhost:${port}`);
  initTelegram();
  startPoller();
});
