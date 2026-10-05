#!/bin/bash
#
# deploy.sh - install acbl-proxy's launchd job (the local ACBL scraper).
#
# The repo lives on the Express, and macOS won't let launchd jobs read an
# external volume without Full Disk Access. So the job runs from a copy of
# local-scraper/ on the internal SSD; this script refreshes that copy
# (including config.json and node_modules) and (re)loads the job.
#
# Re-run after changing anything under local-scraper/ or jobs/launchd/, and
# after `npm install` there.
#
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
JOB_DIR="$HOME/Library/Application Support/launchd-jobs/acbl-proxy"
DOMAIN="gui/$(id -u)"

mkdir -p "$JOB_DIR"
rsync -a --delete "$REPO/local-scraper/" "$JOB_DIR/"

# Render each plist template and (re)load it.
for tpl in "$REPO"/jobs/launchd/*.plist; do
    label="$(basename "$tpl" .plist)"
    dst="$HOME/Library/LaunchAgents/$label.plist"
    tmp="$(mktemp)"
    sed -e "s|@JOB_DIR@|$JOB_DIR|g" -e "s|@HOME@|$HOME|g" "$tpl" > "$tmp"
    plutil -lint -s "$tmp"
    launchctl bootout "$DOMAIN/$label" 2>/dev/null || true
    mv "$tmp" "$dst"
    launchctl bootstrap "$DOMAIN" "$dst"
    echo "loaded $label"
done
