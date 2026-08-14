const cron = require("node-cron");
const { fetchBountyStatus, discoverNewBounties, extractBountyId, parseHoursRemaining } = require("./scraper");
const {
  upsertBounty,
  getBounty,
  trackedBountyIds,
  notifiableTrackersFor,
  allNewBountySubscribers,
  addNotification,
  markEndingSoonNotified,
} = require("./store");
const { notifyChat, STAGE_LABEL, describeOutcome } = require("./telegram");

const ENDING_SOON_HOURS = 24;

async function checkOne(bountyId) {
  try {
    const scraped = await fetchBountyStatus(bountyId);
    // Preserve whatever source this bounty already had (manual vs
    // discovered) - upsertBounty ignores the source arg on existing rows.
    const { changed, previousStage, wasEndingSoonNotified } = upsertBounty(scraped, "manual");

    const label = STAGE_LABEL[scraped.stage] || scraped.stage;
    const outcomeText = describeOutcome({ outcome: scraped.outcome, winners_count: scraped.winnersCount });
    const stageLine = outcomeText ? `${label} — ${outcomeText}` : label;

    if (changed) {
      console.log(`[poller] ${bountyId}: ${previousStage} -> ${scraped.stage}`);
      const ownerKeys = notifiableTrackersFor(bountyId);
      const text = `\ud83d\udd14 "${scraped.title || bountyId}" is now ${stageLine}\n${scraped.url}` +
        (scraped.summary ? `\n\n${scraped.summary.slice(0, 300)}` : "");
      const notifType = scraped.outcome === "paid" || scraped.outcome === "refunded" ? "paid" : "status_change";

      for (const ownerKey of ownerKeys) {
        addNotification(ownerKey, notifType, bountyId, `"${scraped.title || bountyId}" is now ${label}`, outcomeText || scraped.summary);
        if (ownerKey.startsWith("tg:")) await notifyChat(ownerKey.slice(3), text);
      }
    }

    // Ending-soon check: only for bounties still live, only fires once per
    // bounty (tracked via ending_soon_notified) to avoid repeat spam.
    if (scraped.stage === "live" && !wasEndingSoonNotified) {
      const hoursLeft = parseHoursRemaining(scraped.deadlineText);
      if (hoursLeft !== null && hoursLeft <= ENDING_SOON_HOURS) {
        markEndingSoonNotified(bountyId);
        const ownerKeys = notifiableTrackersFor(bountyId);
        const text = `\u26a0\ufe0f "${scraped.title || bountyId}" is ending soon (${scraped.deadlineText})\n${scraped.url}`;
        for (const ownerKey of ownerKeys) {
          addNotification(ownerKey, "ending_soon", bountyId, `"${scraped.title || bountyId}" is ending soon`, scraped.deadlineText);
          if (ownerKey.startsWith("tg:")) await notifyChat(ownerKey.slice(3), text);
        }
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
    if (existing) continue; // already known (whether manual or discovered) - not new

    try {
      const scraped = await fetchBountyStatus(id);
      // First time this id has been seen, and it came from the discovery
      // scan - tag it 'discovered' so it only shows in Discover feeds and
      // never gets attributed to whichever user happens to poll it first.
      upsertBounty(scraped, "discovered");

      if (!subscribers.length) continue;
      const parts = [`\ud83c\udd95 New bounty: "${scraped.title || id}"`];
      if (scraped.rewardUsd) parts.push(`Reward pool: $${scraped.rewardUsd}`);
      if (scraped.winnersCount) parts.push(`Split between ${scraped.winnersCount} winner(s)`);
      parts.push(scraped.url);
      if (scraped.summary) parts.push(scraped.summary.slice(0, 300));
      const text = parts.join("\n");

      for (const ownerKey of subscribers) {
        addNotification(ownerKey, "new_bounty", id, `New bounty: "${scraped.title || id}"`, scraped.summary);
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
