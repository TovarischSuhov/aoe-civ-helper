#!/usr/bin/env node
// scripts/update-all.mjs — auto-rebuild: refresh aoestats.io win rates, then rebuild techtree facts.
//
//   node scripts/update-all.mjs            # refresh aoestats + force re-download + rebuild techtree
//   node scripts/update-all.mjs --cached   # rebuild techtree from cache (skip upstream re-download)
//   node scripts/update-all.mjs --no-stats # skip the aoestats step
//   node scripts/update-all.mjs --no-build # skip the techtree rebuild
//
// Each step is best-effort.
//  • aoestats.io needs outbound internet to aoestats.io; if it's unreachable or unparseable the
//    existing data/aoestats.json is kept and a warning is printed (data is never corrupted — the
//    parse must pass a sanity gate before it's written).
//  • The techtree rebuild runs scripts/build.mjs, which re-downloads from aoe2techtree.net with
//    fallbacks to raw.githubusercontent.com and the GitHub contents API.
//
// Schedule it, e.g. daily at 04:17:
//   17 4 * * *  cd /path/to/aoe && /usr/bin/node scripts/update-all.mjs >> update-all.log 2>&1

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const argv = new Set(process.argv.slice(2));

// Fallback producer when the live backend can't be reached: scrape aoestats.io's live pages. This
// is a separate script (curl fallback for proxy/self-signed-cert envs, per-civ maps + matchups,
// and its own sanity gate) — strictly richer than the old inlined homepage-only scrape it replaces,
// and unlike that scrape it actually works behind a MITM proxy.
function runScrapeAoestats() {
  console.log('→ stats: falling back to scraping aoestats.io live pages (scrape-aoestats.mjs)…');
  const r = spawnSync('node', [join(__dirname, 'scrape-aoestats.mjs')], {
    env: { ...process.env, FORCE: '1' }, stdio: 'inherit', cwd: ROOT,
  });
  return r.status === 0;
}

function rebuildTechtree(force) {
  console.log(`→ techtree: running build.mjs${force ? ' (FORCE_FETCH)' : ''}…`);
  const env = { ...process.env };
  if (force) env.FORCE_FETCH = '1';
  const r = spawnSync('node', [join(__dirname, 'build.mjs')], { env, stdio: 'inherit', cwd: ROOT });
  if (r.status !== 0) { console.error('✗ techtree rebuild failed.'); process.exitCode = 1; return false; }
  return true;
}

// Self-aggregate current civ statistics from the LIVE official AoE2 match backend
// (aoe-api.worldsedgelink.com) — all civs incl. the newest, last N weeks, all four views (overall
// / per-map-type / civ-vs-civ / civ-vs-civ-per-map-type). Returns false when it can't reach the
// backend so the caller falls back to scraping aoestats.io's live pages (scrape-aoestats.mjs).
// (scripts/build-stats.mjs is the older aoestats Parquet path — kept but not the default: those
// weekly dumps have been stale/empty since 2026-02-07 and lack the 3 newest civs.)
function runBuildStatsLive() {
  console.log('→ stats: self-aggregating from the live AoE2 match backend (build-stats-live.mjs)…');
  const r = spawnSync('node', [join(__dirname, 'build-stats-live.mjs')], {
    env: { ...process.env, FORCE: '1' }, stdio: 'inherit', cwd: ROOT,
  });
  return r.status === 0;
}

(async () => {
  console.log('=== update-all ===');
  if (!argv.has('--no-stats')) {
    const ok = runBuildStatsLive();
    if (!ok) {
      console.warn('⚠ live backend unavailable/unparseable — falling back to scraped aoestats.io snapshot.');
      const ok2 = runScrapeAoestats();
      if (!ok2) console.warn('⚠ scrape-aoestats also failed — keeping existing data/aoestats.json.');
    }
  }
  if (!argv.has('--no-build')) rebuildTechtree(!argv.has('--cached'));
  console.log('=== done ===');
})();
