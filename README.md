# AdTrack

A modern, self-hosted ad tracker with a built-in cloaker, landing-page engine and live dashboard — all in a single Node process. No Docker, no Redis, no build step.

## Features

**Tracking**
- Click tracking with nanoid click IDs
- Sub1–Sub5 passthrough and macros (`{clickid}`, `{sub1}`, `{country}`, `{device}` …)
- Cost models: CPC, CPM, CPA
- S2S conversion postback
- JS pixel ping for browser-verification
- Prelander → money page flow

**Cloaker (11 signals)**
- Bot UA tokens (Googlebot, facebookexternalhit, curl, headless, Puppeteer, …)
- Known datacenter IP prefixes (Google, Bing, FB, Yandex, Baidu, Twitter)
- ASN blocklist (Google, MS, AWS, OVH, Hetzner, DO, Linode …) via CF headers
- Geo allow/block (Cloudflare `CF-IPCountry` or custom `X-Country` header)
- Device targeting (mobile / desktop / tablet)
- Empty/short UA detection
- Missing `Accept-Language` (strong bot signal)
- Headless / Electron / Phantom detection
- Referrer requirement toggle
- Per-campaign custom IP / UA / ASN blocklists
- Custom UA substring blocks

**Dashboard**
- KPIs: clicks / real / cloaked / bots / conversions / revenue / cost / profit / CR / ROI
- Hourly traffic chart (clicks vs cloaked)
- Top campaigns
- Real-time click feed (auto-refresh every 5s)
- CRUD UI for campaigns, offers, landings, cloaker rules

## Quick start

```bash
npm install
npm run seed   # creates a demo campaign
npm start      # starts on http://localhost:3000
```

Then open:
- **Public landing:** http://localhost:3000/
- **Dashboard:** http://localhost:3000/admin (token: `admin`)
- **Demo tracker link:** http://localhost:3000/t/demo

## URLs

| URL | Purpose |
| --- | --- |
| `GET /t/:slug?sub1=&sub2=...` | Main tracker. Cloaker decides route. |
| `GET /go/:clickid` | Prelander → money redirect. |
| `GET /px/:clickid.gif` | 1×1 JS/browser ping pixel. |
| `GET /postback?clickid=&payout=&status=&tx=` | S2S conversion callback. |
| `GET /admin` | Dashboard. |
| `GET /api/*` | Admin REST API (header `X-Admin-Token`). |

## Configuration

Copy `.env.example` to `.env`:

```
PORT=3000
ADMIN_TOKEN=change-me-in-production
DB_PATH=./data/adtrack.db
TRUST_PROXY=1
```

If you run behind Cloudflare or Nginx, geo/ASN is read from `CF-IPCountry`, `CF-ASN`, `X-Country`, `X-ASN` headers. If you want MaxMind mmdb lookups, plug it into `src/cloaker/geo.js`.

## Landings

Drop any `.html` file into `/landings/` and create a **Landing** row in the dashboard pointing to it.

Template macros:
- `{{clickid}}` — unique click ID
- `{{goUrl}}` — safe prelander → money redirect (`/go/:clickid`)
- `{{campaign}}`, `{{country}}`

Offer URL macros (money pages on the network side):
- `{clickid}`, `{sub1}`…`{sub5}`, `{country}`, `{device}`, `{os}`, `{browser}`

Included templates:
- `white_blog.html` — a neutral wellness blog (served to bots / wrong geo)
- `prelander_news.html` — a news-style angle page with CTA

## Example postback

Paste this into your affiliate network as postback URL:

```
https://your-domain.com/postback?clickid={clickid}&payout={payout}&status=approved&tx={txid}
```

## Tech

Node 18+, Express, better-sqlite3, nanoid, ua-parser-js. Dashboard is a single HTML file using Tailwind + Alpine.js from CDN — no build step.

## License

MIT
