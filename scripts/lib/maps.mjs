// scripts/lib/maps.mjs — shared competitive map-name → type classification.
//
// Imported by build-stats.mjs (Parquet), build-stats-live.mjs (live backend) and
// scrape-aoestats.mjs so every producer buckets maps IDENTICALLY. Without this, a map could be
// 'open' in one output and 'other' in another depending on which script last wrote
// data/aoestats.json — the same rendered cell would silently change.
//
// AoE2 ships no authoritative open/closed/hybrid/water tag, so this is a curated best-effort map
// of the stable competitive ladder maps; anything unlisted → 'other' (still counted in the overall
// tally, just not in a type bucket). Add a map here once and all three scripts pick it up.
//
// This list is the union of the three former copies; the live-backend list was the most complete,
// so it is the canonical superset.

export const MAP_TYPE = {
  open: ['Arabia', 'Serengeti', 'Gold Rush', 'Acclivity', 'Steppe', 'Runestones', 'Mongolian Heights', 'Kawasan', 'Alpine', 'Sunburst', 'Sunset Plains', 'Red Hills', 'Rubedo', 'El Dorado', 'High View', 'Socotra', 'Haboob', 'Mot wetlands', 'Liquid cav'],
  closed: ['Arena', 'Black Forest', 'Fortress', 'Hill Fort', 'Hideout', 'Valley', 'Golden Pit', 'Poisoned Forest', 'Titan Caves', 'Ghost Lake', 'Megarandom', 'Fortified Clearing'],
  hybrid: ['Cross', 'Lombardia', 'Four Lakes', 'Yucatan', 'Salt Marsh', 'Confluence', 'Boggle', 'Golden Swamp', 'Mountain Pass', 'Land Nomad', 'Nomad', 'Costa Rica', 'Canals'],
  water: ['Islands', 'Archipelago', 'Team Islands', 'Mediterranean', 'Baltic', 'Continental', 'Crater Lake', 'Sea Nomad', 'Coastal', 'Bay'],
};

// lowercased map name → type
export const MAP_NAME_TO_TYPE = {};
for (const [t, names] of Object.entries(MAP_TYPE)) for (const n of names) MAP_NAME_TO_TYPE[n.toLowerCase()] = t;
