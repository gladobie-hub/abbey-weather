#!/usr/bin/env node
// Refreshes the Weather Almanac dashboard's baked-in data, in place.
//
// Pulls the rolling last-14-days window for the current year, plus the matching
// dates one year back, straight from the public weather services — no farm
// backend needed. Rewrites ONLY the #almanac-data JSON block in the HTML file;
// GitHub Pages then republishes index.html from main on the next push.
//
//   Current year : SEPA Day.Total (live) + Open-Meteo forecast (observed blend)
//   Last year    : SEPA from/to + Open-Meteo archive (ERA5) for the same dates
//
// Run from hydro.yml rather than on a schedule of its own — see that workflow for
// why. This reads a different SEPA series from scripts/fetch-hydro.mjs (Day.Total
// 65453010, against the hydro script's 65970010) because the page also needs
// Open-Meteo temperature and wind, which data/*.json does not carry.
//
// Usage: node refresh-weather-dashboard.mjs [path-to-html]

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const HTML_PATH = process.argv[2] ||
  new URL("./index.html", import.meta.url).pathname;

// Sits beside the HTML, so the page's relative fetch("data/dashboard.json")
// resolves whether it is served from the repo root or a project subpath.
const JSON_PATH = join(dirname(HTML_PATH), "data", "dashboard.json");

const SEPA_TS_ID = "65453010"; // Abbey St Bathans, Precip Day.Total (mm)
const LAT = 55.853, LON = -2.387;
const LOCATION = "Abbey St Bathans, Berwickshire";
const SOURCE = "SEPA on-farm gauge (station 36870) &middot; Open-Meteo";
const WINDOW = 14;

const round = (n, dp = 1) => { const f = 10 ** dp; return Math.round(n * f) / f; };

function londonToday() {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(new Date()).map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// Retry only genuinely transient upstream trouble: 5xx and network/DNS errors.
// A 4xx still fails on the first attempt — it means a bad ts_id or a changed API,
// which is a bug to fix rather than a blip to ride out. Keep it that narrow.
const RETRIES = 3;

async function getJson(url, label) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`${label} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    if (res.status >= 500 && attempt < RETRIES) {
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
    return res.json();
  }
}

// SEPA rainfall for a date range → Map<YYYY-MM-DD, mm>
async function sepaRain(from, to) {
  const url = `https://timeseries.sepa.org.uk/KiWIS/KiWIS?service=kisters&type=queryServices` +
    `&datasource=0&request=getTimeseriesValues&ts_id=${SEPA_TS_ID}` +
    `&from=${from}&to=${to}&returnfields=Timestamp,Value&format=json`;
  const j = await getJson(url, "SEPA");
  const rows = (Array.isArray(j) ? j[0]?.data : null) || [];
  return new Map(rows.map(([t, v]) => [String(t).split("T")[0], Number(v)]));
}

// Open-Meteo daily temp/wind for a date range → Map<date, {tmin,tmax,wind}>
async function openMeteo(from, to, archive) {
  const base = archive
    ? "https://archive-api.open-meteo.com/v1/archive"
    : "https://api.open-meteo.com/v1/forecast";
  const url = `${base}?latitude=${LAT}&longitude=${LON}` +
    `&daily=temperature_2m_max,temperature_2m_min,wind_speed_10m_max` +
    `&wind_speed_unit=mph&timezone=Europe/London&start_date=${from}&end_date=${to}`;
  const j = await getJson(url, archive ? "Open-Meteo archive" : "Open-Meteo");
  const d = j.daily;
  const m = new Map();
  for (let i = 0; i < d.time.length; i++) {
    const tmin = d.temperature_2m_min[i], tmax = d.temperature_2m_max[i], wind = d.wind_speed_10m_max[i];
    if (tmin == null || tmax == null) continue;
    m.set(d.time[i], { tmin, tmax, wind });
  }
  return m;
}

const shiftYear = (iso, delta) => {
  const [y, m, d] = iso.split("-");
  return `${Number(y) + delta}-${m}-${d}`;
};

function rollup(days) {
  const wk = days.slice(-7);
  return {
    weekEnding: wk.at(-1).date,
    totalRain: round(wk.reduce((s, x) => s + x.rain, 0)),
    avgMin: round(wk.reduce((s, x) => s + x.tmin, 0) / wk.length),
    avgMax: round(wk.reduce((s, x) => s + x.tmax, 0) / wk.length),
    maxWind: round(Math.max(...wk.map((x) => x.wind)), 0),
    days: wk.length,
  };
}

async function main() {
  const today = londonToday();
  // Wide current-year range: last ~20 days up to today (SEPA/OM trim to what exists)
  const start = new Date(`${today}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - 20);
  const curFrom = start.toISOString().slice(0, 10);

  // Current year
  const [rainCur, tempCur] = await Promise.all([
    sepaRain(curFrom, today),
    openMeteo(curFrom, today, false),
  ]);
  const cur = [...rainCur.keys()]
    .filter((date) => tempCur.has(date))
    .sort()
    .slice(-WINDOW)
    .map((date) => {
      const t = tempCur.get(date);
      return { date, rain: round(rainCur.get(date) ?? 0), tmin: round(t.tmin), tmax: round(t.tmax), wind: round(t.wind, 0) };
    });
  if (cur.length === 0) throw new Error("No overlapping current-year rain/temp data");

  // Last year — same calendar dates
  const lyFrom = shiftYear(cur[0].date, -1);
  const lyTo = shiftYear(cur.at(-1).date, -1);
  const [rainLy, tempLy] = await Promise.all([
    sepaRain(lyFrom, lyTo),
    openMeteo(lyFrom, lyTo, true),
  ]);
  const lyDays = cur.map((c) => {
    const date = shiftYear(c.date, -1);
    const t = tempLy.get(date);
    if (!t) return null;
    return { date, rain: round(rainLy.get(date) ?? 0), tmin: round(t.tmin), tmax: round(t.tmax), wind: round(t.wind, 0) };
  }).filter(Boolean);

  const data = {
    location: LOCATION,
    updated: today,
    source: SOURCE,
    weekly: rollup(cur),
    days: cur,
    lastYear: lyDays.length >= 7
      ? { label: String(Number(cur.at(-1).date.slice(0, 4)) - 1), weekly: rollup(lyDays), days: lyDays }
      : undefined,
  };

  const json = JSON.stringify(data, null, 2);

  // Two outputs, same payload. data/dashboard.json is what the page actually
  // fetches (with a cache-buster, so it is never served stale); the #almanac-data
  // block is the baked-in fallback the page renders first. Write the fallback
  // first — if that throws because the HTML changed shape, we haven't already
  // published a JSON file the page would then disagree with.
  const html = await readFile(HTML_PATH, "utf8");
  const block = `<script id="almanac-data" type="application/json">\n${json}\n</script>`;
  const re = /<script id="almanac-data" type="application\/json">[\s\S]*?<\/script>/;
  if (!re.test(html)) throw new Error("Could not find #almanac-data block in HTML");
  await writeFile(HTML_PATH, html.replace(re, block));

  await writeFile(JSON_PATH, json + "\n");

  console.log(`Refreshed ${HTML_PATH} and ${JSON_PATH}`);
  console.log(`  current: ${cur.length} days ending ${cur.at(-1).date} (rain ${data.weekly.totalRain}mm/wk)`);
  console.log(`  last year: ${data.lastYear ? data.lastYear.days.length + " days, " + data.lastYear.weekly.totalRain + "mm/wk" : "unavailable"}`);
}

main().catch((e) => { console.error(`refresh failed: ${e.message}`); process.exit(1); });
