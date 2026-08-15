/**
 * pump.fun's real internal bounty-listing API, discovered by inspecting
 * network requests while logged in through the app (see project notes).
 *
 *   GET https://livestream-api.pump.fun/bounties/v2/tasks?phase=OPEN&...
 *
 * This requires a logged-in session cookie (PUMPFUN_COOKIE env var - the
 * full Cookie header value copied from a logged-in browser session using a
 * wallet that holds NO funds, specifically to avoid any real financial
 * risk if this ever leaked).
 *
 * UNCONFIRMED: pump.fun sits behind Cloudflare bot protection. The
 * cf_clearance/__cf_bm cookies in that captured session are normally tied
 * to the specific device/IP that obtained them and may not be honored when
 * replayed from a different server (this one). The auth_token itself is a
 * 30-day JWT and should be fine either way - what's uncertain is whether
 * Cloudflare lets the request through at all. This function is written to
 * fail loudly and safely (never crash the app) so we can see exactly what
 * pump.fun says back and adjust from there.
 */

const BASE = "https://livestream-api.pump.fun/bounties/v2/tasks";

async function fetchOpenTasksRaw({ limit = 5 } = {}) {
  const cookie = process.env.PUMPFUN_COOKIE;
  if (!cookie) {
    return { ok: false, error: "PUMPFUN_COOKIE env var is not set." };
  }

  const url = `${BASE}?phase=OPEN&sort=rewardTotalUsd&order=desc&limit=${limit}`;

  try {
    const res = await fetch(url, {
      headers: {
        accept: "application/json",
        cookie,
        origin: "https://pump.fun",
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/132.0.0.0 Safari/537.36",
      },
    });

    const status = res.status;
    const contentType = res.headers.get("content-type") || "";
    const bodyText = await res.text();

    let bodyJson = null;
    if (contentType.includes("application/json")) {
      try {
        bodyJson = JSON.parse(bodyText);
      } catch (_) {
        /* wasn't actually valid JSON despite the content-type */
      }
    }

    return {
      ok: res.ok,
      status,
      contentType,
      // Truncated so a giant HTML challenge page (a likely Cloudflare
      // block response) doesn't blow up the debug endpoint's output.
      bodyPreview: bodyText.slice(0, 2000),
      bodyJson,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { fetchOpenTasksRaw };
