#!/usr/bin/env node
// scripts/build-stats-live.mjs — CURRENT civ statistics self-aggregated from the LIVE official
// Age of Empires II match backend (World's Edge / Relic Link), with a PERSISTENT LOCAL ACCUMULATOR.
//
// aoe2.net is dead, aoestats.io's Parquet dumps are stale (empty since 2026-02-07) and its live
// site lacks the 3 newest civs (Mapuche/Muisca/Tupi), and aoe2insights is Cloudflare-blocked. The
// one authoritative, current, all-civ, no-auth source is the game's own backend documented at
// https://github.com/ustacode/aoe2-apis :
//
//   https://aoe-api.worldsedgelink.com/community/leaderboard/
//     • getAvailableLeaderboards   — civ (races) + matchtype id/name maps
//     • getLeaderBoard2            — top-N ranked players (→ profile_ids) for a ladder
//     • getRecentMatchHistory      — recent COMPLETED matches per player (civ, map, result, time)
//
// The backend returns each player's RECENT matches and has no "give me week X" parameter, so a
// single run only sees ~the last 1–2 weeks. To grow the statistics window we ACCUMULATE: every run
// pulls the latest recent matches, merges the new ones into a local store (.cache/live/store.json),
// and recomputes the four views over the accumulated window (up to MAX_WEEKS). Run it periodically
// and the window grows ~1 week at a time until it hits the cap, then rolls forward.
//
// Fetching is split into PARTS (groups of player chunks); after each part the new matches are
// persisted and the stats are rebuilt + written, so an interrupted run still leaves a valid
// data/aoestats.json from the last completed part — and if the backend is down but the store
// already has data, stats are rebuilt from the store alone.
//
// The four views (computed over the accumulated window):
//   1. Global civ win rate                 civs[slug].winRate / playRate / picks
//   2. Civ win rate per map type           civs[slug].byMapType[open|closed|hybrid|water]
//   3. Total civ-to-civ (matchup)          matchups[A][B] = {winRate, games}
//   4. Civ-to-civ per map type             matchupsByMap[A][B][mapType] = {winRate, games}
// plus per-civ strongAgainst/weakAgainst (derived from #3). Covers ALL civs the sampled players
// actually played — including the newest (Mapuche/Muisca/Tupi) once they hit the ladder.
//
// Usage:
//   node scripts/build-stats-live.mjs              # top 2000 players; accept last 2w as new; keep 12w
//   PLAYERS=4000 WEEKS=4 MAX_WEEKS=26 node scripts/build-stats-live.mjs
//   RESET=1 node scripts/build-stats-live.mjs      # clear the local store first (fresh start)
//   MAX_WEEKS=0 node scripts/build-stats-live.mjs  # keep all accumulated history (no roll-off)
//
// REQUIRES egress to aoe-api.worldsedgelink.com. Be polite: bounded concurrency, small delay.
// Bias note: this samples the TOP of the ladder, so figures reflect high-level play.

import { readFile, writeFile, rename, mkdir, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MAP_NAME_TO_TYPE } from './lib/maps.mjs';
import { pool } from './lib/util.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const CACHE = join(ROOT, '.cache', 'live');
const STORE_PATH = join(CACHE, 'store.json');
const OUT = join(DATA, 'aoestats.json');
const GATE_MS = 60 * 60 * 1000;
const WEEK_S = 7 * 86400;

const UA = 'aoe2-civ-tools/1.0 (build-stats-live)';
const API = 'https://aoe-api.worldsedgelink.com/community/leaderboard';
const TITLE = 'age2';
const LEADERBOARD_ID = +(process.env.LEADERBOARD_ID || 3);    // 3 = SOLO_RM_RANKED (1v1 Random Map)
const MATCHTYPE_ID = +(process.env.MATCHTYPE_ID || 6);         // 6 = 1v1 Random Map (match record field)
const PLAYERS = +(process.env.PLAYERS || 2000);                // how many top players to sample
const WEEKS = Math.max(1, +(process.env.WEEKS || 2));          // fetch-accept window: what counts as "new" this run
const MAX_WEEKS = Math.max(0, +(process.env.MAX_WEEKS || 12)); // retention + stats-lookback cap (0 = keep all)
const PART_SIZE = Math.max(1, +(process.env.PART_SIZE || 20)); // player-chunks per part (rebuild cadence)
const CONCURRENCY = Math.max(1, +(process.env.CONCURRENCY || 12));
const BATCH = 10;                                              // profile_ids per getRecentMatchHistory
const FORCE = process.env.FORCE === '1';
const RESET = process.env.RESET === '1';

// Node's fetch uses its own CA store and fails behind MITM proxies / self-signed roots
// (SELF_SIGNED_CERT_IN_CHAIN). Probe once: if fetch works, use it; otherwise fall back to a
// NON-BLOCKING curl spawn (concurrent — never spawnSync, which blocks the event loop). We do NOT
// toggle NODE_TLS_REJECT_UNAUTHORIZED at runtime: that's unreliable across Node versions and would
// weaken TLS for every host for the rest of the process. curl trusts the OS CA bundle instead.
let USE_CURL = false;
async function probeTransport() {
  const url = `${API}/getAvailableLeaderboards?title=${TITLE}`;
  const ok = await tryFetch(url).then(() => true).catch(() => false);
  if (ok) return;
  USE_CURL = true;
  console.log('  (Node fetch unavailable — likely proxy/self-signed cert — using concurrent curl fallback)');
}
async function tryFetch(url, ms = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
// Non-blocking curl (spawn + streamed stdout) so many run concurrently.
function curlText(url, ms = 30000) {
  return new Promise((resolve, reject) => {
    const ch = spawn('curl', ['-sSL', '--compressed', '-m', String(Math.round(ms / 1000)), '-A', UA, '-H', 'Accept: application/json', url]);
    const chunks = [];
    let err = '';
    ch.stdout.on('data', (d) => chunks.push(d));
    ch.stderr.on('data', (d) => { err += d; });
    const timer = setTimeout(() => { try { ch.kill(); } catch {} reject(new Error('curl timeout')); }, ms);
    ch.on('error', (e) => { clearTimeout(timer); reject(e); });
    ch.on('close', (code) => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(chunks).toString('utf8')); else reject(new Error(`curl ${code}: ${err.slice(0, 200)}`)); });
  });
}

// Map classification + bounded-concurrency pool live in ./lib (shared with the other producers).

// fetch (concurrent) with a non-blocking curl fallback.
async function fetchJson(url, ms = 30000) {
  const raw = USE_CURL ? await curlText(url, ms) : await tryFetch(url, ms).catch(() => curlText(url, ms));
  return JSON.parse(raw);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function gated() {
  if (FORCE) return false;
  try { const st = await stat(OUT); return Date.now() - st.mtimeMs < GATE_MS; } catch { return false; }
}

// --- persistent local accumulator (.cache/live/store.json) ------------------
// `matches` is an object keyed by match id → {id, civA, civB, wonA, wonB, type, map, ct} (ct = epoch
// seconds). Keying by id gives free dedup (the same match arrives via both players' histories) and
// O(1) merge. Atomic save (tmp + rename) survives interruption.

async function loadStore() {
  if (RESET) { console.log('  (RESET=1 — starting with an empty store)'); return { meta: {}, matches: {} }; }
  try {
    const raw = JSON.parse(await readFile(STORE_PATH, 'utf8'));
    if (raw && raw.matches && typeof raw.matches === 'object') return { meta: raw.meta || {}, matches: raw.matches };
  } catch { /* missing or invalid → start empty */ }
  return { meta: {}, matches: {} };
}

async function saveStore(matches) {
  const span = recomputeStoreSpan(matches);
  const store = { meta: { first: span.first, last: span.last, updatedAt: Math.floor(Date.now() / 1000) }, matches };
  await writeFile(STORE_PATH + '.tmp', JSON.stringify(store));
  await rename(STORE_PATH + '.tmp', STORE_PATH);
}

// Drop matches older than minCt (retention). Returns the possibly-smaller matches object.
function trimStore(matches, minCt) {
  if (!minCt) return matches; // MAX_WEEKS = 0 → keep everything
  let kept = 0, total = 0;
  const out = {};
  for (const [id, r] of Object.entries(matches)) {
    total++;
    if (r && typeof r.ct === 'number' && r.ct >= minCt) { out[id] = r; kept++; }
  }
  if (kept < total) console.log(`  (retention trim: dropped ${total - kept} matches older than ${isoDate(minCt)})`);
  return out;
}

// first/last ct over the store (epoch seconds; null when empty).
function recomputeStoreSpan(matches) {
  let first = Infinity, last = 0;
  for (const r of Object.values(matches)) {
    if (typeof r.ct !== 'number') continue;
    if (r.ct < first) first = r.ct;
    if (r.ct > last) last = r.ct;
  }
  return { first: first === Infinity ? null : first, last: last || null };
}

// 7-day bucket helpers for the per-week ingest histogram.
const weekBucket = (ct) => Math.floor(ct / WEEK_S);
const bucketLabel = (b) => isoDate(b * WEEK_S);
function weekHistogram(byWeek) {
  const buckets = Object.keys(byWeek).map(Number).sort((a, b) => a - b);
  if (!buckets.length) return 'no new weeks';
  return 'weeks: ' + buckets.map((b) => `${bucketLabel(b)}=${byWeek[b]}`).join(', ');
}

const isoDate = (ct) => (ct ? new Date(ct * 1000).toISOString().slice(0, 10) : null);

// --- aggregation (pure): matches[] → the four views -------------------------
// Fed the RETAINED store subset (not just this run's fetch), so the window is the accumulated one.
const MIN_GAMES = 8; // civ-vs-civ needs enough meetings; thin cells are still rendered with their games count
function aggregate(matches) {
  const tally = {};              // civ -> {games, wins, by:{type:{games,wins}}}
  const pairs = {};              // "A|B" -> {a,b,winsA,winsB,games}
  const pairsByType = {};        // "A|B|type" -> {a,b,type,winsA,winsB,games}
  for (const g of matches) {
    const a = g.civA, b = g.civB, t = g.type;
    const da = tally[a] || (tally[a] = { games: 0, wins: 0, by: {} });
    da.games++; da.wins += g.wonA;
    const ba = da.by[t] || (da.by[t] = { games: 0, wins: 0 }); ba.games++; ba.wins += g.wonA;
    const db = tally[b] || (tally[b] = { games: 0, wins: 0, by: {} });
    db.games++; db.wins += g.wonB;
    const bb = db.by[t] || (db.by[t] = { games: 0, wins: 0 }); bb.games++; bb.wins += g.wonB;
    if (a === b) continue; // mirror matchup: counts toward each civ's tally, but is not a civ-vs-civ pair
    const key = a <= b ? `${a}|${b}` : `${b}|${a}`;
    const aw = a <= b ? g.wonA : g.wonB, bw = a <= b ? g.wonB : g.wonA;
    const pa = pairs[key] || (pairs[key] = { a: a <= b ? a : b, b: a <= b ? b : a, winsA: 0, winsB: 0, games: 0 });
    pa.winsA += aw; pa.winsB += bw; pa.games++;
    const pbt = pairsByType[`${key}|${t}`] || (pairsByType[`${key}|${t}`] = { a: pa.a, b: pa.b, type: t, winsA: 0, winsB: 0, games: 0 });
    pbt.winsA += aw; pbt.winsB += bw; pbt.games++;
  }

  const totalPicks = Object.values(tally).reduce((s, d) => s + d.games, 0);
  const totalByType = {};
  for (const d of Object.values(tally)) for (const [t, b] of Object.entries(d.by)) totalByType[t] = (totalByType[t] || 0) + b.games;

  const civs = {};
  for (const [name, d] of Object.entries(tally)) {
    if (!d.games) continue;
    const byMapType = {};
    for (const [t, b] of Object.entries(d.by)) {
      if (!b.games) continue;
      byMapType[t] = { winRate: +(100 * b.wins / b.games).toFixed(2), playRate: totalByType[t] ? +(100 * b.games / totalByType[t]).toFixed(2) : 0, picks: b.games };
    }
    civs[name.toLowerCase()] = {
      winRate: +(100 * d.wins / d.games).toFixed(2),
      playRate: +(100 * d.games / totalPicks).toFixed(2),
      picks: d.games,
      byMapType,
    };
  }

  const matchups = {}, matchupsByMap = {};
  for (const p of Object.values(pairs)) {
    if (!p.games) continue;
    const set = (obj, x, y, wr) => { (obj[x] = obj[x] || {}); obj[x][y] = { winRate: wr, games: p.games }; };
    set(matchups, p.a, p.b, +(100 * p.winsA / p.games).toFixed(2));
    set(matchups, p.b, p.a, +(100 * p.winsB / p.games).toFixed(2));
  }
  for (const p of Object.values(pairsByType)) {
    if (!p.games) continue;
    const put = (x, y, wr) => { (matchupsByMap[x] = matchupsByMap[x] || {}); (matchupsByMap[x][y] = matchupsByMap[x][y] || {}); matchupsByMap[x][y][p.type] = { winRate: wr, games: p.games }; };
    put(p.a, p.b, +(100 * p.winsA / p.games).toFixed(2));
    put(p.b, p.a, +(100 * p.winsB / p.games).toFixed(2));
  }
  for (const [civ, opps] of Object.entries(matchups)) {
    const all = Object.entries(opps).map(([opp, v]) => ({ name: opp, games: v.games, winRate: v.winRate })).filter((x) => x.games >= MIN_GAMES);
    all.sort((x, y) => y.winRate - x.winRate);
    const rec = civs[civ] || (civs[civ] = { winRate: null, playRate: null, picks: 0, byMapType: {} });
    rec.strongAgainst = all.slice(0, 5);
    rec.weakAgainst = all.slice(-5).reverse();
  }

  return { civs, matchups, matchupsByMap, matchupPairs: Object.keys(pairs).length, matchupPairsByMap: Object.keys(pairsByType).length };
}

// Rebuild the four views over the retained store and write aoestats.json (if the sanity gate
// passes). On the final attempt a gate failure throws so update-all.mjs falls back to scrape-aoestats.
async function rebuildAndWrite(store, { newThisRun, now, playerCount, final }) {
  const retained = Object.values(store.matches);
  const agg = aggregate(retained);
  const span = recomputeStoreSpan(store.matches);
  if (Object.keys(agg.civs).length >= 30 && retained.length >= 200) {
    await writeOutput(agg, { retained: retained.length, newThisRun, span, now, playerCount });
    console.log(`    ✓ wrote ${OUT}: ${Object.keys(agg.civs).length} civs / ${retained.length} matches (${agg.matchupPairs} civ-pairs, ${agg.matchupPairsByMap} pair/map-type cells).`);
    return true;
  }
  if (final) {
    throw new Error(`sanity gate failed: ${Object.keys(agg.civs).length} civs / ${retained.length} matches — refusing to overwrite ${OUT}.`);
  }
  console.log(`    deferring write — accumulating (${retained.length} matches so far).`);
  return false;
}

async function writeOutput(agg, { retained, newThisRun, span, now, playerCount }) {
  const windowWeeks = MAX_WEEKS || 'all';
  const out = {
    _meta: {
      source: 'Self-aggregated from the live AoE2 match backend (aoe-api.worldsedgelink.com)',
      sourceUrl: 'https://github.com/ustacode/aoe2-apis',
      method: playerCount
        ? `Samples the top ${playerCount} ranked 1v1 Random Map players, pulls recent completed matches (getRecentMatchHistory), filters matchtype_id=${MATCHTYPE_ID} with exactly 2 players, dedupes by match id, and ACCUMULATES them into a local store. Each run accepts matches finished in the last ${WEEKS} week(s) as new; the four views are tallied over the accumulated window (up to ${MAX_WEEKS || '∞'} weeks).`
        : `Rebuilt from the local store (backend unreachable this run); the four views are tallied over the accumulated window (up to ${MAX_WEEKS || '∞'} weeks).`,
      ladder: '1v1 Random Map', rating: `top ${PLAYERS} (high-Elo sample)`,
      weeks: windowWeeks,
      window: { weeks: windowWeeks, first: isoDate(span.first), last: isoDate(span.last) },
      dumpRange: span.first && span.last ? `${isoDate(span.first)} → ${isoDate(span.last)}` : '—',
      updated: new Date(now * 1000).toISOString(),
      mapTypes: 'open/closed/hybrid/water (curated map-script name->type; unmapped -> other)',
      matches: retained, storedMatches: retained, newThisRun,
      civsWithData: Object.keys(agg.civs).length,
      matchupPairs: agg.matchupPairs, matchupPairsByMap: agg.matchupPairsByMap,
      builtAt: new Date(now * 1000).toISOString().slice(0, 10),
      note: `Live official backend data, accumulated locally over up to ${MAX_WEEKS || 'all'} weeks from periodic runs — larger sample than a single fetch, so civ-vs-civ/per-map cells are less noisy. Covers all played civs incl. the newest (Mapuche/Muisca/Tupi). Bias: top-of-ladder sample reflects high-level play; thin cells still flagged by \`games\`.`,
    },
    civs: agg.civs, matchups: agg.matchups, matchupsByMap: agg.matchupsByMap,
  };
  await mkdir(DATA, { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
}

async function main() {
  if (await gated()) { console.log('✓ aoestats.json is fresh (< 1h old) — skipping. Use FORCE=1 to rebuild.'); return; }
  await mkdir(CACHE, { recursive: true });

  const now = Math.floor(Date.now() / 1000);
  const fetchCutoff = now - WEEKS * WEEK_S;           // accept matches newer than this as "new" this run
  const maxCutoff = MAX_WEEKS ? now - MAX_WEEKS * WEEK_S : 0; // retention floor (0 = keep all)

  // 1) Load + retention-trim the persistent store.
  const store = await loadStore();
  if (Object.keys(store.matches).length) {
    store.matches = trimStore(store.matches, maxCutoff);
    const span = recomputeStoreSpan(store.matches);
    console.log(`  store: ${Object.keys(store.matches).length} retained matches (${isoDate(span.first)} → ${isoDate(span.last)}).`);
  }

  // 2) Reach the backend for the civ map + top players. If it's down, skip fetching and rebuild
  //    from whatever the store already has (keeps the accumulated window alive across outages).
  let races = null, civName = null, profileIds = null;
  try {
    await probeTransport();
    console.log('→ backend: getAvailableLeaderboards (civ + matchtype maps)…');
    const avail = await fetchJson(`${API}/getAvailableLeaderboards?title=${TITLE}`);
    races = {}; for (const r of avail.races || []) races[String(r.id)] = r.name;
    console.log(`  ${Object.keys(races).length} civs known (incl. ${['Mapuche', 'Muisca', 'Tupi'].filter((c) => Object.values(races).includes(c)).join('/')}?).`);
    // Backend civ name -> aoe2techtree name ("Indians" was renamed "Hindustanis" in Dynasties of
    // India; the Relic backend still labels it "Indians").
    const CIV_ALIAS = { indians: 'hindustanis' };
    civName = (id) => { const n = (races[String(id)] || `civ${id}`).toLowerCase(); return CIV_ALIAS[n] || n; };

    console.log(`→ backend: paging getLeaderBoard2 (ladder ${LEADERBOARD_ID}) for top ${PLAYERS} players…`);
    profileIds = [];
    const PAGE = 200;
    for (let start = 1; profileIds.length < PLAYERS; start += PAGE) {
      const need = Math.min(PAGE, PLAYERS - profileIds.length);
      const d = await fetchJson(`${API}/getLeaderBoard2?title=${TITLE}&leaderboard_id=${LEADERBOARD_ID}&start=${start}&count=${need}`);
      const groups = {};
      for (const g of d.statGroups || []) groups[String(g.id)] = g;
      let added = 0;
      for (const s of d.leaderboardStats || []) {
        const g = groups[String(s.statgroup_id)];
        for (const m of (g && g.members) || []) if (m.profile_id != null) { profileIds.push(m.profile_id); added++; }
      }
      if (!added) break; // no more rows
      await sleep(120); // polite throttle between pages
    }
    console.log(`  collected ${profileIds.length} profile_ids.`);
  } catch (e) {
    if (!Object.keys(store.matches).length) throw e; // nothing to fall back on → propagate (→ scrape fallback)
    console.warn(`⚠ backend unreachable (${e.message}); rebuilding from the ${Object.keys(store.matches).length}-match local store only.`);
    races = null; profileIds = null;
  }

  // 3) Fetch recent matches in PARTS; persist + rebuild + write after each part.
  const chunks = [];
  if (profileIds) for (let i = 0; i < profileIds.length; i += BATCH) chunks.push(profileIds.slice(i, i + BATCH));
  const parts = [];
  for (let i = 0; i < chunks.length; i += PART_SIZE) parts.push(chunks.slice(i, i + PART_SIZE));
  const windowLabel = MAX_WEEKS ? `last ${MAX_WEEKS}w` : 'all-time';
  if (parts.length) {
    console.log(`→ backend: getRecentMatchHistory for ${profileIds.length} players (${chunks.length} batches in ${parts.length} part(s) of ≤${PART_SIZE}, concurrency ${CONCURRENCY}); accept matches since ${isoDate(fetchCutoff)}; stats window ${windowLabel}…`);
  }

  let newThisRun = 0;
  for (let pi = 0; pi < parts.length; pi++) {
    const part = parts[pi];
    const partNew = []; // candidate new records collected this part (deduped against the store on merge)
    let dropped = 0;
    await pool(part, async (chunk) => {
      const enc = encodeURIComponent(JSON.stringify(chunk));
      let d;
      try { d = await fetchJson(`${API}/getRecentMatchHistory?title=${TITLE}&profile_ids=${enc}`, 45000); }
      catch { await sleep(300); return; }
      for (const m of d.matchHistoryStats || []) {
        if (m.matchtype_id !== MATCHTYPE_ID) continue;        // 1v1 Random Map only
        if (!m.completiontime) continue;                       // finished
        // completiontime is epoch seconds; guard against a future backend switch to milliseconds.
        const ct = m.completiontime > 1e12 ? Math.floor(m.completiontime / 1000) : m.completiontime;
        if (ct < fetchCutoff) continue;                        // only accept this-run-new matches
        const id = String(m.id);
        if (store.matches[id]) continue;                       // already accumulated
        const reps = m.matchhistoryreportresults || [];
        if (reps.length !== 2) { dropped++; continue; }        // exactly two players (no FFA/team leakage)
        const [p1, p2] = reps;
        if (p1.civilization_id == null || p2.civilization_id == null) continue;
        partNew.push({
          id,
          civA: civName(p1.civilization_id),
          civB: civName(p2.civilization_id),
          wonA: p1.resulttype === 1 ? 1 : 0, wonB: p2.resulttype === 1 ? 1 : 0,
          type: MAP_NAME_TO_TYPE[String(m.mapname || '').replace(/\.rms$/i, '').trim().toLowerCase()] || 'other',
          map: String(m.mapname || '').replace(/\.rms$/i, '').trim(),
          ct,
        });
      }
    }, CONCURRENCY);

    // Merge new records into the store (dedup against store + within part), then persist atomically.
    const byWeek = {};
    let added = 0;
    for (const r of partNew) {
      if (store.matches[r.id]) continue;
      store.matches[r.id] = r;
      added++;
      const b = weekBucket(r.ct);
      byWeek[b] = (byWeek[b] || 0) + 1;
    }
    newThisRun += added;
    if (added) await saveStore(store.matches);

    console.log(`  part ${pi + 1}/${parts.length}: +${added} new (${newThisRun} this run${dropped ? `, ${dropped} non-2-player dropped` : ''}) → ${Object.keys(store.matches).length} stored; ${added ? weekHistogram(byWeek) : 'no new matches'}.`);
    await rebuildAndWrite(store, { newThisRun, now, playerCount: profileIds.length, final: pi === parts.length - 1 });
  }

  // 4) Backend was down (or no players): rebuild + write from the store alone.
  if (!parts.length) {
    console.log(`  (no fetch this run — rebuilding from ${Object.keys(store.matches).length} stored matches)`);
    await rebuildAndWrite(store, { newThisRun: 0, now, playerCount: 0, final: true });
  }

  const span = recomputeStoreSpan(store.matches);
  console.log(`\n✓ Done: +${newThisRun} new this run; store holds ${Object.keys(store.matches).length} matches (${isoDate(span.first)} → ${isoDate(span.last)}).`);
}

main().catch((e) => { console.error('BUILD-STATS-LIVE FAILED:', e); process.exit(1); });
