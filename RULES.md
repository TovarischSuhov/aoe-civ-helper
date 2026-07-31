# Data Sync Rules

The SPA reads **only the committed `data/` bundle + `img/` icons** from its own origin — it makes no
external requests. A background CI job (`.github/workflows/update-data.yml`) rebuilds that bundle
daily from the primary sources and commits it; the rules below govern how the running app stays in
sync with whatever CI deployed. Implemented in [`js/updater.js`](../js/updater.js).

| Rule | Trigger | Action |
|------|---------|--------|
| **R1 — Bootstrap** | No `aoe_meta` in `localStorage`, or `schemaVersion` changed | Import bundled `data/meta.json`; warm the civ + guide caches. |
| **R2 — Drift** | Bundled `meta.hash` ≠ stored `meta.hash` (CI rebuilt the data) | Update stored meta; clear the civ + data caches so the next view re-fetches the rebuilt civ files. **Runs on every load**, so the app auto-syncs to the latest deploy with no live-fetch. |
| **R4 — Manual** | User clicks **↻ Refresh** | Force a cache-busted re-sync to the deployed bundle (`syncBundle`): re-pull `meta.json`; if drifted, clear + re-warm (R2); always re-pull the guides + stats. |
| **R5 — Preserve** | Every rebuild | `strategy` is hand-curated in `data/strategy.json`; `build.mjs` preserves it server-side when re-deriving `facts`. The SPA never writes `strategy`. |

The old **R3** (a periodic in-browser live-fetch of aoe2techtree.net) is gone — R2 on load replaced
it. The app picks up CI-deployed data automatically on the next page load.

## One path

There's a single data path now: **CI rebuilds `data/` + `img/` → committed → SPA reads cached**. The
browser does no live data fetching; `↻ Refresh` only re-reads the same-origin bundle.

## Version key

`meta.hash` is the SHA-256 (truncated to 12 hex) of the upstream `data.json`, recorded when
`build.mjs` runs in CI. It's the drift detector the SPA compares on every load (R2) — when CI
commits a rebuild, the hash changes and every visitor re-warms on next load.

## Facts vs strategy

- **facts** — machine-derived from upstream by `build.mjs` (CI): army type, bonuses, team bonus,
  unique units, unique techs, tech gaps. Regenerated each rebuild; committed in each civ file.
- **strategy** — hand-curated, English (`data/strategy.json`): build orders, recommendations,
  strengths/weaknesses, timings. Edited by humans; preserved across every rebuild (R5).
