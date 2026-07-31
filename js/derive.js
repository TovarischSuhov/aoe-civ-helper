// js/derive.js — PURE fact derivation from aoe2techtree data.json + strings.json.
// No DOM, no fs, no fetch. Imported by BOTH scripts/build.mjs (Node) and js/updater.js
// (browser) so derivation has a single source of truth.
//
// Data model recap (verified against SiegeEngineers/aoe2techtree):
//   data.civs[<Name>] = { Building:[ids], Tech:[ids], Unit:[ids], help_string_id, name_string_id }
//   data.data.Unit|Tech|Building[id] = { ..., LanguageNameId, HP, Attack, Cost, Speed, ... }
//   strings.json keyed by string-id:
//     - civ name/help  -> direct (e.g. help_string_id 120193)
//     - Unit & Building names -> strings[LanguageNameId + 9000]
//     - Tech names            -> strings[LanguageNameId + 10000]

export const SCHEMA_VERSION = 4;

// Curated reference set: items a "fully teched" generic civ typically has.
// A civ lacking one is a notable tech gap. Names resolved against the name index.
export const REF_UPGRADES = {
  // Reference upgrade LINES + techs for the "Notable tech gaps" section, grouped by the building
  // that produces them. techGaps applies three rules:
  //   1. Building collapse — if the producing building is unavailable (e.g. Meso civs have no
  //      Stable), the whole group collapses to a single "No <Building>" gap (no spam of every
  //      stable unit/tech).
  //   2. Line collapse — within a unit line (base → top) only the FIRST tier a civ is missing is
  //      shown: no Cavalier ⇒ no Paladin, so "No Cavalier" alone.
  //   3. Regional alternative — a regional line substituting for a standard one (e.g. the Andean
  //      Champi line for the Militia line) suppresses that line's gap when the alternative exists.
  groups: [
    // `gate` buildings are the ones civs genuinely vary on (only the Stable — Meso civs lack it);
    // other buildings are universal, so they aren't gated (gating them risks false "No Mill"-style
    // gaps where the data simply omits a universal building for some civ).
    { building: 'Stable', gate: true, techs: ['Bloodlines', 'Husbandry'], lines: [
      { tiers: ['Light Cavalry', 'Hussar'], requires: 'Scout Cavalry', alt: /winged hussar/i },
      { tiers: ['Cavalier', 'Paladin'], requires: 'Knight', alt: /savar/i },
      { tiers: ['Heavy Camel Rider'], requires: 'Camel Rider' },
      { tiers: ['Heavy Cavalry Archer'], requires: 'Cavalry Archer' },
    ] },
    { building: 'Archery Range', techs: ['Thumb Ring', { name: 'Parthian Tactics', ifUnitRe: /cavalry archer/i }], lines: [
      { tiers: ['Crossbowman', 'Arbalester'], requires: 'Archer' },
      { tiers: ['Elite Skirmisher'], requires: 'Skirmisher' },
    ] },
    { building: 'Barracks', techs: ['Supplies', 'Gambesons'], lines: [
      { tiers: ['Long Swordsman', 'Two-Handed Swordsman', 'Champion'], requires: 'Man-at-Arms', alt: /champi|legionary/i },
      { tiers: ['Pikeman', 'Halberdier'], requires: 'Spearman' },
    ] },
    { building: 'Siege Workshop', techs: ['Siege Engineers'], lines: [
      { tiers: ['Battering Ram', 'Siege Ram'], alt: /armored elephant/i },
      { tiers: ['Mangonel', 'Onager'], alt: /rocket cart/i },
      { tiers: ['Scorpion', 'Heavy Scorpion'], alt: /war chariot/i },
      ['Bombard Cannon'], ['Petard'],
    ] },
    { building: 'Dock', techs: ['Careening', 'Dry Dock', 'Shipwright'], lines: [
      ['War Galley', 'Galleon'], ['Fire Galley', 'Fast Fire Ship'],
    ] },
    { building: 'Blacksmith', techs: [], lines: [
      { tiers: ['Forging', 'Iron Casting', 'Blast Furnace'], cat: 'Tech' },
      { tiers: ['Fletching', 'Bodkin Arrow', 'Bracer'], cat: 'Tech' },
      { tiers: ['Scale Mail Armor', 'Chain Mail Armor', 'Plate Mail Armor'], cat: 'Tech' },
      { tiers: ['Padded Archer Armor', 'Leather Archer Armor', 'Ring Archer Armor'], cat: 'Tech' },
      // Cavalry armor (barding) only matters if the civ can train cavalry (has a Stable).
      { tiers: ['Scale Barding Armor', 'Chain Barding Armor', 'Plate Barding Armor'], cat: 'Tech', requiresBuilding: 'Stable' },
    ] },
    { building: 'University', techs: ['Chemistry', 'Heated Shot', 'Bombard Tower'], lines: [
      // Tower upgrades are a LINE (Watch Tower → Guard Tower → Keep): only the first missing tier is
      // a gap (no Guard Tower ⇒ no Keep reported). Sicilians skip it — their Donjon replaces towers.
      { tiers: ['Guard Tower', 'Keep'], cat: 'Tech', alt: /donjon/i },
    ] },
    { building: 'Monastery', techs: ['Redemption', 'Heresy', 'Illumination', 'Theocracy'], lines: [] },
    { building: 'Mill', techs: ['Crop Rotation'], lines: [] },
  ],
};

export function cleanText(s) {
  if (typeof s !== 'string') return s == null ? '' : String(s);
  return s
    .replace(/<br\s*\/?>\n?/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// Resolve an item's English display name. Try direct id first (safest for the handful
// of direct-keyed items), then the category offset, then the other offset.
export function resolveName(cat, id, data, strings) {
  const item = data.data[cat] && (data.data[cat][String(id)] || data.data[cat][id]);
  if (!item || item.LanguageNameId == null) return null;
  const lid = item.LanguageNameId;
  const primary = cat === 'Tech' ? 10000 : 9000;
  const other = cat === 'Tech' ? 9000 : 10000;
  for (const off of [0, primary, other]) {
    const v = strings[String(lid + off)];
    if (v) return cleanText(v);
  }
  return null;
}

export function title(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Build { Unit:{name->id}, Tech:{...}, Building:{...} } lowercased-name indexes.
export function buildNameIndex(data, strings) {
  const idx = { Unit: {}, Tech: {}, Building: {} };
  for (const cat of Object.keys(idx)) {
    const pool = data.data[cat] || {};
    for (const id of Object.keys(pool)) {
      const name = resolveName(cat, id, data, strings);
      if (!name) continue;
      // Strip soft line-break hyphens ("Circum- navigation" → "Circumnavigation") so help-string
      // names resolve; real hyphenated names ("Man-at-Arms") have no space after the hyphen.
      const key = name.replace(/-\s+/g, '').toLowerCase();
      if (!idx[cat][key]) idx[cat][key] = String(id);
    }
  }
  return idx;
}

export function parseCivHelp(help) {
  const out = { armyType: '', bonuses: [], uniqueUnits: [], uniqueTechs: [], teamBonus: '' };
  let t = cleanText(help);

  // Team Bonus is always the trailing section.
  const tb = t.search(/Team Bonus:\s*/i);
  if (tb >= 0) {
    out.teamBonus = t.slice(tb).replace(/Team Bonus:\s*/i, '').trim();
    t = t.slice(0, tb);
  }
  // Unique Techs: bullet list before team bonus.
  const ut = t.search(/Unique Techs?:\s*/i);
  if (ut >= 0) {
    const txt = t.slice(ut).replace(/Unique Techs?:\s*/i, '');
    t = t.slice(0, ut);
    out.uniqueTechs = txt.split('•').map((s) => s.trim()).filter(Boolean);
  }
  // Unique Unit(s): comma-separated list (each may carry a "(Role)" annotation).
  const uu = t.search(/Unique Units?:\s*/i);
  if (uu >= 0) {
    const txt = t.slice(uu).replace(/Unique Units?:\s*/i, '');
    t = t.slice(0, uu);
    out.uniqueUnits = txt.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  }
  // Remaining head = armyType + bonuses separated by '•'.
  const parts = t.split('•').map((s) => s.trim()).filter(Boolean);
  out.armyType = parts.shift() || '';
  out.bonuses = parts;
  return out;
}

function normalizeCost(cost) {
  if (!cost || typeof cost !== 'object') return null;
  const out = {};
  for (const k of ['Food', 'Wood', 'Gold', 'Stone']) {
    if (cost[k] != null) out[k.toLowerCase()] = Number(cost[k]);
  }
  return Object.keys(out).length ? out : null;
}

// Stats for the civ's unique units (and their elite upgrade when available).
export function keyUnits(civName, data, strings, nameIndex, pictureIndex = {}) {
  const civ = data.civs[civName];
  const enabledUnits = new Set((civ.Unit || []).map(String));
  const help = parseCivHelp(strings[String(civ.help_string_id)]);
  // Research cost to reach each tier, keyed by the upgraded unit's id (data.unit_upgrades) — the
  // same source build-regional.mjs uses for regional-unit lines.
  const researchCostById = {};
  for (const [k, v] of Object.entries(data.data.unit_upgrades || {})) {
    if (v) researchCostById[String(k)] = v.Cost || null;
  }
  const result = [];
  for (const uu of help.uniqueUnits) {
    const baseName = uu.replace(/\s*\([^)]*\)\s*$/, '').trim(); // drop "(Role)"
    const role = (uu.match(/\(([^)]*)\)/) || [])[1] || '';
    let id = nameIndex.Unit[baseName.toLowerCase()];
    let hasElite = !!nameIndex.Unit['elite ' + baseName.toLowerCase()];
    // Dual-mode / variant units (e.g. Ratha stored as "Ratha (Melee)"/"(Ranged)"): prefix match.
    if (!id) {
      const prefix = baseName.toLowerCase();
      const cands = Object.keys(nameIndex.Unit).filter((k) => k.startsWith(prefix));
      const base = cands.find((k) => !k.startsWith('elite '));
      id = base ? nameIndex.Unit[base] : (cands[0] && nameIndex.Unit[cands[0]]);
      hasElite = cands.some((k) => k.startsWith('elite ') && enabledUnits.has(nameIndex.Unit[k]));
    } else {
      hasElite = hasElite && enabledUnits.has(nameIndex.Unit['elite ' + baseName.toLowerCase()]);
    }
    const u = id && data.data.Unit[id];
    if (!u) continue;
    // Build the upgrade line as ordered tiers: base (train cost) + Elite (research cost) if present.
    // Regional units use the same tiers shape (built in build-regional.mjs) and may have >2 tiers.
    const tiers = [{
      name: baseName,
      pic: (pictureIndex.unit && pictureIndex.unit[id]) || null,
      hp: Number(u.HP) || null,
      attack: Number(u.Attack) || null,
      range: u.Range != null ? Number(u.Range) : null,
      speed: u.Speed != null ? Number(u.Speed) : null,
      cost: normalizeCost(u.Cost),
    }];
    if (hasElite) {
      const eId = nameIndex.Unit['elite ' + baseName.toLowerCase()]
        || (Object.keys(nameIndex.Unit).find((k) => k.startsWith('elite ' + baseName.toLowerCase())));
      const e = eId && data.data.Unit[eId];
      if (e) tiers.push({
        name: 'Elite ' + baseName,
        pic: (eId && pictureIndex.unit && pictureIndex.unit[eId]) || null,
        hp: Number(e.HP) || null,
        attack: Number(e.Attack) || null,
        range: e.Range != null ? Number(e.Range) : null,
        speed: e.Speed != null ? Number(e.Speed) : null,
        cost: normalizeCost(researchCostById[String(eId)]),
      });
    }
    result.push({ id, name: baseName, role, elite: !!hasElite, tiers });
  }
  return result;
}

export function techGaps(civName, data, nameIndex, pictureIndex = {}) {
  const civ = data.civs[civName];
  // Category-specific sets: item ids are NOT globally unique (e.g. the Stable building and a tech
  // can both be id 101), so a building check must only consult civ.Building, a unit check civ.Unit.
  const has = {
    Unit: new Set((civ.Unit || []).map(String)),
    Tech: new Set((civ.Tech || []).map(String)),
    Building: new Set((civ.Building || []).map(String)),
  };
  const gaps = [];
  // Each gap carries category + id + pic. `pic` is the aoe2techtree picture_index (the real
  // icon filename — the data id does NOT reliably match it); render uses pic, falling back to id.
  const picOf = (cat, id) => {
    const m = pictureIndex[cat.toLowerCase()];
    return m && m[id] != null ? m[id] : null;   // `!= null`: picture_index 0 is valid (Crop Rotation)
  };
  const idOf = (cat, name) => nameIndex[cat] && nameIndex[cat][name.toLowerCase()];
  const hasUnitName = (name) => { const id = idOf('Unit', name); return !!(id && has.Unit.has(String(id))); };
  const hasBuilding = (name) => { const id = idOf('Building', name); return !!(id && has.Building.has(String(id))); };
  // Does the civ train any unit whose name matches (e.g. a regional "Champi" alternative)?
  const hasUnitLike = (re) => Object.keys(nameIndex.Unit || {}).some(
    (n) => re.test(n) && has.Unit.has(String(nameIndex.Unit[n])));
  // Regional/unique alternative present — checks BOTH units and buildings (the Donjon is a building).
  const hasAnyLike = (re) =>
    Object.keys(nameIndex.Unit || {}).some((n) => re.test(n) && has.Unit.has(String(nameIndex.Unit[n]))) ||
    Object.keys(nameIndex.Building || {}).some((n) => re.test(n) && has.Building.has(String(nameIndex.Building[n])));

  for (const g of REF_UPGRADES.groups) {
    const bId = idOf('Building', g.building);
    if (g.gate && bId && !has.Building.has(String(bId))) {
      // Rule 1 — producing building unavailable: one "No <Building>" gap, suppress the group.
      gaps.push({ label: 'No ' + g.building, name: g.building, cat: 'Building', id: bId, pic: picOf('Building', bId) });
      continue;
    }
    for (const line of g.lines) {
      const tiers = Array.isArray(line) ? line : line.tiers;
      const cat = (!Array.isArray(line) && line.cat) || 'Unit';
      // Rule 3 — a regional/unique alternative exists for this whole line: suppress its gap entirely
      // (Savar↔Paladin, Winged Hussar↔Hussar, Legionary/Champi↔militia top, Rocket Cart↔Onager,
      // Armored Elephant↔Siege Ram, War Chariot↔Heavy Scorpion, Donjon↔tower line).
      if (!Array.isArray(line) && line.alt && hasAnyLike(line.alt)) continue;
      // Optional line: only a gap if the civ has the line's base unit (camel / cavalry-archer) or,
      // for tech lines like cavalry barding armor, the producing building (Stable).
      if (!Array.isArray(line) && line.requires && !hasUnitName(line.requires)) continue;
      if (!Array.isArray(line) && line.requiresBuilding && !hasBuilding(line.requiresBuilding)) continue;
      for (const name of tiers) {           // Rule 2 — base → top: first missing tier wins
        const id = idOf(cat, name);
        if (id && !has[cat].has(String(id))) {
          gaps.push({ label: 'No ' + name, name, cat, id, pic: picOf(cat, id) });
          break;
        }
      }
    }
    for (const t of g.techs) {
      const name = typeof t === 'string' ? t : t.name;
      // Conditional tech (e.g. Parthian Tactics) is only a gap if the civ has a unit it applies to.
      if (typeof t === 'object' && t.ifUnitRe && !hasUnitLike(t.ifUnitRe)) continue;
      const id = idOf('Tech', name);
      if (id && !has.Tech.has(String(id))) gaps.push({ label: 'No ' + name, name, cat: 'Tech', id, pic: picOf('Tech', id) });
    }
  }
  return gaps;
}

// Resolve each unique-tech help string ("Sipahi (Mounted Archers +20 HP)") to its
// Castle/Imperial tech cost (+ icon picture_index) via the name index.
export function uniqueTechDetails(uniqueTechStrings, data, nameIndex, pictureIndex = {}) {
  return (uniqueTechStrings || []).map((raw) => {
    const display = raw;
    // Drop the trailing "(effect …)" — strip from the FIRST "(" so nested parens in the effect
    // text (e.g. "Fereters (Infantry (except Spearman-line) +30 HP; …)") are handled.
    const baseName = raw.replace(/\s*\(.*$/, '').trim();
    const id = baseName && nameIndex.Tech[baseName.toLowerCase()];
    const tech = id && data.data.Tech && (data.data.Tech[id] || data.data.Tech[String(id)]);
    const cost = tech && tech.Cost ? normalizeCost(tech.Cost) : null;
    const pic = id && pictureIndex.tech && pictureIndex.tech[id] != null ? pictureIndex.tech[id] : null;
    return { display, name: baseName, cost, pic };
  });
}

// Honest keyword heuristic over bonus text. Real timings live in curated strategy.timings.
export function genericTimings(civName, data, strings) {
  const civ = data.civs[civName];
  const help = cleanText(strings[String(civ.help_string_id)] || '').toLowerCase();
  const ecoWords = ['gather', 'work', 'faster', 'carry', 'drop-off', 'wood', 'gold', 'food', 'stone', 'farm'];
  const hasEco = ecoWords.some((w) => help.includes(w));
  const hasAgeBonus = /cheaper|costs? -|free|starting in/.test(help) && /(dark|feudal|castle|imperial|age|advance)/.test(help);
  const note = [
    hasEco ? 'Economy bonuses present — can hit up-times faster than baseline' : 'No notable economy bonus — standard up-times',
    hasAgeBonus ? 'age/upgrade discount speeds key transitions' : '',
  ].filter(Boolean).join('; ');
  return {
    feudal: '~10:30',
    castle: '~15:30',
    imperial: '~27:00',
    heuristic: true,
    note: note + '.',
  };
}

// Data-driven analysis: strengths / weaknesses / best practices for EVERY civ.
// Grounded in the civ's actual bonus text + tech gaps + key upgrades — no guessing.
// Each bonus is consumed by at most one theme (priority order), and quoted so every line is
// verifiable against the civ's real bonuses.
const THEME_DETECTORS = [
  { key: 'monks', label: 'Monks', re: /(monk|monastery|relic|convert|faith|theocracy|heresy|redemption|sanctity|illumination)/i,
    practice: 'Use Monks to convert high-value units and collect relics.' },
  { key: 'navy', label: 'Navy / water', re: /(ship|dock|galley|fire ship|demolition|naval|dromon|cannon galleon|fishing|fleet|warship)/i,
    practice: 'On water maps, press your naval advantage early.' },
  { key: 'gunpowder', label: 'Gunpowder', re: /(gunpowder|hand cannon|janissary|conquistador)/i,
    practice: 'Transition into Hand Cannoneers / Bombard Cannons in Imperial.' },
  { key: 'siege', label: 'Siege', re: /(siege|scorpion|mangonel|\bram\b|onager|trebuchet|siege workshop|ballista)/i,
    practice: 'Anchor the army with siege — scorpions, rams or onager per your tree.' },
  { key: 'cavArcher', label: 'Cavalry archers', re: /(cavalry[- ]?archer|mounted archer|horse archer|genitour|mangudai|parthian tactics)/i,
    practice: 'Use Cavalry Archers / your mounted unique archer for mobile, raid-friendly ranged damage — they also benefit from archer upgrades (Thumb Ring/Bracer/armor) AND from mounted upgrades (Bloodlines/Husbandry).' },
  { key: 'cavalry', label: 'Cavalry', re: /(cavalry|mounted|knight|stable|light cavalry|scout cavalry|cataphract|mameluke|husbandry|lancer)/i,
    practice: 'Win with mobility — raid and pick fights with your cavalry.' },
  { key: 'archer', label: 'Archers (foot)', re: /(?<!cavalry )(?<!mounted )(?<!horse )\barcher|crossbow|arbalest|skirmisher|archery/i,
    practice: 'Mass foot archers (Archer → Crossbow → Arbalester) with range/armor upgrades; add Elite Skirmishers if you have them. Note: generic archer bonuses also apply to your Cavalry Archers if you field them.' },
  { key: 'infantry', label: 'Infantry', re: /(infantry|militia|spearman|man.at.arms|champion|barracks|squires|gambesons)/i,
    practice: 'Commit to infantry with blacksmith upgrades; lean on your unique infantry.' },
  { key: 'defense', label: 'Defenses', re: /(tower|wall|fortified|castle cost|town center|\bkeep\b|\bgate\b|buildings?.*(hp|cost|stronger|armor|fire))/i,
    practice: 'Use stronger buildings/towers to control the map and secure a boom.' },
  { key: 'eco', label: 'Economy', re: /(gather|work|mine|farm|forag|hunt|shepherd|fisher|woodcutt|lumberjack|carry|drop.?off|mill technolo|gold miner|stone miner|resources? last|booming|population|cost(?:s|ing)?\s*[-–−]|cheaper|\bfree\b)/i,
    practice: 'Use your economy bonus for faster up-times or a bigger boom.' },
];

// Ordered by importance — only the most consequential gaps are surfaced as weaknesses.
const GAP_WEAKNESS = [
  ['no elite skirmisher', 'Weak anti-archer (no Elite Skirmisher)'],
  ['no arbalester', 'Foot archer line capped (no Arbalester)'],
  ['no heavy cavalry archer', 'Cavalry Archer line capped (no Heavy Cavalry Archer)'],
  ['no halberdier', 'Anti-cavalry capped (no Halberdier)'],
  ['no paladin', 'No Paladin (heavy cavalry capped at Cavalier)'],
  ['no cavalier', 'No Cavalier (weak heavy cavalry)'],
  ['no hussar', 'No Hussar (light-cavalry line capped)'],
  ['no ring archer armor', 'No Ring Archer Armor (archer armor capped)'],
  ['no bracer', 'No Bracer (range capped at Bodkin Arrow)'],
  ['no parthian tactics', 'No Parthian Tactics (Cavalry Archer armor capped)'],
  ['no bloodlines', 'No Bloodlines (cavalry HP capped)'],
  ['no gambesons', 'No Gambesons (militia line)'],
  ['no onager', 'No Onager (siege capped at Mangonel)'],
  ['no heavy scorpion', 'No Heavy Scorpion'],
  ['no bombard cannon', 'No Bombard Cannon (no long-range siege)'],
  ['no siege engineers', 'No Siege Engineers'],
  ['no redemption', 'No Redemption (Monks can’t convert siege)'],
  ['no heresy', 'No Heresy (units can be converted)'],
  ['no illumination', 'No Illumination (slower Monk production)'],
  ['no crop rotation', 'No Crop Rotation (weaker late farming)'],
  ['no heated shot', 'No Heated Shot (weak anti-ship from land)'],
];

const GAP_PRACTICE = [
  ['no elite skirmisher', 'Vs massed archers, bring your own archers or siege — you lack Elite Skirmishers.'],
  ['no heavy cavalry archer', 'If leaning on Cavalry Archers, pivot to foot archers in Imperial (no Heavy Cav Archer).'],
  ['no bombard cannon', 'Break buildings with Trebuchets or the Mangonel line (no Bombard Cannon).'],
  ['no halberdier', 'Vs heavy cavalry, lean on Pikemen/camels/Monks — no Halberdier.'],
  ['no paladin', 'Don’t over-invest past Cavalier; pivot to your civ’s real strengths.'],
  ['no onager', 'Handle massed units with Scorpions or mobility (no Onager).'],
  ['no redemption', 'Guard your siege manually — your Monks can’t convert enemy siege.'],
];

export function deriveAnalysis(parsed, facts) {
  const bonuses = parsed.bonuses || [];
  const army = (parsed.armyType || '');
  const gaps = (facts.techGaps || []).map((g) => (typeof g === 'string' ? g : g.label).toLowerCase());
  const used = new Set();

  // Strengths: one per detected theme; each bonus consumed at most once (priority order).
  const strengths = [];
  for (const t of THEME_DETECTORS) {
    let snippet = null;
    for (let i = 0; i < bonuses.length; i++) {
      if (used.has(i)) continue;
      if (t.re.test(bonuses[i].toLowerCase())) { snippet = bonuses[i]; used.add(i); break; }
    }
    if (!snippet && t.re.test(army.toLowerCase())) snippet = army;
    if (snippet) strengths.push(`${t.label}: “${String(snippet).slice(0, 90)}”`);
  }
  // Structural strengths from upgrade presence.
  // Knight line: surface it for ANY civ with Cavaliers (not just Paladin), so non-Paladin
  // knight civs (Cumans, Tatars, Byzantines…) still show their heavy-cavalry line.
  if (!gaps.includes('no cavalier')) {
    strengths.push(!gaps.includes('no paladin')
      ? 'Full heavy-cavalry line (Knight → Cavalier → Paladin).'
      : 'Heavy-cavalry line available (Knight → Cavalier).');
  }
  if (!gaps.includes('no bombard cannon') && !gaps.includes('no siege engineers')) {
    strengths.push('Bombard Cannon + Siege Engineers (strong gunpowder siege).');
  }
  if (!strengths.length) strengths.push(`${army || 'Specialist'} civilization — review the bonuses above.`);

  // Weaknesses: map present gaps, most important first, capped.
  const weaknesses = [];
  for (const [gap, line] of GAP_WEAKNESS) {
    if (gaps.includes(gap)) weaknesses.push(line);
    if (weaknesses.length >= 6) break;
  }
  if (!weaknesses.length) weaknesses.push('Few notable tech gaps — broad, flexible tech tree.');

  // Best practices: theme actions + gap mitigations + a closing principle (capped at 6).
  const bestPractices = [];
  for (const t of THEME_DETECTORS) {
    const hasTheme = bonuses.some((b) => t.re.test(b.toLowerCase())) || t.re.test(army.toLowerCase());
    if (hasTheme) bestPractices.push(t.practice);
  }
  for (const [gap, line] of GAP_PRACTICE) if (gaps.includes(gap)) bestPractices.push(line);
  bestPractices.push('Play to your unique units and match your composition to the opponent.');
  const practices = bestPractices.slice(0, 6);

  return { strengths: strengths.slice(0, 6), weaknesses, bestPractices: practices };
}

// Per-civ economy notes: surface this civ's economy-relevant bonuses and how to leverage them.
// Ties each civilization back to the general Economy Guide.
const ECO_DETECTORS = [
  // Cost discounts (cheaper buildings / techs / age-ups / units, or free ones) are ECONOMY
  // bonuses — they free resources. Placed FIRST so e.g. "Archery Ranges and Stables cost -75 wood"
  // is tagged here, not mis-tagged as wood-gathering by the 'Wood' detector below.
  { cat: 'Cost discounts', re: /(cost(?:s|ing)?\s*[-–−]|cost\s+no\s+(wood|food|gold|stone)|cheaper|\bfree\b|-\s*\d+\s*(wood|food|gold|stone)|-\s*\d+%\s*(wood|food|gold|stone))/i,
    tip: 'Your cost-discount bonus makes buildings, technologies or age-ups cheaper — the saved wood/food/gold is an economy advantage; reinvest it into more villagers or army.' },
  { cat: 'Villager efficiency', re: /(wheelbarrow|hand cart|mule cart|\bcarry|drop.?off|economic|villagers? (work|move|gather|build))/i,
    tip: 'Your villager-efficiency bonus smooths gathering and up-times — keep drop-off buildings tight to their resource and villager flow constant.' },
  { cat: 'Food / hunting', re: /(sheep|boar|deer|hunt|shepherd|forag|live ?stock|livestock|herdabl|fish|shore fish|berries)/i,
    tip: 'Your food/hunting bonus speeds the Dark/Feudal up-time — lure both boar and use the deer.' },
  { cat: 'Farming', re: /(farm|mill technolo|crop rotation|horse collar|heavy plow)/i,
    tip: 'Your farm bonus sustains more food — keep farms seeded around a TC/Mill and grab the Mill upgrades.' },
  { cat: 'Wood', re: /(wood|lumber|tree|forest|woodcutt)/i,
    tip: 'Your wood bonus funds faster buildings, farms and siege — keep a Lumber Camp flush to the forest and lean into wood-heavy comps.' },
  { cat: 'Gold', re: /(gold (miner|mining|gather|extra|faster|longer)|\bgold miners?\b|\bgold mining\b|relics? \+)/i,
    tip: 'Your gold bonus funds faster gold units and age-ups — press the timing it unlocks.' },
  { cat: 'Stone', re: /(stone (miner|mining|extra|faster)|\bstone miners?\b|\bstone mining\b)/i,
    tip: 'Your stone bonus supports extra Castles/Town Centers — wall up or boom behind it.' },
  { cat: 'Age / boom', re: /(town center|cheaper .*age|age costs|villager|population|advance)/i,
    tip: 'Your age/villager bonus enables faster or cheaper transitions — use it to out-boom or out-time.' },
];

export function deriveEconomy(parsed) {
  const bonuses = parsed.bonuses || [];
  const used = new Set();
  const highlights = [];
  const tips = [];
  for (const d of ECO_DETECTORS) {
    for (let i = 0; i < bonuses.length; i++) {
      if (used.has(i)) continue;
      if (d.re.test(bonuses[i].toLowerCase())) {
        highlights.push({ category: d.cat, bonus: bonuses[i] });
        tips.push(d.tip);
        used.add(i);
        break;
      }
    }
  }
  const tip = tips.length
    ? tips.join(' ')
    : 'Standard economy — follow the general guide; no special economy bonus to leverage.';
  return { highlights, tip };
}

// --- Civ-vs-civ matchups (heuristic) ---
// Classify a civ's primary composition from army type + bonus text.
const COMP_DETECTORS = [
  { key: 'cavArcher', re: /(cavalry[- ]?archer|mounted archer|genitour|mangudai|parthian tactics)/i },
  { key: 'cavalry', re: /(cavalry|knight|cataphract|mameluke|war elephant|battle elephant|keshik|stable|lancer)/i },
  { key: 'archer', re: /(?<!cavalry )(?<!mounted )(?<!horse )\barcher|crossbow|arbalest|skirmisher|archery/i },
  { key: 'infantry', re: /(infantry|militia|spearman|man.at.arms|champion|huscarl|samurai|barracks)/i },
  { key: 'gunpowder', re: /(gunpowder|hand cannon|janissary|conquistador|bombard)/i },
  { key: 'siege', re: /(siege|scorpion|mangonel|onager|trebuchet)/i },
  { key: 'monks', re: /(monk|monastery|relic|convert)/i },
  { key: 'navy', re: /(ship|dock|galley|naval|dromon|warship|longboat)/i },
];
function composition(parsed) {
  const text = ((parsed.armyType || '') + ' ' + (parsed.bonuses || []).join(' ')).toLowerCase();
  for (const d of COMP_DETECTORS) if (d.re.test(text)) return d.key;
  return 'eco';
}
const hasNot = (gapSet, name) => !gapSet.has('no ' + name);

// For each civ, up to 5 strong-against and 5 weak-against with a short reason, derived from
// army composition (counter lines) and tech gaps (e.g. no Elite Skirmisher / Halberdier).
export function deriveMatchups(profiles) {
  const out = {};
  for (const m of profiles) {
    const strong = [], weak = [];
    const seenS = new Set(), seenW = new Set();
    const archerM = m.primary === 'archer' || m.primary === 'cavArcher';
    for (const o of profiles) {
      if (o.slug === m.slug) continue;
      const archerO = o.primary === 'archer' || o.primary === 'cavArcher';
      const sWhy = archerO && m.hasEliteSkirmisher ? 'their archers fall to your Elite Skirmishers'
        : archerO && m.hasOnager ? 'your Onagers flatten their archer mass'
        : o.primary === 'cavalry' && m.hasHalberdier ? 'their cavalry dies to your Halberdiers'
        : o.primary === 'cavalry' && m.primary === 'monks' ? 'your Monks convert their expensive cavalry'
        : o.primary === 'infantry' && archerM ? 'your archers kite their infantry'
        : o.primary === 'infantry' && m.hasOnager ? 'your Onagers shred their infantry'
        : !o.hasEliteSkirmisher && archerM ? 'they lack Elite Skirmishers for your archers'
        : !o.hasHalberdier && m.primary === 'cavalry' ? 'they lack Halberdiers for your cavalry'
        : null;
      if (sWhy && !seenS.has(o.slug)) { strong.push({ slug: o.slug, name: o.name, internalName: o.internalName, why: sWhy }); seenS.add(o.slug); }
      const wWhy = archerM && o.hasEliteSkirmisher ? 'their Elite Skirmishers counter your archers'
        : archerM && o.hasOnager ? 'their Onagers wreck your archer mass'
        : m.primary === 'cavalry' && o.hasHalberdier ? 'their Halberdiers counter your cavalry'
        : m.primary === 'infantry' && archerO ? 'their archers kite your infantry'
        : m.primary === 'infantry' && o.hasOnager ? 'their Onagers shred your infantry'
        : !m.hasEliteSkirmisher && archerO ? 'you have no Elite Skirmishers vs their archers'
        : !m.hasHalberdier && o.primary === 'cavalry' ? 'you have no Halberdier vs their cavalry'
        : null;
      if (wWhy && !seenW.has(o.slug)) { weak.push({ slug: o.slug, name: o.name, internalName: o.internalName, why: wWhy }); seenW.add(o.slug); }
    }
    // Dedupe: an opponent must not be both strong- and weak-against (prefer strong).
    const weakOnly = weak.filter((w) => !strong.some((s) => s.slug === w.slug));
    out[m.slug] = { strongAgainst: strong.slice(0, 5), weakAgainst: weakOnly.slice(0, 5) };
  }
  return out;
}

// Map-type affinity + per-map strong/weak civs (open / closed / hybrid / water), heuristic from
// composition, bonuses and tech gaps. aoestats.io is the reference for live win rates.
const MAP_TYPES = ['open', 'closed', 'hybrid', 'water'];
function mapScore(p) {
  const navy = /ship|dock|galley|naval|dromon|warship|longboat|fisher|fish trap|fishing/.test(p.bonusText);
  const defense = /tower|wall|fortified|castle cost|town center|\bkeep\b|defen[sc]/.test(p.bonusText);
  const eco = /gather|work|farm|wood|gold|stone|carry|drop.?off|villager|cheaper|boom/.test(p.bonusText);
  const mobility = p.primary === 'cavalry' || p.primary === 'cavArcher';
  const archer = p.primary === 'archer';
  return {
    open: 2 + (mobility ? 3 : 0) + (archer ? 2 : 0) + (p.hasEliteSkirmisher ? 1 : 0) + (eco ? 1 : 0),
    closed: 2 + (defense ? 3 : 0) + (p.primary === 'gunpowder' ? 2 : 0) + (p.primary === 'monks' ? 2 : 0) + (eco ? 1 : 0) + (p.hasOnager ? 1 : 0),
    hybrid: 2 + (eco ? 2 : 0) + (archer ? 1 : 0) + (mobility ? 1 : 0) + (navy ? 2 : 0),
    water: 1 + (navy ? 5 : 0) + (eco ? 2 : 0) + (p.hasGalleon ? 1 : 0) + (p.hasFastFire ? 1 : 0),
  };
}
export function deriveMaps(profiles) {
  const scores = {};
  profiles.forEach((p) => { scores[p.slug] = mapScore(p); });
  const byMap = {};
  for (const t of MAP_TYPES) {
    const sorted = [...profiles].sort((a, b) => scores[b.slug][t] - scores[a.slug][t]);
    byMap[t] = { strong: sorted.slice(0, 5).map((p) => p.name), weak: sorted.slice(-5).map((p) => p.name) };
  }
  const out = {};
  for (const p of profiles) {
    const affinity = {};
    for (const t of MAP_TYPES) {
      const v = scores[p.slug][t];
      const below = profiles.filter((q) => scores[q.slug][t] < v).length;
      const pct = below / (profiles.length - 1);
      affinity[t] = pct >= 0.66 ? 'Strong' : pct <= 0.34 ? 'Weak' : 'OK';
    }
    out[p.slug] = { affinity, byMap };
  }
  return out;
}

// Main entry: returns { meta, civFacts }. Hash/version added by the caller.
export function deriveAll(data, strings, pictureIndex = {}) {
  const nameIndex = buildNameIndex(data, strings);
  const civOrder = [];
  const civFacts = {};
  const profiles = [];
  for (const internalName of Object.keys(data.civs)) {
    const civ = data.civs[internalName];
    const rawName = strings[String(civ.name_string_id)] || internalName;
    const display = rawName.charAt(0).toUpperCase() + rawName.slice(1);
    const slug = String(rawName).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const parsed = parseCivHelp(strings[String(civ.help_string_id)] || '');
    const gaps = techGaps(internalName, data, nameIndex, pictureIndex);
    civFacts[slug] = {
      id: display,
      slug,
      internalName,
      facts: {
        armyType: parsed.armyType,
        bonuses: parsed.bonuses,
        teamBonus: parsed.teamBonus,
        uniqueUnits: parsed.uniqueUnits,
        uniqueTechs: uniqueTechDetails(parsed.uniqueTechs, data, nameIndex, pictureIndex),
        keyUnits: keyUnits(internalName, data, strings, nameIndex, pictureIndex),
        techGaps: gaps,
        genericTimings: genericTimings(internalName, data, strings),
      },
    };
    const gapSet = new Set(gaps.map((g) => g.label.toLowerCase()));
    profiles.push({
      slug, name: display, internalName,
      bonusText: ((parsed.armyType || '') + ' ' + (parsed.bonuses || []).join(' ')).toLowerCase(),
      primary: composition(parsed),
      hasEliteSkirmisher: hasNot(gapSet, 'elite skirmisher'),
      hasHalberdier: hasNot(gapSet, 'halberdier'),
      hasOnager: hasNot(gapSet, 'onager'),
      hasGalleon: hasNot(gapSet, 'galleon'),
      hasFastFire: hasNot(gapSet, 'fast fire ship'),
    });
    civOrder.push({ name: display, slug, internalName, armyType: parsed.armyType });
  }
  civOrder.sort((a, b) => a.name.localeCompare(b.name));
  const matchups = deriveMatchups(profiles);
  const maps = deriveMaps(profiles);
  for (const slug of Object.keys(civFacts)) {
    civFacts[slug].facts.matchups = matchups[slug] || { strongAgainst: [], weakAgainst: [] };
    civFacts[slug].facts.maps = maps[slug] || { affinity: {}, byMap: {} };
  }
  return {
    meta: { schemaVersion: SCHEMA_VERSION, civOrder, refUpgrades: REF_UPGRADES, pictureIndex },
    civFacts,
  };
}
