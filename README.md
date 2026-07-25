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
- `.github/workflows/refresh.yml` — runs the script every morning (09:45 UTC) on
  GitHub's servers and commits any change. GitHub Pages redeploys on each commit,
  so the link stays current with no computer or login required.

No secrets or credentials are needed — it reads only public weather data.
