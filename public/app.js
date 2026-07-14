// If opened inside Telegram as a Mini App, expand to full height.
if (window.Telegram?.WebApp) {
  window.Telegram.WebApp.ready();
  window.Telegram.WebApp.expand();
}

const STAGES = ["open", "ended", "ruled", "paid"];

const form = document.getElementById("add-form");
const input = document.getElementById("url-input");
const formError = document.getElementById("form-error");
const list = document.getElementById("list");
const empty = document.getElementById("empty");
const count = document.getElementById("count");
const template = document.getElementById("card-template");
const tgBtn = document.getElementById("telegram-btn");

async function api(path, options) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function stageIndex(status) {
  const i = STAGES.indexOf(status);
  return i === -1 ? (status === "closed" ? 1 : -1) : i;
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

  const idx = stageIndex(bounty.status);
  node.querySelectorAll(".stop").forEach((el, i) => {
    el.classList.toggle("lit", i <= idx);
    el.classList.toggle("current", i === idx);
  });

  const titleEl = node.querySelector(".title");
  titleEl.textContent = bounty.title || bounty.id;
  titleEl.href = bounty.url;

  const pill = node.querySelector(".status-pill");
  pill.textContent = (bounty.status || "unknown").toUpperCase();
  pill.dataset.status = bounty.status;

  node.querySelector(".summary").textContent = bounty.raw_summary || "No summary available yet.";
  node.querySelector(".deadline").textContent = bounty.deadline_text || "\u2014";
  node.querySelector(".checked").textContent = timeAgo(bounty.last_checked_at);

  const bell = node.querySelector(".bell");
  bell.classList.toggle("active", Boolean(bounty.subscribed));
  bell.textContent = bounty.subscribed ? "Notifying \u2713" : "Notify me";
  bell.addEventListener("click", async () => {
    try {
      if (bell.classList.contains("active")) {
        await api(`/api/bounties/${bounty.id}/unsubscribe`, { method: "POST" });
      } else {
        await api(`/api/bounties/${bounty.id}/subscribe`, { method: "POST" });
      }
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

  return node;
}

async function load() {
  const bounties = await api("/api/bounties");
  list.innerHTML = "";
  empty.hidden = bounties.length > 0;
  count.textContent = `${bounties.length} tracked`;
  for (const b of bounties) list.appendChild(renderCard(b));
}

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
  } catch (_) {
    /* endpoint not configured yet - leave default button state */
  }
}

tgBtn.addEventListener("click", async () => {
  try {
    const { url } = await api("/api/telegram/link");
    window.open(url, "_blank");
    // Poll for a bit in case the user comes back to this tab after connecting.
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

load();
refreshTelegramButton();
