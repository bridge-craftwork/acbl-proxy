/***** CONFIG *****/
const CFG = {
  district: "21",
  years: [new Date().getFullYear(), new Date().getFullYear() + 1],
  sheetName: "Upcoming",
  timezone: "America/Los_Angeles",

  // 1) Your Cloud Run proxy base (no trailing slash)
  proxyBase: "https://acbl-proxy-785631188931.us-west1.run.app",

  // 2) The JSON endpoint the page calls. Replace actual year/district in that URL with {YEAR} and {DIST}.
  // Example (you will replace with the *real* one you saw in DevTools):
  // "https://members.acbl.org/api/tournaments?year={YEAR}&district={DIST}&page=1"
  apiBase: "https://tournaments.acbl.org/ajax/tournamentslist",
  apiTemplate: "https://tournaments.acbl.org/ajax/tournamentslist?month=&year={YEAR}&category={CATEGORY}&type=&city=&state=&district={DIST}&unit=",

  // 3) Your shared secret (same as Cloud Run env PROXY_SECRET)
  //    Stored in Project Settings > Script Properties, not hardcoded here.
  proxySecret: PropertiesService.getScriptProperties().getProperty("PROXY_SECRET") || ""
};

/***** MAIN *****/
// If the local Playwright scraper (local-scraper/) delivered data within this window,
// a blocked proxy run is logged as SKIPPED instead of failing.
const INGEST_FRESH_HOURS = 20;

function refreshCalendar() {
  const years = CFG.years.slice();
  let raw;

  try {
    raw = fetchAllRawViaProxy_(years);
  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    const lastIngest = Number(PropertiesService.getScriptProperties().getProperty("LAST_INGEST_AT") || 0);
    const ageHrs = (Date.now() - lastIngest) / 36e5;
    if (lastIngest && ageHrs < INGEST_FRESH_HOURS) {
      Logger.log(`Proxy failed, but local ingest ran ${ageHrs.toFixed(1)}h ago; skipping. ${msg}`);
      logRun_("SKIPPED", `Proxy blocked; using local ingest from ${ageHrs.toFixed(1)}h ago. ${String(err)}`, "", years);
      return;
    }
    Logger.log("ERROR in refreshCalendar: " + msg);
    logRun_("ERROR", msg, "", years);
    throw err;
  }

  try {
    processRaw_(raw, years, "proxy");
  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    Logger.log("ERROR in refreshCalendar: " + msg);
    logRun_("ERROR", msg, raw.length, years);
    throw err;
  }
}

/***** INGEST FROM LOCAL SCRAPER *****/
// POST body: { secret, years: [2026, 2027], raw: [{ district: "" | "1".."25", cols: [...] }] }
function doPost(e) {
  const out = (obj) => ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);

  let body;
  try {
    body = JSON.parse(e.postData.contents);
  } catch (err) {
    return out({ ok: false, error: "Bad JSON" });
  }

  const secret = PropertiesService.getScriptProperties().getProperty("INGEST_SECRET");
  if (!secret || body.secret !== secret) return out({ ok: false, error: "Unauthorized" });
  if (!Array.isArray(body.raw) || !Array.isArray(body.years)) {
    return out({ ok: false, error: "Missing raw or years" });
  }

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return out({ ok: false, error: "Busy" });
  try {
    const written = processRaw_(body.raw, body.years, "local");
    PropertiesService.getScriptProperties().setProperty("LAST_INGEST_AT", String(Date.now()));
    return out({ ok: true, rows: written });
  } catch (err) {
    const msg = (err && err.stack) ? err.stack : String(err);
    logRun_("ERROR", "[local] " + msg, body.raw.length, body.years);
    return out({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/***** FETCH: NABC once per year + every district *****/
function fetchAllRawViaProxy_(years) {
  const raw = [];

  years.forEach(yr => {
    // 1) NABC events once per year
    const nabcUrl = makeUrl_(CFG.apiBase, {
      month: "",
      year: yr,
      category: "N",   // NABC
      type: "",
      city: "",
      state: "",
      district: "",
      unit: ""
    });
    Logger.log(`NABC fetch for ${yr}: ${nabcUrl}`);

    let json = fetchJsonViaProxy(nabcUrl);
    let rows = (json && Array.isArray(json.aaData)) ? json.aaData : [];
    Logger.log(`  NABC rows (${yr}): ${rows.length}`);
    rows.forEach(cols => raw.push({ district: "", cols }));  // no district; global

    Utilities.sleep(200);

    // 2) Per-district all events (catches STaC & any cross-district definitions)
    for (let d = 1; d <= 25; d++) {
      const dStr = String(d);
      const url = makeUrl_(CFG.apiBase, {
        month: "",
        year: yr,
        category: "",  // all categories
        type: "",      // all types
        city: "",
        state: "",
        district: dStr,
        unit: ""
      });

      Logger.log(`District ${dStr} fetch for ${yr}: ${url}`);

      json = fetchJsonViaProxy(url);
      rows = (json && Array.isArray(json.aaData)) ? json.aaData : [];
      Logger.log(`  District ${dStr} rows (${yr}): ${rows.length}`);
      rows.forEach(cols => raw.push({ district: dStr, cols }));  // force district = d

      Utilities.sleep(150);
    }
  });

  return raw;
}

/***** PROCESS: normalize, dedupe, filter, write *****/
function processRaw_(raw, years, source) {
  const tz = CFG.timezone || "America/Los_Angeles";
  const all = raw.map(r => normalizeRow_(r.cols, r.district));

  Logger.log(`[${source}] Total raw rows collected: ${all.length}`);

  // --- De-duplicate: one row per (sanction, start-date, district) ---

  const seen = new Set();
  const deduped = [];

  all.forEach(e => {
    const startKey = e.start
      ? Utilities.formatDate(e.start, tz, "yyyy-MM-dd")
      : "";
    const key = [
      e.sanction || "",
      startKey,
      e.district || ""
    ].join("|");

    if (seen.has(key)) return;
    seen.add(key);
    deduped.push(e);
  });

  Logger.log(`after dedup: ${deduped.length} rows`);

  // --- Future filter ---
  const todayStr = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd");
  const today = new Date(todayStr + "T00:00:00");

  const future = deduped.filter(r => r.end && r.end >= today);
  Logger.log(`after future-filter: ${future.length} rows (today=${todayStr})`);

  // --- Sort by start date ---
  future.sort((a, b) => {
    const as = a.start ? a.start.getTime() : 9e15;
    const bs = b.start ? b.start.getTime() : 9e15;
    return as - bs;
  });

  Logger.log(`writing ${future.length} rows to Upcoming`);
  writeSheet(future);

  if (future.length < 100) {
    const msg = `Warning: refreshCalendar (${source}) wrote only ${future.length} rows. Check ACBL or proxy.`;
    Logger.log(msg);
    try {
      MailApp.sendEmail({
        to: "bridge.craftwork@gmail.com",
        subject: "[ACBL Calendar] Low row count warning",
        body: msg
      });
    } catch (e) {
      Logger.log("MailApp failed: " + e);
    }
  }

  if (typeof updateDistrictSheetsMeta === "function") {
    updateDistrictSheetsMeta(future);
  }

  logRun_("OK", `[${source}] Fetched and wrote ${future.length} rows`, future.length, years);
  return future.length;
}

/***** FETCH VIA PROXY *****/
function fetchJsonViaProxy(targetUrl) {
  const proxied = CFG.proxyBase + "/fetch?url=" + encodeURIComponent(targetUrl);
  const res = UrlFetchApp.fetch(proxied, {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { "x-proxy-secret": CFG.proxySecret, "Accept": "application/json" }
  });
  const code = res.getResponseCode();
  const txt = res.getContentText();
  if (code >= 400) {
    // Surface the page title so the Log shows e.g. a Cloudflare block vs. a real 404
    const title = (txt.match(/<title>([^<]*)<\/title>/i) || [])[1] || txt.slice(0, 120);
    throw new Error("Proxy fetch failed " + code + " (" + title.trim() + ") for " + targetUrl);
  }

  // Try JSON; if not JSON, log first 2KB for debugging
  try {
    return JSON.parse(txt);
  } catch (e) {
    Logger.log("Non-JSON response head:\n" + txt.slice(0, 2000));
    throw new Error("Endpoint did not return JSON. Check apiTemplate.");
  }
}

/***** NORMALIZE YOUR JSON *****/
/*  Map the endpoint’s JSON fields to our row format.
    After you paste your real endpoint, open View→Logs once to see what the JSON looks like and
    adjust the field names below (example names provided). */

function normalizeRow_(cols, forcedDistrict) {
  // 0: Dates, 1: City, 2: State, 3: Info, 4: Results,
  // 5: District, 6: Unit, 7: Type, 8: Category

  const dateStr = cols[0] || "";
  const city    = cols[1] || "";
  const state   = cols[2] || "";
  const infoA   = cols[3] || "";
  const resA    = cols[4] || "";
  const unit    = cols[6];
  const typeRaw = cols[7] || "";
  const cat     = cols[8] || "";

  const { start, end } = parseAcblDateRange(dateStr);

  // Extract real hrefs from <a href=""> fields
  const infoHref    = getHref(infoA);
  const resultsHref = getHref(resA);

  // Only convert to absolute URLs when they actually exist
  const infoUrl    = infoHref    ? absUrl(infoHref) : "";
  const resultsUrl = resultsHref ? absUrl(resultsHref) : "";

  const sanction   = extractSanction(infoUrl);

  const cityState = city && state
    ? `${city}, ${state}`
    : (city || state || "");

  const typeCombined = [typeRaw, cat].filter(Boolean).join(" / ");

  const name = [
    typeRaw || "",
    unit ? `Unit ${unit}` : "",
    cityState
  ].filter(Boolean).join(" — ");

  return {
    district: forcedDistrict || "",    // key change: trust the query context
    name,
    city: cityState,
    type: typeCombined,
    category: cat,
    infoUrl,
    resultsUrl,
    start,
    end,
    sanction
  };
}

function extractSanction(u) {
  if (!u) return "";
  const m = String(u).match(/[?&]sanction=(\d+)/i);
  return m ? m[1] : "";
}

function parseDateSafe(s) {
  if (!s) return null;
  // Common cases: "2025-03-21", "2025-03-21T00:00:00Z"
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

/***** WRITE TO SHEET *****/
function writeSheet(rows) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName(CFG.sheetName) || ss.insertSheet(CFG.sheetName);

  // Remove any existing filter and clear sheet
  const existing = sh.getFilter();
  if (existing) existing.remove();
  sh.clear();

  // New header INCLUDING District as first column
  const header = [
    "District",
    "Name",
    "Start (PT)",
    "End (PT)",
    "City/State",
    "Type",
    "Info",
    "Results",
    "Sanction"
  ];

  const data = rows.map(r => ([
    r.district || "",
    r.name || "",
    r.start ? Utilities.formatDate(r.start, CFG.timezone, "yyyy-MM-dd") : "",
    r.end   ? Utilities.formatDate(r.end,   CFG.timezone, "yyyy-MM-dd") : "",
    r.city || "",
    r.type || "",
    r.infoUrl || "",      // <-- was r.info
    r.resultsUrl || "",    // <-- was r.results
    r.sanction || ""
  ]));

  // Write header + data
  sh.getRange(1, 1, 1, header.length)
    .setValues([header])
    .setFontWeight("bold");

  if (data.length) {
    sh.getRange(2, 1, data.length, header.length).setValues(data);
  }

  // Freeze header, add filter, autosize
  sh.setFrozenRows(1);
  const filterRange = sh.getRange(1, 1, Math.max(2, data.length + 1), header.length);
  filterRange.createFilter();
  for (let c = 1; c <= header.length; c++) {
    sh.autoResizeColumn(c);
  }
}

function makeUrl_(base, params) {
  const parts = [];
  Object.keys(params).forEach(k => {
    const v = params[k];
    if (v !== undefined && v !== null && String(v) !== "") {
      parts.push(encodeURIComponent(k) + "=" + encodeURIComponent(String(v)));
    }
  });
  return base + (base.includes("?") ? "&" : "?") + parts.join("&");
}

/***** MENU *****/
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("ACBL")
    .addItem("Refresh Upcoming", "refreshCalendar")
    .addToUi();
}

// === ACBL date & link helpers ===
function getHref(anchorHtml) {
  if (!anchorHtml) return "";
  const m = String(anchorHtml).match(/href\s*=\s*['"]([^'"]+)['"]/i);
  return m ? m[1] : "";
}

function absUrl(u) {
  if (!u) return "";
  if (/^https?:\/\//i.test(u)) return u;
  return "https://tournaments.acbl.org/" + u.replace(/^\/+/, "");
}

function parseAcblDateRange(s) {
  const txt = String(s).replace(/[–—−]/g, "-").trim();
  const mon = "(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)";
  const day = "(\\d{1,2})";
  const year = "(\\d{4})";

  // Cross-month: "Apr 30-May 3, 2025"
  let m = txt.match(new RegExp(`^${mon}\\s+${day}-${mon}\\s+${day},\\s*${year}$`, "i"));
  if (m) {
    const y = +m[5];
    return {
      start: new Date(y, monthIdx(m[1]), +m[2]),
      end:   new Date(y, monthIdx(m[3]), +m[4])
    };
  }

  // Same-month: "Jan 6-12, 2025"
  m = txt.match(new RegExp(`^${mon}\\s+${day}-${day},\\s*${year}$`, "i"));
  if (m) {
    const y = +m[4], mo = monthIdx(m[1]);
    return { start: new Date(y, mo, +m[2]), end: new Date(y, mo, +m[3]) };
  }

  // Single day: "Oct 3, 2025"
  m = txt.match(new RegExp(`^${mon}\\s+${day},\\s*${year}$`, "i"));
  if (m) {
    const y = +m[3], mo = monthIdx(m[1]);
    const d = new Date(y, mo, +m[2]);
    return { start: d, end: d };
  }

  // Fallback: try generic Date
  const maybe = new Date(txt);
  if (!isNaN(maybe)) return { start: maybe, end: maybe };
  return { start: null, end: null };
}

function monthIdx(monStr) {
  const map = {jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11};
  return map[monStr.slice(0,3).toLowerCase()];
}

function sheetName() {
  return SpreadsheetApp.getActiveSpreadsheet().getActiveSheet().getName();
}

function createDistrictSheets_Test() {
  const ss = SpreadsheetApp.getActive();
  const template = ss.getSheetByName("District Template");
  if (!template) throw new Error("District Template sheet not found.");

  // 🧪 Temporary list for testing
  const districts = ["District 24", "District 25"];

  districts.forEach((name) => {
    // Skip if the sheet already exists
    if (ss.getSheetByName(name)) {
      Logger.log(`Skipping ${name} (already exists)`);
      return;
    }

    // Copy the template and rename
    const sh = template.copyTo(ss);
    sh.setName(name);

    // Extract district number from name (e.g. "District 24" → 24)
    const districtNum = Number(name.replace(/[^\d]/g, ""));
    sh.getRange("A1").setValue(districtNum);

    // Hide metadata row
    sh.hideRows(1);

    Logger.log(`Created ${name}`);
  });
}

function createDistrictSheets() {
  const ss = SpreadsheetApp.getActive();
  const template = ss.getSheetByName("District Template");
  if (!template) throw new Error("District Template sheet not found.");

  for (let d = 1; d <= 25; d++) {
    const sheetName = "District " + d;

    // If sheet already exists, don't touch it (preserves published URLs)
    let sh = ss.getSheetByName(sheetName);
    if (sh) {
      Logger.log("Skipping " + sheetName + " (already exists)");
      continue;
    }

    // Copy template
    sh = template.copyTo(ss);
    sh.setName(sheetName);

    // Set district number for the FILTER formula
    sh.getRange("A1").setValue(d);

    // Hide metadata row
    sh.hideRows(1);

    Logger.log("Created " + sheetName);
  }
}

function syncDistrictSheetsFromTemplate() {
  const ss = SpreadsheetApp.getActive();
  const template = ss.getSheetByName("DistrictTemplate");
  const templateRange = template.getDataRange();

  const districts = Array.from({length: 25}, (_, i) => String(i + 1));

  districts.forEach(d => {
    const sh = ss.getSheetByName(d);
    if (!sh) return;

    // Preserve A1/B1 (metadata), replace everything from row 2 down with template's row 2+
    sh.getRange(2, 1, sh.getMaxRows() - 1, sh.getMaxColumns()).clear();

    // Copy formulas & formatting from template rows 2+ into target rows 2+
    const rows = templateRange.getNumRows() - 1;
    const cols = templateRange.getNumColumns();
    if (rows > 0) {
      template.getRange(2, 1, rows, cols).copyTo(
        sh.getRange(2, 1),
        {contentsOnly: false}
      );
    }

    // Re-hide row 1 if needed
    if (!sh.isRowHiddenByUser(1)) sh.hideRows(1);
  });
}

function getLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("Log");
  if (!sh) {
    sh = ss.insertSheet("Log");
    sh.appendRow([
      "Timestamp",
      "Status",
      "Details",
      "Total Rows Written",
      "Years"
    ]);
  }
  return sh;
}

function logRun_(status, details, totalRows, yearsArray) {
  const sh = getLogSheet_();
  const tz = CFG.timezone || "America/Los_Angeles";
  const ts = Utilities.formatDate(new Date(), tz, "yyyy-MM-dd HH:mm:ss");
  const years = (yearsArray || []).join(", ");
  sh.appendRow([ts, status, details || "", totalRows || "", years]);
}

function buildDirectory() {
  const ss = SpreadsheetApp.getActive();
  let dir = ss.getSheetByName("Directory");
  if (!dir) dir = ss.insertSheet("Directory");

  dir.clear();
  dir.appendRow(["District", "Sheet Link", "Sheet GID", "Public URL (to fill later)"]);

  const baseUrl = ss.getUrl().split("/edit")[0];

  ss.getSheets().forEach(sh => {
    const name = sh.getName();
    if (/^District\s+\d+$/i.test(name)) {
      const gid = sh.getSheetId();
      const internal = `=HYPERLINK("#gid=${gid}", "${name}")`;
      // Write formulas so links stay live
      dir.appendRow([name, internal, gid, ""]);
    }
  });

  dir.autoResizeColumns(1, 4);
}

function ensureCalendarsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("Calendars");
  if (!sh) {
    sh = ss.insertSheet("Calendars");
    sh.appendRow(["District", "CalendarId", "Name", "URL"]);
  }
  return sh;
}

function setupDistrictCalendars() {
  const sh = ensureCalendarsSheet_();
  const data = sh.getDataRange().getValues();
  const header = data[0];
  const rows = data.slice(1);

  const idxDistrict = header.indexOf("District");
  const idxCalId    = header.indexOf("CalendarId");

  // Build a quick lookup of existing rows by district
  const existing = {};
  rows.forEach(r => {
    const d = String(r[idxDistrict] || "").trim();
    const id = String(r[idxCalId] || "").trim();
    if (d && id) {
      existing[d] = id;
    }
  });

  for (let d = 1; d <= 25; d++) {
    const dStr = String(d);
    if (existing[dStr]) {
      // Already have a calendar recorded for this district
      Logger.log(`District ${dStr}: using existing calendar ${existing[dStr]}`);
      continue;
    }

    const name = `ACBL District ${dStr} Tournaments`;
    const cal = CalendarApp.createCalendar(name);
    const calId = cal.getId();
    const url = "https://calendar.google.com/calendar/u/0/r?cid=" + encodeURIComponent(calId);

    Logger.log(`Created calendar for District ${dStr}: ${calId}`);

    // Append to Calendars sheet
    sh.appendRow([dStr, calId, name, url]);
  }
}

function getCalendarMap_() {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("Calendars");
  if (!sh) throw new Error("Calendars sheet not found. Run setupDistrictCalendars() first.");

  const data = sh.getDataRange().getValues();
  const header = data[0];
  const rows = data.slice(1);

  const idxDistrict = header.indexOf("District");
  const idxCalId    = header.indexOf("CalendarId");

  const map = {};
  rows.forEach(r => {
    const d = String(r[idxDistrict] || "").trim();
    const id = String(r[idxCalId] || "").trim();
    if (d && id) {
      map[d] = id;
    }
  });
  return map;
}

function syncDistrictCalendarsRange(startDistrict, endDistrict) {
  const ss = SpreadsheetApp.getActive();
  const sh = ss.getSheetByName("Upcoming");
  if (!sh) throw new Error("Upcoming sheet not found.");

  const DEBUG_STOP_ON_MISSING = true;  // set false to disable once you find the culprit

  const values = sh.getDataRange().getValues();
  if (values.length < 2) {
    Logger.log("No data in Upcoming.");
    return;
  }

  const header = values[0];
  const rows = values.slice(1);

  const idxDistrict = header.indexOf("District");
  const idxName     = header.indexOf("Name");
  const idxStart    = header.indexOf("Start (PT)");
  const idxEnd      = header.indexOf("End (PT)");
  const idxCity     = header.indexOf("City/State");
  const idxType     = header.indexOf("Type");
  const idxInfo     = header.indexOf("Info");
  const idxSanction = header.indexOf("Sanction");

  const required = [idxDistrict, idxName, idxStart, idxEnd, idxCity, idxType, idxInfo];
  if (required.some(i => i === -1)) {
    throw new Error("One or more required columns not found in Upcoming header.");
  }

  const calMap = getCalendarMap_();
  const tz = CFG.timezone || "America/Los_Angeles";

  const today = new Date();
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear() + 2, 0, 1); // adjust if desired

  // Load full index once; we'll update+save per-district
  let index = loadEventIndex_();
  const runId = new Date().toISOString();

  // Pre-build desired events by district from Upcoming
  const desiredByDistrict = {};
  rows.forEach(r => {
    const rowDistrict = String(r[idxDistrict] || "");
    const name        = String(r[idxName] || "").trim();
    const typeVal     = String(r[idxType] || "");
    const info        = String(r[idxInfo] || "");
    const city        = String(r[idxCity] || "");

    const start = toAllDayDate_(r[idxStart]);
    const end   = toAllDayDate_(r[idxEnd]);
    if (!start || !end) return;

    const endExclusive = new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1);
    if (endExclusive <= start) return;

    const isNabc = /NABC/i.test(typeVal);

    const targetDistricts = [];

    if (rowDistrict) {
      targetDistricts.push(String(rowDistrict));
    }

    if (isNabc) {
      Object.keys(calMap).forEach(d => {
        if (!targetDistricts.includes(d)) targetDistricts.push(d);
      });
    }

    if (targetDistricts.length === 0) return;

    const startKey = Utilities.formatDate(start, tz, "yyyy-MM-dd");
    const baseKey = (name + "|" + city + "|" + startKey);

    const title = name || (typeVal || "Bridge Event");

    let descBase = "";
    if (typeVal) descBase += "Type: " + typeVal + "\n";
    if (city)    descBase += "Location: " + city + "\n";
    if (info)     descBase += "\nInfo: " + info + "\n";

    targetDistricts.forEach(dStr => {
      if (!calMap[dStr]) return;
      const key = dStr + "|" + baseKey;
      if (!desiredByDistrict[dStr]) desiredByDistrict[dStr] = {};
      desiredByDistrict[dStr][key] = {
        title,
        start,
        endExclusive,
        location: city,
        description: descBase
      };
    });
  });

  const logSheet = ensureCalendarLogSheet_();

  // Process each district in the requested range
  for (let d = startDistrict; d <= endDistrict; d++) {
    const dStr = String(d);
    const calId = calMap[dStr];
    if (!calId) {
      Logger.log(`No calendar for District ${dStr}`);
      continue;
    }
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) {
      Logger.log(`Calendar not found for District ${dStr}: ${calId}`);
      continue;
    }

    const desired = desiredByDistrict[dStr] || {};
    const existingIndex = index[dStr] || {};
    const keysDesired = Object.keys(desired);
    const keysExisting = Object.keys(existingIndex);

    Logger.log(`District ${dStr}: desired=${keysDesired.length}, tracked=${keysExisting.length}`);

    // Load current events in window for this calendar
    const existingEvents = cal.getEvents(windowStart, windowEnd);
    const eventsById = {};
    existingEvents.forEach(e => { eventsById[e.getId()] = e; });

    const newIndexForDistrict = {};
    let created = 0, updated = 0, removed = 0;

    // 1) Upsert desired events
    keysDesired.forEach(key => {
      const de = desired[key];
      const evId = existingIndex[key];
      let ev = evId ? eventsById[evId] : null;

      if (!ev && evId) {
        try {
          ev = CalendarApp.getCalendarById(calId).getEventById(evId);
        } catch (e) {
          ev = null;
        }
      }

      if (!ev) {
        const newEv = cal.createAllDayEvent(
          de.title,
          de.start,
          de.endExclusive,
          {
            description: de.description,
            location: de.location
          }
        );
        newIndexForDistrict[key] = newEv.getId();
        created++;
        if (created % 40 === 0) Utilities.sleep(800);
      } else {
        let needsUpdate = false;

        if (ev.getAllDayStartDate().getTime() !== de.start.getTime() ||
            ev.getAllDayEndDate().getTime()   !== de.endExclusive.getTime()) {
          needsUpdate = true;
        }
        if (ev.getTitle() !== de.title) needsUpdate = true;
        if ((ev.getDescription() || "") !== (de.description || "")) needsUpdate = true;
        if ((ev.getLocation() || "") !== (de.location || "")) needsUpdate = true;

        if (needsUpdate) {
          ev.setTitle(de.title);
          ev.setAllDayDates(de.start, de.endExclusive);
          ev.setDescription(de.description || "");
          ev.setLocation(de.location || "");
          updated++;
        }
        newIndexForDistrict[key] = ev.getId();
      }
    });
   Logger.log(`District ${dStr}: checking for stale future events`);

    // 2) Remove stale future events for this district
    keysExisting.forEach(key => {

      if (desired[key]) return; // still needed

      const evId = existingIndex[key];
      if (!evId) return;

      let ev = eventsById[evId];
      if (!ev) {
        try {
          ev = CalendarApp.getCalendarById(calId).getEventById(evId);
        } catch (e) {
          ev = null;
        }
      }
      if (!ev) return;

      const today = new Date();
      const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate());

      const evStart = ev.getAllDayStartDate() || ev.getStartTime();
      if (evStart && evStart >= todayMidnight) {
        // Only delete future/ongoing events; keep completed ones
        const title = ev.getTitle ? ev.getTitle() : "(no title)";
        const startStr = Utilities.formatDate(evStart, CFG.timezone || "America/Los_Angeles", "yyyy-MM-dd");
        Logger.log(`Deleting event: "${title}" starting ${startStr}`);
        ev.deleteEvent();
        removed++;
        if (removed % 40 === 0) Utilities.sleep(800);
      }
    
    });

    // --- 2b) Remove unindexed future events by ID (tomorrow onward) ---
    Logger.log(`District ${dStr}: cleanup by ID (tomorrow onward)`);

    // Build the allow-list from what we just kept/created this run
    const allowed = new Set();
    Object.values(newIndexForDistrict).forEach(id => {
      if (!id) return;
      allowed.add(id);
      allowed.add(String(id).replace(/@google\.com$/, "")); // handle bare form too
    });

    // Only look at events starting tomorrow or later
    const tomorrowMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const futureEvents = cal.getEvents(tomorrowMidnight, windowEnd);

    let removedById = 0;
    futureEvents.forEach(ev => {
      const eid = ev.getId();
      const keep = allowed.has(eid) || allowed.has(String(eid).replace(/@google\.com$/, ""));
      if (!keep) {
        ev.deleteEvent();
        removedById++;
        if (removedById % 40 === 0) Utilities.sleep(800);
      }
    });
    Logger.log(`District ${dStr}: removed ${removedById} unindexed events by ID`);

    Logger.log(
      `District ${dStr}: created=${created}, updated=${updated}, removed=${removed}`
    );

    // 3) Persist index + log immediately for this district
    index[dStr] = newIndexForDistrict;
    saveEventIndex_(index);  // <-- save progress after each district

      if (removed > 50 && created === 0 && updated === 0 && keysDesired.length > 0) {
        const msg = `Calendar sync anomaly for District ${dStr}: ` +
                    `${removed} removed, 0 created, 0 updated. Please review.`;
      Logger.log(msg);
      try {
        MailApp.sendEmail({
          to: "bridge.craftwork@gmail.com",
          subject: "[ACBL Calendar] Calendar sync anomaly",
          body: msg
        });
      } catch (e) {
        Logger.log("MailApp failed: " + e);
      }
    }

    const kept = Math.max(keysDesired.length - created - updated, 0);
    const totalAfter = keysDesired.length;

    Logger.log(
      `District ${dStr}: created=${created}, updated=${updated}, removed=${removed}, ` +
      `kept=${kept}, totalAfter=${totalAfter}`
    );

    logSheet.appendRow([
      new Date(),
      runId,
      `syncDistrictCalendarsRange(${startDistrict},${endDistrict})`,
      dStr,
      created,
      updated,
      removed,
      kept,
      totalAfter,
      "OK"
    ]);

    Utilities.sleep(300);
  }
}

function toAllDayDate_(value) {
  if (!value) return null;

  // If it's already a Date object
  if (Object.prototype.toString.call(value) === "[object Date]" && !isNaN(value)) {
    return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  }

  // If it's a string like "2025-01-15"
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const m = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (m) {
      const year = Number(m[1]);
      const month = Number(m[2]) - 1;
      const day = Number(m[3]);
      return new Date(year, month, day);
    }
    // Last resort: let Date parse it
    const d = new Date(trimmed);
    if (!isNaN(d)) {
      return new Date(d.getFullYear(), d.getMonth(), d.getDate());
    }
  }

  return null;
}

function ensureCalendarEventsSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("CalendarEvents");
  if (!sh) {
    sh = ss.insertSheet("CalendarEvents");
    sh.appendRow(["District", "Key", "EventId"]);
  }
  return sh;
}

function loadEventIndex_() {
  const sh = ensureCalendarEventsSheet_();
  const values = sh.getDataRange().getValues();
  if (values.length < 2) return {};

  const header = values[0];
  const rows = values.slice(1);

  const idxDistrict = header.indexOf("District");
  const idxKey      = header.indexOf("Key");
  const idxEventId  = header.indexOf("EventId");

  const index = {}; // { district: { key: eventId } }

  rows.forEach(r => {
    const d = String(r[idxDistrict] || "").trim();
    const k = String(r[idxKey] || "").trim();
    const id = String(r[idxEventId] || "").trim();
    if (!d || !k || !id) return;
    if (!index[d]) index[d] = {};
    index[d][k] = id;
  });

  return index;
}

function saveEventIndex_(index) {
  const sh = ensureCalendarEventsSheet_();
  sh.clear();
  sh.appendRow(["District", "Key", "EventId"]);

  const rows = [];
  Object.keys(index).forEach(d => {
    const byKey = index[d];
    Object.keys(byKey).forEach(k => {
      rows.push([d, k, byKey[k]]);
    });
  });

  if (rows.length) {
    sh.getRange(2, 1, rows.length, 3).setValues(rows);
  }
}

function purgeLegacyEventsOnce() {
  const calMap = getCalendarMap_();
  const index = loadEventIndex_();

  const today = new Date();
  // Only touch future-ish events so we don't rewrite history
  const windowStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const windowEnd = new Date(today.getFullYear() + 2, 0, 1); // same window as sync

  Object.keys(calMap).forEach(dStr => {
    const calId = calMap[dStr];
    const cal = CalendarApp.getCalendarById(calId);
    if (!cal) {
      Logger.log(`Calendar not found for District ${dStr}: ${calId}`);
      return;
    }

    const knownIds = new Set(Object.values(index[dStr] || {}));

    Logger.log(`Purging legacy events for District ${dStr}`);
    const events = cal.getEvents(windowStart, windowEnd);
    let removed = 0;

    events.forEach(e => {
      const id = e.getId();

      // If this event's ID is not in our mapping, it's from the old system → remove it.
      if (!knownIds.has(id)) {
        e.deleteEvent();
        removed++;
        if (removed % 50 === 0) {
          Utilities.sleep(1000); // be gentle with API
        }
      }
    });

    Logger.log(`District ${dStr}: removed ${removed} legacy events`);
    Utilities.sleep(300);
  });
}

function ensureCalendarLogSheet_() {
  const ss = SpreadsheetApp.getActive();
  let sh = ss.getSheetByName("Calendar Log");
  if (!sh) {
    sh = ss.insertSheet("Calendar Log");
    sh.appendRow([
      "Timestamp",
      "RunId",
      "Source",
      "District",
      "Created",
      "Updated",
      "Removed",
      "Note"
    ]);
  }
  return sh;
}

// --- Chunked calendar sync helpers ---
// Run these one at a time from the Run menu in Apps Script.

function syncChunk1to5()  { syncDistrictCalendarsRange(1,5);  }
function syncChunk6to10() { syncDistrictCalendarsRange(6,10); }
function syncChunk11to15(){ syncDistrictCalendarsRange(11,15); }
function syncChunk16to20(){ syncDistrictCalendarsRange(16,20); }
function syncChunk21to25(){ syncDistrictCalendarsRange(21,25); }
function syncDistrict11(){ syncDistrictCalendarsRange(11,11); }
function syncDistrict6(){ syncDistrictCalendarsRange(6,6); }

// Optional: wrapper to run all with pauses between chunks
function syncAllChunksSequentially() {
  syncDistrictCalendarsRange(1,5);
  Utilities.sleep(20000); // 20-second pause between chunks
  syncDistrictCalendarsRange(6,10);
  Utilities.sleep(20000);
  syncDistrictCalendarsRange(11,15);
  Utilities.sleep(20000);
  syncDistrictCalendarsRange(16,20);
  Utilities.sleep(20000);
  syncDistrictCalendarsRange(21,25);
}

