# Bounty Watch

Paste a pump.fun bounty link, it tracks the status, and pings you on Telegram
the moment it changes — including everything that happens *after* the timer
runs out (ended → ruled → paid out, or closed with no winner). The same
front end doubles as a Telegram Mini App.

## How it actually works (read this first)

pump.fun does **not** publish a documented public API for bounty details.
There's no `GET /bounty/{id}` you can rely on. So this tool works the only
way anything outside pump.fun can:

1. It fetches the public bounty page, `https://pump.fun/go/<id>`.
2. It looks for a status summary in whatever pump.fun embeds in that page —
   first an embedded JSON blob if one exists, then the page's
   `og:description`/`meta description` tag (pump.fun fills this with plain
   text like *"This bounty is closed."* or *"The full reward was paid out to
   1 winner."*), then raw page text as a last resort.
3. It classifies that text into `open / ended / ruled / paid / closed /
   unknown` using keyword rules in `server/scraper.js`.
4. A cron job re-checks every tracked bounty on a timer and diffs the
   status. On any change it writes to history and messages every Telegram
   chat subscribed to that bounty.

**Why this matters for you:** pump.fun can change its page markup at any
time, which would break the keyword matching. Everything scraper-related is
isolated in `server/scraper.js` — if statuses stop updating correctly, that
file is the only one you should need to touch. Open a tracked bounty's URL
in a browser, view source, and compare against what the scraper expects; the
functions are commented to make that easy.

This is also why there's no guarantee of catching a status change the
*instant* it happens — it's only as fresh as your poll interval
(`POLL_INTERVAL_MINUTES`, default 5 min).

## Features

- Paste a link → it's tracked immediately, no login required.
- A "manifest" UI shows every tracked bounty with a status rail
  (OPEN → ENDED → RULED → PAID) so you can see progress at a glance.
- Background polling with full status-change history per bounty.
- Telegram bot: connect once from the site, or just DM the bot a pump.fun
  link directly and it starts tracking + notifying in that chat.
- The exact same web app works as a Telegram Mini App (see setup below).

## Setup

```bash
npm install
cp .env.example .env
# edit .env
npm start
```

Requires Node 18+ (for built-in `fetch`).

### Telegram bot (for notifications)

1. Message [@BotFather](https://t.me/BotFather) on Telegram, run `/newbot`,
   follow the prompts.
2. Put the token it gives you in `.env` as `TELEGRAM_BOT_TOKEN`, and the
   bot's `@username` (no `@`) as `TELEGRAM_BOT_USERNAME`.
3. Restart the server. The "Connect Telegram" button on the site will now
   open a deep link to your bot and link that chat to the browser session.
4. You can also skip the website entirely and just DM the bot a pump.fun
   bounty link — it tracks and notifies in that same chat. Commands: `/list`,
   `/untrack <id>`.

### Turning it into a Telegram Mini App

1. In BotFather: `/newapp`, pick your bot, and set the Web App URL to your
   deployed site's HTTPS URL (Mini Apps require HTTPS — `localhost` won't
   work here, deploy first).
2. That's it — `telegram-web-app.js` is already loaded in `index.html`, so
   the app expands to full height automatically when opened inside
   Telegram. Everything else (adding bounties, notifications) works the
   same as the website.

### Deploying

Any Node host works (Railway, Render, Fly.io, a VPS). Notes:

- The SQLite file (`data.sqlite`) needs a persistent disk — on platforms
  with ephemeral filesystems (e.g. some serverless targets) attach a volume,
  or swap `better-sqlite3` for a hosted Postgres if you'd rather not think
  about it.
- Set `PUBLIC_URL` to your real domain once deployed.
- Only one process should run the poller — don't run multiple instances
  without moving the cron job to a dedicated worker, or you'll get
  duplicate notifications.

## API (for reference / building your own front end)

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/bounties` | list tracked bounties (+ your subscribe state) |
| POST | `/api/bounties` | `{ url }` → start tracking |
| POST | `/api/bounties/:id/refresh` | force an immediate re-check |
| POST | `/api/bounties/:id/subscribe` | notify my linked Telegram chat |
| POST | `/api/bounties/:id/unsubscribe` | stop notifying me |
| GET | `/api/bounties/:id/history` | full status-change timeline |
| GET | `/api/telegram/link` | get a deep link to connect Telegram |
| GET | `/api/telegram/status` | is this browser linked to Telegram? |

## Project layout

```
server/
  index.js      Express app, REST API, cookie-based anonymous sessions
  db.js         SQLite schema
  store.js      DB read/write helpers shared by API + bot + poller
  scraper.js    pump.fun page fetch + status classification (see caveat above)
  poller.js     cron job, diffs status, fires notifications
  telegram.js   bot commands + outbound messages
public/
  index.html / style.css / app.js   the manifest UI
```
