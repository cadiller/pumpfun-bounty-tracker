const cron = require("node-cron");
const { fetchBountyStatus } = require("./scraper");
const { upsertBounty, allBounties, subscribersFor } = require("./store");
const { notifyChat } = require("./telegram");

const STATUS_LABEL = {
  open: "is now OPEN",
  ended: "has ENDED (awaiting ruling)",
  ruled: "has been RULED",
  paid: "has been PAID OUT \u2705",
  closed: "was CLOSED",
  unknown: "status could not be read",
};

async function checkOne(bounty) {
  try {
    const status = await fetchBountyStatus(bounty.id);
    const { changed, previousStatus } = upsertBounty(status);
    if (changed) {
      console.log(`[poller] ${bounty.id}: ${previousStatus} -> ${status.status}`);
      const chats = subscribersFor(bounty.id);
      const label = STATUS_LABEL[status.status] || `changed to ${status.status}`;
      const text =
        `\ud83d\udd14 "${status.title || bounty.id}" ${label}\n${status.url}` +
        (status.summary ? `\n\n${status.summary.slice(0, 300)}` : "");
      for (const chatId of chats) {
        await notifyChat(chatId, text);
      }
    }
  } catch (err) {
    console.error(`[poller] failed to check ${bounty.id}:`, err.message);
  }
}

function startPoller() {
  const minutes = Number(process.env.POLL_INTERVAL_MINUTES || 5);
  const cronExpr = `*/${minutes} * * * *`;

  console.log(`[poller] checking tracked bounties every ${minutes} min`);

  cron.schedule(cronExpr, async () => {
    const bounties = allBounties();
    for (const b of bounties) {
      await checkOne(b);
    }
  });
}

module.exports = { startPoller, checkOne };
