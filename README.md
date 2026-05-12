# Cloakly

A self-hosted traffic cloaker with a clean dashboard — modeled after AdsPect, Palladium and HideClick.

**English / Русский** — the entire dashboard is bilingual with a one-click switcher.

## What it does

You create a **flow** — a tracking link. When a visitor opens it:
- If they look like a real human, they go to your **offer**.
- If they look like a bot, a moderator, or don't match your targeting, they go to a **safe page**.

Everything is configured by toggles and chips in the dashboard — no JSON, no config files, no CLI.

## Screenshots in one paragraph

Sidebar has three sections: **Dashboard** (KPIs, traffic chart, block reasons, top countries), **Flows** (cards with one-click pause/resume, edit, duplicate, delete), **Visitors** (live log with IP, country, device, browser, result). Creating a flow is a 3-step wizard: name & destinations → filters (checkboxes for bots/datacenter/VPN/headless, country allow/block with chip picker) → done, here's your link.

## Features

- **3-step create wizard** — name, money URL, safe URL, then filters
- **Bot protection** (all toggleable): known crawlers, datacenter IPs, VPN/proxy ASNs, headless browsers, empty UA, missing Accept-Language
- **Targeting**: country allow/block, device, OS, browser, language, time-of-day schedule
- **Anti-fraud**: JS challenge, referrer requirement, per-IP rate limits
- **Custom blacklists**: IPs and user-agent keywords
- **Custom domains**: point an A-record to the server and attach the domain to a flow
- **Macros in offer URL**: `{clickid}`, `{country}`, `{device}`, `{os}`, `{browser}`, plus any query param
- **Dashboard**: real-time visitors, traffic chart, block-reason breakdown, country stats, 1h/24h/7d/30d ranges
- **Bilingual UI**: English + Russian, switches instantly

## One-command install on a VPS

On a fresh Ubuntu / Debian / Rocky / AlmaLinux server:

```bash
curl -fsSL https://raw.githubusercontent.com/Fhshjsvxhd/test/main/install.sh | sudo bash
```

At the end the script prints:
- Your admin token
- `http://YOUR_IP/admin` — dashboard
- `http://YOUR_IP/` — landing page

### If the repo is private

Clone it manually first (using a PAT), then run the installer:

```bash
sudo apt-get install -y git
sudo git clone https://YOUR_TOKEN@github.com/Fhshjsvxhd/test.git /opt/cloakly
sudo bash /opt/cloakly/install.sh
```

### Attach a custom domain

1. DNS → create **A-record** `offer.example.com → YOUR_IP`
2. Dashboard → Flows → Edit → **Custom domain** = `offer.example.com`
3. Opening `http://offer.example.com/` now runs that flow.

One server can host any number of domains, each tied to its own flow.

### Add HTTPS

```bash
sudo bash /opt/cloakly/install-https.sh offer.example.com you@example.com
```

### Update

Same one-liner — the installer is idempotent:

```bash
curl -fsSL https://raw.githubusercontent.com/Fhshjsvxhd/test/main/install.sh | sudo bash
```

## Local dev

```bash
npm install
npm start
# open http://localhost:3000
```

## Tech stack

Node 18+, Express, better-sqlite3, ua-parser-js, nanoid. The dashboard is a single HTML file using Tailwind + Alpine.js from CDN — no build step, no bundler.

## Tracking URLs

| URL | Purpose |
| --- | --- |
| `GET /f/:slug` | Main tracker link. |
| `GET /t/:slug` | Backward-compat alias. |
| `GET /` on a custom domain | Same as `/f/:slug` for the matching flow. |
| `GET /px/:visitId.gif` | JS-verification pixel. |
| `GET /admin` | Dashboard. |
| `GET /api/*` | Admin REST API (header `X-Admin-Token`). |

## License

MIT
