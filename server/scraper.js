/**
 * pump.fun has no documented public API for bounty details, so this reads
 * the bounty page itself (https://pump.fun/go/<id>) and works out status
 * from whatever text/JSON it ships in the HTML.
 *
 * TWO TEXT SOURCES, used for different jobs:
 *  - `shortText`  = the og:description meta tag. Clean, but pump.fun
 *    deliberately truncates it (for link-preview purposes), so it's NOT
 *    reliable for getting the FULL description/deliverables text.
 *  - `richText`   = the full page body, with <script>/<style> stripped.
 *    Longer and more complete - this is now the primary source for
 *    description/deliverables/submissions/split extraction. shortText is
 *    still used first for stage/status keyword matching since it's less
 *    noisy, falling back to richText if shortText doesn't decide anything.
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

  $("script, style, noscript").remove();
  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title: (jsonSummary && jsonSummary.title) || title.trim(),
    rewardText: jsonSummary && jsonSummary.rewardText,
    shortText: metaDescription.trim(),
    // IMPORTANT: prefer the short, clean meta description. It's what
    // pump.fun writes specifically for link-preview purposes, and while
    // it's sometimes truncated, it's reliably real bounty content. The
    // full page body was tried as a "fuller" alternative but turned out
    // to often contain site navigation and age-verification popup text
    // instead of the actual description - worse, not better. Body text
    // is now only used as a last resort when there's no meta description
    // at all.
    richText: metaDescription.trim() || bodyText.slice(0, 8000),
    json: jsonSummary,
  };
}

/** Coarse status: open | ended | ruled | paid | closed | unknown */
function classifyStatus(text) {
  const t = (text || "").toLowerCase();
  if (/paid out|payout receipts|reward was paid/.test(t)) return "paid";
  if (/full ruling|ruling, evidence/.test(t)) return "ruled";
  if (/this bounty is closed|bounty has ended|bounty closed|ends:?\s*closed/.test(t)) return "closed";
  if (/no winner|expired without a winner|no valid submissions/.test(t)) return "closed";
  if (
    /\bends?\s+in\s+\d|\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?)\s*(?:left|remaining)/i.test(t) ||
    /\bis\s+live\b|\blive\s+now\b|\bbounty\s+is\s+live\b/i.test(t)
  )
    return "open";
  return "unknown";
}

const STAGE_PATTERNS = [
  ["paid", /paid out to|payout receipt|rewards? claimed/i],
  ["claimable", /rewards? claimable on-?chain|claimable now/i],
  ["finalizing_payout", /finaliz(?:e|ing) payout|platform finalizing payout/i],
  ["dispute_window", /dispute window/i],
  ["decision_posted", /initial decision posted|winners? picked|decision final/i],
  ["submissions_closed", /submissions closed/i],
  ["closed_no_winner", /no valid submissions|expired without a winner|no winner/i],
  [
    "live",
    /\bends?\s+in\s+\d|\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?)\s*(?:left|remaining)|\bis\s+live\b|\blive\s+now\b|\bbounty\s+is\s+live\b/i,
  ],
];

function classifyStage(shortText, richText, coarseStatus) {
  for (const source of [shortText, richText]) {
    if (!source) continue;
    for (const [stage, pattern] of STAGE_PATTERNS) {
      if (pattern.test(source)) return stage;
    }
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

function classifyOutcome(text, stage) {
  const t = text || "";
  if (/refund(ed)?\s*(to creator)?/i.test(t)) return "refunded";
  if (/paid out to|payout receipt/i.test(t)) return "paid";
  if (stage === "closed_no_winner") return "refunded";
  if (stage === "claimable" || stage === "paid") return "paid";
  return null;
}

// pump.fun's short preview text starts with something like
// "Reward: $120.98 • Ends: closed " or "Reward: $29.66 • Ends in 12d 15h ".
// We already surface reward/deadline as their own fields, so strip this
// exact prefix pattern out of the description to avoid showing it twice.
function stripSummaryPrefix(text) {
  if (!text) return text;
  return text
    .replace(
      /^\s*reward:\s*\$[\d,.]+\s*•?\s*ends?:?\s*(?:closed|in\s+\d+d(?:\s*\d+h)?|in\s+\d+h)?\s*•?\s*/i,
      ""
    )
    .trim();
}

/**
 * Splits into Description and Deliverables using pump.fun's own
 * "Deliverables" heading as the split point when present.
 */
function splitDescription(text) {
  const t = stripSummaryPrefix((text || "").trim());
  if (!t) return { description: null, deliverables: null };
  const m = t.match(/deliverables?\s*:?\s*/i);
  if (!m) return { description: t || null, deliverables: null };
  const idx = m.index;
  return {
    description: t.slice(0, idx).trim() || null,
    deliverables: t.slice(idx + m[0].length).trim() || null,
  };
}

const SPLIT_PATTERNS = [
  /first\s+\d+\s+valid\s+submissions?[^.•]*/i,
  /split\s+(?:between|among)\s+\d+[^.•]*/i,
  /shared\s+(?:between|among|by)\s+\d+[^.•]*/i,
  /up to\s+\d+\s+winners?[^.•]*/i,
  /\d+\s*winners?\s*(?:will be\s*)?(?:picked|selected|chosen)[^.•]*/i,
  /paid out to\s+\d+\s+winners?[^.•]*/i,
];

function extractSplitInfo(text) {
  const t = text || "";
  for (const pattern of SPLIT_PATTERNS) {
    const m = t.match(pattern);
    if (m) {
      const numMatch = m[0].match(/\d+/);
      return { splitText: m[0].trim(), winnersCount: numMatch ? parseInt(numMatch[0], 10) : null };
    }
  }
  return { splitText: null, winnersCount: null };
}

// Widened net for submissions phrasing. NOTE: for a still-LIVE bounty this
// count likely only exists in JS-rendered UI a plain fetch can't see, so 0
// may be a real ceiling here rather than a bug - see SKILL note in README.
const SUBMISSIONS_PATTERNS = [
  /(\d+)\s*(?:entries|submissions)\b/i,
  /(\d+)\s*(?:people\s+)?(?:have\s+)?submitted\b/i,
  /submissions?\s*(?:so far)?\s*:\s*(\d+)/i,
];

function extractRichFields(text) {
  const t = text || "";
  const usdMatch = t.match(/\$([\d,]+\.\d{2})/);
  let submissionsCount = 0;
  for (const pattern of SUBMISSIONS_PATTERNS) {
    const m = t.match(pattern);
    if (m) {
      submissionsCount = parseInt(m[1], 10);
      break;
    }
  }
  return {
    rewardUsd: usdMatch ? parseFloat(usdMatch[1].replace(/,/g, "")) : null,
    submissionsCount,
  };
}

function extractDeadlineText(text) {
  if (!text) return null;
  const m = text.match(/(\d+\s*(?:day|hour|minute|hr|min)s?\s*left)|(\bends?\s+in\s+\d[^.•]*)/i);
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
  const { title, rewardText, shortText, richText } = extractSummary(html);

  const status = classifyStatus(shortText || richText);
  const stage = classifyStage(shortText, richText, status);
  const outcome = classifyOutcome(shortText || richText, stage);
  const rich = extractRichFields(richText);
  const split = extractSplitInfo(richText);
  const { description, deliverables } = splitDescription(richText);
  const deadlineText = extractDeadlineText(shortText || richText);

  return {
    id,
    url,
    title: title || null,
    rewardText: rewardText || null,
    rewardUsd: rich.rewardUsd,
    winnersCount: split.winnersCount,
    splitText: split.splitText,
    submissionsCount: rich.submissionsCount,
    status,
    stage,
    outcome,
    summary: shortText || richText.slice(0, 400),
    description,
    deliverables,
    deadlineText,
  };
}

/**
 * EXPERIMENTAL - discovering brand new bounties as they're published.
 * pump.fun's own bounty-listing API requires an authenticated JWT tied to a
 * logged-in wallet session, which this app doesn't have. This tries the
 * public go.pump.fun page as a best-effort fallback. Entries that don't
 * resolve to a real title are skipped rather than stored as blank/garbage
 * rows (this is what previously caused broken-looking Discover cards).
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
