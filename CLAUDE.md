# CLAUDE.md

## Project Overview

This repo contains two components that work together:
1. **`index.js`** — a Node.js/Express proxy deployed on Google Cloud Run
2. **`appsscript/Code.js`** — a Google Apps Script that scrapes ACBL tournament data into a Google Sheet
3. **`local-scraper/`** — a Playwright script run nightly on Rick's Mac that fetches the data in a real browser and POSTs it to the Apps Script web app (`doPost`)

## Cloudflare (since Aug 2026)

tournaments.acbl.org is behind a Cloudflare bot check. The Cloud Run proxy gets `403 (Just a moment...)`, and headless Chrome is blocked outright, so the working path is `local-scraper/scrape.mjs` in **headed** Chrome.
- Schedule: LaunchAgent `com.bridgecraftwork.acbl-scraper` at 1:30 AM, logging to `~/Library/Logs/acbl-scraper.log`
- `refreshCalendar()` (1:55 AM trigger) logs `SKIPPED` instead of failing if a local ingest landed within 20h
- Endpoint: `https://tournaments.acbl.org/ajax/tournamentslist` (moved from `/includes/ajax/tournamentslist.php`)
- If Cloudflare blocks the scraper, delete `~/Library/Application Support/acbl-scraper/profile`

## Deploying the Proxy

The proxy runs on Google Cloud Run under the `bridge-craftwork@gmail.com` account, project `acbl-proxy-bridge`, in `us-west1`.

To redeploy after changes to `index.js`, use the Cloud Run console or `gcloud` CLI.

## Deploying Apps Script Changes

Always use clasp from the `appsscript/` directory:

```bash
cd appsscript && clasp push
```

Clasp is authenticated as `bridge-craftwork@gmail.com`. Do not run `clasp login` unless re-authenticating.

## Secrets

- `PROXY_SECRET` is **not** in source code
- In Cloud Run: set as an environment variable via the console
- In Apps Script: set as a Script Property (Project Settings → Script Properties)
- The value is stored in 1Password
- `INGEST_SECRET` guards the `doPost` web app. It's stored in Script Properties and in the macOS Keychain (service `acbl-ingest`). The web app URL is in `local-scraper/config.json` (gitignored)
- After changing `appsscript.json`, use `clasp push -f` (plain push silently skips manifest changes)
- The web app serves the last **deployed** version, not the pushed head. After any `Code.js` change that affects `doPost`/`processRaw_`, run `clasp deploy -i AKfycbyl_XTYGEvLsTPwxLWFKLxeF-TNjWcNNLxS_FK6rlmNdN87KCgI2QI50Tki7XBpYbq17w` or the local scraper keeps using the old code

## Key Config (appsscript/Code.js)

- `CFG.district` — home district (21)
- `CFG.proxyBase` — Cloud Run service URL
- `CFG.apiBase` — ACBL tournament API endpoint
- `CFG.years` — current and next year

## Google Sheet Structure

- **Upcoming** — main sheet written by `refreshCalendar()`, one row per tournament
- **District 1–25** — per-district filtered views
- **Calendars** — maps district numbers to Google Calendar IDs
- **CalendarEvents** — index of synced calendar event IDs (used for upsert/delete logic)
- **Log** — run history for `refreshCalendar()`
- **Calendar Log** — run history for calendar sync
