// --- Telegram Mini App identity ------------------------------------------
const tgWebApp = window.Telegram?.WebApp;
const TG_INIT_DATA = tgWebApp?.initData || null;
if (tgWebApp) {
  tgWebApp.ready();
  tgWebApp.expand();
}

// --- theme (persisted) -----------------------------------------------------
const THEME_KEY = "bounty-watch-theme";
function applyTheme(theme) {
  document.body.setAttribute("data-theme", theme);
  localStorage.setItem(THEME_KEY, theme);
}
applyTheme(localStorage.getItem(THEME_KEY) || "dark");
document.getElementById("theme-btn").addEventListener("click", () => {
  const next = document.body.getAttribute("data-theme") === "dark" ? "light" : "dark";
  applyTheme(next);
});

// --- stage bucketing (4 groups the UI shows) --------------------------------
const STAGE_GROUP = {
  live: "live",
  submissions_closed: "ended",
  decision_posted: "ended",
  dispute_window: "dispute",
  finalizing_payout: "dispute",
  claimable: "paid",
  paid: "paid",
  closed_no_winner: "paid",
  closed: "paid",
  unknown: "unknown",
};
const STAGE_ORDER = ["live", "ended", "dispute", "paid"];
const BADGE_LABEL = { live: "LIVE", ended: "ENDED", dispute: "IN DISPUTE", paid: "PAID OUT", unknown: "UNKNOWN" };

function outcomeText(bounty) {
  if (bounty.outcome === "refunded") return "Refunded — no valid winner";
  if (bounty.outcome === "paid" && bounty.winners_count) {
    return `Paid to ${bounty.winners_count} winner${bounty.winners_count === 1 ? "" : "s"}`;
  }
  if (bounty.outcome === "paid") return "Paid out";
  return null;
}

function subText(bounty) {
  const bits = [];
  if (bounty.reward_usd) bits.push(`$${bounty.reward_usd}`);
  const out = outcomeText(bounty);
  if (out) bits.push(out);
  else if (bounty.deadline_text) bits.push(bounty.deadline_text);
  return bits.join(" · ") || "No details yet";
}

// --- DOM refs ----------------------------------------------------------------
const form = document.getElementById("add-form");
const input = document.getElementById("url-input");
const formError = document.getElementById("form-error");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const cardTemplate = document.getElementById("card-template");
const discoverTemplate = document.getElementById("discover-card-template");
const discoverList = document.getElementById("discover-list");
const discoverEmpty = document.getElementById("discover-empty");
const newBountyToggle = document.getElementById("new-bounty-toggle");
const tgBtn = document.getElementById("telegram-btn");
const tgLabel = document.getElementById("tg-label");
const statTracked = document.getElementById("stat-tracked");
const statLive = document.getElementById("stat-live");
const statPaid = document.getElementById("stat-paid");

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (TG_INIT_DATA) headers["X-Telegram-Init-Data"] = TG_INIT_DATA;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let lastLoadedBounties = [];

function renderCard(bounty) {
  const node = cardTemplate.content.cloneNode(true);
  const group = STAGE_GROUP[bounty.stage] || "unknown";
  const idx = STAGE_ORDER.indexOf(group);

  const titleBtn = node.querySelector(".bc-title");
  titleBtn.textContent = bounty.title || bounty.id;
  titleBtn.addEventListener("click", () => openDetail(bounty.id));

  node.querySelector(".ext-link").href = bounty.url;

  const badge = node.querySelector(".badge");
  badge.textContent = BADGE_LABEL[group];
  badge.dataset.b = group;

  node.querySelector(".bc-sub").textContent = subText(bounty);
  node.querySelector(".submissions").textContent = `${bounty.submissions_count ?? 0} submissions`;

  const fill = node.querySelector(".progress-fill");
  fill.style.width = idx >= 0 ? `${((idx + 1) / STAGE_ORDER.length) * 100}%` : "0%";
  node.querySelectorAll(".progress-labels span").forEach((el) => {
    el.classList.toggle("on", el.dataset.stage === group);
  });

  const notifyBtn = node.querySelector(".notify-btn");
  notifyBtn.classList.toggle("active", Boolean(bounty.notify));
  notifyBtn.textContent = bounty.notify ? "Notifying ✓" : "Notify me";
  notifyBtn.addEventListener("click", async () => {
    try {
      await api(`/api/bounties/${bounty.id}/notify`, { method: "POST", body: JSON.stringify({ notify: !bounty.notify }) });
      await load();
    } catch (err) { alert(err.message); }
  });

  node.querySelector(".refresh-btn").addEventListener("click", async (e) => {
    e.target.textContent = "Checking…";
    e.target.disabled = true;
    try {
      await api(`/api/bounties/${bounty.id}/refresh`, { method: "POST" });
      await load();
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
      e.target.textContent = "Check now";
    }
  });

  node.querySelector(".del-btn").addEventListener("click", async () => {
    if (!confirm("Stop tracking this bounty? Removes it everywhere - site, Mini App, and bot.")) return;
    try {
      await api(`/api/bounties/${bounty.id}`, { method: "DELETE" });
      await load();
    } catch (err) { alert(err.message); }
  });

  return node;
}

async function load() {
  const bounties = await api("/api/bounties");
  lastLoadedBounties = bounties;
  list.innerHTML = "";
  empty.hidden = bounties.length > 0;
  for (const b of bounties) list.appendChild(renderCard(b));

  statTracked.textContent = bounties.length;
  statLive.textContent = bounties.filter((b) => STAGE_GROUP[b.stage] === "live").length;
  const paidTotal = bounties
    .filter((b) => b.outcome === "paid" && b.reward_usd)
    .reduce((sum, b) => sum + b.reward_usd, 0);
  statPaid.textContent = `$${Math.round(paidTotal)}`;
}

function renderDiscoverCard(bounty) {
  const node = discoverTemplate.content.cloneNode(true);
  const group = STAGE_GROUP[bounty.stage] || "unknown";

  const titleBtn = node.querySelector(".bc-title");
  titleBtn.textContent = bounty.title || bounty.id;
  titleBtn.addEventListener("click", () => openDetail(bounty.id, bounty));

  node.querySelector(".ext-link").href = bounty.url;

  const badge = node.querySelector(".badge");
  badge.textContent = BADGE_LABEL[group];
  badge.dataset.b = group;

  node.querySelector(".bc-sub").textContent = subText(bounty);

  node.querySelector(".track-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Tracking…";
    try {
      await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: bounty.url }) });
      await load();
      await loadDiscover();
    } catch (err) {
      alert(err.message);
      e.target.disabled = false;
      e.target.textContent = "Track it";
    }
  });

  return node;
}

async function loadDiscover() {
  try {
    const bounties = await api("/api/discover");
    discoverList.innerHTML = "";
    discoverEmpty.hidden = bounties.length > 0;
    for (const b of bounties) discoverList.appendChild(renderDiscoverCard(b));
  } catch (_) { /* best-effort */ }
}

// --- detail modal ------------------------------------------------------------
const modalBackdrop = document.getElementById("modal-backdrop");
const modalTitle = document.getElementById("modal-title");
const modalBadge = document.getElementById("modal-badge");
const modalReward = document.getElementById("modal-reward");
const modalSubmissions = document.getElementById("modal-submissions");
const modalTimeLeft = document.getElementById("modal-time-left");
const modalTimeLeftText = document.getElementById("modal-time-left-text");
const modalSplit = document.getElementById("modal-split");
const modalSplitText = document.getElementById("modal-split-text");
const modalOutcome = document.getElementById("modal-outcome");
const modalOutcomeText = document.getElementById("modal-outcome-text");
const modalDescription = document.getElementById("modal-description");
const modalDescriptionText = document.getElementById("modal-description-text");
const modalDeliverables = document.getElementById("modal-deliverables");
const modalDeliverablesText = document.getElementById("modal-deliverables-text");
const modalHistory = document.getElementById("modal-history");
const modalOpen = document.getElementById("modal-open");
const modalUntrack = document.getElementById("modal-untrack");
const modalRefresh = document.getElementById("modal-refresh");

let currentModalBountyId = null;

async function openDetail(bountyId, fallbackBounty) {
  currentModalBountyId = bountyId;
  const bounty = lastLoadedBounties.find((b) => b.id === bountyId) || fallbackBounty;
  if (!bounty) return;
  fillModal(bounty);
  modalBackdrop.hidden = false;

  try {
    const history = await api(`/api/bounties/${bountyId}/history`);
    modalHistory.innerHTML = "";
    if (!history.length) {
      modalHistory.innerHTML = '<div class="history-row">No history yet</div>';
    } else {
      for (const h of history.slice().reverse()) {
        const group = STAGE_GROUP[h.stage] || "unknown";
        const row = document.createElement("div");
        row.className = "history-row";
        const when = new Date(h.changed_at.replace(" ", "T") + "Z").toLocaleString();
        row.innerHTML = `<span class="h-stage">${BADGE_LABEL[group] || h.stage}</span><span>${when}</span>`;
        modalHistory.appendChild(row);
      }
    }
  } catch (_) {
    modalHistory.innerHTML = '<div class="history-row">Couldn\'t load history</div>';
  }
}

function fillModal(bounty) {
  const group = STAGE_GROUP[bounty.stage] || "unknown";
  modalTitle.textContent = bounty.title || bounty.id;
  modalBadge.textContent = BADGE_LABEL[group];
  modalBadge.dataset.b = group;
  modalReward.textContent = bounty.reward_usd ? `$${bounty.reward_usd}` : "—";
  modalSubmissions.textContent = bounty.submissions_count ?? 0;

  if (group === "live" && bounty.deadline_text) {
    modalTimeLeft.hidden = false;
    modalTimeLeftText.textContent = bounty.deadline_text;
  } else {
    modalTimeLeft.hidden = true;
  }

  if (bounty.split_text) {
    modalSplit.hidden = false;
    modalSplitText.textContent = bounty.split_text;
  } else {
    modalSplit.hidden = true;
  }

  const out = outcomeText(bounty);
  if (out) {
    modalOutcome.hidden = false;
    modalOutcomeText.textContent = out;
  } else {
    modalOutcome.hidden = true;
  }

  if (bounty.description) {
    modalDescription.hidden = false;
    modalDescriptionText.textContent = bounty.description;
  } else {
    modalDescription.hidden = true;
  }

  if (bounty.deliverables) {
    modalDeliverables.hidden = false;
    modalDeliverablesText.textContent = bounty.deliverables;
  } else {
    modalDeliverables.hidden = true;
  }

  modalOpen.href = bounty.url;
}

document.getElementById("modal-close").addEventListener("click", () => { modalBackdrop.hidden = true; });
modalBackdrop.addEventListener("click", (e) => { if (e.target === modalBackdrop) modalBackdrop.hidden = true; });

modalUntrack.addEventListener("click", async () => {
  if (!currentModalBountyId) return;
  if (!confirm("Stop tracking this bounty? Removes it everywhere - site, Mini App, and bot.")) return;
  try {
    await api(`/api/bounties/${currentModalBountyId}`, { method: "DELETE" });
    modalBackdrop.hidden = true;
    await load();
  } catch (err) { alert(err.message); }
});

modalRefresh.addEventListener("click", async () => {
  if (!currentModalBountyId) return;
  modalRefresh.textContent = "Checking…";
  modalRefresh.disabled = true;
  try {
    await api(`/api/bounties/${currentModalBountyId}/refresh`, { method: "POST" });
    await load();
    await openDetail(currentModalBountyId);
  } catch (err) {
    alert(err.message);
  } finally {
    modalRefresh.textContent = "Check now";
    modalRefresh.disabled = false;
  }
});

// --- new-bounty alert toggle --------------------------------------------------
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
    await refreshNewBountyToggle();
  } catch (err) { alert(err.message); }
});

// --- add form ------------------------------------------------------------------
form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Tracking…";
  try {
    await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: input.value }) });
    input.value = "";
    await load();
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Track";
  }
});

// --- telegram connect ------------------------------------------------------------
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
    alert(err.message + "\n\nMake sure TELEGRAM_BOT_TOKEN and TELEGRAM_BOT_USERNAME are set on the server.");
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
loadDiscover();
refreshNewBountyToggle();
