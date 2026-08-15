/**
 * pump.fun has no documented public API for bounty details, so this reads
 * the bounty page itself (https://pump.fun/go/<id>) and works out status
 * from whatever text/JSON it ships in the HTML.
 *
 * Reliability notes (read before tweaking the regexes below):
 *  - The og:description meta tag pump.fun writes for link-preview purposes
 *    is the most trustworthy source - it's a clean, pre-written summary.
 *  - Raw page body text is NOT trusted for stage detection anymore. Static
 *    UI labels like "TIME LEFT" appear on every bounty page regardless of
 *    whether it's actually still live, so a loose scan of the whole body
 *    text produced false "live" results on already-ended bounties. Stage
 *    detection now only trusts the clean summary text, falling back to a
 *    status-derived guess (not a body-text scan) when the summary alone
 *    isn't specific enough.
 *  - <script>/<style> tags are stripped before any text extraction, since
 *    pump.fun's Next.js app embeds raw serialized data in inline <script>
 *    tags that would otherwise leak into "description" text as gibberish.
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

  // Strip script/style/noscript BEFORE reading any body text, or their raw
  // (often JSON-ish) contents leak straight into what we treat as prose.
  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title: (jsonSummary && jsonSummary.title) || title.trim(),
    rewardText: jsonSummary && jsonSummary.rewardText,
    text: metaDescription.trim() || bodyText.slice(0, 4000),
    bodyText,
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
  if (/no winner|expired without a winner|no valid submissions/.test(t)) return "closed";
  // Requires an actual digit next to a time unit - NOT just the bare word
  // "left", which also appears in the static "TIME LEFT" heading on every
  // bounty page regardless of whether it's actually still live.
  if (/\bends?\s+in\s+\d|\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?)\s*(?:left|remaining)/i.test(t))
    return "open";

  return "unknown";
}

// Ordered MOST-ADVANCED first. Only scanned against the clean summary text
// (never the raw body), so static page labels can't cause false matches.
const STAGE_PATTERNS = [
  ["paid", /paid out to|payout receipt|rewards? claimed/i],
  ["claimable", /rewards? claimable on-?chain|claimable now/i],
  ["finalizing_payout", /finaliz(?:e|ing) payout|platform finalizing payout/i],
  ["dispute_window", /dispute window/i],
  ["decision_posted", /initial decision posted|winners? picked|decision final/i],
  ["submissions_closed", /submissions closed/i],
  ["closed_no_winner", /no valid submissions|expired without a winner|no winner/i],
  ["live", /\bends?\s+in\s+\d|\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?)\s*(?:left|remaining)/i],
];

function classifyStage(cleanText, coarseStatus) {
  const t = cleanText || "";
  for (const [stage, pattern] of STAGE_PATTERNS) {
    if (pattern.test(t)) return stage;
  }
  const fallback = {
    open: "live",
    ended: "submissions_closed",
    ruled: "finalizing_payout",
    paid: "paid",
    closed: "closed_no_winner",
    unknown: "unknown",
  };
  return fallback[coarseStatus] || "unknown";
}

/** Once a bounty is resolved: 'paid' | 'refunded' | null (not resolved yet) */
function classifyOutcome(cleanText, stage) {
  const t = cleanText || "";
  if (/refund(ed)?\s*(to creator)?/i.test(t)) return "refunded";
  if (/paid out to|payout receipt/i.test(t)) return "paid";
  if (stage === "closed_no_winner") return "refunded";
  if (stage === "claimable" || stage === "paid") return "paid";
  return null;
}

/**
 * Splits the clean summary into a Description and a Deliverables section,
 * using pump.fun's own "Deliverables" heading as the split point when
 * present. Falls back to putting everything under description.
 */
function splitDescription(cleanText) {
  const t = (cleanText || "").trim();
  if (!t) return { description: null, deliverables: null };
  const m = t.match(/deliverables?\s*:?\s*/i);
  if (!m) return { description: t, deliverables: null };
  const idx = m.index;
  return {
    description: t.slice(0, idx).trim() || null,
    deliverables: t.slice(idx + m[0].length).trim() || null,
  };
}

// Broad set of ways pump.fun bounties phrase how the reward pool is split.
// We keep the raw matched sentence (splitText) rather than trying to fully
// normalize it, since showing the real wording is more trustworthy than a
// guessed paraphrase.
const SPLIT_PATTERNS = [
  /first\s+\d+\s+valid\s+submissions?[^.]*/i,
  /split\s+(?:between|among)\s+\d+[^.]*/i,
  /shared\s+(?:between|among|by)\s+\d+[^.]*/i,
  /up to\s+\d+\s+winners?[^.]*/i,
  /\d+\s*winners?\s*(?:will be\s*)?(?:picked|selected|chosen)[^.]*/i,
  /paid out to\s+\d+\s+winners?[^.]*/i,
];

function extractSplitInfo(cleanText) {
  const t = cleanText || "";
  for (const pattern of SPLIT_PATTERNS) {
    const m = t.match(pattern);
    if (m) {
      const numMatch = m[0].match(/\d+/);
      return { splitText: m[0].trim(), winnersCount: numMatch ? parseInt(numMatch[0], 10) : null };
    }
  }
  return { splitText: null, winnersCount: null };
}

/** Best-effort extraction of $ reward and live submissions count. */
function extractRichFields(cleanText) {
  const t = cleanText || "";
  const usdMatch = t.match(/\$([\d,]+\.\d{2})/);
  const submissionsMatch = t.match(/(\d+)\s*(entries|submissions)/i);
  return {
    rewardUsd: usdMatch ? parseFloat(usdMatch[1].replace(/,/g, "")) : null,
    // Explicitly 0 rather than null when we can't find a count - a bounty
    // genuinely can have 0 submissions, and the UI should show that as 0,
    // not as a blank/unknown state.
    submissionsCount: submissionsMatch ? parseInt(submissionsMatch[1], 10) : 0,
  };
}

function extractDeadlineText(text) {
  if (!text) return null;
  const m = text.match(/(\d+\s*(?:day|hour|minute|hr|min)s?\s*left)|(\bends?\s+in\s+\d[^.]*)/i);
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
  const stage = classifyStage(summary.text, status);
  const outcome = classifyOutcome(summary.text, stage);
  const rich = extractRichFields(summary.text);
  const split = extractSplitInfo(summary.text);
  const { description, deliverables } = splitDescription(summary.text);
  const deadlineText = extractDeadlineText(summary.text);

  return {
    id,
    url,
    title: summary.title || null,
    rewardText: summary.rewardText || null,
    rewardUsd: rich.rewardUsd,
    winnersCount: split.winnersCount,
    splitText: split.splitText,
    submissionsCount: rich.submissionsCount,
    status,
    stage,
    outcome,
    summary: summary.text,
    description,
    deliverables,
    deadlineText,
  };
}

/**
 * EXPERIMENTAL - discovering brand new bounties as they're published.
 * pump.fun's own bounty-listing API requires an authenticated JWT tied to a
 * logged-in wallet session, which this app doesn't have. This tries the
 * public go.pump.fun page as a best-effort fallback and returns an empty
 * list if it can't find anything - it will NOT crash the poller.
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
