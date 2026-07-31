// js/updater.js — the data-sync engine. The SPA reads ONLY the committed/cached `data/` bundle from
// its own origin; a background CI job (.github/workflows/update-data.yml) rebuilds that bundle from
// aoe2techtree.net. The browser never fetches aoe2techtree.net for data.
//
//   R1 Bootstrap — no stored meta, or schemaVersion changed → import bundled meta, warm caches.
//   R2 Drift     — bundled meta.hash != stored hash (CI rebuilt the bundle) → clear caches so detail
//                  views re-fetch the rebuilt civ files. Runs on EVERY load → the SPA auto-syncs to
//                  whatever CI deployed, with no live-fetch.
//   R4 Manual    — the ↻ Refresh button forces a cache-busted re-sync to the deployed bundle.
//   R5 Preserve  — strategy lives in the committed civ files; build.mjs preserves data/strategy.json
//                  server-side, and the SPA never writes strategy.
//
// UI always renders from localStorage; route() re-renders after a sync.

import * as store from './store.js';

// Standalone guide/data files cached into localStorage so all views serve from cache.
const DATA_FILES = ['economy', 'sotl', 'buildorders', 'tips', 'sources-log', 'aoestats'];

async function fetchJson(url) {
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
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
  return { ok: true, meta: store.getMeta(), reconciled };
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

// Force a cache-busted re-sync to the DEPLOYED bundle (↻ Refresh button). Re-fetches meta.json; if
// CI rebuilt the bundle (hash/schema drift) clears stale caches and re-warms civ files; always
// re-pulls the standalone data files (guides + stats change on their own schedules). Never touches
// aoe2techtree.net — only same-origin data/. Returns { drifted, changed }.
export async function syncBundle({ onProgress } = {}) {
  onProgress?.('Checking deployed data…');
  const bundled = await fetchJson(`data/meta.json?_=${Date.now()}`);
  const stored = store.getMeta();
  const drifted = !stored || stored.hash !== bundled.hash || stored.schemaVersion !== bundled.schemaVersion;
  if (drifted) {
    store.setMeta({ ...bundled, schemaVersion: bundled.schemaVersion });
    store.clearCachedCivs();
    store.clearDataCache();
    store.setDataVersion({ schemaVersion: bundled.schemaVersion, hash: bundled.hash });
    onProgress?.('Loaded new tech-tree data; re-warming…');
    const warm = (bundled.civOrder || []).map((c) =>
      fetchJson(`data/civs/${c.slug}.json?_=${Date.now()}`).then((j) => store.putCiv(c.slug, j)).catch(() => {}));
    await Promise.allSettled(warm);
  }
  onProgress?.('Refreshing data files…');
  let changed = drifted;
  await Promise.all(DATA_FILES.map((n) =>
    refreshData(n).then((r) => { if (r.changed) changed = true; }).catch(() => {})));
  return { drifted, changed };
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
