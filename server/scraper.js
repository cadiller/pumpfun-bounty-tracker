/**
 * pump.fun has no documented public API for bounty details, so this reads
 * the bounty page itself (https://pump.fun/go/<id>) and works out status
 * from whatever text/JSON it ships in the HTML.
 *
 * TWO LAYERS:
 *  1. COARSE status (open/ended/ruled/paid/closed) - this is the part that's
 *     been tested against real bounties and confirmed working. It reads the
 *     og:description/meta summary pump.fun writes for link-preview purposes.
 *  2. FINE-GRAINED stage (live/submissions_closed/decision_posted/
 *     dispute_window/finalizing_payout/claimable/closed_no_winner) - this is
 *     NEW and UNCONFIRMED. The detailed per-step timeline (the one with
 *     dollar breakdown and "Submissions closed / Initial decision posted /
 *     Dispute window closed / ..." steps) may only render client-side via
 *     JavaScript, in which case a plain HTTP fetch won't see it at all.
 *     If that's the case, `stage` quietly falls back to a value derived
 *     from the coarse status instead of breaking anything. Test this against
 *     a few real bounties and tell me what actually comes back - that's the
 *     fastest way to tune the STAGE_PATTERNS list below.
 */

const cheerio = require("cheerio");

const BOUNTY_URL_RE = /pump\.fun\/go\/([a-zA-Z0-9-]+)/i;

function extractBountyId(input) {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(BOUNTY_URL_RE);
  if (match) return match[1];
  if (/^[a-zA-Z0-9-]{6,}$/.test(trimmed)) return trimmed;
  return null;
}

function canonicalUrl(id) {
  return `https://pump.fun/go/${id}`;
}

function findBountyFields(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const keys = Object.keys(node);
  const looksLikeBounty = keys.some((k) => /bounty|reward|deadline|winner|ruling/i.test(k));
  if (looksLikeBounty) {
    return {
      title: node.title || node.name || null,
      rewardText: node.rewardText || node.reward || null,
      status: node.status || null,
      deadline: node.deadline || node.endsAt || node.endDate || null,
      winner: node.winner || null,
    };
  }
  for (const k of keys) {
    const found = findBountyFields(node[k], depth + 1);
    if (found) return found;
  }
  return null;
}

function extractSummary(html) {
  const $ = cheerio.load(html);

  let jsonSummary = null;
  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    try {
      jsonSummary = findBountyFields(JSON.parse(nextData));
    } catch (_) {
      /* fall through */
    }
  }

  const metaDescription =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    "";
  const title = $('meta[property="og:title"]').attr("content") || $("title").first().text() || "";
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title: (jsonSummary && jsonSummary.title) || title.trim(),
    rewardText: jsonSummary && jsonSummary.rewardText,
    text: metaDescription.trim() || bodyText.slice(0, 4000),
    bodyText, // full page text, used for the fine-grained stage/field guesses
    json: jsonSummary,
  };
}

/** Coarse status: open | ended | ruled | paid | closed | unknown */
function classifyStatus({ text, json }) {
  const t = (text || "").toLowerCase();

  if (json && json.status) {
    const s = String(json.status).toLowerCase();
    if (/paid/.test(s)) return "paid";
    if (/rul/.test(s)) return "ruled";
    if (/clos|end|complet|expir/.test(s)) return "closed";
    if (/open|active|live/.test(s)) return "open";
  }

  if (/paid out|payout receipts|reward was paid/.test(t)) return "paid";
  if (/full ruling|ruling, evidence/.test(t)) return "ruled";
  if (/this bounty is closed|bounty has ended|bounty closed/.test(t)) return "closed";
  if (/\bends? in\b|\bleft\b|time remaining|days? left|hours? left/.test(t)) return "open";
  if (/no winner|expired without a winner|no valid submissions/.test(t)) return "closed";

  return "unknown";
}

// Ordered MOST-ADVANCED first. We scan for these phrases and take the
// furthest-along one found, since a fully rendered timeline page tends to
// mention earlier completed steps too (e.g. "Submissions closed" still
// appears in the text even once payout is finalizing).
const STAGE_PATTERNS = [
  ["paid", /paid out to|payout receipt|rewards? claimed/i],
  ["claimable", /rewards? claimable on-?chain|claimable now/i],
  ["finalizing_payout", /finaliz(?:e|ing) payout|platform finalizing payout/i],
  ["dispute_window", /dispute window/i],
  ["decision_posted", /initial decision posted|winners? picked|decision final/i],
  ["submissions_closed", /submissions closed/i],
  ["closed_no_winner", /no valid submissions|expired without a winner|no winner/i],
  ["live", /\bends? in\b|\bleft\b|time remaining|days? left|hours? left/i],
];

function classifyStage(bodyText, coarseStatus) {
  const t = bodyText || "";
  for (const [stage, pattern] of STAGE_PATTERNS) {
    if (pattern.test(t)) return stage;
  }
  // Fall back to something derived from the coarse status so the UI always
  // has *something* sensible even when the detailed timeline isn't visible
  // to a plain HTTP fetch (e.g. if it's client-rendered only).
  const fallback = { open: "live", ended: "submissions_closed", ruled: "finalizing_payout", paid: "paid", closed: "closed_no_winner", unknown: "unknown" };
  return fallback[coarseStatus] || "unknown";
}

/** Once a bounty is resolved: 'paid' | 'refunded' | null (not resolved yet) */
function classifyOutcome(bodyText, stage) {
  const t = bodyText || "";
  if (/refund(ed)?\s*(to creator)?/i.test(t)) return "refunded";
  if (/paid out to|payout receipt/i.test(t)) return "paid";
  if (stage === "closed_no_winner") return "refunded";
  if (stage === "claimable" || stage === "paid") return "paid";
  return null;
}

/** Best-effort extraction of $ reward, winners count, submissions count. */
function extractRichFields(bodyText) {
  const t = bodyText || "";
  const usdMatch = t.match(/\$([\d,]+\.\d{2})/);
  const winnersMatch = t.match(/(\d+)\s*winners?\s*(picked|selected)?/i);
  const submissionsMatch = t.match(/(\d+)\s*(entries|submissions)/i);
  return {
    rewardUsd: usdMatch ? parseFloat(usdMatch[1].replace(/,/g, "")) : null,
    winnersCount: winnersMatch ? parseInt(winnersMatch[1], 10) : null,
    submissionsCount: submissionsMatch ? parseInt(submissionsMatch[1], 10) : null,
  };
}

function extractDeadlineText(text) {
  if (!text) return null;
  const m = text.match(/(\d+\s*(?:day|hour|minute|hr|min)s?\s*left)|(\bends?\s+in\s+[^.]+)/i);
  return m ? m[0].trim() : null;
}

async function fetchBountyStatus(idOrUrl) {
  const id = extractBountyId(idOrUrl);
  if (!id) {
    throw new Error(
      "Could not find a pump.fun bounty id in that link. Expected something like https://pump.fun/go/<id>"
    );
  }
  const url = canonicalUrl(id);

  const res = await fetch(url, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });
  if (!res.ok) throw new Error(`pump.fun returned HTTP ${res.status} for ${url}`);

  const html = await res.text();
  const summary = extractSummary(html);
  const status = classifyStatus(summary);
  const stage = classifyStage(summary.bodyText, status);
  const outcome = classifyOutcome(summary.bodyText, stage);
  const rich = extractRichFields(summary.bodyText);
  const deadlineText = extractDeadlineText(summary.text);

  return {
    id,
    url,
    title: summary.title || null,
    rewardText: summary.rewardText || null,
    rewardUsd: rich.rewardUsd,
    winnersCount: rich.winnersCount,
    submissionsCount: rich.submissionsCount,
    status,
    stage,
    outcome,
    summary: summary.text,
    deadlineText,
  };
}

/**
 * EXPERIMENTAL - discovering brand new bounties as they're published.
 * pump.fun's own bounty-listing API (frontend-api-v3.pump.fun and similar)
 * requires an authenticated JWT tied to a logged-in wallet session, which
 * this app doesn't have. This function tries the public go.pump.fun page
 * as a best-effort fallback and simply returns an empty list if it can't
 * find anything - it will NOT crash the poller. Treat this as a starting
 * point to iterate on rather than a finished feature.
 */
async function discoverNewBounties() {
  try {
    const res = await fetch("https://pump.fun/go", {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const ids = new Set();
    const re = /pump\.fun\/go\/([a-zA-Z0-9-]{6,})/g;
    let m;
    while ((m = re.exec(html))) ids.add(m[1]);
    return [...ids].map(canonicalUrl);
  } catch (err) {
    console.error("[discoverNewBounties] failed:", err.message);
    return [];
  }
}

module.exports = {
  extractBountyId,
  canonicalUrl,
  fetchBountyStatus,
  discoverNewBounties,
  classifyStatus,
  classifyStage,
  classifyOutcome,
};
