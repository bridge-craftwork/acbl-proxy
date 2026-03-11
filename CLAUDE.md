# CLAUDE.md

## Project Overview

This repo contains two components that work together:
1. **`index.js`** — a Node.js/Express proxy deployed on Google Cloud Run
2. **`appsscript/Code.js`** — a Google Apps Script that scrapes ACBL tournament data into a Google Sheet

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
