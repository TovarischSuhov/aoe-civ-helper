# Data Update Rules (R1–R5)

These rules govern how civilization data is refreshed and persisted to `localStorage`.
Implemented in [`js/updater.js`](../js/updater.js). The invariant: **refresh writes only `facts`;
curated `strategy` is never overwritten.**

| Rule | Trigger | Action |
|------|---------|--------|
| **R1 — Bootstrap** | No `aoe_meta` in `localStorage`, or `schemaVersion` changed | Import bundled `data/meta.json`; clear the cached civ cache so detail views fetch fresh files. |
| **R2 — Drift** | Bundled `meta.hash` ≠ stored `meta.hash` (the data files were rebuilt) | Update stored meta; clear civ cache so the rebuilt civ files (new facts, preserved strategy) are re-fetched. |
| **R3 — Periodic** | `now − meta.liveChecked > 7 days` | Live-fetch `data.json` + English `strings.json` from aoe2techtree.net, `deriveAll`, push new `facts` into cached civs, update `hash`/`liveChecked`. On any network/CORS/parse error → keep current data, log, defer. |
| **R4 — Manual** | User clicks **↻ Refresh** | Force the R3 path immediately. |
| **R5 — Preserve** | Any refresh | Only `facts` (and `version`) are written per civ (`store.mergeFacts`). `strategy` and `sources` are untouched. |

## Why two paths?

- **Repo path** (`scripts/build.mjs`): the authoritative offline rebuild. Run it when a new game
  patch ships. It re-derives facts from upstream and merges them onto the hand-curated
  `data/strategy.json`, writing `data/meta.json` + `data/civs/*.json`.
- **Browser path** (`js/updater.js`): lets the running app self-update from the live site without a
  rebuild (R3/R4). CORS on aoe2techtree.net is open (`access-control-allow-origin: *`), so this
  works from `http://localhost`.

## Version key

`meta.hash` is the SHA-256 (truncated to 12 hex chars) of the upstream `data.json`. It is the
canonical drift detector — `updateLabel` (the "Update NNNNNN" footer number) is best-effort and
only informational.

## Facts vs strategy

- **facts** — machine-derived from upstream (`js/derive.js`): army type, bonuses, team bonus,
  unique units (with stats), unique techs, tech gaps, heuristic timings. Regenerated on refresh.
- **strategy** — hand-curated, English (`data/strategy.json`): build orders, recommendations,
  strengths/weaknesses, timings. Edited by humans; preserved across every refresh.
