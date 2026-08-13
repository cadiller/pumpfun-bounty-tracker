const { Telegraf } = require("telegraf");
const db = require("./db");
const { fetchBountyStatus, extractBountyId } = require("./scraper");
const {
  upsertBounty,
  trackForOwner,
  untrackForOwner,
  listTrackedForOwner,
  subscribeNewBounties,
  unsubscribeNewBounties,
  isSubscribedToNewBounties,
} = require("./store");

let bot = null;

const STAGE_LABEL = {
  live: "OPEN",
  submissions_closed: "SUBMISSIONS CLOSED",
  decision_posted: "DECISION POSTED",
  dispute_window: "DISPUTE WINDOW",
  finalizing_payout: "FINALIZING PAYOUT",
  claimable: "CLAIMABLE",
  paid: "PAID",
  closed_no_winner: "CLOSED (no winner)",
  closed: "CLOSED",
  unknown: "UNKNOWN",
};

function initTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set - notifications disabled.");
    return null;
  }

  bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const payload = ctx.startPayload;
    if (payload) {
      const row = db.prepare("SELECT * FROM link_codes WHERE code = ?").get(payload);
      if (row) {
        db.prepare("UPDATE link_codes SET telegram_chat_id = ? WHERE code = ?").run(
          String(ctx.chat.id),
          payload
        );
        return ctx.reply(
          "Connected! Head back to the site - your tracked bounties will now show up there too."
        );
      }
    }
    return ctx.reply(
      "Welcome to Bounty Watch.\n\n" +
        "Paste a pump.fun bounty link and I'll track it and DM you here the moment its stage changes " +
        "(submissions closed, decision posted, dispute window, payout finalizing, claimable).\n\n" +
        "Commands:\n" +
        "/list - your tracked bounties\n" +
        "/untrack <id or link> - stop tracking one (removes it everywhere, incl. the Mini App)\n" +
        "/newbounties on|off - get pinged when a brand new bounty is published"
    );
  });

  bot.command("list", async (ctx) => {
    const ownerKey = `tg:${ctx.chat.id}`;
    const rows = listTrackedForOwner(ownerKey);
    if (!rows.length) return ctx.reply("You're not tracking any bounties yet. Paste a link to start.");
    const lines = rows.map(
      (b) => `• ${b.title || b.id} — ${STAGE_LABEL[b.stage] || b.stage}\n  ${b.url}`
    );
    return ctx.reply(lines.join("\n\n"));
  });

  bot.command("untrack", async (ctx) => {
    const arg = ctx.message.text.split(" ").slice(1).join(" ").trim();
    const id = extractBountyId(arg) || arg;
    if (!id) return ctx.reply("Usage: /untrack <bounty id or link>");
    untrackForOwner(`tg:${ctx.chat.id}`, id);
    return ctx.reply(`Stopped tracking ${id}. It's gone from your list on the site and Mini App too.`);
  });

  bot.command("newbounties", async (ctx) => {
    const arg = ctx.message.text.split(" ").slice(1).join(" ").trim().toLowerCase();
    const ownerKey = `tg:${ctx.chat.id}`;
    if (arg === "off") {
      unsubscribeNewBounties(ownerKey);
      return ctx.reply("Okay, you won't get new-bounty alerts anymore.");
    }
    if (arg === "on" || !arg) {
      subscribeNewBounties(ownerKey);
      return ctx.reply("You're in - I'll message you here whenever a brand new bounty is published.");
    }
    return ctx.reply("Usage: /newbounties on  or  /newbounties off");
  });

  bot.on("text", async (ctx) => {
    const id = extractBountyId(ctx.message.text);
    if (!id) return;
    try {
      await ctx.reply("Checking that bounty...");
      const scraped = await fetchBountyStatus(id);
      upsertBounty(scraped);
      trackForOwner(`tg:${ctx.chat.id}`, scraped.id, 1);
      return ctx.reply(
        `Tracking "${scraped.title || scraped.id}"\nStage: ${STAGE_LABEL[scraped.stage] || scraped.stage}\n${scraped.url}\n\n` +
          "I'll message you here when this changes."
      );
    } catch (err) {
      return ctx.reply(`Couldn't read that bounty: ${err.message}`);
    }
  });

  bot.launch();
  console.log("[telegram] bot launched");
  process.once("SIGINT", () => bot.stop("SIGINT"));
  process.once("SIGTERM", () => bot.stop("SIGTERM"));
  return bot;
}

async function notifyChat(chatId, text) {
  if (!bot) return;
  try {
    await bot.telegram.sendMessage(chatId, text);
  } catch (err) {
    console.error(`[telegram] failed to notify ${chatId}:`, err.message);
  }
}

module.exports = { initTelegram, notifyChat, STAGE_LABEL };
