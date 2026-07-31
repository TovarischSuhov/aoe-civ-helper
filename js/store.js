// js/store.js — localStorage CRUD. The UI always reads from here; never blocks on network.
// Facts are cacheable/refreshable; strategy is bundled in the civ files and preserved (R5).

const META_KEY = 'aoe_meta';
const CIV_PREFIX = 'aoe_civ:';
const VISITED_KEY = 'aoe_visited'; // slugs whose civ file we've cached

export function getMeta() {
  try { return JSON.parse(localStorage.getItem(META_KEY) || 'null'); } catch { return null; }
}

export function setMeta(meta) {
  localStorage.setItem(META_KEY, JSON.stringify({ ...meta, ts: Date.now() }));
}

export function getCiv(slug) {
  try { return JSON.parse(localStorage.getItem(CIV_PREFIX + slug) || 'null'); } catch { return null; }
}

export function putCiv(slug, civ) {
  localStorage.setItem(CIV_PREFIX + slug, JSON.stringify(civ));
  const visited = getVisited();
  if (!visited.includes(slug)) { visited.push(slug); localStorage.setItem(VISITED_KEY, JSON.stringify(visited)); }
}

// R5: update ONLY the facts block of a cached civ (live refresh preserves strategy).
export function mergeFacts(slug, facts, version) {
  const civ = getCiv(slug);
  if (!civ) return false;
  civ.facts = facts;
  civ.version = version;
  putCiv(slug, civ);
  return true;
}

export function getVisited() {
  try { return JSON.parse(localStorage.getItem(VISITED_KEY) || '[]'); } catch { return []; }
}

export function clearCachedCivs() {
  Object.keys(localStorage).filter((k) => k.startsWith(CIV_PREFIX)).forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(VISITED_KEY);
}

// Generic cache for standalone data files (economy, sotl, buildorders, bestpractices,
// posts-log). Versioned by schemaVersion+hash so a rebuild invalidates it. Together with
// the per-civ cache above, this lets EVERY view serve from localStorage (offline after
// first load).
const DATA_PREFIX = 'aoe_data:';
const DATA_VER_KEY = 'aoe_data_version';

export function getData(name) {
  try { return JSON.parse(localStorage.getItem(DATA_PREFIX + name) || 'null'); } catch { return null; }
}
export function setData(name, obj) {
  localStorage.setItem(DATA_PREFIX + name, JSON.stringify(obj));
}
export function getDataVersion() {
  try { return JSON.parse(localStorage.getItem(DATA_VER_KEY) || 'null'); } catch { return null; }
}
export function setDataVersion(v) {
  localStorage.setItem(DATA_VER_KEY, JSON.stringify(v));
}
export function clearDataCache() {
  Object.keys(localStorage).filter((k) => k.startsWith(DATA_PREFIX)).forEach((k) => localStorage.removeItem(k));
  localStorage.removeItem(DATA_VER_KEY);
}

export function clearAll() {
  clearCachedCivs();
  clearDataCache();
  localStorage.removeItem(META_KEY);
}
