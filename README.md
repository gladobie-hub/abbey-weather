# Abbey St Bathans — Weather Almanac

A small public dashboard showing recent weather for Abbey St Bathans, Berwickshire:
daily rainfall, temperature range and wind, a 7-day rollup, and a year-on-year
comparison against the same dates last year.

**Live page:** https://gladobie-hub.github.io/abbey-weather/

## How it works

- `index.html` — the dashboard. All data is baked into a single JSON block
  (`#almanac-data`) so the page is fully static and loads instantly.
- `refresh-weather-dashboard.mjs` — rebuilds that data block from free public
  services: rainfall from the **SEPA** on-farm gauge (station 36870) and
  temperature/wind from **Open-Meteo** (with their archives for last year).
- `.github/workflows/refresh.yml` — runs the script every morning (09:52 UTC) on
  GitHub's servers and commits any change. GitHub Pages redeploys on each commit,
  so the link stays current with no computer or login required.

No secrets or credentials are needed — it reads only public weather data.

## Hydrology data files

The dashboard is for reading. `data/` is for asking — flat JSON at fixed URLs, so a
rainfall or river question is answered by fetching one file rather than querying an
API. There is no server: the committed files *are* the interface, and git history is
the archive.

| File | Size | Contents |
|---|---|---|
| [`data/latest.json`](data/latest.json) | ~2KB | Current conditions. The default read for most questions |
| [`data/daily.json`](data/daily.json) | ~70KB | Every daily total since 2005, plus precomputed annual totals, wettest days and dry runs |
| [`data/recent-15min.json`](data/recent-15min.json) | ~20KB | Rolling 30 days at 15-minute resolution, for storm profiles |
| [`data/monthly.json`](data/monthly.json) | ~33KB | Monthly totals and long-term min/mean/max per calendar month |

Read them raw at:

```
https://raw.githubusercontent.com/gladobie-hub/abbey-weather/main/data/latest.json
```

`scripts/fetch-hydro.mjs` builds them from SEPA's KiWIS service;
`.github/workflows/hydro.yml` runs it hourly, with a fuller rollup at 09:38 UTC.
Both crons sit on odd minutes to dodge GitHub's congested quarter-hour slots —
don't tidy them to round numbers.

### Four things that will mislead you if ignored

**The hydrological day ends at 09:00 UTC, fixed year-round — not 9am local.** Under
BST the gauge day therefore closes at *10:00* local. This was established from the
data, not assumed: over 150 days there were 9 on which the two readings give
different totals, and SEPA's published `Day.Total` matched the 09:00 UTC window on
all 9 and the local-time window on none. `latest.json` gives both
`sinceMidnightLocal` and `sinceHydroDay0900`, each labelled. "How much rain today?"
almost always means the first.

**Compare month-to-date with month-to-date.** Setting this month's total against a
*whole-month* average makes every month look like a drought until the last day of it
— on the 2nd you'd read "2% of normal". `monthToDate.normalToDate` is the like-for-
like figure: the 1st to the same day of month, averaged over previous years, with the
historic range alongside. Use that one. `wholeMonthNormal` is context only.

**`null` is not `0`.** A zero is a real reading of no rain; a null means no reading
arrived. Conflating them turns a gauge outage into a dry spell. The dense arrays in
`daily.json` and `recent-15min.json` preserve nulls, and `missingDates` lists them —
50 days of the 7,876 on record.

**Quality code 254 means "no code assigned", not "bad".** It covers most live
telemetry. Genuinely doubtful readings are 150 (suspect, 310 days) and 100
(estimated); -1 marks a missing value. Treating 254 as a problem would flag almost
everything and mean nothing.

**Six of SEPA's aggregate series are empty at this station** — `Month.Total`,
`CalendarYear.Total`, `HydrologicalYear.Total`, both `LongTermValue` Min/Max, and
`PeaksOverThreshold`. Every total here is therefore computed from the daily record
instead, which is also more checkable. Don't "restore" those `ts_id`s without first
confirming they return rows.

### When it breaks

The script exits non-zero — so GitHub emails — rather than publishing a plausible
wrong answer, if the feed is over 3 hours stale, if a response can't be parsed, or if
any closed day disagrees with SEPA's own published daily total. Every file carries
`fetchedAt` and `lastReadingAt`; **quote the reading time when answering**, because
readings are typically 25–50 minutes old (SEPA reports every 15 min, GitHub's cron
drifts, and the raw CDN caches for ~5 min).

To audit the day-boundary assumption by hand:

```
node scripts/fetch-hydro.mjs --verify-history 365
```

SEPA's timeseries service is a demonstrator, explicitly not supported for business
use. This is a single gauge: indicative for the holding, not per-field truth, and not
for flood or safety decisions.
