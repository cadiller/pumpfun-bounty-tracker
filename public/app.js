// If opened inside Telegram as a Mini App, expand to full height and use
// Telegram's signed initData to identify the user securely (no linking
// needed - this is what fixes bounties leaking across different accounts).
const tgWebApp = window.Telegram?.WebApp;
const TG_INIT_DATA = tgWebApp?.initData || null;
if (tgWebApp) {
  tgWebApp.ready();
  tgWebApp.expand();
}

const STAGE_GROUP = {
  live: "live",
  submissions_closed: "review",
  decision_posted: "review",
  dispute_window: "dispute",
  finalizing_payout: "dispute",
  claimable: "done",
  paid: "done",
  closed_no_winner: "done",
  closed: "done",
  unknown: "live",
};
const STAGE_ORDER = ["live", "review", "dispute", "done"];
const STAGE_LABEL = {
  live: "LIVE",
  submissions_closed: "SUBMISSIONS CLOSED",
  decision_posted: "DECISION POSTED",
  dispute_window: "DISPUTE WINDOW",
  finalizing_payout: "FINALIZING PAYOUT",
  claimable: "CLAIMABLE",
  paid: "PAID",
  closed_no_winner: "CLOSED",
  closed: "CLOSED",
  unknown: "UNKNOWN",
};

const form = document.getElementById("add-form");
const input = document.getElementById("url-input");
const formError = document.getElementById("form-error");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const count = document.getElementById("count");
const template = document.getElementById("card-template");
const tgBtn = document.getElementById("telegram-btn");

const discoverList = document.getElementById("discover-list");
const discoverEmpty = document.getElementById("discover-empty");
const discoverTemplate = document.getElementById("discover-card-template");
const newBountyToggle = document.getElementById("new-bounty-toggle");

async function api(path, options = {}) {
  const headers = { "Content-Type": "application/json", ...(options.headers || {}) };
  if (TG_INIT_DATA) headers["X-Telegram-Init-Data"] = TG_INIT_DATA;
  const res = await fetch(path, { ...options, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function timeAgo(iso) {
  if (!iso) return "never checked";
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "checked just now";
  if (mins < 60) return `checked ${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `checked ${hrs}h ago`;
  return `checked ${Math.round(hrs / 24)}d ago`;
}

function renderCard(bounty) {
  const node = template.content.cloneNode(true);
  const li = node.querySelector(".card");
  li.dataset.id = bounty.id;

  const group = STAGE_GROUP[bounty.stage] || "live";
  const idx = STAGE_ORDER.indexOf(group);
  node.querySelectorAll(".stop").forEach((el, i) => {
    el.classList.toggle("lit", i <= idx);
    el.classList.toggle("current", i === idx);
  });

  const titleEl = node.querySelector(".title");
  titleEl.textContent = bounty.title || bounty.id;
  titleEl.href = bounty.url;

  const pill = node.querySelector(".status-pill");
  pill.textContent = STAGE_LABEL[bounty.stage] || (bounty.stage || "unknown").toUpperCase();
  pill.dataset.status = bounty.stage;

  node.querySelector(".summary").textContent = bounty.raw_summary || "No summary available yet.";
  node.querySelector(".deadline").textContent = bounty.deadline_text || "\u2014";
  node.querySelector(".checked").textContent = timeAgo(bounty.last_checked_at);

  const bell = node.querySelector(".bell");
  bell.classList.toggle("active", Boolean(bounty.notify));
  bell.textContent = bounty.notify ? "Notifying \u2713" : "Notify me";
  bell.addEventListener("click", async () => {
    try {
      await api(`/api/bounties/${bounty.id}/notify`, {
        method: "POST",
        body: JSON.stringify({ notify: !bounty.notify }),
      });
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  node.querySelector(".refresh").addEventListener("click", async (e) => {
    e.target.textContent = "Checking\u2026";
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

  node.querySelector(".delete").addEventListener("click", async () => {
    if (!confirm("Stop tracking this bounty? This removes it everywhere - site, Mini App, and bot.")) return;
    try {
      await api(`/api/bounties/${bounty.id}`, { method: "DELETE" });
      await load();
    } catch (err) {
      alert(err.message);
    }
  });

  return node;
}

async function load() {
  const bounties = await api("/api/bounties");
  list.innerHTML = "";
  empty.hidden = bounties.length > 0;
  count.textContent = `${bounties.length} tracked`;
  for (const b of bounties) list.appendChild(renderCard(b));
}

function renderDiscoverCard(bounty) {
  const node = discoverTemplate.content.cloneNode(true);
  const titleEl = node.querySelector(".title");
  titleEl.textContent = bounty.title || bounty.id;
  titleEl.href = bounty.url;

  const pill = node.querySelector(".status-pill");
  pill.textContent = STAGE_LABEL[bounty.stage] || (bounty.stage || "unknown").toUpperCase();
  pill.dataset.status = bounty.stage;

  node.querySelector(".summary").textContent = bounty.raw_summary || "No summary available yet.";

  node.querySelector(".track-btn").addEventListener("click", async (e) => {
    e.target.disabled = true;
    e.target.textContent = "Tracking\u2026";
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
  } catch (_) {
    /* discovery is best-effort; fail quietly */
  }
}

async function refreshNewBountyToggle() {
  try {
    const { subscribed } = await api("/api/new-bounties/status");
    newBountyToggle.classList.toggle("on", subscribed);
    newBountyToggle.textContent = subscribed ? "Alerting \u2713" : "Alert me";
  } catch (_) {}
}

newBountyToggle.addEventListener("click", async () => {
  const isOn = newBountyToggle.classList.contains("on");
  try {
    await api(`/api/new-bounties/${isOn ? "unsubscribe" : "subscribe"}`, { method: "POST" });
    await refreshNewBountyToggle();
  } catch (err) {
    alert(err.message);
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  formError.hidden = true;
  const btn = form.querySelector("button");
  btn.disabled = true;
  btn.textContent = "Tracking\u2026";
  try {
    await api("/api/bounties", { method: "POST", body: JSON.stringify({ url: input.value }) });
    input.value = "";
    await load();
  } catch (err) {
    formError.textContent = err.message;
    formError.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = "Track it";
  }
});

async function refreshTelegramButton() {
  try {
    const status = await api("/api/telegram/status");
    if (status.connected) {
      tgBtn.textContent = "Telegram connected \u2713";
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

// If we're already inside the Mini App, there's nothing to "connect" -
// Telegram identified us automatically, so hide the connect button.
if (TG_INIT_DATA) {
  tgBtn.textContent = "Telegram connected \u2713";
  tgBtn.classList.add("connected");
  tgBtn.onclick = null;
} else {
  refreshTelegramButton();
}

load();
loadDiscover();
refreshNewBountyToggle();
