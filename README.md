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

Two paths, both governed by **rules R1–R5** (see [`RULES.md`](./RULES.md)):

1. **Rebuild the bundle** (offline, authoritative):
   ```bash
   node scripts/build.mjs                # uses .cache/ if present
   FORCE_FETCH=1 node scripts/build.mjs  # force re-download from aoe2techtree.net / GitHub
   ```
   This re-derives every civ's `facts` from upstream, preserves hand-curated `strategy`
   (read from `data/strategy.json`), and rewrites `data/meta.json` + `data/civs/*.json`.

2. **Live refresh** (in-browser): the **↻ Refresh** button fetches the live `data.json` +
   English `strings.json` from aoe2techtree.net (CORS is open), re-derives facts, and pushes
   them into `localStorage` — **without touching curated strategy** (rule R5).

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

4. **Ranked statistics** (`data/aoestats.json`): the committed file is a scraped aoestats.io
   snapshot. Self-computing it from raw Parquet needs aoestats.io egress + `pyarrow` and is done
   with `scripts/build-stats.mjs` (or the `update-all.mjs` orchestrator); until then the snapshot
   has no per-map-type (`byMapType`) or matchup matrix data.

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
  aoestats.json                   # ranked win/play rates (scraped snapshot until build-stats runs)
  civs/<slug>.json                # per-civ: facts (auto) + strategy (curated) + sotl + regional
  version.json                    # tiny version probe
scripts/
  build.mjs           # fetch aoe2techtree → derive facts → write meta.json + civs/*.json
  build-regional.mjs  # repo tarball → data/regional.json (regional units/buildings)
  build-stats.mjs     # self-compute aoestats from raw Parquet (needs egress + pyarrow)
  update-all.mjs      # auto-rebuild: refresh aoestats + rebuild techtree facts
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
- `aoestats.json` is a scraped snapshot; per-map-type and matchup-matrix stats only appear once
  `build-stats.mjs` runs on raw Parquet (needs aoestats.io egress + `pyarrow`).
- `aoe2database.com` is a JavaScript SPA, so it is treated as secondary context/attribution,
  not a structured feed.
- Curated strategy covers the civilizations the source channel actually discusses (~20).

Age of Empires II © Microsoft Corporation. Data from aoe2techtree.net is MIT-licensed. This tool
is not affiliated with or endorsed by Microsoft.
