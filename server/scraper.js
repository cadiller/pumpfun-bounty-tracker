/**
 * pump.fun does not publish a documented public API for bounty detail data,
 * so this scraper reads the bounty page itself (https://pump.fun/go/<id>)
 * and works out status from whatever text/JSON it can find.
 *
 * IMPORTANT: pump.fun is a client-rendered app. This scraper relies on
 * either (a) an embedded JSON payload pump.fun ships in the HTML for SEO /
 * link-preview purposes, or (b) the <meta name="description"> /
 * og:description tag, which pump.fun fills with a human-readable summary
 * ("This bounty is closed.", "The full reward was paid out to 1 winner.",
 * "Xd left", etc). If pump.fun changes its markup, only this file should
 * need updating - the keyword rules below are intentionally isolated so you
 * can tweak them without touching the rest of the app.
 */

const cheerio = require("cheerio");

const BOUNTY_URL_RE = /pump\.fun\/go\/([a-zA-Z0-9-]+)/i;

function extractBountyId(input) {
  const trimmed = String(input || "").trim();
  const match = trimmed.match(BOUNTY_URL_RE);
  if (match) return match[1];
  // allow pasting a bare id too
  if (/^[a-zA-Z0-9-]{6,}$/.test(trimmed)) return trimmed;
  return null;
}

function canonicalUrl(id) {
  return `https://pump.fun/go/${id}`;
}

/** Pull whatever text summary we can find out of the raw HTML. */
function extractSummary(html) {
  const $ = cheerio.load(html);

  // 1) Try an embedded Next.js data blob first - richest source if present.
  let jsonSummary = null;
  const nextData = $("#__NEXT_DATA__").html();
  if (nextData) {
    try {
      const data = JSON.parse(nextData);
      // Structure is unconfirmed; walk the tree looking for bounty-shaped fields.
      jsonSummary = findBountyFields(data);
    } catch (_) {
      /* ignore parse errors, fall through to meta tags */
    }
  }

  const metaDescription =
    $('meta[property="og:description"]').attr("content") ||
    $('meta[name="description"]').attr("content") ||
    "";

  const title =
    $('meta[property="og:title"]').attr("content") ||
    $("title").first().text() ||
    "";

  const bodyText = $("body").text().replace(/\s+/g, " ").trim();

  return {
    title: (jsonSummary && jsonSummary.title) || title.trim(),
    rewardText: jsonSummary && jsonSummary.rewardText,
    // Prefer the meta description (usually a clean pre-written summary);
    // fall back to raw body text if it's empty.
    text: metaDescription.trim() || bodyText.slice(0, 4000),
    json: jsonSummary,
  };
}

/** Best-effort recursive search for bounty-looking keys in a JSON blob. */
function findBountyFields(node, depth = 0) {
  if (!node || typeof node !== "object" || depth > 6) return null;
  const keys = Object.keys(node);
  const looksLikeBounty = keys.some((k) =>
    /bounty|reward|deadline|winner|ruling/i.test(k)
  );
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

/**
 * Classify a bounty's status from its summary text.
 * Returns one of: 'paid' | 'ruled' | 'closed' | 'ended' | 'open' | 'unknown'
 */
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
  if (/this bounty is closed|bounty has ended|bounty closed/.test(t))
    return "closed";
  if (/\bends? in\b|\bleft\b|time remaining|days? left|hours? left/.test(t))
    return "open";
  if (/no winner|expired without a winner|no valid submissions/.test(t))
    return "closed";

  return "unknown";
}

/** Try to pull a human readable deadline / time-left phrase out of the text. */
function extractDeadlineText(text) {
  if (!text) return null;
  const m = text.match(
    /(\d+\s*(?:day|hour|minute|hr|min)s?\s*left)|(\bends?\s+in\s+[^.]+)/i
  );
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
      // A normal browser UA avoids being served a stripped-down bot response.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      Accept: "text/html,application/xhtml+xml",
    },
  });

  if (!res.ok) {
    throw new Error(`pump.fun returned HTTP ${res.status} for ${url}`);
  }

  const html = await res.text();
  const summary = extractSummary(html);
  const status = classifyStatus(summary);
  const deadlineText = extractDeadlineText(summary.text);

  return {
    id,
    url,
    title: summary.title || null,
    rewardText: summary.rewardText || null,
    status,
    summary: summary.text,
    deadlineText,
  };
}

module.exports = {
  extractBountyId,
  canonicalUrl,
  fetchBountyStatus,
  classifyStatus, // exported for tests
};
