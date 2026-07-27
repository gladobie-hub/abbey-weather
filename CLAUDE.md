# Working in this repo

## Never commit directly to `main`

Branch first, always. The loop is: branch off `main` → commit → push → open a PR →
merge → delete the branch.

- **One branch, one thing.** If a branch grows a second purpose, split it.
- **Name branches `type/short-description`** — `feature/`, `fix/`, `docs/`, `chore/`.
- **Open the PR early**, even as a draft. A branch nobody can see is a branch that gets
  forgotten.
- **Merge within hours here, not days** (see below — this repo is unusually unforgiving of
  long branches).
- **Delete the branch on merge.**
- **`main` must always work.** GitHub Pages deploys from it on every commit.

## `main` moves on its own — plan for it

Two GitHub Actions workflows commit to `main` without you:

| Workflow | Schedule | Writes |
|---|---|---|
| `.github/workflows/hydro.yml` | hourly, plus a fuller rollup at 09:45 UTC | `data/` |
| `.github/workflows/refresh.yml` | 09:45, 12:45 and 16:45 UTC | `index.html` |

This is by design — it is what keeps the public page current with no computer switched on.
It also means **`main` will have moved since you branched**, and a branch held open for a
day will collide with the bot.

So:

- **Never hand-edit `data/*.json` or the `#almanac-data` block in `index.html`.** Both are
  generated. Change the generator — `scripts/fetch-hydro.mjs` or
  `refresh-weather-dashboard.mjs` — and let the workflow rewrite the output.
- **Rebase on `main` before opening the PR.** It will have moved.
- **Keep branches short.** Hours, not days. Long branches here mean merge conflicts on
  generated files, which are tedious and easy to resolve wrongly.

## Before changing the data pipeline

Read the README first, particularly "Four things that will mislead you if ignored". The
09:00 UTC hydrological day, `null` vs `0`, month-to-date comparisons and SEPA quality codes
are all settled questions with evidence behind them. Don't re-derive them, and don't
"fix" them without reading why they are the way they are.

The fetch script is deliberately built to **fail loudly rather than publish a plausible
wrong answer**. Keep it that way: if a change makes an error path softer, that is a
regression, not an improvement.
