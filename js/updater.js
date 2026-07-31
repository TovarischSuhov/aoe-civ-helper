// js/updater.js — the update rules engine (R1–R5). Two refresh paths, both write only `facts`.
//
//   R1 Bootstrap  — no stored meta, or schemaVersion changed → import bundled meta, clear civ cache.
//   R2 Drift      — bundled meta.hash != stored hash → clear civ cache so detail views re-fetch
//                   the rebuilt (new-facts, preserved-strategy) civ files.
//   R3 Periodic   — older than REFRESH_INTERVAL → live-fetch data.json+strings, deriveAll, push
//                   new facts into cached civs, update hash/ts. Errors fall back gracefully.
//   R4 Manual     — Refresh button forces R3.
//   R5 Preserve   — refresh writes only `facts`; strategy is never touched (store.mergeFacts).
//
// UI always renders from localStorage; updater runs in the background and re-renders on change.

import { deriveAll, SCHEMA_VERSION } from './derive.js';
import * as store from './store.js';

const REFRESH_INTERVAL = 7 * 24 * 60 * 60 * 1000; // 7 days
const DATA_JSON = 'https://aoe2techtree.net/data/data.json';
const STRINGS_JSON = 'https://aoe2techtree.net/data/locales/en/strings.json';

// Standalone guide/data files cached into localStorage so all views serve from cache.
const DATA_FILES = ['economy', 'sotl', 'buildorders', 'tips', 'sources-log', 'aoestats'];

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function sha256Hex(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 12);
}

// Returns { changed: bool, meta }. Throws on network/parse failure (caller handles fallback).
export async function liveRefresh({ onProgress } = {}) {
  onProgress?.('Fetching aoe2techtree.net…');
  const [data, strings] = await Promise.all([fetchJson(DATA_JSON), fetchJson(STRINGS_JSON)]);
  const dataText = JSON.stringify(data); // canonical-ish for hashing
  const hash = await sha256Hex(dataText);
  const { civFacts } = deriveAll(data, strings, store.getMeta()?.pictureIndex || {});

  // Push new facts into every cached civ (R5: strategy preserved). civFacts is keyed by slug.
  let updated = 0;
  for (const slug of store.getVisited()) {
    const rec = civFacts[slug];
    if (rec && store.mergeFacts(slug, rec.facts, { hash, schemaVersion: SCHEMA_VERSION })) updated++;
  }

  const prev = store.getMeta();
  const changed = !prev || prev.hash !== hash;
  const meta = { ...(prev || {}), hash, schemaVersion: SCHEMA_VERSION, liveChecked: Date.now() };
  store.setMeta(meta);
  return { changed, updated, hash };
}

// Boot/drift reconciliation against the bundled data/meta.json.
export async function ensureData({ onProgress } = {}) {
  onProgress?.('Loading…');
  let bundled;
  try {
    bundled = await fetchJson('data/meta.json');
  } catch (e) {
    return { ok: false, error: 'Could not load bundled data/meta.json: ' + e.message };
  }

  const stored = store.getMeta();
  let reconciled = false;
  // R1 / R2: schema change or hash drift → refresh meta + drop stale caches.
  const staleMeta = !stored || stored.schemaVersion !== bundled.schemaVersion || stored.hash !== bundled.hash;
  if (staleMeta) {
    store.setMeta({ ...bundled, schemaVersion: bundled.schemaVersion });
    store.clearCachedCivs();
    store.clearDataCache();
    store.setDataVersion({ schemaVersion: bundled.schemaVersion, hash: bundled.hash });
    reconciled = true;
  } else {
    store.setMeta({ ...bundled, schemaVersion: bundled.schemaVersion });
  }

  // Backend caching: warm localStorage with every standalone guide + civ file so the whole
  // app serves from localStorage on every subsequent view (fully offline after first load).
  onProgress?.('Caching data…');
  const warm = [];
  for (const name of DATA_FILES) {
    if (!store.getData(name)) warm.push(fetchJson(`data/${name}.json`).then((j) => store.setData(name, j)).catch(() => {}));
  }
  for (const c of bundled.civOrder || []) {
    if (!store.getCiv(c.slug)) warm.push(fetchJson(`data/civs/${c.slug}.json`).then((j) => store.putCiv(c.slug, j)).catch(() => {}));
  }
  await Promise.allSettled(warm);

  // R3: periodic live refresh (best-effort, non-blocking).
  const stale = !stored || !stored.liveChecked || Date.now() - stored.liveChecked > REFRESH_INTERVAL;
  let live = null;
  if (stale) {
    try { live = await liveRefresh({ onProgress }); }
    catch (e) { live = { error: e.message }; }
  }
  return { ok: true, meta: store.getMeta(), reconciled, live };
}

// Cache-first read of a standalone data file; fetches + caches on miss.
export async function loadData(name) {
  const cached = store.getData(name);
  if (cached) return cached;
  const j = await fetchJson(`data/${name}.json`);
  store.setData(name, j);
  return j;
}

// Force re-fetch of a standalone data file (cache-busted) and update localStorage. The Refresh
// button uses this for files that change INDEPENDENTLY of the techtree hash — notably stats, which
// the server rebuilds on a schedule while data/aoestats.json's bundled copy otherwise sits behind
// the hash gate. Returns { name, changed }.
export async function refreshData(name, { onProgress } = {}) {
  onProgress?.(`Fetching data/${name}.json…`);
  const prev = store.getData(name);
  // Cache-bust: the file changes server-side without its URL changing, so bypass every HTTP cache.
  const next = await fetchJson(`data/${name}.json?_=${Date.now()}`);
  store.setData(name, next);
  return { name, changed: JSON.stringify(prev) !== JSON.stringify(next) };
}

// Fetch a civ file on demand; cache it; return the civ object.
export async function loadCiv(slug) {
  const cached = store.getCiv(slug);
  if (cached) return cached;
  const res = await fetch(`data/civs/${slug}.json`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const civ = await res.json();
  store.putCiv(slug, civ);
  return civ;
}
