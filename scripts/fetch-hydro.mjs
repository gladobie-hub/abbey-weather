#!/usr/bin/env node
// Pulls Abbey St Bathans rainfall and river level from SEPA and writes flat JSON
// into data/. Nothing here is served by an API — the committed files ARE the API,
// so a reader fetches one static URL and computes any window it likes locally.
//
//   data/latest.json        current conditions; overwritten every run
//   data/recent-15min.json  rolling 30 days at 15-minute resolution
//   data/daily.json         every daily total since 2005; refetched whole
//   data/monthly.json       monthly totals + long-term min/mean/max per month
//
// Usage: node scripts/fetch-hydro.mjs [--daily] [--out DIR]
//   --daily  also rebuild daily.json and monthly.json (the 09:00 UTC rollup).
//            Implied when daily.json is missing, so a first run backfills itself.
//
// All KiWIS timestamps are UTC. Two traps are handled explicitly and must stay
// handled — see verifyHydroDay() and londonMidnightUtc().

import { readFile, writeFile, mkdir } from "node:fs/promises";

const KIWIS = "https://timeseries.sepa.org.uk/KiWIS/KiWIS";

const STATION = {
  id: 36870,
  no: "15018",
  name: "Abbey St Bathans",
  river: "Whiteadder Water",
  catchment: "Tweed",
  lat: 55.853,
  lon: -2.387,
};

// Only series confirmed to return data. SEPA also publishes ts_ids for
// Month.Total, CalendarYear.Total, HydrologicalYear.Total, LongTermValue
// Min/Max and PeaksOverThreshold — all six are EMPTY at this station, so every
// aggregate below is computed from the daily record instead. Do not "restore"
// them without checking they actually return rows.
const TS = {
  rain15: "65452010", // Precip 15minute.Total (mm)
  rainHour: "65446010", // Precip Hour.Total (mm)
  rain36h: "65970010", // Precip Hour.36HourTotal (mm)
  rainDay: "65453010", // Precip Day.Total (mm), stamped at the 09:00Z day START
  ltvMonthMean: "65449010", // LongTermValue.Month.Mean (mm)
  river15: "56178010", // River level 15minute (m)
  riverTrend: "69680010", // 15m.RisingFalling.Cmd (+1 rising / -1 falling)
  riverDayMin: "56184010",
  riverDayMean: "56183010",
  riverDayMax: "56182010",
};

// SEPA's own getQualityCodes vocabulary. 254 is the bulk of live telemetry and
// means "no code assigned" — provisional, NOT bad. -1 marks a genuine gap: the
// value comes back null and must never be read as a zero.
const QUALITY = {
  50: "good",
  100: "estimated",
  140: "provisional",
  150: "suspect",
  200: "unknown",
  254: "unclassified",
  "-1": "missing",
};
const CONCERNING = new Set([100, 150, 200]); // worth surfacing; 50/254 are routine

const HISTORY_START = "2005-01-01"; // daily totals begin here
const STALE_HOURS = 3; // fail the job past this, so a dead feed can't read as dry

const round = (n, dp = 1) => (n == null ? null : Math.round(n * 10 ** dp) / 10 ** dp);
const isoDay = (t) => String(t).slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);

// ---------------------------------------------------------------- KiWIS access

// SEPA's demonstrator service returns the occasional 500 — one did on 2026-07-28,
// costing a whole run at a point where GitHub was already dropping most of them.
// A 429 cost another run on 2026-07-29: nine ts_ids fire concurrently every tick
// (scripts/fetch-hydro.mjs's Promise.all below), enough to occasionally trip
// SEPA's rate limiter. Retry only what is genuinely transient: 5xx, 429, and
// network/DNS errors. Everything else still fails on the first attempt, and that
// is the point — a 4xx other than 429 means a bad ts_id (our bug, not a blip),
// and the parse, staleness and hydrological-day guards below exist precisely to
// stop a plausible-but-wrong file being published. Do not widen this into a
// general retry wrapper.
const RETRIES = 3;

async function fetchWithRetry(url, label) {
  for (let attempt = 1; ; attempt++) {
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      if (attempt >= RETRIES) throw new Error(`${label} failed: ${e.message}`);
      await new Promise((r) => setTimeout(r, attempt * 2000));
      continue;
    }
    if ((res.status >= 500 || res.status === 429) && attempt < RETRIES) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const delayMs = retryAfter > 0 ? retryAfter * 1000 : attempt * 2000;
      await new Promise((r) => setTimeout(r, delayMs));
      continue;
    }
    if (!res.ok) throw new Error(`${label} failed: ${res.status} ${res.statusText}`);
    return res;
  }
}

async function kiwis(tsId, params) {
  const qs = new URLSearchParams({
    service: "kisters",
    type: "queryServices",
    datasource: "0",
    request: "getTimeseriesValues",
    ts_id: tsId,
    returnfields: "Timestamp,Value,Quality Code",
    format: "json",
    kvp: "true",
    ...params,
  });
  const res = await fetchWithRetry(`${KIWIS}?${qs}`, `KiWIS ${tsId}`);
  const body = await res.json();
  const block = Array.isArray(body) ? body[0] : null;
  if (!block || !Array.isArray(block.data)) {
    throw new Error(`KiWIS ${tsId} returned no data block (shape changed?)`);
  }
  // Normalise to {t, v, q}. A null value is a real gap, preserved as null.
  return block.data.map(([t, v, q]) => ({
    t: String(t),
    v: v == null ? null : Number(v),
    q: q == null ? null : Number(q),
  }));
}

const series = (tsId, from, to) => kiwis(tsId, { from, to });
const recent = (tsId, period) => kiwis(tsId, { period });

// ------------------------------------------------------------- time boundaries

// Milliseconds Europe/London is ahead of UTC at instant d (0 in GMT, 3600000 in BST).
function londonOffsetMs(d) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(d);
  const g = (type) => Number(parts.find((p) => p.type === type).value);
  const asIfUtc = Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute"), g("second"));
  return asIfUtc - Math.floor(d.getTime() / 1000) * 1000;
}

// The UTC instant of the most recent local midnight. Under BST that is 23:00Z
// the previous day — get this wrong and overnight rain lands on the wrong date.
function londonMidnightUtc(now) {
  const local = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/London", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const naive = new Date(`${local}T00:00:00Z`);
  return new Date(naive.getTime() - londonOffsetMs(naive));
}

// The most recent 09:00 UTC boundary at or before `now`. Verified empirically:
// Day.Total matches a 09:00Z..09:00Z window year-round, NOT 09:00 local, so in
// BST the gauge day closes at 10:00 local. See verifyHydroDay().
function hydroDayStartUtc(now) {
  const today9 = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 9, 0, 0,
  ));
  return now >= today9 ? today9 : addDays(today9, -1);
}

// --------------------------------------------------------------- summarisation

// Sum values in (after, upTo]. Returns the total plus what was skipped, so a
// gauge outage is visible as gaps rather than disguised as a dry spell.
function sumWindow(rows, after, upTo) {
  let mm = 0, readings = 0, gaps = 0;
  const flagged = [];
  for (const r of rows) {
    const t = Date.parse(r.t);
    if (!(t > after.getTime() && t <= upTo.getTime())) continue;
    if (r.v == null) { gaps++; continue; }
    mm += r.v;
    readings++;
    if (CONCERNING.has(r.q)) flagged.push({ at: r.t, quality: QUALITY[r.q] ?? String(r.q) });
  }
  return { mm: round(mm, 2), readings, gaps, flagged };
}

const lastGood = (rows) => [...rows].reverse().find((r) => r.v != null) ?? null;

// Cross-check our 15-minute summing against SEPA's own published Day.Total for
// every closed day we hold, and simultaneously test the rival hypothesis that
// the day boundary is 09:00 *local* rather than 09:00 UTC.
//
// Checking one day is close to worthless: the two hypotheses only give different
// answers when rain actually fell in the disputed hour, which was true on just 6
// of 87 days sampled. So we check the whole window and count how many days were
// genuinely discriminating — a run of "agrees" over non-discriminating days
// proves nothing, and the file should say so rather than imply confidence.
function verifyHydroDay(rain15, rainDay, now) {
  const results = [], disagreements = [];
  let discriminating = 0, localHypothesisMatches = 0;

  for (const published of rainDay) {
    if (published.v == null) continue;
    const date = isoDay(published.t);
    const start = new Date(`${date}T09:00:00Z`);
    const end = addDays(start, 1);
    if (end > now) continue; // day not closed yet

    const utcWindow = sumWindow(rain15, start, end);
    if (utcWindow.readings < 90) continue; // not enough 15-min cover to judge

    // Same day under the "09:00 local" reading — an hour earlier during BST.
    const shift = londonOffsetMs(start);
    const localWindow = shift
      ? sumWindow(rain15, new Date(start.getTime() - shift), new Date(end.getTime() - shift)).mm
      : utcWindow.mm;

    const utcAgrees = Math.abs(utcWindow.mm - published.v) < 0.05;
    const localAgrees = Math.abs(localWindow - published.v) < 0.05;
    if (utcWindow.mm !== localWindow) {
      discriminating++;
      if (localAgrees) localHypothesisMatches++;
    }
    results.push(utcAgrees);
    if (!utcAgrees) {
      disagreements.push({ day: date, publishedMm: published.v, computedMm: utcWindow.mm });
    }
  }

  if (!results.length) return { checked: false, reason: "no closed day with full 15-minute cover" };
  return {
    checked: true,
    agrees: disagreements.length === 0,
    window: "09:00Z to 09:00Z, fixed year-round",
    daysChecked: results.length,
    daysAgreed: results.filter(Boolean).length,
    discriminatingDays: discriminating,
    localTimeHypothesisMatches: localHypothesisMatches,
    disagreements,
    note: "discriminatingDays counts days where a 09:00-local boundary would give a different total. Only those days actually test the assumption; localTimeHypothesisMatches should stay 0",
  };
}

// ------------------------------------------------------------------- documents

// The long-term average rainfall for the 1st to the Nth of this month, taken over
// every complete year on record and excluding the current one.
//
// Without this, month-to-date can only be compared against a whole-month mean —
// which on the 2nd of the month reads as "2% of normal" and looks like a drought.
// Comparing part of a month with all of one is not a comparison.
function monthToDateNormal(dailyDoc, month, dayOfMonth, currentYear) {
  if (!dailyDoc) return null;
  const base = Date.parse(`${dailyDoc.firstDate}T00:00:00Z`);
  const byYear = new Map();

  for (let i = 0; i < dailyDoc.mm.length; i++) {
    const d = new Date(base + i * 86400000);
    if (d.getUTCMonth() + 1 !== month || d.getUTCDate() > dayOfMonth) continue;
    const y = d.getUTCFullYear();
    if (y === currentYear) continue;
    if (!byYear.has(y)) byYear.set(y, { sum: 0, days: 0, gaps: 0 });
    const b = byYear.get(y);
    if (dailyDoc.mm[i] == null) b.gaps++;
    else { b.sum += dailyDoc.mm[i]; b.days++; }
  }

  // Only years with every day of the window present can be averaged.
  const vals = [...byYear.values()]
    .filter((b) => b.gaps === 0 && b.days === dayOfMonth)
    .map((b) => b.sum);
  if (!vals.length) return null;
  return {
    mean: round(vals.reduce((s, v) => s + v, 0) / vals.length, 1),
    min: round(Math.min(...vals), 1),
    max: round(Math.max(...vals), 1),
    years: vals.length,
  };
}

function buildLatest({ rain15, rainDay, rain36h, river15, riverTrend, riverDay, ltv, dailyDoc }, now) {
  const newest = lastGood(rain15);
  const lastReadingAt = newest ? newest.t : null;
  const upTo = lastReadingAt ? new Date(Date.parse(lastReadingAt)) : now;

  const midnight = londonMidnightUtc(now);
  const hydro = hydroDayStartUtc(now);

  const sinceMidnight = sumWindow(rain15, midnight, upTo);
  const sinceHydro = sumWindow(rain15, hydro, upTo);
  const last24h = sumWindow(rain15, addDays(upTo, -1), upTo);
  const last7d = sumWindow(rain15, addDays(upTo, -7), upTo);

  // 36h total is a published rolling series; fall back to summing if absent.
  const newest36 = lastGood(rain36h);
  const last36h = newest36
    ? { mm: round(newest36.v, 2), source: "SEPA Hour.36HourTotal" }
    : { ...sumWindow(rain15, new Date(upTo.getTime() - 36 * 3600000), upTo), source: "computed from 15-minute values" };

  // Month to date, and how that compares with the long-term mean for this month.
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const mtd = sumWindow(rain15, monthStart, upTo);
  const monthMean = ltv.get(now.getUTCMonth() + 1) ?? null;
  const mtdNormal = monthToDateNormal(
    dailyDoc, now.getUTCMonth() + 1, now.getUTCDate(), now.getUTCFullYear(),
  );

  const level = lastGood(river15);
  const trend = lastGood(riverTrend);

  // Scoped to the last 24h — the windows above overlap, so combining their
  // counts would double-count the same readings.
  const flagged = last24h.flagged;
  const gaps = last24h.gaps;

  return {
    station: { id: STATION.id, name: STATION.name, river: STATION.river, lat: STATION.lat, lon: STATION.lon },
    fetchedAt: now.toISOString(),
    lastReadingAt,
    stalenessMinutes: lastReadingAt ? Math.round((now - Date.parse(lastReadingAt)) / 60000) : null,
    rainfall: {
      units: "mm",
      sinceMidnightLocal: {
        mm: sinceMidnight.mm,
        dayDefinition: "midnight Europe/London (BST in summer)",
        from: midnight.toISOString(),
      },
      sinceHydroDay0900: {
        mm: sinceHydro.mm,
        dayDefinition: "09:00 UTC hydrological day — 10:00 local under BST",
        from: hydro.toISOString(),
      },
      last24h: { mm: last24h.mm },
      last36h,
      last7d: { mm: last7d.mm },
      monthToDate: {
        mm: mtd.mm,
        throughDayOfMonth: now.getUTCDate(),
        // Like-for-like: this month so far against the same span of previous years.
        // Use this one for "wetter or drier than normal?".
        normalToDate: mtdNormal
          ? {
              mm: mtdNormal.mean,
              percentOfNormal: mtdNormal.mean ? Math.round((mtd.mm / mtdNormal.mean) * 100) : null,
              rangeMm: [mtdNormal.min, mtdNormal.max],
              basedOnYears: mtdNormal.years,
            }
          : null,
        // The whole-month figure, for context only. Comparing a part-month total
        // against it understates rainfall badly early in the month.
        wholeMonthNormal: {
          mm: monthMean,
          note: "full-month long-term mean — do NOT compare month-to-date against this",
        },
        note: "summed from 15-minute values over the calendar month (UTC); SEPA's Month.Total series is empty at this station. The to-date baseline comes from the 09:00Z daily record, so the two differ by a sub-day boundary offset",
      },
    },
    riverLevel: {
      units: "m",
      m: level ? round(level.v, 3) : null,
      at: level ? level.t : null,
      trend: trend ? (trend.v > 0 ? "rising" : trend.v < 0 ? "falling" : "steady") : null,
      lastClosedDay: riverDay,
    },
    quality: {
      allGood: flagged.length === 0 && gaps === 0,
      gaps,
      flagged,
      note: "SEPA codes: 50 good, 100 estimated, 140 provisional, 150 suspect, 200 unknown, 254 unclassified (routine live telemetry), -1 missing",
    },
    hydroDayCheck: verifyHydroDay(rain15, rainDay, now),
    source: "SEPA KiWIS timeseries (demonstrator service, not supported for business use)",
  };
}

// Twenty-one years of daily totals as one object per day is ~660KB — too big to
// read in one go, which defeats the point. The series is contiguous, so store a
// dense array indexed off firstDate instead: ~15x smaller and losslessly
// expandable. Densifying (rather than trusting contiguity) means a future gap in
// SEPA's dates becomes an honest null, not a silent one-day shift of everything
// after it.
function buildDaily(rainDay, now) {
  const byDate = new Map();
  for (const r of rainDay) {
    byDate.set(isoDay(r.t), { mm: r.v == null ? null : round(r.v, 2), q: r.q });
  }
  const dates = [...byDate.keys()].sort();
  const first = dates[0], last = dates.at(-1);

  const mm = [];
  const missingDates = [], suspectDates = [];
  const qualityCounts = {};
  for (let t = Date.parse(`${first}T00:00:00Z`); t <= Date.parse(`${last}T00:00:00Z`); t += 86400000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const row = byDate.get(date);
    const label = row ? QUALITY[row.q] ?? String(row.q) : "absent";
    qualityCounts[label] = (qualityCounts[label] ?? 0) + 1;
    if (!row || row.mm == null) missingDates.push(date);
    else if (label === "suspect") suspectDates.push(date);
    mm.push(row ? row.mm : null);
  }

  return {
    station: { id: STATION.id, name: STATION.name },
    fetchedAt: now.toISOString(),
    dayDefinition: "09:00 UTC to 09:00 UTC, stamped with the START date",
    units: "mm",
    encoding: "mm[i] is the total for the day (firstDate + i days). Dates are consecutive with none missing. null means no reading was received — never read it as zero rainfall",
    firstDate: first,
    lastDate: last,
    count: mm.length,
    gaps: missingDates.length,
    qualityCounts,
    stats: dailyStats(first, mm),
    missingDates,
    suspectDates,
    mm,
  };
}

// Precomputed answers to the questions that would otherwise mean parsing the
// whole array — annual totals, wettest days, dry runs.
function dailyStats(firstDate, mm) {
  const dateAt = (i) => new Date(Date.parse(`${firstDate}T00:00:00Z`) + i * 86400000).toISOString().slice(0, 10);

  const calendar = {}, hydrological = {};
  let wettest = { date: null, mm: -1 };
  let longestDry = { days: 0, from: null, to: null };
  let run = 0, runStart = 0;

  for (let i = 0; i < mm.length; i++) {
    const v = mm[i], date = dateAt(i);
    const year = Number(date.slice(0, 4));
    // Hydrological year runs Oct–Sep and is named for the year it starts in.
    const hy = Number(date.slice(5, 7)) >= 10 ? year : year - 1;

    if (v != null) {
      calendar[year] = round((calendar[year] ?? 0) + v, 1);
      hydrological[hy] = round((hydrological[hy] ?? 0) + v, 1);
      if (v > wettest.mm) wettest = { date, mm: v };
    }
    // A null breaks a dry run: we cannot claim a day was dry with no reading.
    if (v === 0) {
      if (run === 0) runStart = i;
      run++;
      if (run > longestDry.days) longestDry = { days: run, from: dateAt(runStart), to: date };
    } else {
      run = 0;
    }
  }

  const ranked = mm
    .map((v, i) => (v == null ? null : { date: dateAt(i), mm: v }))
    .filter(Boolean)
    .sort((a, b) => b.mm - a.mm)
    .slice(0, 10);

  return {
    wettestDay: wettest.date ? wettest : null,
    top10WettestDays: ranked,
    longestDryRun: longestDry.days ? longestDry : null,
    currentDryRun: run,
    calendarYearTotals: calendar,
    hydrologicalYearTotals: hydrological,
    note: "hydrological year runs October–September, named for the year it starts. Years at either end of the record are partial. Dry run counts days of exactly 0.0mm; a missing reading breaks the run",
  };
}

function buildMonthly(dailyDoc, ltv, now) {
  // Aggregate the daily record into calendar months, tracking completeness so an
  // incomplete month is never compared against a full-month long-term mean.
  const buckets = new Map();
  const base = Date.parse(`${dailyDoc.firstDate}T00:00:00Z`);
  for (let i = 0; i < dailyDoc.mm.length; i++) {
    const key = new Date(base + i * 86400000).toISOString().slice(0, 7);
    if (!buckets.has(key)) buckets.set(key, { mm: 0, days: 0, gaps: 0 });
    const b = buckets.get(key);
    if (dailyDoc.mm[i] == null) b.gaps++;
    else { b.mm += dailyDoc.mm[i]; b.days++; }
  }

  const daysInMonth = (key) => {
    const [y, m] = key.split("-").map(Number);
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
  };

  const months = [...buckets.entries()].sort().map(([month, b]) => ({
    month,
    mm: round(b.mm, 1),
    daysWithData: b.days,
    gaps: b.gaps,
    complete: b.days + b.gaps >= daysInMonth(month) && b.gaps === 0,
  }));

  // Long-term min/mean/max per calendar month, from complete months only.
  const byCalendarMonth = {};
  for (let m = 1; m <= 12; m++) {
    const vals = months.filter((x) => x.complete && Number(x.month.slice(5)) === m).map((x) => x.mm);
    byCalendarMonth[m] = vals.length
      ? {
          min: round(Math.min(...vals), 1),
          mean: round(vals.reduce((s, v) => s + v, 0) / vals.length, 1),
          max: round(Math.max(...vals), 1),
          years: vals.length,
          sepaLongTermMean: ltv.get(m) ?? null,
        }
      : { min: null, mean: null, max: null, years: 0, sepaLongTermMean: ltv.get(m) ?? null };
  }

  return {
    station: { id: STATION.id, name: STATION.name },
    fetchedAt: now.toISOString(),
    units: "mm",
    note: "computed from the daily record; SEPA's Month.Total and LongTermValue Min/Max series are empty at this station. 'complete' months only are used for the long-term figures",
    months,
    longTermByCalendarMonth: byCalendarMonth,
  };
}

// ------------------------------------------------------------------------ main

// Audit the day-boundary assumption over a long window, where days that actually
// discriminate between 09:00Z and 09:00-local are guaranteed to occur. The routine
// hourly check only sees ~10 days and is usually powerless; this is the one that
// can genuinely fail. Run it after any SEPA-side change.
async function verifyHistory(days) {
  const now = new Date();
  const from = addDays(now, -days).toISOString().slice(0, 10);
  const to = now.toISOString().slice(0, 10);
  const [rain15, rainDay] = await Promise.all([
    series(TS.rain15, `${from}T00:00:00`, `${to}T23:59:59`),
    series(TS.rainDay, from, to),
  ]);
  const check = verifyHydroDay(rain15, rainDay, now);
  console.log(JSON.stringify(check, null, 2));
  if (!check.checked) throw new Error(`cannot verify: ${check.reason}`);
  if (!check.agrees) throw new Error(`${check.disagreements.length} day(s) disagree with the 09:00Z boundary`);
  if (check.discriminatingDays === 0) {
    throw new Error(`no discriminating days in ${days} days — the check proved nothing; widen the window`);
  }
  if (check.localTimeHypothesisMatches > 0) {
    throw new Error(`the 09:00-local hypothesis matched on ${check.localTimeHypothesisMatches} day(s) — boundary is not settled`);
  }
  console.log(`\nOK — ${check.daysAgreed}/${check.daysChecked} days agree with a 09:00Z boundary, ` +
    `${check.discriminatingDays} of them genuinely discriminating, and the 09:00-local reading matched none.`);
}

async function main() {
  const args = process.argv.slice(2);
  const vIdx = args.indexOf("--verify-history");
  if (vIdx >= 0) return verifyHistory(Number(args[vIdx + 1]) || 120);

  const outIdx = args.indexOf("--out");
  const OUT = outIdx >= 0 ? args[outIdx + 1] : new URL("../data/", import.meta.url).pathname;
  await mkdir(OUT, { recursive: true });

  const dailyPath = `${OUT}/daily.json`;
  let wantDaily = args.includes("--daily");
  // The committed daily record is also the baseline for "wetter than normal?",
  // so every run reads it, not just the rollup.
  let dailyDoc = null;
  try { dailyDoc = JSON.parse(await readFile(dailyPath, "utf8")); }
  catch { wantDaily = true; } // first run (or a lost file) backfills itself

  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  const from30 = addDays(now, -31).toISOString().slice(0, 10);

  const [rain15, rain36h, river15, riverTrend, rainDayRecent, ltvRows,
         rDayMin, rDayMean, rDayMax] = await Promise.all([
    series(TS.rain15, `${from30}T00:00:00`, `${today}T23:59:59`),
    recent(TS.rain36h, "P3D"),
    recent(TS.river15, "P2D"),
    recent(TS.riverTrend, "P2D"),
    recent(TS.rainDay, "P10D"),
    recent(TS.ltvMonthMean, "P400D"),
    recent(TS.riverDayMin, "P5D"),
    recent(TS.riverDayMean, "P5D"),
    recent(TS.riverDayMax, "P5D"),
  ]);

  // Long-term monthly means, keyed by calendar month.
  const ltv = new Map();
  for (const r of ltvRows) if (r.v != null) ltv.set(Number(r.t.slice(5, 7)), round(r.v, 1));

  const dMin = lastGood(rDayMin), dMean = lastGood(rDayMean), dMax = lastGood(rDayMax);
  const riverDay = dMean
    ? { date: isoDay(dMean.t), min: round(dMin?.v, 3), mean: round(dMean.v, 3), max: round(dMax?.v, 3) }
    : null;

  const write = (name, doc) => writeFile(`${OUT}/${name}`, JSON.stringify(doc, null, 2) + "\n");

  // Rebuild the history first when it is due, so latest.json compares against a
  // current baseline — and so a first run produces a complete file rather than
  // one missing normalToDate until the next tick.
  let daily = null, monthly = null;
  if (wantDaily) {
    const rainDayAll = await series(TS.rainDay, HISTORY_START, today);
    daily = buildDaily(rainDayAll, now);
    monthly = buildMonthly(daily, ltv, now);
    dailyDoc = daily;
  }

  const latest = buildLatest(
    { rain15, rainDay: rainDayRecent, rain36h, river15, riverTrend, riverDay, ltv, dailyDoc }, now,
  );

  // Refuse to publish a stale file as if it were current (PRD §11).
  if (latest.stalenessMinutes == null || latest.stalenessMinutes > STALE_HOURS * 60) {
    throw new Error(`last reading is ${latest.stalenessMinutes ?? "unknown"} min old (limit ${STALE_HOURS * 60}) — refusing to publish`);
  }
  const check = latest.hydroDayCheck;
  if (check.checked && !check.agrees) {
    const detail = check.disagreements
      .map((d) => `${d.day}: SEPA ${d.publishedMm}mm vs computed ${d.computedMm}mm`)
      .join("; ");
    throw new Error(`hydrological day check failed on ${check.disagreements.length}/${check.daysChecked} days — ${detail}`);
  }

  await write("latest.json", latest);

  // Same dense encoding as daily.json, for the same reason — 3,000 timestamped
  // objects is 290KB, the bare values are ~15KB.
  const step = 15 * 60000;
  const startsAt = rain15[0]?.t ?? null;
  const dense = [];
  if (startsAt) {
    const byT = new Map(rain15.map((r) => [Date.parse(r.t), r.v]));
    for (let t = Date.parse(startsAt); t <= Date.parse(rain15.at(-1).t); t += step) {
      dense.push(byT.has(t) ? byT.get(t) : null);
    }
  }
  await write("recent-15min.json", {
    station: { id: STATION.id, name: STATION.name },
    fetchedAt: now.toISOString(),
    units: "mm",
    startsAt,
    endsAt: rain15.at(-1)?.t ?? null,
    intervalMinutes: 15,
    count: dense.length,
    encoding: "mm[i] covers the 15 minutes ending at startsAt + i*15min (UTC). null means no reading received, not zero rainfall",
    mm: dense,
  });

  console.log(`latest.json        ${latest.rainfall.sinceMidnightLocal.mm}mm since local midnight, ` +
    `${latest.rainfall.sinceHydroDay0900.mm}mm since 09:00Z, river ${latest.riverLevel.m}m ${latest.riverLevel.trend ?? ""}`);
  console.log(`                   last reading ${latest.lastReadingAt} (${latest.stalenessMinutes} min old)`);
  console.log(`                   hydro-day check: ${latest.hydroDayCheck.checked ? (latest.hydroDayCheck.agrees ? "agrees" : "DISAGREES") : "skipped"}`);
  console.log(`recent-15min.json  ${rain15.length} readings`);

  if (daily) {
    await write("daily.json", daily);
    await write("monthly.json", monthly);
    console.log(`daily.json         ${daily.count} days, ${daily.firstDate} to ${daily.lastDate}, ${daily.gaps} gaps`);
    console.log(`monthly.json       ${monthly.months.length} months`);
  }
}

main().catch((e) => { console.error(`fetch-hydro failed: ${e.message}`); process.exit(1); });
