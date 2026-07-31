# AoE II Civ Guide

A standalone, offline-capable web app that combines **auto-derived civilization facts**
(from [aoe2techtree.net](https://aoe2techtree.net/)) with **curated strategy** — build orders,
timings, recommendations — translated into English from the strategy channel
[t.me/kiritastrich](https://t.me/s/kiritastrich), with [aoe2database.com](https://aoe2database.com/)
as secondary context.

All 53 civilizations get an auto-derived fact profile (army type, bonuses, team bonus, unique
units with stats + elite-version stats, unique techs, notable tech gaps, heuristic matchups) plus
auto-derived best-practice and economy notes grounded in each civ's real bonuses and tech gaps.
Each page also lists the civ's **regional units & buildings** (Battle Elephant, Steppe Lancer,
Caravanserai, … — the items the tech tree marks region/unique, with stats and costs) and its
**unique buildings** (Feitoria, Krepost, Donjon…). The ~20 civilizations the source channel
actually discusses additionally get a hand-curated strategy block (build orders, timings,
recommendations); where present, the curated strengths/weaknesses take precedence over the
auto-derived ones.

General guides are also included:

- **Build Orders** (`data/buildorders.json`, `#/buildorders`) — universal, civ-agnostic openings
  (Fast Castle, Scout rush, M@A→Archers, straight Archers, Drush, Tower rush, Fast Imperial, boom)
  with build steps, tips and the army types they suit. Sourced from t.me/kiritastrich, Spirit of
  the Law, Hera and CyberDabVinc. Every civ build-order's source chip links to the specific
  Telegram post it was translated from (rule R5 — strategy is never overwritten on refresh).
- **Economy Guide** (`data/economy.json`, `#/economy`) — civ-agnostic how-tos: how to farm
  (placement, reseed, Mill upgrades), how to chop wood (lumber camp on the forest, upgrades),
  food sources (sheep/boar/deer/berries), gold & stone, Town Center/villager production, the
  market, water & fishing (fish traps vs farms, keeping the sea), resource math/rates (gathering
  rates and wood-efficiency, from kiritastrich), and rough targets. Each civ page adds an
  auto-derived **Economy notes** block that ties that civ's economy bonuses back to the guide.
- **Spirit Of The Law best practices** (`data/sotl.json`, `#/sotl`) — principles and the 2026
  1v1 Arabia civ ranking (Elo ≥1200) distilled from SOTL's recent videos (last ~2 years), with
  per-civ takeaways surfaced as a 🏆 callout on the 12 ranked civ pages and #rank badges on the
  grid. The SOTL layer is also preserved across data refreshes (rule R5).

## Run it

It's a static site — no build step for the app itself. Serve it with any static server
(aoE modules require `http://`, not `file://`):

```bash
python3 -m http.server 8000
# open http://localhost:8000/
```

## Update the data

The SPA reads only the committed bundle; CI rebuilds it. Governed by the **sync rules** (see [`RULES.md`](./RULES.md)):

1. **Rebuild the bundle** (offline, authoritative):
   ```bash
   node scripts/build.mjs                # uses .cache/ if present
   FORCE_FETCH=1 node scripts/build.mjs  # force re-download from aoe2techtree.net / GitHub
   ```
   This re-derives every civ's `facts` from upstream, preserves hand-curated `strategy`
   (read from `data/strategy.json`), and rewrites `data/meta.json` + `data/civs/*.json`.
   `scripts/build-images.mjs` mirrors the aoe2techtree icons into `img/`; `scripts/update-all.mjs`
   runs the full set (stats + techtree + images).

2. **SPA reads only cached data**: the app loads exclusively from the committed `data/` bundle +
   `img/` icons (same origin) — it never fetches aoe2techtree.net. A daily CI rebuild
   (`.github/workflows/update-data.yml`) keeps them current. The **↻ Refresh** button cache-busts
   and re-syncs to the latest deployed bundle (R2 drift picks up new techtree facts; guides + stats
   are re-pulled); curated strategy is never touched (rule R5).

3. **Tech-tree structure** (regional units/buildings + icon map): these come from the repo
   **tarball** (`data/trees/*.json`), not `data.json`, so refresh them when a patch/DLC reshapes
   the tree:
   ```bash
   node scripts/build-regional.mjs        # → data/regional.json (per-civ node_type-flagged items)
   # then rebuild so civ files pick up the new regional data:
   node scripts/build.mjs
   # data/picture-index.json (data-id → icon) is regenerated the same way from each tree node's
   # picture_index field — see js/derive.js / scripts/build-regional.mjs.
   ```

4. **Ranked statistics** (`data/aoestats.json`): self-aggregated from the **live official match
   backend** by `scripts/build-stats-live.mjs`, which **accumulates** matches into a local store
   (`.cache/live/store.json`) so the window grows ~1 week per run up to a cap, then rolls forward:
   ```bash
   node scripts/build-stats-live.mjs               # top 2000 players; accept last 2w as new; keep 12w
   PLAYERS=4000 WEEKS=4 MAX_WEEKS=26 node scripts/build-stats-live.mjs
   RESET=1 node scripts/build-stats-live.mjs       # clear the store (fresh start)
   MAX_WEEKS=0 node scripts/build-stats-live.mjs   # keep all accumulated history
   ```
   It produces all four views (overall + per-map-type win rates, civ-vs-civ, civ-vs-civ-per-map).
   `WEEKS` = what counts as "new" this run; `MAX_WEEKS` (default 12) = the retention/lookback cap.
   Run it on a schedule (e.g. every 12h) so the window fills; the store stays bounded by retention.
   `scripts/update-all.mjs` runs `build-stats-live.mjs` and falls back to `scrape-aoestats.mjs`
   (aoestats.io live pages) if the backend is unreachable. `scripts/build-stats.mjs` is the older
   aoestats.io Parquet path — kept but not the default (those weekly dumps have been stale since
   2026-02-07).

## Deploy (GitHub Pages)

It's a static site, so it deploys to GitHub Pages with **no build step**:

1. Push the repo to GitHub.
2. **Settings → Pages → Source: Deploy from a branch → `master` / `/ (root)`**. It goes live at
   `https://<user>.github.io/<repo>/` — all asset paths are relative, so the subpath works, and
   ES modules load fine over HTTPS.

The deployed `data/` + `img/` are the **committed snapshot** — Pages has no runtime to run the
rebuild. They stay fresh automatically instead: [`.github/workflows/update-data.yml`](.github/workflows/update-data.yml)
runs `update-all.mjs` once a day (techtree facts + images from aoe2techtree.net, stats from the live
backend; the accumulator's `.cache/live/` store is cached across runs) and commits the result back to
`master` — with Pages deploying from the branch, that republishes the site. The in-browser **↻ Refresh**
button re-syncs to the latest deployed bundle (same-origin only).

## Layout

```
index.html, css/style.css          # UI
js/
  app.js        routing + wiring
  store.js      localStorage CRUD
  updater.js    update rules R1–R5 (live fetch + drift reconciliation)
  render.js     DOM rendering (grid + detail)
  derive.js     PURE fact derivation — shared by build.mjs AND updater.js
data/
  meta.json                       # version/hash + civ index
  picture-index.json              # data-id → aoe2techtree icon filename (picture_index); tarball-derived
  regional.json                   # per-civ regional units/buildings (node_type-flagged); tarball-derived
  strategy.json                   # curated strategy (single source of truth, EN)
  sotl.json                       # Spirit Of The Law best practices + 2026 ranking
  economy.json                    # general Economy Guide (how to farm/chop/mine)
  buildorders.json                # universal Build Orders (FC/scouts/archers/…) + sources
  tips.json                       # distilled improvement tips per source (kiritastrich/SOTL/Hera/…)
  aoestats.json                   # ranked win/play/matchup rates (self-aggregated from the live backend)
  civs/<slug>.json                # per-civ: facts (auto) + strategy (curated) + sotl + regional
  version.json                    # tiny version probe
scripts/
  build.mjs              # fetch aoe2techtree → derive facts → write meta.json + civs/*.json
  build-regional.mjs     # repo tarball → data/regional.json (regional units/buildings)
  build-stats-live.mjs   # PRIMARY stats: live backend → accumulator store → aoestats.json (4 views)
  scrape-aoestats.mjs    # FALLBACK stats: scrape aoestats.io live pages → aoestats.json
  build-stats.mjs        # older aoestats Parquet path (stale; not the default)
  update-all.mjs         # auto-rebuild: build-stats-live (→ scrape fallback) + rebuild techtree facts
  lib/maps.mjs           # shared curated map-name → open/closed/hybrid/water classification
  lib/util.mjs           # shared bounded-concurrency pool + slug helper
.cache/live/store.json   # the stats accumulator's persistent match store (gitignored)
logs/                    # cron/pipeline logs (gitignored)
```

## Data model

Each `data/civs/<slug>.json`:

```jsonc
{
  "id": "Turks", "slug": "turks", "internalName": "Turks",
  "version": { "hash": "…", "updateLabel": "…", "schemaVersion": 1 },
  "facts":  { "armyType": "…", "bonuses": […], "teamBonus": "…",
              "uniqueUnits": […], "uniqueTechs": […], "keyUnits": [{…stats, eliteCost}],
              "techGaps": [{ label, name, cat, id, pic }, …],
              "matchups": { "strongAgainst": […], "weakAgainst": […] },
              "analysis": { "strengths": […], "weaknesses": […], "bestPractices": […] },
              "economy": { "highlights": [{category, bonus}], "tip": "…" } },
  "strategy": { "buildOrders": […], "recommendations": […], "strengths": […],
                "weaknesses": […], "timings": […] },
  "sotl": { "rank": 1, "year": 2026, "takeaway": "…" },   // present for the 12 SOTL-ranked civs
  "regional": { "units": [{name, cat, pic, cost, kind}], "buildings": […] }, // region/unique items (node_type-flagged)
  "sources": ["aoe2techtree", "kiritastrich", "aoe2database"]
}
```

`facts` is regenerated on every refresh; `strategy` is edited in `data/strategy.json` and never
overwritten. `regional` and `data/picture-index.json` are generated from the aoe2techtree **repo
tarball** (`scripts/build-regional.mjs`), not from `data.json`, so they are refreshed separately
when the tech tree changes.

**Tech gaps** (`facts.techGaps`) are deduplicated by upgrade line: within each line only the first
missing tier is shown (no Cavalier ⇒ no Paladin, so just "No Cavalier"); if the producing building
is unavailable the whole group collapses (Meso civs → "No Stable", not a list of stable units); a
line only counts if the civ has its base unit (no Camels ⇒ no "No Heavy Camel Rider"); the Andean
Champi line suppresses the Militia gap; and Parthian Tactics / cavalry-barding only matter when the
relevant units/building exist. Blacksmith upgrade lines are included.

## Honest limits

- `facts.techGaps` are a heuristic: lines collapse to the first missing tier, a group collapses when
  its producing building is absent (Meso civs → "No Stable"), and a line only counts if the civ has
  its base unit (no Camels ⇒ no "No Heavy Camel Rider"); the Andean Champi line suppresses the
  Militia gap. `genericTimings` is still derived but no longer displayed — authoritative timings
  live in curated `strategy.timings`.
- Regional units/buildings and the icon map come from the repo **tarball**'s `node_type` /
  `picture_index` fields, not from `data.json`, so they are regenerated separately
  (`scripts/build-regional.mjs`). Unique-tech icons are the aoe2techtree silver/gold age markers —
  there is no per-tech art in the data.
- `aoestats.json` is self-aggregated from the live match backend by `build-stats-live.mjs` and
  accumulated over up to `MAX_WEEKS` (12) weeks. It samples the top of the 1v1 ladder, so figures
  reflect high-level play; civ-vs-civ / per-map-type cells with few games are noisy (filter by
  `games`). The older aoestats Parquet path (`build-stats.mjs`) is stale since 2026-02-07.
- `aoe2database.com` is a JavaScript SPA, so it is treated as secondary context/attribution,
  not a structured feed.
- Curated strategy covers the civilizations the source channel actually discusses (~20).

Age of Empires II © Microsoft Corporation. Data from aoe2techtree.net is MIT-licensed. This tool
is not affiliated with or endorsed by Microsoft.
