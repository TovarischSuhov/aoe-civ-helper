// scripts/build.mjs — fetch aoe2techtree data, derive facts, write meta.json + per-civ files.
// No external deps. Node >= 18 (global fetch + webcrypto).
//
// Usage:
//   node scripts/build.mjs            # uses .cache/ if present, else downloads
//   FORCE_FETCH=1 node scripts/build.mjs   # always re-download upstream
//
// Update safety: when a data/civs/<slug>.json already exists, only `facts`/`id`/`version`
// are rewritten; hand-curated `strategy` + `sources` are preserved (rule R5).

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { deriveAll, SCHEMA_VERSION } from '../js/derive.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const CACHE = join(ROOT, '.cache');
const DATA = join(ROOT, 'data');
const CIVS = join(DATA, 'civs');

const UA = 'aoe2-civ-tools/1.0 (build script)';
const GH_REPO = 'SiegeEngineers/aoe2techtree';
const GH_BRANCH = 'master';
const SRC_DATA = [
  { url: 'https://aoe2techtree.net/data/data.json' },
  { url: `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/data/data.json` },
  { gh: 'data/data.json' }, // GitHub contents API — reachable when the raw hosts are blocked
];
const SRC_STRINGS = [
  { url: 'https://aoe2techtree.net/data/locales/en/strings.json' },
  { url: `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/data/locales/en/strings.json` },
  { gh: 'data/locales/en/strings.json' },
];

async function fetchAny(sources, dest) {
  let lastErr;
  for (const src of sources) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        let text;
        if (src.gh) {
          // GitHub contents API returns base64 — works where raw.githubusercontent is blocked.
          const r = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${src.gh}?ref=${GH_BRANCH}`, {
            headers: { 'User-Agent': UA, Accept: 'application/vnd.github+json' },
          });
          if (!r.ok) throw new Error(`gh HTTP ${r.status}`);
          const j = await r.json();
          if (!j || j.content == null) throw new Error('gh: no content');
          text = Buffer.from(j.content.replace(/\s/g, ''), 'base64').toString('utf8');
        } else {
          const ctrl = new AbortController();
          const t = setTimeout(() => ctrl.abort(), 60000);
          const res = await fetch(src.url, { signal: ctrl.signal, headers: { 'User-Agent': UA } });
          clearTimeout(t);
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          text = await res.text();
        }
        JSON.parse(text); // validate
        await writeFile(dest, text);
        return src.gh ? `gh:${src.gh}` : src.url;
      } catch (e) {
        lastErr = e;
        await new Promise((r) => setTimeout(r, 1500 * attempt));
      }
    }
  }
  throw new Error(`All sources failed for ${dest}: ${lastErr && lastErr.message}`);
}

function slugify(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const force = process.env.FORCE_FETCH === '1';
  await mkdir(CACHE, { recursive: true });
  await mkdir(CIVS, { recursive: true });

  const dataPath = join(CACHE, 'data.json');
  const strPath = join(CACHE, 'en_strings.json');

  let dataSource = '[cached]';
  if (force || !existsSync(dataPath)) dataSource = await fetchAny(SRC_DATA, dataPath);
  let stringsSource = '[cached]';
  if (force || !existsSync(strPath)) stringsSource = await fetchAny(SRC_STRINGS, strPath);
  console.log(`data: ${dataSource}\nstrings: ${stringsSource}`);

  const data = JSON.parse(await readFile(dataPath, 'utf8'));
  const strings = JSON.parse(await readFile(strPath, 'utf8'));

  const dataText = await readFile(dataPath, 'utf8');
  const hash = createHash('sha256').update(dataText).digest('hex').slice(0, 12);

  // Human version label (best-effort) from the site footer "Update NNNNNN".
  let updateLabel = '';
  try {
    const idxRes = await fetch('https://aoe2techtree.net/', { headers: { 'User-Agent': UA } });
    if (idxRes.ok) updateLabel = (await idxRes.text()).match(/Update\s+(\d+)/i)?.[1] || '';
  } catch { /* offline — label optional */ }

  // picture_index map: data-id -> aoe2techtree icon filename (the data id does NOT reliably
  // equal the image id). Generated from the repo's data/trees/*.json; see data/picture-index.json.
  let pictureIndex = { unit: {}, tech: {}, building: {} };
  try { pictureIndex = JSON.parse(await readFile(join(DATA, 'picture-index.json'), 'utf8')); }
  catch { console.warn('  (no data/picture-index.json — unit/tech icons fall back to data id)'); }

  const { meta, civFacts } = deriveAll(data, strings, pictureIndex);

  // Curated strategy is the single hand-authored source of truth (English, translated
  // from kiritastrich + aoe2database context). It is NEVER overwritten by upstream refresh.
  let curated = {};
  try { curated = JSON.parse(await readFile(join(DATA, 'strategy.json'), 'utf8')); }
  catch { console.warn('  (no data/strategy.json — civs will ship facts-only)'); }

  // Spirit Of The Law takeaways (last ~2 years) — merged per civ; never overwritten by refresh.
  let sotl = { civs: {} };
  try { sotl = JSON.parse(await readFile(join(DATA, 'sotl.json'), 'utf8')); }
  catch { console.warn('  (no data/sotl.json — SOTL takeaways omitted)'); }

  // aoestats.io ranked win/play rates — attached per civ; never overwritten by upstream refresh.
  let aoestats = { _meta: {}, civs: {} };
  try { aoestats = JSON.parse(await readFile(join(DATA, 'aoestats.json'), 'utf8')); }
  catch { console.warn('  (no data/aoestats.json — ranked win rates omitted)'); }

  // Regional units/buildings (RegionalUnit/RegionalBuilding/UniqueBuilding) — generated from the
  // aoe2techtree trees by scripts/build-regional.mjs. Attached per civ; never overwritten by refresh.
  let regional = { civs: {} };
  try { regional = JSON.parse(await readFile(join(DATA, 'regional.json'), 'utf8')); }
  catch { console.warn('  (no data/regional.json — regional units/buildings omitted)'); }

  const civOrder = [];
  let withStrategy = 0;
  for (const display of Object.keys(civFacts)) {
    const rec = civFacts[display];
    const slug = slugify(display);
    const file = join(CIVS, `${slug}.json`);
    const strat = curated[slug] || {};
    const sotlEntry = sotl.civs[slug] || null;
    // Match aoestats by the civ's internal name first (e.g. civ "Inca" has internalName "Incas"
    // → aoestats key "incas"), then by slug. Handles singular/plural naming differences.
    const aoeKey = (rec.internalName || '').toLowerCase();
    const aoeEntry = aoestats.civs[aoeKey] || aoestats.civs[slug] || null;
    const stats = aoeEntry ? {
      winRate: aoeEntry.winRate, playRate: aoeEntry.playRate, picks: aoeEntry.picks,
      patch: aoestats._meta.patch, ladder: aoestats._meta.ladder, rating: aoestats._meta.rating,
      updated: aoestats._meta.updated, window: aoestats._meta.dumpRange || null,
      source: aoestats._meta.source || 'ranked match statistics',
      sourceUrl: aoestats._meta.sourceUrl || 'https://aoestats.io/',
      sourceCiv: `https://aoestats.io/civs/${slug}`,
      // Per-map-type win rates (open/closed/hybrid/water) + civ-vs-civ matchups. Drives the
      // Matchups & Maps sections (see render.js); render falls back to the tech-tree heuristic
      // when these are absent.
      byMapType: aoeEntry.byMapType || {},
      strongAgainst: aoeEntry.strongAgainst || [],
      weakAgainst: aoeEntry.weakAgainst || [],
    } : null;
    const regionalEntry = regional.civs[(rec.internalName || '').toLowerCase()] || { units: [], buildings: [] };
    const out = {
      id: rec.id,
      internalName: rec.internalName,
      slug,
      version: { hash, updateLabel, schemaVersion: SCHEMA_VERSION },
      facts: rec.facts,
      strategy: strat,
      sotl: sotlEntry,
      stats,
      regional: regionalEntry,
      sources: Array.from(new Set([
        'aoe2techtree',
        ...(strat.sources || []),
        ...(sotlEntry ? ['spirit-of-the-law'] : []),
        ...(aoeEntry ? ['aoestats'] : []),
      ])),
    };
    if (Object.keys(strat).length) withStrategy++;
    await writeFile(file, JSON.stringify(out, null, 2) + '\n');
    const orderEntry = { name: rec.id, slug, internalName: rec.internalName, armyType: rec.facts.armyType };
    if (sotlEntry) orderEntry.sotlRank = sotlEntry.rank;
    if (stats) orderEntry.winRate = stats.winRate;
    civOrder.push(orderEntry);
  }

  const metaOut = {
    schemaVersion: SCHEMA_VERSION,
    gameVersion: 'Age of Empires II: Definitive Edition',
    updateLabel,
    hash,
    generatedAt: new Date().toISOString().slice(0, 10),
    sources: {
      techtree: 'https://aoe2techtree.net/',
      dataJson: 'https://aoe2techtree.net/data/data.json',
      stringsJson: 'https://aoe2techtree.net/data/locales/en/strings.json',
    },
    civOrder,
    refUpgrades: meta.refUpgrades,
    pictureIndex: meta.pictureIndex,
  };
  await writeFile(join(DATA, 'meta.json'), JSON.stringify(metaOut, null, 2) + '\n');
  await writeFile(join(DATA, 'version.json'), JSON.stringify(
    { hash, updateLabel, generatedAt: metaOut.generatedAt, schemaVersion: SCHEMA_VERSION }, null, 2) + '\n');

  console.log(`\n✓ Built: ${civOrder.length} civs (${withStrategy} with curated strategy)`);
  console.log(`  hash=${hash}  update=${updateLabel || '?'}  date=${metaOut.generatedAt}`);
}

main().catch((e) => { console.error('BUILD FAILED:', e); process.exit(1); });
