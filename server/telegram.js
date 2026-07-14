const { Telegraf } = require("telegraf");
const db = require("./db");
const { fetchBountyStatus, extractBountyId } = require("./scraper");
const { upsertBounty, subscribe, listForChat, unsubscribe } = require("./store");

let bot = null;

function initTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log("[telegram] TELEGRAM_BOT_TOKEN not set - notifications disabled.");
    return null;
  }

  bot = new Telegraf(token);

  bot.start(async (ctx) => {
    const payload = ctx.startPayload; // link code from the website, if any
    if (payload) {
      const row = db.prepare("SELECT * FROM link_codes WHERE code = ?").get(payload);
      if (row) {
        db.prepare("UPDATE link_codes SET telegram_chat_id = ? WHERE code = ?").run(
          String(ctx.chat.id),
          payload
        );
        return ctx.reply(
          "Connected! Head back to the site - your tracked bounties will now notify you here.\n\n" +
            "You can also just paste a pump.fun bounty link right here any time, e.g.\n" +
            "https://pump.fun/go/<id>"
        );
      }
    }
    return ctx.reply(
      "Welcome to Bounty Watch.\n\n" +
        "Paste a pump.fun bounty link and I'll track it and DM you the moment its status changes " +
        "(ended / ruled / paid out).\n\n" +
        "Commands:\n" +
        "/list - your tracked bounties\n" +
        "/untrack <id> - stop tracking one"
    );
  });

  bot.command("list", async (ctx) => {
    const rows = listForChat(String(ctx.chat.id));
    if (!rows.length) return ctx.reply("You're not tracking any bounties yet. Paste a link to start.");
    const lines = rows.map(
      (b) => `• ${b.title || b.id} — ${b.status.toUpperCase()}\n  ${b.url}`
    );
    return ctx.reply(lines.join("\n\n"));
  });

  bot.command("untrack", async (ctx) => {
    const arg = ctx.message.text.split(" ").slice(1).join(" ").trim();
    const id = extractBountyId(arg) || arg;
    if (!id) return ctx.reply("Usage: /untrack <bounty id or link>");
    unsubscribe(id, String(ctx.chat.id));
    return ctx.reply(`Stopped tracking ${id}.`);
  });

  // Any message containing a pump.fun bounty link gets tracked automatically.
  bot.on("text", async (ctx) => {
    const id = extractBountyId(ctx.message.text);
    if (!id) return; // ignore unrelated chat
    try {
      await ctx.reply("Checking that bounty...");
      const status = await fetchBountyStatus(id);
      upsertBounty(status);
      subscribe(status.id, String(ctx.chat.id));
      return ctx.reply(
        `Tracking "${status.title || status.id}"\nStatus: ${status.status.toUpperCase()}\n${status.url}\n\n` +
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

module.exports = { initTelegram, notifyChat };
