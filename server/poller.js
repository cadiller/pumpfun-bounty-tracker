const cron = require("node-cron");
const { fetchBountyStatus, discoverNewBounties, extractBountyId } = require("./scraper");
const {
  upsertBounty,
  getBounty,
  trackedBountyIds,
  notifiableTrackersFor,
  allNewBountySubscribers,
} = require("./store");
const { notifyChat, STAGE_LABEL, describeOutcome, formatBountyDetail } = require("./telegram");

async function checkOne(bountyId) {
  try {
    const scraped = await fetchBountyStatus(bountyId);
    const { changed, previousStage } = upsertBounty(scraped);
    if (changed) {
      console.log(`[poller] ${bountyId}: ${previousStage} -> ${scraped.stage}`);
      const ownerKeys = notifiableTrackersFor(bountyId);
      const label = STAGE_LABEL[scraped.stage] || scraped.stage;
      const outcomeText = describeOutcome({ outcome: scraped.outcome, winners_count: scraped.winnersCount });
      const stageLine = outcomeText ? `${label} — ${outcomeText}` : label;
      const text =
        `\ud83d\udd14 "${scraped.title || bountyId}" is now ${stageLine}\n${scraped.url}` +
        (scraped.summary ? `\n\n${scraped.summary.slice(0, 300)}` : "");
      for (const ownerKey of ownerKeys) {
        if (ownerKey.startsWith("tg:")) await notifyChat(ownerKey.slice(3), text);
        // web:<uid>-only owners have no Telegram chat to message; they'll
        // see the change next time they open the site/Mini App instead.
      }
    }
  } catch (err) {
    console.error(`[poller] failed to check ${bountyId}:`, err.message);
  }
}

async function checkAllTracked() {
  const ids = trackedBountyIds();
  for (const id of ids) await checkOne(id);
}

async function checkForNewBounties() {
  const urls = await discoverNewBounties();
  if (!urls.length) return;

  const subscribers = allNewBountySubscribers();
  for (const url of urls) {
    const id = extractBountyId(url);
    if (!id) continue;
    const existing = getBounty(id);
    if (existing) continue; // already known, not new

    try {
      const scraped = await fetchBountyStatus(id);
      upsertBounty(scraped);
      if (!subscribers.length) continue;

      const text = `\ud83c\udd95 New bounty!\n\n${formatBountyDetail(scraped)}`;

      for (const ownerKey of subscribers) {
        if (ownerKey.startsWith("tg:")) await notifyChat(ownerKey.slice(3), text);
      }
    } catch (err) {
      console.error(`[poller] failed to process discovered bounty ${id}:`, err.message);
    }
  }
}

function startPoller() {
  const minutes = Number(process.env.POLL_INTERVAL_MINUTES || 5);
  const cronExpr = `*/${minutes} * * * *`;
  console.log(`[poller] checking tracked bounties every ${minutes} min`);

  cron.schedule(cronExpr, async () => {
    await checkAllTracked();
    await checkForNewBounties();
  });
}

module.exports = { startPoller, checkOne };
