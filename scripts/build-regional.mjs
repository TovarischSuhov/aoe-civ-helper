// scripts/build-regional.mjs — extract each civ's REGIONAL units/buildings from the tech tree.
//
// aoe2techtree.net marks regional (and unique) tree items with a distinct colour, and that colour
// comes from a `node_type` field on every node in data/trees/<CIV>.json (in the repo tarball):
//   RegionalUnit / RegionalBuilding / UniqueBuilding   vs.  Unit / UniqueUnit / Research / …
// This script reads those nodes and emits data/regional.json, keyed by internal-name-lowercased
// (so build.mjs joins via `rec.internalName.toLowerCase()`). Each item carries its icon
// `picture_index` (pic) + cost (from data.json) for rendering. node_type is the authoritative flag —
// no threshold heuristic.
//
// REQUIRES: network egress to api.github.com (for the tarball) the first time; afterwards the
// tarball is cached in .cache/. data.json is read from .cache/ (populated by build.mjs).
//
// Usage:  node scripts/build-regional.mjs
//         FORCE=1 node scripts/build-regional.mjs   # re-download the tarball even if cached

import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, createWriteStream, readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const CACHE = join(ROOT, '.cache');
const OUT = join(DATA, 'regional.json');
const TARBALL = join(CACHE, 'aoe2techtree.tarball');
const EXTRACT = join(CACHE, 'trees_extract');

const UA = 'aoe2-civ-tools/1.0 (build-regional)';
const TARBALL_URL = 'https://api.github.com/repos/SiegeEngineers/aoe2techtree/tarball/master';
const DATA_JSON_URL = 'https://aoe2techtree.net/data/data.json';

const WANTED = new Set(['RegionalUnit', 'RegionalBuilding', 'UniqueBuilding']);
const FORCE = process.env.FORCE === '1';

// Short descriptions for regional/unique buildings — the aoe2techtree data carries only stats
// (no help text for buildings), so these are curated. Keyed by lowercased display name.
const BUILDING_DESC = {
  'fortified church': "Replaces the Monastery — trains Monks/Warrior Priests and researches Monastery techs; heavily fortified.",
  'mule cart': "Mobile resource drop-off site that repositions to your gathering nodes.",
  'krepost': "Mini-Castle — trains the Konnik and researches Bulgarian unique techs; cheaper than a Castle.",
  'caravanserai': "Heals nearby units and speeds Trade Carts passing between Caravanserais.",
  'settlement': "Andean production building — trains the Spearman and Skirmisher lines.",
  'pasture': "Replaces the Farm — renewable food worked by up to 2 Villagers; depletes and must be rebuilt.",
  'harbor': "Replaces the Dock (Southeast Asian) — trains ships and Fishing Boats; fortified and can attack.",
  'folwark': "Replaces the Mill — new Farms built in its aura instantly yield a chunk of food.",
  'feitoria': "Passively generates food, wood, gold and stone; costs 20 population.",
  'donjon': "Defensive tower that trains the Serjeant and researches Sicilian unique techs.",
};

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  await pipeline(res.body, createWriteStream(dest));
}

// data.json is needed for item COSTS (names come straight off the tree node). Prefer .cache (what
// build.mjs populates); fall back to a one-off download so this script is runnable standalone.
async function loadData() {
  const cached = join(CACHE, 'data.json');
  if (existsSync(cached)) return JSON.parse(await readFile(cached, 'utf8'));
  await mkdir(CACHE, { recursive: true });
  console.log('  .cache/data.json missing — downloading from aoe2techtree.net…');
  await download(DATA_JSON_URL, cached);
  return JSON.parse(await readFile(cached, 'utf8'));
}

async function ensureTarball() {
  if (!FORCE && existsSync(TARBALL)) {
    console.log(`tarball: [cached] ${TARBALL}`);
    return;
  }
  console.log('tarball: downloading from api.github.com…');
  await download(TARBALL_URL, TARBALL);
}

// Extract only data/trees/*.json into a clean temp dir. System `tar` (the env has it); the tarball
// root is SiegeEngineers-aoe2techtree-<sha>/, hence the leading wildcard. Note `-C dir` must come
// BEFORE the archive on the GNU tar command line.
function extractTrees() {
  const r = spawnSync('tar',
    ['-C', EXTRACT, '-xzf', TARBALL, '--wildcards', '*/data/trees/*.json'],
    { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error('tar extraction failed: ' + (r.stderr || `exit ${r.status}`));
  }
}

function findTreeDir() {
  // EXTRACT/<repo-prefix>/data/trees
  for (const entry of readdirSync(EXTRACT)) {
    const dir = join(EXTRACT, entry, 'data', 'trees');
    if (existsSync(dir)) return dir;
  }
  throw new Error('could not locate data/trees inside the extracted tarball');
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  await mkdir(DATA, { recursive: true });

  if (FORCE && existsSync(EXTRACT)) await rm(EXTRACT, { recursive: true, force: true });

  await ensureTarball();
  await rm(EXTRACT, { recursive: true, force: true }).catch(() => {});
  await mkdir(EXTRACT, { recursive: true });
  extractTrees();
  const treeDir = findTreeDir();
  const treeFiles = readdirSync(treeDir).filter((f) => f.endsWith('.json'));
  console.log(`trees: ${treeFiles.length} civ files.`);

  const data = await loadData();
  // Normalise to lowercase resource keys — render.js costNodes only reads food/wood/gold/stone.
  const normCost = (c) => {
    if (!c || typeof c !== 'object') return null;
    const o = {};
    for (const k of ['Food', 'Wood', 'Gold', 'Stone']) if (c[k] != null) o[k.toLowerCase()] = Number(c[k]);
    return Object.keys(o).length ? o : null;
  };
  const costOf = (cat, id) => {
    const o = data.data?.[cat]?.[String(id)];
    return normCost(o && o.Cost);
  };

  const civs = {};
  for (const f of treeFiles) {
    const civKey = f.replace(/\.json$/, '').toLowerCase(); // internal-name-lowercased
    const tree = JSON.parse(readFileSync(join(treeDir, f), 'utf8'));
    const nodes = [...(tree.buildings || []), ...(tree.units_techs || [])];
    const buildings = [];
    for (const n of nodes) {
      if (!n || n.node_type === 'RegionalUnit') continue;     // units handled below
      if (!WANTED.has(n.node_type)) continue;
      if (n.node_status === 'NotAvailable') continue;          // civ can't build it — skip
      const id = String(n.node_id ?? (String(n.id || '').split('_')[1] ?? ''));
      buildings.push({
        id,
        name: n.name || null,
        cat: 'Building',
        pic: n.picture_index ?? null,
        cost: costOf('Building', id),
        desc: BUILDING_DESC[(n.name || '').toLowerCase()] || null,
        kind: n.node_type === 'UniqueBuilding' ? 'unique' : 'regional',
      });
    }
    // Regional units: group into upgrade LINES via each node's link_id (the previous tier's
    // node_id), ordered root → top. Base tier shows train cost; each later tier shows its research
    // cost (from data.unit_upgrades). Lines of any length (1–4+ tiers, e.g. the Champi line) work.
    const regionalNodes = [];
    for (const n of nodes) {
      if (!n || n.node_type !== 'RegionalUnit') continue;
      if (n.node_status === 'NotAvailable') continue;          // civ can't train it — drop the tier
      const id = String(n.node_id ?? (String(n.id || '').split('_')[1] ?? ''));
      regionalNodes.push({ id, name: n.name || null, pic: n.picture_index ?? null,
        parentId: n.link_id != null ? String(n.link_id) : null });
    }
    const nodeById = {};
    for (const rn of regionalNodes) nodeById[rn.id] = rn;
    const childrenOf = (pid) => regionalNodes.filter((rn) => rn.parentId && nodeById[rn.parentId] && rn.parentId === pid);
    const statsOf = (id) => {
      const o = data.data?.Unit?.[String(id)];
      if (!o) return null;
      return { hp: o.HP != null ? Number(o.HP) : null, attack: o.Attack != null ? Number(o.Attack) : null,
        range: o.Range != null ? Number(o.Range) : null, speed: o.Speed != null ? Number(o.Speed) : null };
    };
    const researchCostOf = (id) => {
      const v = data.data?.unit_upgrades?.[String(id)];
      return normCost(v && v.Cost);
    };
    const buildTiers = (root) => {
      const chain = [];
      let cur = root;
      while (cur) { chain.push(cur); const kids = childrenOf(cur.id); cur = kids.length ? kids[0] : null; }
      return chain.map((node, i) => {
        const st = statsOf(node.id) || {};
        return {
          name: node.name, pic: node.pic,
          hp: st.hp ?? null, attack: st.attack ?? null, range: st.range ?? null, speed: st.speed ?? null,
          cost: i === 0 ? costOf('Unit', node.id) : researchCostOf(node.id),
        };
      });
    };
    const units = regionalNodes
      .filter((rn) => !rn.parentId || !nodeById[rn.parentId]) // roots of a line
      .map((rn) => ({ name: rn.name, cat: 'Unit', kind: 'regional', tiers: buildTiers(rn) }));
    if (units.length || buildings.length) civs[civKey] = { units, buildings };
  }

  const out = {
    _meta: {
      generatedAt: new Date().toISOString().slice(0, 10),
      source: 'aoe2techtree data/trees/*.json (repo tarball)',
      nodeTypes: [...WANTED],
      note: 'Per-civ regional units, regional buildings, and unique buildings — identified by tree node_type. Keyed by internal-name-lowercased; joined in build.mjs via internalName. Costs from data.json; icons (pic) are picture_index values.',
    },
    civs,
  };
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');

  const civsWith = Object.keys(civs).length;
  const totalItems = Object.values(civs).reduce((s, c) => s + c.units.length + c.buildings.length, 0);
  console.log(`\n✓ Wrote ${OUT}: ${civsWith} civs, ${totalItems} regional/unique items.`);
}

main().catch((e) => { console.error('BUILD-REGIONAL FAILED:', e); process.exit(1); });
