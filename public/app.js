// --- Telegram Mini App identity ------------------------------------------
const tgWebApp = window.Telegram?.WebApp;
const TG_INIT_DATA = tgWebApp?.initData || null;
if (tgWebApp) { tgWebApp.ready(); tgWebApp.expand(); }

// --- theme (persisted) -----------------------------------------------------
const THEME_KEY = "bounty-watch-theme";
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
document.getElementById("theme-btn").addEventListener("click", () => {
  applyTheme(document.body.getAttribute("data-theme") === "dark" ? "light" : "dark");
});

// --- toast (replaces blocking alert() for routine feedback) ----------------
const toastEl = document.getElementById("toast");
let toastTimer = null;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  requestAnimationFrame(() => toastEl.classList.add("show"));
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.classList.remove("show");
    setTimeout(() => { toastEl.hidden = true; }, 200);
  }, 2200);
}

// --- stage bucketing ---------------------------------------------------------
const STAGE_GROUP = {
  live: "live", submissions_closed: "ended", decision_posted: "ended",
  dispute_window: "dispute", finalizing_payout: "dispute",
  claimable: "paid", paid: "paid", closed_no_winner: "paid", closed: "paid", unknown: "unknown",
};
const STAGE_ORDER = ["live", "ended", "dispute", "paid"];
const BADGE_LABEL = { live: "LIVE", ended: "ENDED", dispute: "IN DISPUTE", paid: "PAID OUT", unknown: "UNKNOWN" };
const ALERT_ICON = { new_bounty: "\ud83c\udd95", status_change: "\ud83d\udd04", ending_soon: "\u26a0\ufe0f", paid: "\u2705" };

function outcomeText(b) {
  if (b.outcome === "refunded") return "Refunded — no valid winner";
  if (b.outcome === "paid" && b.winners_count) return `Paid to ${b.winners_count} winner${b.winners_count === 1 ? "" : "s"}`;
  if (b.outcome === "paid") return "Paid out";
  return null;
}
function subText(b) {
  const bits = [];
  if (b.reward_usd) bits.push(`<b>$${b.reward_usd}</b>`);
  const out = outcomeText(b);
  if (out) bits.push(out);
  else if (b.deadline_text) bits.push(b.deadline_text);
  return bits.join(" · ") || "No details yet";
}
function timeAgo(iso) {
  if (!iso) return "never checked";
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (TG_INIT_DATA) headers["X-Telegram-Init-Data"] = TG_INIT_DATA;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// --- page/tab switching ------------------------------------------------------
const pages = { my: document.getElementById("page-my"), discover: document.getElementById("page-discover"), alerts: document.getElementById("page-alerts") };
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const key = btn.dataset.page;
    Object.entries(pages).forEach(([k, el]) => { el.hidden = k !== key; });
    document.querySelectorAll(".nav-item").forEach((b) => b.classList.toggle("active", b === btn));
    if (key === "discover") loadDiscover();
    if (key === "alerts") loadAlerts();
  });
});

// --- DOM refs -----------------------------------------------------------------
const form = document.getElementById("add-form");
const input = document.getElementById("url-input");
const formError = document.getElementById("form-error");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const mySkeleton = document.getElementById("my-skeleton");
const myError = document.getElementById("my-error");
const myFreshness = document.getElementById("my-freshness");
const cardTemplate = document.getElementById("card-template");
const discoverTemplate = document.getElementById("discover-card-template");
const discoverList = document.getElementById("discover-list");
const discoverEmpty = document.getElementById("discover-empty");
const discoverSkeleton = document.getElementById("discover-skeleton");
const discoverError = document.getElementById("discover-error");
const newBountyToggle = document.getElementById("new-bounty-toggle");
const tgBtn = document.getElementById("telegram-btn");
const tgLabel = document.getElementById("tg-label");
const statTracked = document.getElementById("stat-tracked");
const statLive = document.getElementById("stat-live");
const statPaid = document.getElementById("stat-paid");
const discoverBadge = document.getElementById("discover-badge");
const alertsBadge = document.getElementById("alerts-badge");

function skeletons(n) {
  return Array.from({ length: n }).map(() => '<div class="skeleton-card"></div>').join("");
}
mySkeleton.innerHTML = skeletons(2);
discoverSkeleton.innerHTML = skeletons(3);

// --- My bounties --------------------------------------------------------------
let lastLoaded = null;

function renderCard(bounty) {
  const node = cardTemplate.content.cloneNode(true);
  const group = STAGE_GROUP[bounty.stage] || "unknown";
  const idx = STAGE_ORDER.indexOf(group);

  const titleEl = node.querySelector(".bc-title");
  titleEl.textContent = bounty.title || bounty.id;
  titleEl.href = bounty.url;
  titleEl.addEventListener("click", (e) => { e.preventDefault(); openDetail(bounty.id); });

  node.querySelector(".badge").textContent = BADGE_LABEL[group];
  node.querySelector(".badge").dataset.b = group;
  node.querySelector(".bc-sub").innerHTML = subText(bounty);
  node.querySelector(".bc-meta").textContent = `Checked ${timeAgo(bounty.last_checked_at)}`;

  const fill = node.querySelector(".progress-fill");
  fill.style.width = idx >= 0 ? `${((idx + 1) / STAGE_ORDER.length) * 100}%` : "0%";
  node.querySelectorAll(".progress-labels span").forEach((el) => el.classList.toggle("on", el.dataset.stage === group));

  const card = node.querySelector(".bounty-card");
  card.addEventListener("click", (e) => {
    if (e.target.closest("button, a")) return;
    openDetail(bounty.id);
  });

  const notifyBtn = node.querySelector(".notify-btn");
  notifyBtn.classList.toggle("active", Boolean(bounty.notify));
  notifyBtn.textContent = bounty.notify ? "Notifying ✓" : "Notify me";
  notifyBtn.addEventListener("click", async (e) => {
    e.stopPropagation();
    try {
      await api(`/api/bounties/${bounty.id}/notify`, { method: "POST", body: JSON.stringify({ notify: !bounty.notify }) });
      toast(bounty.notify ? "Notifications off" : "You'll be notified");
      await load();
    } catch (err) { toast(err.message); }
  });

  node.querySelector(".refresh-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    e.target.textContent = "Checking…";
    e.target.disabled = true;
    try {
      await api(`/api/bounties/${bounty.id}/refresh`, { method: "POST" });
      toast("Updated");
      await load();
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
      e.target.textContent = "Check now";
    }
  });

  node.querySelector(".del-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    if (!confirm("Stop tracking this bounty? Removes it everywhere - site, Mini App, and bot.")) return;
    try {
      await api(`/api/bounties/${bounty.id}`, { method: "DELETE" });
      toast("Untracked");
      await load();
    } catch (err) { toast(err.message); }
  });

  return node;
}

async function load({ silent } = {}) {
  if (!silent) { mySkeleton.hidden = false; myError.hidden = true; }
  try {
    const bounties = await api("/api/bounties");
    lastLoaded = new Date();
    mySkeleton.hidden = true;
    myError.hidden = true;
    list.innerHTML = "";
    empty.hidden = bounties.length > 0;
    for (const b of bounties) list.appendChild(renderCard(b));

    statTracked.textContent = bounties.length;
    statLive.textContent = bounties.filter((b) => STAGE_GROUP[b.stage] === "live").length;
    const paidTotal = bounties.filter((b) => b.outcome === "paid" && b.reward_usd).reduce((s, b) => s + b.reward_usd, 0);
    statPaid.textContent = `$${Math.round(paidTotal)}`;
    updateFreshness();
    refreshBadges();
  } catch (err) {
    mySkeleton.hidden = true;
    if (!list.children.length) myError.hidden = false;
    else toast("Couldn't refresh - showing last known data");
  }
}
function updateFreshness() {
  if (!lastLoaded) return;
  myFreshness.textContent = `Updated ${timeAgo(lastLoaded.toISOString())}`;
}
setInterval(updateFreshness, 15000);
document.getElementById("my-retry").addEventListener("click", () => load());

// --- Discover ------------------------------------------------------------------
let currentSort = "newest";
document.querySelectorAll(".sort-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    currentSort = btn.dataset.sort;
    document.querySelectorAll(".sort-btn").forEach((b) => b.classList.toggle("active", b === btn));
    loadDiscover();
  });
});

function renderDiscoverCard(bounty) {
  const node = discoverTemplate.content.cloneNode(true);
  const group = STAGE_GROUP[bounty.stage] || "unknown";

  const titleEl = node.querySelector(".bc-title");
  titleEl.textContent = bounty.title || bounty.id;
  titleEl.href = bounty.url;
  titleEl.addEventListener("click", (e) => { e.preventDefault(); openDetail(bounty.id, true); });

  node.querySelector(".badge").textContent = BADGE_LABEL[group];
  node.querySelector(".badge").dataset.b = group;
  node.querySelector(".bc-sub").innerHTML = subText(bounty);
  if (bounty.is_new) node.querySelector(".new-badge").hidden = false;

  node.querySelector(".view-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    await api(`/api/discover/${bounty.id}/view`, { method: "POST" }).catch(() => {});
    openDetail(bounty.id, true);
  });

  node.querySelector(".track-btn").addEventListener("click", async (e) => {
    e.stopPropagation();
    e.target.disabled = true;
    e.target.textContent = "Tracking…";
    try {
      await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: bounty.url }) });
      toast("Tracking added");
      await load();
      await loadDiscover();
    } catch (err) {
      toast(err.message);
      e.target.disabled = false;
      e.target.textContent = "Track it";
    }
  });

  return node;
}

async function loadDiscover() {
  discoverSkeleton.hidden = false;
  discoverError.hidden = true;
  try {
    const bounties = await api(`/api/discover?sort=${currentSort}`);
    discoverSkeleton.hidden = true;
    discoverList.innerHTML = "";
    discoverEmpty.hidden = bounties.length > 0;
    for (const b of bounties) discoverList.appendChild(renderDiscoverCard(b));
    refreshBadges();
  } catch (_) {
    discoverSkeleton.hidden = true;
    discoverError.hidden = false;
  }
}
document.getElementById("discover-retry").addEventListener("click", loadDiscover);

async function refreshNewBountyToggle() {
  try {
    const { subscribed } = await api("/api/new-bounties/status");
    newBountyToggle.classList.toggle("on", subscribed);
    newBountyToggle.textContent = subscribed ? "Alerting ✓" : "Alert me";
  } catch (_) {}
}
newBountyToggle.addEventListener("click", async () => {
  const isOn = newBountyToggle.classList.contains("on");
  try {
    await api(`/api/new-bounties/${isOn ? "unsubscribe" : "subscribe"}`, { method: "POST" });
    toast(isOn ? "New-bounty alerts off" : "You'll be alerted about new bounties");
    await refreshNewBountyToggle();
  } catch (err) { toast(err.message); }
});

// --- Alerts ----------------------------------------------------------------------
const alertsList = document.getElementById("alerts-list");
const alertsEmpty = document.getElementById("alerts-empty");
const alertTemplate = document.getElementById("alert-template");

function renderAlert(n) {
  const node = alertTemplate.content.cloneNode(true);
  const item = node.querySelector(".alert-item");
  item.classList.toggle("read", Boolean(n.read));
  node.querySelector(".alert-icon").textContent = ALERT_ICON[n.type] || "\ud83d\udd14";
  node.querySelector(".alert-title").textContent = n.title;
  node.querySelector(".alert-msg").textContent = n.message || "";
  node.querySelector(".alert-time").textContent = timeAgo(n.created_at);
  item.addEventListener("click", async () => {
    if (!n.read) {
      await api(`/api/notifications/${n.id}/read`, { method: "POST" }).catch(() => {});
      item.classList.add("read");
      refreshBadges();
    }
    if (n.bounty_id) openDetail(n.bounty_id);
  });
  return node;
}

async function loadAlerts() {
  try {
    const { items } = await api("/api/notifications");
    alertsList.innerHTML = "";
    alertsEmpty.hidden = items.length > 0;
    for (const n of items) alertsList.appendChild(renderAlert(n));
  } catch (_) {}
}
document.getElementById("mark-all-read").addEventListener("click", async () => {
  try {
    await api("/api/notifications/read-all", { method: "POST" });
    toast("All marked read");
    await loadAlerts();
    refreshBadges();
  } catch (err) { toast(err.message); }
});

async function refreshBadges() {
  try {
    const [{ count }, { unread }] = await Promise.all([
      api("/api/discover/unseen-count"),
      api("/api/notifications"),
    ]);
    discoverBadge.hidden = count === 0;
    discoverBadge.textContent = count > 9 ? "9+" : count;
    alertsBadge.hidden = unread === 0;
    alertsBadge.textContent = unread > 9 ? "9+" : unread;
  } catch (_) {}
}

// --- Detail modal ------------------------------------------------------------------
const overlay = document.getElementById("detail-overlay");
const detailBody = document.getElementById("detail-body");
document.getElementById("detail-close").addEventListener("click", closeDetail);
overlay.addEventListener("click", (e) => { if (e.target === overlay) closeDetail(); });
function closeDetail() { overlay.hidden = true; }

async function openDetail(id, fromDiscover) {
  overlay.hidden = false;
  detailBody.innerHTML = '<div class="skeleton-card" style="height:220px"></div>';
  try {
    const b = await api(`/api/bounties/${id}`);
    const group = STAGE_GROUP[b.stage] || "unknown";
    const out = outcomeText(b);

    const historyHtml = (b.history || [])
      .map((h) => `<div class="history-item"><span class="hstage">${BADGE_LABEL[STAGE_GROUP[h.stage] || "unknown"]}</span><span class="htime">${timeAgo(h.changed_at)}</span></div>`)
      .join("") || '<div class="bc-meta">No history yet.</div>';

    detailBody.innerHTML = `
      <span class="badge" data-b="${group}">${BADGE_LABEL[group]}</span>
      <div class="detail-title">${b.title || b.id}</div>
      <div class="detail-badges">
        ${b.reward_usd ? `<div class="detail-stat"><span class="k">REWARD</span><span class="v">$${b.reward_usd}</span></div>` : ""}
        ${b.winners_count ? `<div class="detail-stat"><span class="k">WINNERS</span><span class="v">${b.winners_count}</span></div>` : ""}
        ${b.submissions_count ? `<div class="detail-stat"><span class="k">ENTRIES</span><span class="v">${b.submissions_count}</span></div>` : ""}
        ${b.deadline_text ? `<div class="detail-stat"><span class="k">TIME LEFT</span><span class="v">${b.deadline_text}</span></div>` : ""}
      </div>
      ${out ? `<div class="bc-sub"><b>${out}</b></div>` : ""}
      <div class="detail-section-h">Description &amp; deliverables</div>
      <div class="detail-desc">${(b.description || b.raw_summary || "No description available.").replace(/</g, "&lt;")}</div>
      <div class="detail-section-h">Status history</div>
      ${historyHtml}
      <div class="detail-actions">
        ${b.tracked
          ? `<button class="secondary" id="detail-untrack">Untrack</button>`
          : `<button class="primary" id="detail-track">Track it</button>`}
        <button class="secondary" id="detail-refresh">Check now</button>
        <a class="secondary" style="text-align:center;text-decoration:none;display:flex;align-items:center;justify-content:center;" href="${b.url}" target="_blank" rel="noopener">Open ↗</a>
      </div>
    `;

    if (fromDiscover) await api(`/api/discover/${id}/view`, { method: "POST" }).catch(() => {});

    const trackBtn = document.getElementById("detail-track");
    if (trackBtn) trackBtn.addEventListener("click", async () => {
      try {
        await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: b.url }) });
        toast("Tracking added");
        closeDetail();
        await load(); await loadDiscover();
      } catch (err) { toast(err.message); }
    });
    const untrackBtn = document.getElementById("detail-untrack");
    if (untrackBtn) untrackBtn.addEventListener("click", async () => {
      if (!confirm("Stop tracking this bounty?")) return;
      try {
        await api(`/api/bounties/${id}`, { method: "DELETE" });
        toast("Untracked");
        closeDetail();
        await load();
      } catch (err) { toast(err.message); }
    });
    document.getElementById("detail-refresh").addEventListener("click", async (e) => {
      e.target.textContent = "Checking…";
      try {
        await api(`/api/bounties/${id}/refresh`, { method: "POST" });
        openDetail(id, false);
        await load();
      } catch (err) { toast(err.message); }
    });
  } catch (err) {
    detailBody.innerHTML = `<div class="error-box">Couldn't load this bounty.<button id="detail-retry">Try Again</button></div>`;
    document.getElementById("detail-retry").addEventListener("click", () => openDetail(id, fromDiscover));
  }
}

// --- add form ----------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Tracking…";
  try {
    await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: input.value }) });
    input.value = "";
    toast("Tracking added");
    await load();
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Track";
  }
});

// --- Telegram connect ----------------------------------------------------------------
async function refreshTelegramButton() {
  try {
    const status = await api("/api/telegram/status");
    if (status.connected) {
      tgLabel.textContent = "Telegram connected";
      tgBtn.classList.add("connected");
      tgBtn.onclick = null;
    }
  } catch (_) {}
}
tgBtn.addEventListener("click", async () => {
  try {
    const { url } = await api("/api/telegram/link");
    window.open(url, "_blank");
    let attempts = 0;
    const iv = setInterval(async () => {
      attempts += 1;
      await refreshTelegramButton();
      if (tgBtn.classList.contains("connected") || attempts > 20) clearInterval(iv);
    }, 3000);
  } catch (err) {
    toast(err.message);
  }
});
if (TG_INIT_DATA) {
  tgLabel.textContent = "Telegram connected";
  tgBtn.classList.add("connected");
  tgBtn.onclick = null;
} else {
  refreshTelegramButton();
}

load();
refreshNewBountyToggle();
refreshBadges();
setInterval(refreshBadges, 60000);
