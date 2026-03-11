# acbl-proxy

A lightweight HTTP proxy and Google Apps Script that scrapes the ACBL tournament calendar and populates a Google Sheet with upcoming bridge tournaments.

## Components

### `index.js` — Cloud Run Proxy

An Express server deployed on Google Cloud Run that fetches URLs on behalf of Google Apps Script (which cannot directly access ACBL's tournament API due to CORS/access restrictions).

- Endpoint: `GET /fetch?url=<encoded-url>`
- Authenticated via `x-proxy-secret` request header or `token` query parameter
- Secret configured via `PROXY_SECRET` environment variable in Cloud Run

### `appsscript/Code.js` — Google Apps Script

Runs nightly via a time-based trigger. Fetches ACBL tournament data for all 25 districts and two calendar years, deduplicates entries, and writes upcoming events to the **Upcoming** sheet. Also syncs events to per-district Google Calendars.

Key functions:
- `refreshCalendar()` — main entry point, fetches and writes tournament data
- `syncDistrictCalendarsRange(start, end)` — syncs a range of district calendars
- `syncAllChunksSequentially()` — syncs all 25 districts with pauses between chunks

## Setup

### Cloud Run Proxy

1. Deploy to Google Cloud Run (us-west1 for free tier)
2. Set environment variable `PROXY_SECRET` to a long random string

### Apps Script

1. Install clasp: `npm install -g @google/clasp`
2. Enable the Apps Script API at [script.google.com/home/usersettings](https://script.google.com/home/usersettings)
3. Log in: `clasp login`
4. Push changes: `cd appsscript && clasp push`

In the Apps Script project, set a Script Property `PROXY_SECRET` matching the Cloud Run value:
- Apps Script editor → Project Settings (gear) → Script Properties

### Nightly Trigger

In the Apps Script editor, set a time-based trigger for `refreshCalendar` to run once per day.

## Google Cloud Accounts

- Proxy is deployed under `bridge-craftwork@gmail.com` Google Cloud account
- Cloud Run service: `acbl-proxy` in `us-west1`
