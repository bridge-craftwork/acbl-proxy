// Fetches ACBL tournament lists in a real browser (tournaments.acbl.org sits behind a
// Cloudflare bot check that the Cloud Run proxy can't pass) and POSTs the raw rows to
// the Apps Script web app (doPost in appsscript/Code.js), which writes the sheet.
//
// Usage:  node scrape.mjs            fetch + post
//         node scrape.mjs --dry-run  fetch only, print counts
//
// Config: config.json next to this file ({ "webAppUrl": "https://script.google.com/macros/s/.../exec" })
// Secret: macOS Keychain, service "acbl-ingest" (must match Script Property INGEST_SECRET)

import { chromium } from "playwright";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE_DIR = join(homedir(), "Library", "Application Support", "acbl-scraper", "profile");
const SITE = "https://tournaments.acbl.org/";
const API = "https://tournaments.acbl.org/ajax/tournamentslist";
const DRY_RUN = process.argv.includes("--dry-run");

const log = (...a) => console.log(new Date().toISOString(), ...a);

function buildRequests(years) {
  const q = (o) => API + "?" + new URLSearchParams({
    month: "", year: "", category: "", type: "", city: "", state: "", district: "", unit: "", ...o
  });
  const reqs = [];
  for (const yr of years) {
    reqs.push({ district: "", url: q({ year: yr, category: "N" }) });  // NABC, no district
    for (let d = 1; d <= 25; d++) reqs.push({ district: String(d), url: q({ year: yr, district: d }) });
  }
  return reqs;
}

async function fetchAll(reqs) {
  const ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    // Cloudflare blocks headless Chrome outright, so this opens a real (small) window for ~1 minute
    channel: "chrome",
    headless: false,
    viewport: { width: 800, height: 600 },
    args: ["--disable-blink-features=AutomationControlled", "--window-size=800,600"],
  });
  try {
    const page = ctx.pages()[0] || await ctx.newPage();
    await page.goto(SITE, { waitUntil: "networkidle", timeout: 60000 });
    const title = await page.title();
    if (!/ACBL Tournaments/i.test(title)) throw new Error(`Blocked loading ${SITE} (title: "${title}")`);

    // Fetch from inside the page so the requests carry the browser's Cloudflare clearance
    return await page.evaluate(async (reqs) => {
      const raw = [];
      const counts = [];
      for (const r of reqs) {
        const res = await fetch(r.url, { headers: { Accept: "application/json" } });
        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { /* handled below */ }
        if (!res.ok || !json || !Array.isArray(json.aaData)) {
          throw new Error(`Fetch failed ${res.status} for ${r.url}: ${text.slice(0, 120)}`);
        }
        json.aaData.forEach(cols => raw.push({ district: r.district, cols }));
        counts.push(`${r.district || "NABC"}:${json.aaData.length}`);
        await new Promise(ok => setTimeout(ok, 200));
      }
      return { raw, counts };
    }, reqs);
  } finally {
    await ctx.close();
  }
}

async function main() {
  const now = new Date().getFullYear();
  const years = [now, now + 1];
  const reqs = buildRequests(years);

  log(`Fetching ${reqs.length} lists for ${years.join(", ")}`);
  const { raw, counts } = await fetchAll(reqs);
  log(`Got ${raw.length} raw rows (${counts.join(" ")})`);

  if (DRY_RUN) return;

  const { webAppUrl } = JSON.parse(readFileSync(join(HERE, "config.json"), "utf8"));
  const secret = execFileSync("security", ["find-generic-password", "-s", "acbl-ingest", "-w"])
    .toString().trim();

  const res = await fetch(webAppUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ secret, years, raw }),
  });
  const text = await res.text();
  let out;
  try { out = JSON.parse(text); } catch { throw new Error(`Web app returned ${res.status}: ${text.slice(0, 300)}`); }
  if (!out.ok) throw new Error(`Web app error: ${out.error}`);
  log(`Web app wrote ${out.rows} rows`);
}

main().catch(err => {
  log("FAILED:", err.message);
  process.exit(1);
});
