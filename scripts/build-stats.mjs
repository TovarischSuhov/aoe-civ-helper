// scripts/build-stats.mjs — SELF-COMPUTE ranked civ statistics from RAW match data.
//
// aoe2.net (the original raw source) was permanently sunset. The canonical raw feed now
// lives on aoestats.io as weekly Parquet database dumps (matches.parquet + players.parquet),
// documented at https://aoestats.io/api-info/ . This script downloads those dumps, filters to
// 1v1 Random Map on the newest patch present, and tallies FOUR views — all from the raw games:
//
//   1. Global civ win rate                      → civs[slug].winRate / playRate / picks
//   2. Civ win rate per map type                → civs[slug].byMapType[open|closed|hybrid|water]
//   3. Total civ-to-civ (matchup) win rate       → matchups[A][B] = {winRate, games}
//   4. Civ-to-civ per map type                   → matchupsByMap[A][B][mapType] = {winRate, games}
//
// These four views drive the win-rate, Matchups and Maps sections on every civ page.
//
// REQUIRES in the environment it runs in:
//   - network egress to aoestats.io  (NOT available in every CI/sandbox)
//   - python3 + pyarrow              (pip install pyarrow)  — Parquet has no zero-dep Node reader
//
// Usage:
//   node scripts/build-stats.mjs            # respects the 1-hour time gate; last 2 non-empty weeks
//   FORCE=1 node scripts/build-stats.mjs    # ignore the gate, always rebuild
//   WEEKS=4 node scripts/build-stats.mjs    # last N non-empty weekly dumps (default 2)
//   WEEKS=0 node scripts/build-stats.mjs    # ALL non-empty dumps on the newest patch (broad sample)
//   LATEST=1 node scripts/build-stats.mjs   # only the single most recent non-empty dump
//
// Time gate: if data/aoestats.json was written < 1h ago, the run is skipped. FORCE=1 overrides.
//
// NOTE on freshness: aoestats.io publishes one dump per calendar week, but the weekly buckets are
// sometimes empty for recent weeks (the pipeline lags). This script silently skips empty buckets
// (num_matches == 0) and uses the most recent weeks that actually contain games, so "last 2 weeks"
// always means the last 2 weeks with real data. The actual window used is recorded in _meta.dumpRange.

import { writeFile, mkdir, stat } from 'node:fs/promises';
import { existsSync, createWriteStream } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { MAP_NAME_TO_TYPE } from './lib/maps.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const CACHE = join(ROOT, '.cache', 'db_dumps');
const OUT = join(DATA, 'aoestats.json');
const GATE_MS = 60 * 60 * 1000; // 1 hour

const UA = 'aoe2-civ-tools/1.0 (build-stats)';
const RAW_MATCH_1V1 = 6;               // raw_match_type: 6 = 1v1 Random Map

// Map-name -> type classification is shared across all producers in ./lib/maps.mjs.

const FORCE = process.env.FORCE === '1';
const LATEST = process.env.LATEST === '1';
// WEEKS: how many most-recent NON-EMPTY weekly dumps to aggregate. WEEKS=0 = all non-empty dumps.
const WEEKS = process.env.WEEKS === undefined ? 2 : Math.max(0, +process.env.WEEKS || 0);

// --- 1-hour gate -----------------------------------------------------------
async function gated() {
  if (FORCE) return false;
  try {
    const st = await stat(OUT);
    return Date.now() - st.mtimeMs < GATE_MS;
  } catch { return false; }
}

// Preflight: Parquet aggregation needs python3 + pyarrow. Fail fast with an actionable message so
// update-all.mjs can fall back to the scraped snapshot where pyarrow/egress aren't available.
function preflight() {
  const r = spawnSync('python3', ['-c', 'import pyarrow; print(pyarrow.__version__)'], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('python3 + pyarrow required (pip install pyarrow) and aoestats.io must be reachable — cannot self-compute stats.');
  }
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

// Normalise the db_dumps listing. The API returns objects with start_date/end_date/num_matches and
// media URLs; older shapes (string tokens / {range,path}) are tolerated. Capture the media dir so we
// can build the .parquet URLs, plus num_matches to skip empty (pipeline-lagged) weekly buckets.
function normaliseDumps(list) {
  const out = [];
  for (const item of list || []) {
    let start, end, mediaDir, numMatches = null;
    if (item && typeof item === 'object' && (item.start_date || item.end_date)) {
      start = item.start_date; end = item.end_date; numMatches = item.num_matches ?? null;
      const mu = item.matches_url || item.players_url || '';
      const m = mu.match(/db_dumps\/(.+)\/(?:matches|players)\.parquet/);
      mediaDir = m ? m[1] : (start && end ? `date_range=${start}_${end}` : null);
    } else {
      const s = typeof item === 'string' ? item : (item.range || item.path || item.url || item.date_range || JSON.stringify(item));
      const mm = s.match(/(\d{4}-\d{2}-\d{2})_(\d{4}-\d{2}-\d{2})/);
      if (!mm) continue;
      start = mm[1]; end = mm[2];
      mediaDir = s.includes('date_range=') ? s.slice(s.indexOf('date_range=')) : `date_range=${start}_${end}`;
    }
    if (!start || !end || !mediaDir) continue;
    out.push({ token: `${start}_${end}`, start, end, mediaDir, numMatches });
  }
  return out;
}

async function download(url, dest) {
  if (existsSync(dest)) return; // cache per range
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

// Python does the Parquet read + the tallies (Parquet has no zero-dep Node parser). TWO passes:
//   pass 1 — newest patch across all match files (so a mid-window patch bump doesn't zero the result
//            when the window straddles a release; override with AOE_PATCH to force a specific patch);
//   pass 2 — per-civ overall + per-map-type tallies, plus civ-vs-civ overall AND per-map-type.
const PY_AGG = `
import os, sys, json
import pyarrow.parquet as pq
RMT_1V1 = int(os.environ.get('AOE_RMT_1V1', '6'))
FORCED_PATCH = os.environ.get('AOE_PATCH', '0')
MAPS = json.loads(os.environ.get('AOE_MAPS', '{}'))  # lowercased map name -> type
def mtype(name):
    if not name:
        return 'other'
    return MAPS.get(str(name).strip().lower(), 'other')
args = sys.argv[1:]
m_paths = args[0::2]
p_paths = args[1::2]

# Pass 1: newest patch across all matches files.
cur_patch = 0
for mp in m_paths:
    for v in pq.read_table(mp, columns=['patch']).column('patch').to_pylist():
        if v and v > cur_patch:
            cur_patch = v
if FORCED_PATCH and FORCED_PATCH != '0':
    cur_patch = int(FORCED_PATCH)

# Pass 2: tally per-civ (overall + per map type) and civ-vs-civ (overall + per map type).
tally = {}; pairs = {}; pairs_by_type = {}; matches_kept = 0
for mp, pp in zip(m_paths, p_paths):
    mt = pq.read_table(mp, columns=['game_id','patch','raw_match_type','num_players','map'])
    patch = mt.column('patch').to_pylist(); rmt = mt.column('raw_match_type').to_pylist()
    np_ = mt.column('num_players').to_pylist(); gid = mt.column('game_id').to_pylist(); mp2 = mt.column('map').to_pylist()
    valid = set(); gtype = {}
    for j in range(len(gid)):
        if patch[j] == cur_patch and rmt[j] == RMT_1V1 and np_[j] == 2:
            valid.add(gid[j]); gtype[gid[j]] = mtype(mp2[j])
    matches_kept += len(valid)
    pt = pq.read_table(pp, columns=['game_id','civ','winner'])
    g = pt.column('game_id').to_pylist(); c = pt.column('civ').to_pylist(); w = pt.column('winner').to_pylist()
    gamePlayers = {}
    for j in range(len(g)):
        gg = g[j]
        if gg not in valid:
            continue
        civ = c[j] or 'Unknown'; won = bool(w[j])
        d = tally.setdefault(civ, {'games': 0, 'wins': 0, 'by': {}})
        d['games'] += 1
        if won:
            d['wins'] += 1
        b = d['by'].setdefault(gtype[gg], {'games': 0, 'wins': 0})
        b['games'] += 1
        if won:
            b['wins'] += 1
        gamePlayers.setdefault(gg, []).append((civ, won))
    for gg, pls in gamePlayers.items():
        if len(pls) != 2:
            continue
        (c1, w1), (c2, w2) = pls
        if c1 == c2:
            continue  # mirror: already counted in each civ's tally, not a civ-vs-civ pair
        a, b = (c1, c2) if c1 <= c2 else (c2, c1)
        key = a + '|' + b; t = gtype[gg]
        p = pairs.setdefault(key, {'a': a, 'b': b, 'winsA': 0, 'winsB': 0, 'games': 0})
        pb = pairs_by_type.setdefault(key + '|' + t, {'a': a, 'b': b, 'type': t, 'winsA': 0, 'winsB': 0, 'games': 0})
        wa, wb = (1 if w1 else 0, 1 if w2 else 0) if c1 == a else (1 if w2 else 0, 1 if w1 else 0)
        p['winsA'] += wa; p['winsB'] += wb; p['games'] += 1
        pb['winsA'] += wa; pb['winsB'] += wb; pb['games'] += 1
print(json.dumps({'tally': tally, 'pairs': pairs, 'pairs_by_type': pairs_by_type, 'games': matches_kept, 'patch': cur_patch}))
`;

function runAggregator(pairs) {
  const tmp = join(CACHE, '_aggregate.py');
  // spawnSync writes the script file inline below; here just run it.
  const r = spawnSync('python3', [tmp, ...pairs], {
    env: { ...process.env, AOE_RMT_1V1: String(RAW_MATCH_1V1), AOE_MAPS: JSON.stringify(MAP_NAME_TO_TYPE) },
    encoding: 'utf8',
    // python aggregation over a few hundred thousand rows can take a couple of minutes.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (r.status !== 0) {
    throw new Error('python aggregation failed: ' + (r.stderr || r.stdout || `exit ${r.status}`));
  }
  const line = (r.stdout || '').trim().split('\n').pop(); // last non-empty line is our JSON
  return JSON.parse(line);
}

async function main() {
  if (await gated()) {
    console.log('✓ aoestats.json is fresh (< 1h old) — skipping. Use FORCE=1 to rebuild.');
    return;
  }
  preflight();

  console.log('Listing weekly match dumps from aoestats.io…');
  const raw = await fetchJson('https://aoestats.io/api/db_dumps');
  const all = normaliseDumps(Array.isArray(raw) ? raw : (raw.db_dumps || raw.dumps || raw.data || [])).sort((a, b) => a.end.localeCompare(b.end));
  // Skip empty buckets (the pipeline sometimes lags: recent weeks publish with 0 games).
  let withData = all.filter((d) => (d.numMatches ?? 0) > 0);
  if (!withData.length) withData = all; // num_matches missing everywhere → fall back to all
  const chosen = LATEST ? withData.slice(-1)
    : (WEEKS === 0 ? withData : withData.slice(-WEEKS));
  if (!chosen.length) throw new Error('no non-empty weekly dumps available from aoestats.io');
  console.log(`  ${all.length} dumps listed (${withData.length} with games); using ${chosen.length} (${LATEST ? 'latest' : WEEKS === 0 ? 'all non-empty' : 'last ' + chosen.length}).`);
  console.log(`  window: ${chosen[0].start} → ${chosen[chosen.length - 1].end}`);

  await mkdir(CACHE, { recursive: true });
  const cacheRoot = resolve(CACHE);
  const pairs = [];
  for (const d of chosen) {
    // mediaDir comes from the network listing — make sure join() can't escape the cache dir.
    const dir = join(cacheRoot, d.mediaDir);
    const rel = relative(cacheRoot, dir);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`mediaDir escapes cache dir (possible bad upstream data): ${d.mediaDir}`);
    }
    await mkdir(dir, { recursive: true });
    const m = join(dir, 'matches.parquet');
    const p = join(dir, 'players.parquet');
    console.log(`  · ${d.token} (${d.numMatches ?? '?'} matches)`);
    await download('https://aoestats.io/media/db_dumps/' + d.mediaDir + '/matches.parquet', m);
    await download('https://aoestats.io/media/db_dumps/' + d.mediaDir + '/players.parquet', p);
    pairs.push(m, p);
  }

  // Write the aggregator script and run it.
  await writeFile(join(CACHE, '_aggregate.py'), PY_AGG);
  console.log('Tallying per-civ + civ-vs-civ wins/games (python + pyarrow)…');
  const agg = runAggregator(pairs);

  const tally = agg.tally || {};
  // players.parquet `civ` must be the civ NAME, not a numeric id — otherwise the keys ("1","2",…)
  // won't join to data/civs/<slug>.json. build-stats-live.mjs carries a races id->name map for the
  // live backend; the Parquet path assumes aoestats already denormalised names. Fail loudly if not.
  const tallyKeys = Object.keys(tally);
  if (tallyKeys.length && tallyKeys.every((k) => /^\d+$/.test(k))) {
    throw new Error('players.parquet `civ` looks numeric (ids, not names) — build-stats.mjs has no id->name map; refusing to write unjoinable civ keys.');
  }
  const totalPicks = Object.values(tally).reduce((s, d) => s + d.games, 0);
  const totalByType = {};
  for (const d of Object.values(tally)) for (const [t, b] of Object.entries(d.by || {})) totalByType[t] = (totalByType[t] || 0) + b.games;
  const civs = {};
  for (const [name, d] of Object.entries(tally)) {
    if (!d.games) continue;
    const byMapType = {};
    for (const [t, b] of Object.entries(d.by || {})) {
      if (!b.games) continue;
      byMapType[t] = {
        winRate: +(100 * b.wins / b.games).toFixed(2),
        playRate: totalByType[t] ? +(100 * b.games / totalByType[t]).toFixed(2) : 0,
        picks: b.games,
      };
    }
    civs[name.toLowerCase()] = {
      winRate: +(100 * d.wins / d.games).toFixed(2),
      playRate: +(100 * d.games / totalPicks).toFixed(2),
      picks: d.games,
      byMapType,
    };
  }

  // Civ-vs-civ overall: matchups[A][B] = A's win rate vs B over `games` 1v1 meetings (symmetric).
  const matchups = {};
  for (const p of Object.values(agg.pairs || {})) {
    if (!p.games) continue;
    (matchups[p.a] = matchups[p.a] || {}); (matchups[p.b] = matchups[p.b] || {});
    matchups[p.a][p.b] = { winRate: +(100 * p.winsA / p.games).toFixed(2), games: p.games };
    matchups[p.b][p.a] = { winRate: +(100 * p.winsB / p.games).toFixed(2), games: p.games };
  }
  // Civ-vs-civ per map type: matchupsByMap[A][B][mapType] = {winRate, games}.
  const matchupsByMap = {};
  for (const p of Object.values(agg.pairs_by_type || {})) {
    if (!p.games) continue;
    const set = (x, y, wr) => {
      (matchupsByMap[x] = matchupsByMap[x] || {});
      (matchupsByMap[x][y] = matchupsByMap[x][y] || {});
      matchupsByMap[x][y][p.type] = { winRate: wr, games: p.games };
    };
    set(p.a, p.b, +(100 * p.winsA / p.games).toFixed(2));
    set(p.b, p.a, +(100 * p.winsB / p.games).toFixed(2));
  }

  const firstEnd = chosen[0].end, lastEnd = chosen[chosen.length - 1].end;
  const out = {
    _meta: {
      source: 'Self-computed from aoestats.io weekly match dumps (raw ranked games)',
      sourceUrl: 'https://aoestats.io/api-info/',
      method: 'Per-civ wins/games + civ-vs-civ pairs tallied from matches.parquet + players.parquet; filtered to raw_match_type=6 (1v1 Random Map), num_players=2, newest patch present ('
        + agg.patch + '). Civ-vs-civ computed only from matches with exactly 2 players.',
      patch: agg.patch,
      ladder: '1v1 Random Map',
      rating: 'ALL',
      dumpRange: firstEnd === lastEnd ? firstEnd : `${firstEnd}–${lastEnd}`,
      weeks: LATEST ? 1 : (WEEKS === 0 ? 'all non-empty' : WEEKS),
      updated: lastEnd,
      mapTypes: 'open/closed/hybrid/water (curated name->type; unmapped -> other)',
      matchupPairs: Object.keys(agg.pairs || {}).length,
      matchupPairsByMap: Object.keys(agg.pairs_by_type || {}).length,
      matches: agg.games,
      civsWithData: Object.keys(civs).length,
      builtAt: new Date().toISOString().slice(0, 10),
      note: 'Computed locally from raw ranked 1v1 games over the window above — the most recent weeks aoestats.io published raw data for. New/unranked civs appear once they have ranked 1v1 games; per-map-type civ-vs-civ cells with few games are noisy (filter by `games` when rendering).',
    },
    civs,
    matchups,
    matchupsByMap,
  };
  // Sanity gate: never overwrite good data with a degenerate result (empty/stale dumps, bad patch).
  if (Object.keys(civs).length < 30 || !agg.games) {
    throw new Error(`sanity gate failed: ${Object.keys(civs).length} civs / ${agg.games} matches (patch ${agg.patch}) — refusing to overwrite ${OUT}.`);
  }
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\n✓ Wrote ${OUT}: ${Object.keys(civs).length} civs from ${agg.games} 1v1 matches (patch ${agg.patch}, ${out._meta.dumpRange}; ${out._meta.matchupPairs} civ-pairs, ${out._meta.matchupPairsByMap} civ-pair/map-type cells).`);
}

main().catch((e) => { console.error('BUILD-STATS FAILED:', e.message); process.exit(1); });
