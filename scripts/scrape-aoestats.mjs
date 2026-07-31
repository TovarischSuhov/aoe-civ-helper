#!/usr/bin/env node
// scripts/scrape-aoestats.mjs — CURRENT civ statistics from the aoestats.io LIVE site.
//
// The aoestats.io Parquet dumps (used by build-stats.mjs) are stale — the weekly buckets have
// been empty since 2026-02-07. But the LIVE site is updated daily (pages carry "last updated"
// from the current week). This scraper reads the rendered HTML tables on:
//
//   • the homepage  — overall Win Rate / Play Rate / Picks for every civ        (stat #1)
//   • each /civs/<slug>/ page — per-map Win Rate table (→ open/closed/hybrid/   (stat #2)
//     water/nomad aggregation) and the Best/Worst matchup tables                (stat #3)
//
// and writes data/aoestats.json: per-civ {winRate, playRate, picks, byMapType, strongAgainst,
// weakAgainst}. civ-vs-civ PER MAP TYPE (stat #4) is not exposed by any current source, so it is
// intentionally omitted here (build-stats.mjs can still compute it from the stale Parquet if a
// fresh dump ever reappears). build.mjs attaches these to each civ page; render.js drives the
// win-rate, Matchups and Maps sections from them.
//
// Usage:  node scripts/scrape-aoestats.mjs
//         FORCE=1 node scripts/scrape-aoestats.mjs   # ignore the 1h time gate
//         CONCURRENCY=8 node scripts/scrape-aoestats.mjs
//
// REQUIRES network egress to aoestats.io (allowed in this sandbox). HTML-table scraping is layout-
// dependent; if aoestats changes its table headers the parser will warn and skip that view.

import { writeFile, stat } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAP_NAME_TO_TYPE } from './lib/maps.mjs';
import { pool, slug } from './lib/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const OUT = join(DATA, 'aoestats.json');
const GATE_MS = 60 * 60 * 1000;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 (aoe2-civ-tools/1.0)';
const FORCE = process.env.FORCE === '1';
const CONCURRENCY = Math.max(1, +(process.env.CONCURRENCY || 6));
const BASE = 'https://aoestats.io';

// Map classification + slug + bounded-concurrency pool live in ./lib (shared with the other producers).

async function fetchText(url, ms = 30000) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'text/html,application/json' } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return await r.text();
    } finally { clearTimeout(t); }
  } catch (e) {
    // Node's fetch uses its own CA store and fails behind a MITM proxy / custom root (e.g. this
    // sandbox: SELF_SIGNED_CERT_IN_CHAIN). curl trusts the OS CA bundle, so fall back to it rather
    // than weakening TLS globally.
    const r = spawnSync('curl', ['-sSL', '--compressed', '-m', String(Math.round(ms / 1000)), '-A', UA, '-H', 'Accept: text/html', url],
      { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || !r.stdout) throw new Error(`fetch failed (${e.message}); curl fallback failed (${(r.stderr || '').trim() || r.status})`);
    return r.stdout;
  }
}

// Strip tags/scripts → single line so the homepage civ rows become a stable pattern (same approach
// as update-all.mjs). Each civ renders as: "Win Rate <wr>% Play Rate <pr>% <Name> Picks: <n>".
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#?\w+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseHomepage(text) {
  const re = /Win Rate\s+([\d.]+)%\s+Play Rate\s+([\d.]+)%\s+([A-Za-z][A-Za-z' ]+?)\s+Picks:\s*([\d,]+)/g;
  const civs = {};
  let m;
  while ((m = re.exec(text))) {
    const k = slug(m[3]);
    if (!k) continue;
    civs[k] = { winRate: +m[1], playRate: +m[2], picks: +m[4].replace(/,/g, '') };
  }
  return civs;
}

// --- rendered-HTML table parsing (per-civ page) ----------------------------
const stripTags = (s) => s.replace(/<[^>]+>/g, ' ').replace(/&#?\w+;/g, ' ').replace(/\s+/g, ' ').trim();

function tablesOf(html) {
  const out = [];
  const re = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let m;
  while ((m = re.exec(html))) {
    const body = m[1];
    const ths = [...body.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((x) => stripTags(x[1]));
    const rows = [];
    const trRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
    let tr;
    while ((tr = trRe.exec(body))) {
      if (!/<td/i.test(tr[1])) continue; // skip header rows
      const cells = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((x) => stripTags(x[1]));
      rows.push(cells);
    }
    out.push({ headers: ths, rows });
  }
  return out;
}

// "66.67%±19.00" → 66.67 ; "61.51%±5.76" → 61.51
const parsePct = (s) => {
  const m = String(s).match(/(-?[\d.]+)%/);
  return m ? +m[1] : null;
};

// Best/Worst matchup tables share the header row [Civilization, Games, Win Rate]. The DOM order of
// the two tables isn't reliable, so collect rows from every matching table, dedupe by opponent, and
// derive strong/weak purely from win rate.
function parseMatchupTables(tables) {
  const mu = tables.filter((t) => t.headers.join('|').toLowerCase() === 'civilization|games|win rate');
  const rows = mu.flatMap((t) => t.rows.map((r) => ({
    name: r[0], games: parseInt(String(r[1]).replace(/[^\d-]/g, ''), 10) || 0, winRate: parsePct(r[2]),
  })).filter((x) => x.name && x.games > 0 && x.winRate != null));
  const byName = new Map();
  for (const x of rows) {
    const prev = byName.get(x.name);
    if (!prev || x.games > prev.games) byName.set(x.name, x); // keep highest-sample row per opponent
  }
  const byWr = [...byName.values()].sort((a, b) => b.winRate - a.winRate);
  return { strongAgainst: byWr.slice(0, 5), weakAgainst: byWr.slice(-5).reverse() };
}

// Per-map table header [Map, Civ Picks, Play Rate, Win Rate]. Aggregate rows to map types.
function parseMapTable(tables) {
  const t = tables.find((x) => x.headers.join('|').toLowerCase().startsWith('map|civ picks'));
  if (!t) return null;
  const perType = {}; // type -> {games, wins}
  for (const r of t.rows) {
    if (r.length < 4) continue;
    // Cell 0 carries "<Map name>  Play Rate: <x%>" — keep the part before "Play Rate:".
    const mapName = r[0].split(/\s+play rate:/i)[0].trim();
    if (!mapName) continue;
    const games = parseInt(String(r[1]).replace(/[^\d-]/g, ''), 10) || 0;
    const wr = parsePct(r[3]);
    if (!games || wr == null) continue;
    const type = MAP_NAME_TO_TYPE[mapName.toLowerCase()] || 'other';
    const acc = perType[type] || (perType[type] = { games: 0, wins: 0 });
    acc.games += games;
    acc.wins += games * wr / 100;
  }
  return perType;
}

async function gated() {
  if (FORCE) return false;
  try { const st = await stat(OUT); return Date.now() - st.mtimeMs < GATE_MS; } catch { return false; }
}

async function main() {
  if (await gated()) { console.log('✓ aoestats.json is fresh (< 1h old) — skipping. Use FORCE=1 to rebuild.'); return; }

  console.log('→ aoestats.io: scraping homepage for overall win/play rates…');
  const homeHtml = await fetchText(BASE + '/');
  const overall = parseHomepage(htmlToText(homeHtml));
  const homeKeys = Object.keys(overall);
  console.log(`  homepage: ${homeKeys.length} civs.`);
  const lastUpdated = (htmlToText(homeHtml).match(/last updated:\s*(\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}(?::\d{2})?(?:\s*UTC|Z)?)?)/i) || [])[1]
    || (homeHtml.match(/"(\d{4}-\d{2}-\d{2}T[\d:]+Z)"/) || [])[1] || null;
  const patch = (() => {
    const m = homeHtml.match(/patch[^\d]{0,24}(\d{5,6})/i);
    return m ? +m[1] : null;
  })();

  console.log(`→ aoestats.io: scraping ${homeKeys.length} per-civ pages (concurrency ${CONCURRENCY}) for maps + matchups…`);
  let done = 0, withDetail = 0;
  await pool(homeKeys, async (civSlug) => {
    try {
      const html = await fetchText(`${BASE}/civs/${civSlug}/`);
      const tables = tablesOf(html);
      const mu = parseMatchupTables(tables);
      const perType = parseMapTable(tables);
      const entry = overall[civSlug] || {};
      if (perType || mu.strongAgainst.length || mu.weakAgainst.length) {
        entry._perType = perType;
        entry.strongAgainst = mu.strongAgainst;
        entry.weakAgainst = mu.weakAgainst;
        withDetail++;
      }
      overall[civSlug] = entry;
    } catch (e) {
      // Page missing/changed for a new civ — keep homepage overall only.
    }
    if (++done % 10 === 0) console.log(`  …${done}/${homeKeys.length} pages`);
  }, CONCURRENCY);
  console.log(`  per-civ detail for ${withDetail}/${homeKeys.length} civs.`);

  // Aggregate per-map-type into byMapType, computing each type's play rate from global totals.
  const totalByType = {};
  for (const e of Object.values(overall)) {
    if (!e._perType) continue;
    for (const [t, a] of Object.entries(e._perType)) totalByType[t] = (totalByType[t] || 0) + a.games;
  }
  const civs = {};
  for (const [civSlug, e] of Object.entries(overall)) {
    const byMapType = {};
    if (e._perType) {
      for (const [t, a] of Object.entries(e._perType)) {
        if (!a.games) continue;
        byMapType[t] = {
          winRate: +(100 * a.wins / a.games).toFixed(2),
          playRate: totalByType[t] ? +(100 * a.games / totalByType[t]).toFixed(2) : 0,
          picks: a.games,
        };
      }
    }
    civs[civSlug] = {
      winRate: e.winRate, playRate: e.playRate, picks: e.picks,
      byMapType,
      strongAgainst: e.strongAgainst || [],
      weakAgainst: e.weakAgainst || [],
    };
  }

  const out = {
    _meta: {
      source: 'Scraped from aoestats.io live pages (current; updated daily)',
      sourceUrl: BASE + '/',
      method: 'Homepage = overall win/play/picks per civ. Per-civ /civs/<slug>/ pages = per-map Win Rate table (aggregated to open/closed/hybrid/water/nomad) + Best/Worst matchup tables (civ-vs-civ). All current — not the stale Parquet dumps.',
      patch,
      ladder: '1v1 Random Map',
      rating: 'ALL',
      updated: lastUpdated,
      mapTypes: 'open/closed/hybrid/water/nomad (curated name->type; per-civ page lists ~20 most-played maps)',
      civsWithData: Object.keys(civs).length,
      civsWithDetail: withDetail,
      builtAt: new Date().toISOString().slice(0, 10),
      note: 'Live aoestats.io data (daily). The Parquet dumps (build-stats.mjs) are stale since 2026-02-07, so this scrape is the current source. civ-vs-civ-per-map-type is not exposed by the live site and is omitted.',
    },
    civs,
  };
  // Sanity gate: never overwrite good data when a homepage layout change collapses the parse.
  // update-all.mjs relies on this exiting non-zero on failure (it keeps the existing file).
  if (Object.keys(civs).length < 40) {
    throw new Error(`sanity gate failed: only ${Object.keys(civs).length} civs parsed — aoestats.io layout may have changed; refusing to overwrite ${OUT}.`);
  }
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✓ Wrote ${OUT}: ${Object.keys(civs).length} civs (${withDetail} with per-map + matchup detail); updated ${lastUpdated || '?'}.`);
}

main().catch((e) => { console.error('SCRAPE-AOESTATS FAILED:', e); process.exit(1); });
