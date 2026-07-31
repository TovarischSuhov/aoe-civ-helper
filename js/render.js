// js/render.js — pure DOM rendering for the grid + detail views.

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v;
    else if (k === 'html') e.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
    else if (v != null) e.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

function iconUrl(internalName) {
  return `img/Civs/${internalName.toLowerCase()}.png`;
}

// Win-rate lookups against the cached aoestats data (served from localStorage).
function aoestatsCivs() {
  try { return JSON.parse(localStorage.getItem('aoe_data:aoestats') || 'null')?.civs || null; } catch { return null; }
}
function civOrderCached() {
  try { return JSON.parse(localStorage.getItem('aoe_meta') || 'null')?.civOrder || []; } catch { return []; }
}
// Resolve a civ slug → win rate. Matches by slug, then by the civ's internal name
// (so "inca"→Incas and "maya"→Mayans resolve to their aoestats rows).
function wrForSlug(slug) {
  const civs = aoestatsCivs(); if (!civs) return null;
  if (civs[slug] && civs[slug].winRate != null) return civs[slug].winRate;
  const c = civOrderCached().find((x) => x.slug === slug);
  const k = (c?.internalName || '').toLowerCase();
  if (civs[k] && civs[k].winRate != null) return civs[k].winRate;
  return null;
}
function wrForName(name) {
  const c = civOrderCached().find((x) => x.name === name);
  return c ? wrForSlug(c.slug) : null;
}
// Comma list of civ names each annotated with its overall win rate (for the maps section).
function civListWithWr(names) {
  if (!names || !names.length) return '—';
  return names.map((n) => { const wr = wrForName(n); return wr != null ? `${n} ${wr.toFixed(0)}%` : n; }).join(', ');
}
function wrClass(wr) { return wr >= 51.5 ? 'good' : wr < 48.5 ? 'bad' : 'ok'; }

// Known recommendation sources -> their public page. Rendered as a clickable chip
// so a "kiritastrich" tag links back to the source channel it was translated from.
const SOURCE_URLS = {
  kiritastrich: 'https://t.me/s/kiritastrich',
  aoe2database: 'https://aoe2database.com/',
};
function sourceTag(source, url) {
  const label = source || 'curated';
  const href = url || SOURCE_URLS[label.toLowerCase()];
  if (href) {
    return el('a', { class: 'tag src', href, target: '_blank', rel: 'noopener', title: `Open source: ${label}` }, label);
  }
  return el('span', { class: 'tag src' }, label);
}

export function renderHeader(meta, { onRefresh, onEconomy, onBuilds, onHome, onAbout, onTips } = {}) {
  const sub = el('div', { class: 'subtitle' },
    meta?.generatedAt ? `data updated ${new Date(meta.generatedAt).toLocaleDateString()}` : 'offline-ready civilization companion');
  return el('header', { class: 'app-header' },
    el('div', { class: 'header-left' },
      el('button', { class: 'brand', onclick: onHome, title: 'Back to all civilizations' }, 'AoE II Civ Guide'),
      sub),
    el('div', { class: 'header-right' },
      el('button', { class: 'ghost-btn', onclick: onBuilds }, '📋 Builds'),
      el('button', { class: 'ghost-btn', onclick: onEconomy }, '📖 Economy'),
      el('button', { class: 'ghost-btn', onclick: onTips }, '💡 Tips'),
      el('button', { class: 'ghost-btn', onclick: onAbout }, 'ℹ️ About'),
      el('button', { class: 'refresh-btn', onclick: onRefresh }, '↻ Refresh'),
    ),
  );
}

// Bundle/version info rendered into the page footer (kept out of the header).
export function paintFooter(meta) {
  const node = document.getElementById('footer-meta');
  if (!node) return;
  const parts = [];
  if (meta?.generatedAt) parts.push(`Built ${meta.generatedAt}`);
  if (meta?.hash) parts.push(`data hash ${meta.hash}`);
  if (meta?.updateLabel) parts.push(`aoe2techtree update ${meta.updateLabel}`);
  node.textContent = parts.join(' · ');
}

export function renderSotl(sotl, onBack, onSelectCiv) {
  const rankSort = (a, b) => {
    const ra = a.rank === 'HM' ? 99 : a.rank;
    const rb = b.rank === 'HM' ? 99 : b.rank;
    return ra - rb;
  };
  const rows = Object.entries(sotl.civs || {}).map(([slug, c]) => ({ slug, ...c })).sort(rankSort);
  const ranking = el('table', { class: 'stats' },
    el('thead', {}, el('tr', {}, el('th', { style: 'width:56px' }, 'Rank'), el('th', {}, 'Civilization'), el('th', {}, 'Why (SOTL)'))),
    el('tbody', {}, ...rows.map((c) =>
      el('tr', {},
        el('td', {}, el('span', { class: c.rank === 'HM' ? 'tag' : 'tag sotl-rank' }, c.rank === 'HM' ? 'HM' : '#' + c.rank)),
        el('td', {}, onSelectCiv
          ? el('a', { href: `#/civ/${c.slug}` }, civDisplayName(c.slug))
          : civDisplayName(c.slug)),
        el('td', {}, c.takeaway),
      ))),
  );
  const videos = (sotl.videos || []).map((v) =>
    el('div', { class: 'card' },
      el('div', { class: 'card-title' }, el('a', { href: v.url, target: '_blank', rel: 'noopener' }, v.title)),
      el('p', { class: 'muted small' }, v.date),
      el('p', {}, v.takeaway),
    ));
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: onBack }, '← All civilizations'),
    el('h2', {}, sotl.title || 'Spirit of the Law'),
    el('p', { class: 'lede' }, sotl.intro || ''),
    section('Best-practice principles (from SOTL)', list(sotl.metaPrinciples || [])),
    section(`Top 1v1 Arabia civs — ${sotl.rankingYear || ''}`,
      el('p', { class: 'muted small' }, ['Ranked by win rate at Elo ≥1200. ', el('a', { href: sotl.rankingSource, target: '_blank', rel: 'noopener' }, 'Source video'), '.']),
      ranking),
    section('Recent SOTL videos', ...videos),
    el('p', { class: 'sources' }, sotl._meta?.note || ''),
  );
}

// SOTL ranking keys civs by slug; map back to a display name via the loaded meta if available.
function civDisplayName(slug) {
  try {
    const meta = JSON.parse(localStorage.getItem('aoe_meta') || '{}');
    const found = (meta.civOrder || []).find((c) => c.slug === slug);
    if (found) return found.name;
  } catch { /* ignore */ }
  return slug.replace(/(^|[-])(\w)/g, (_, s, c) => (s ? ' ' : '') + c.toUpperCase());
}

// Map a SOTL year to its "Best Civilizations" video URL.
function sotlSource(year) {
  return year === 2025
    ? 'https://www.youtube.com/watch?v=G14PVVbRhsQ'
    : 'https://www.youtube.com/watch?v=eM4jZD5zOFA';
}

function renderCell(c) {
  if (c && typeof c === 'object' && c.img) {
    return el('td', {},
      el('img', { class: 'res-icon', src: c.img, alt: c.label || '', loading: 'lazy',
        onerror: function () { this.style.display = 'none'; } }),
      c.label || '');
  }
  return el('td', {}, String(c));
}

function dataTable(t) {
  if (!t || !t.rows || !t.rows.length) return null;
  return el('table', { class: 'stats' },
    t.headers && t.headers.length
      ? el('thead', {}, el('tr', {}, ...t.headers.map((h) => el('th', {}, h))))
      : null,
    el('tbody', {}, ...t.rows.map((r) => el('tr', {}, ...r.map(renderCell)))),
  );
}

function matchupTable(rows) {
  if (!rows || !rows.length) return el('p', { class: 'muted small' }, '—');
  return el('table', { class: 'stats match-tbl' },
    el('tbody', {}, ...rows.map((r) => {
      const wr = wrForSlug(r.slug);
      return el('tr', {},
        el('td', { class: 'match-civ' },
          r.internalName ? el('img', { class: 'civ-icon-sm', src: iconUrl(r.internalName), alt: r.name, loading: 'lazy',
            onerror: function () { this.style.visibility = 'hidden'; } }) : null,
          el('a', { href: `#/civ/${r.slug}` }, r.name),
          wr != null ? el('span', { class: 'wr-mini ' + wrClass(wr) }, wr.toFixed(1) + '%') : null));
    })));
}

// Real civ-vs-civ matchups from aoestats.io (rows: {name, games, winRate}). Resolve the opponent's
// display name -> slug/internalName (for the icon + link) against the loaded civ order.
const nameSlug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function civByName() {
  const m = {};
  for (const c of civOrderCached()) m[c.name.toLowerCase()] = c;
  return m;
}
function realMatchupTable(rows) {
  if (!rows || !rows.length) return el('p', { class: 'muted small' }, '—');
  const byName = civByName();
  return el('table', { class: 'stats match-tbl' },
    el('tbody', {}, ...rows.map((r) => {
      const c = byName[(r.name || '').toLowerCase()] || {};
      const slug = c.slug || nameSlug(r.name);
      return el('tr', {},
        el('td', { class: 'match-civ' },
          c.internalName ? el('img', { class: 'civ-icon-sm', src: iconUrl(c.internalName), alt: r.name, loading: 'lazy',
            onerror: function () { this.style.visibility = 'hidden'; } }) : null,
          el('a', { href: `#/civ/${slug}` }, r.name)),
        el('td', { class: 'small muted' }, r.games != null ? r.games.toLocaleString() + ' games' : ''),
        el('td', {}, r.winRate != null ? el('span', { class: 'wr-pill ' + wrClass(r.winRate) }, r.winRate.toFixed(1) + '%') : ''));
    })));
}
// Real per-map-type win rate from aoestats.io (byMapType: {open:{winRate,picks,playRate}, …}).
function realMapsTable(byMapType) {
  return el('table', { class: 'stats' },
    el('thead', {}, el('tr', {}, el('th', {}, 'Map type'), el('th', {}, 'Win rate'), el('th', {}, 'Sample'))),
    el('tbody', {}, ...['open', 'closed', 'hybrid', 'water'].map((t) => {
      const d = byMapType[t];
      if (!d || d.picks == null) return el('tr', {}, el('td', {}, t.charAt(0).toUpperCase() + t.slice(1)), el('td', {}, '—'), el('td', { class: 'small muted' }, '—'));
      const thin = d.picks < 200;
      return el('tr', {},
        el('td', {}, t.charAt(0).toUpperCase() + t.slice(1)),
        el('td', {}, el('span', { class: 'wr-pill ' + wrClass(d.winRate) }, d.winRate.toFixed(1) + '%')),
        el('td', { class: 'small' }, thin ? el('span', { class: 'muted' }, d.picks.toLocaleString() + ' games (thin)') : d.picks.toLocaleString() + ' games · ' + d.playRate.toFixed(1) + '% pick'));
    })));
}

export function renderBuildOrders(bo, onBack) {
  const urlByName = {};
  for (const s of bo.sources || []) urlByName[s.name.toLowerCase()] = s.url;
  const namedTag = (name) => {
    const u = urlByName[(name || '').toLowerCase()];
    return u ? el('a', { class: 'tag src', href: u, target: '_blank', rel: 'noopener', title: `Open ${name}` }, name)
             : el('span', { class: 'tag src' }, name);
  };
  const srcLinks = (bo.sources || []).map((s) =>
    el('a', { class: 'tag src', href: s.url, target: '_blank', rel: 'noopener' }, s.name));
  const orders = (bo.orders || []).map((o) =>
    el('section', { class: 'block' },
      el('h3', {}, o.title),
      o.fits && o.fits.length ? el('p', { class: 'muted small' }, 'Suits: ' + o.fits.join(', ')) : null,
      o.when ? el('p', { class: 'muted small' }, 'When: ' + o.when) : null,
      o.goal ? el('p', { class: 'bonus' }, o.goal) : null,
      o.steps && o.steps.length
        ? el('div', { class: 'card' },
            el('div', { class: 'card-title' }, 'Build steps'),
            ...o.steps.map((s, i) => el('p', { class: 'small' }, `${i + 1}. ${s}`)))
        : null,
      o.tips && o.tips.length
        ? el('div', { class: 'card' },
            el('div', { class: 'card-title' }, 'Tips'),
            ...o.tips.map((t) => el('p', { class: 'small' }, t)))
        : null,
      o.vils && o.vils.length
        ? el('div', { class: 'card' },
            el('div', { class: 'card-title' }, 'Villager allocation (who goes where)'),
            ...o.vils.map((v) => el('p', { class: 'small' }, v)))
        : null,
      el('div', {}, ...(o.sources || []).map(namedTag)),
    ));
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: onBack }, '← All civilizations'),
    el('h2', {}, bo.title || 'Build Orders', bo._meta?.outdated ? el('span', { class: 'tag', style: 'background:#f0d67a;color:#8a6d3b;margin-left:10px;vertical-align:middle' }, '⚠ Outdated') : null),
    bo._meta?.outdatedNote ? el('p', { class: 'muted small' }, bo._meta.outdatedNote) : null,
    el('p', { class: 'lede' }, bo.intro || ''),
    ...orders,
    el('p', { class: 'sources' }, bo._meta?.note || ''),
  );
}

export function renderEconomy(guide, onBack) {
  const sections = (guide.sections || []).map((sec) =>
    el('section', { class: 'block' },
      el('h3', {}, sec.title),
      sec.body ? el('p', { class: 'bonus' }, sec.body) : null,
      sec.sourceUrl ? el('p', { class: 'muted small' }, ['Source: ', el('a', { href: sec.sourceUrl, target: '_blank', rel: 'noopener' }, sec.source || 'kiritastrich'), '.']) : null,
      sec.tables && sec.tables.length
        ? el('div', {}, ...sec.tables.map((t) =>
            el('div', { class: 'card' },
              t.caption ? el('div', { class: 'card-title' }, t.caption) : null,
              dataTable(t))))
        : null,
      sec.notes && sec.notes.length
        ? el('div', { class: 'card' },
            el('div', { class: 'card-title' }, 'Notes'),
            ...sec.notes.map((n) => el('p', { class: 'small' }, n)))
        : null,
      sec.do && sec.do.length
        ? el('div', { class: 'do-dont' }, el('div', { class: 'do' },
            el('div', { class: 'dd-head' }, '✓ Do'), ...sec.do.map((d) => el('p', {}, d))),
            sec.dont && sec.dont.length ? el('div', { class: 'dont' },
              el('div', { class: 'dd-head' }, '✗ Don’t'), ...sec.dont.map((d) => el('p', {}, d))) : null,
          )
        : null,
    ),
  );
  const targets = (guide.targets || []).map((t) =>
    el('tr', {}, el('td', {}, t.label), el('td', {}, t.value)));
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: onBack }, '← All civilizations'),
    el('h2', {}, guide.title || 'Economy Guide'),
    el('p', { class: 'lede' }, guide.intro || ''),
    section('Core principles', list(guide.principles || [])),
    ...sections,
    section('Rough targets',
      el('table', { class: 'stats' }, el('tbody', {}, ...targets)),
      el('p', { class: 'muted small' }, 'Approximate; adjust by civilization and strategy.'),
    ),
    el('p', { class: 'sources' }, 'General AoE II economy principles — apply alongside each civilization’s economy bonus.'),
  );
}

export function renderGrid(civOrder, onSelect) {
  const grid = el('div', { class: 'civ-grid' });
  for (const c of civOrder) {
    const card = el('button', {
      class: 'civ-card',
      onclick: () => onSelect(c.slug),
      title: c.armyType || c.name,
    },
      el('img', { class: 'civ-icon', src: iconUrl(c.internalName), alt: c.name, loading: 'lazy',
        onerror: function () { this.style.visibility = 'hidden'; } }),
      el('div', { class: 'civ-name' }, c.name),
      el('div', { class: 'civ-army' }, c.armyType || ''),
      (c.winRate != null)
        ? el('div', { class: 'civ-wr ' + (c.winRate >= 51.5 ? 'good' : c.winRate < 48.5 ? 'bad' : '') },
            'WR ' + c.winRate.toFixed(1) + '%')
        : null,
    );
    grid.appendChild(card);
  }
  return el('main', { class: 'container' },
    el('p', { class: 'lede' }, `${civOrder.length} civilizations · click any for its tech tree, ranked stats, matchups and build orders`),
    grid,
  );
}

function section(title, ...children) {
  return el('section', { class: 'block' }, el('h3', {}, title), ...children);
}

function list(items) {
  if (!items || !items.length) return el('p', { class: 'muted' }, '—');
  return el('ul', {}, ...items.map((t) => el('li', {}, Array.isArray(t) ? t : [t])));
}

function costStr(cost) {
  if (!cost) return '';
  return Object.entries(cost).map(([r, v]) => `${v}${r[0].toUpperCase()}`).join(' ');
}

// Resource icon URLs (aoe2techtree) for rendering costs as icon+amount, not "60F 55G".
const RES_ICONS = {
  food: 'img/food.png',
  wood: 'img/wood.png',
  gold: 'img/gold.png',
  stone: 'img/stone.png',
};
const RES_ORDER = ['food', 'wood', 'gold', 'stone'];
function costNodes(cost) {
  if (!cost) return el('span', { class: 'muted' }, '–');
  const parts = [];
  for (const r of RES_ORDER) {
    if (cost[r] == null) continue;
    parts.push(el('img', { class: 'res-icon', src: RES_ICONS[r], alt: r, title: r, loading: 'lazy',
      onerror: function () { this.style.display = 'none'; } }), ' ' + cost[r] + ' ');
  }
  return parts.length ? el('span', { class: 'cost' }, ...parts) : el('span', { class: 'muted' }, '–');
}

// Coerce a curated field that may be a string or an array into an array.
const asArr = (v) => (Array.isArray(v) ? v : v ? [v] : []);

export function renderDetail(civ, onBack) {
  const f = civ.facts || {};
  const s = civ.strategy || {};

  // Render a list of units (unique OR regional) as a base row plus an "↳ Elite" row — each tier
  // with its own icon — when the unit has an elite version. Shared by Unique techs & Regional units.
  const iconFor = (pic, name) => pic != null
    ? el('img', { class: 'uicon', src: `img/Unit/${pic}.png`, alt: name, loading: 'lazy', onerror: function () { this.style.visibility = 'hidden'; } })
    : null;
  const statCell = (v) => el('td', {}, v == null ? '–' : String(v));
  const rngCell = (v) => el('td', {}, v != null ? String(v) : '–');
  const spdCell = (v) => el('td', {}, v != null ? Number(v).toFixed(2) : '–');
  const unitRows = (units) => {
    const rows = [];
    for (const u of units) {
      // Each unit carries an ordered `tiers` line (base → … → top). Base row shows train cost;
      // each later tier (↳) shows its research cost. Falls back to a single flat row for legacy data.
      const tiers = (u.tiers && u.tiers.length) ? u.tiers
        : [{ name: u.name, pic: (u.pic != null ? u.pic : u.id), hp: u.hp, attack: u.attack, range: u.range, speed: u.speed, cost: u.cost }];
      tiers.forEach((t, i) => rows.push(el('tr', { class: i === 0 ? '' : 'sub-row' },
        el('td', {}, iconFor(t.pic, t.name),
          i === 0 ? ' ' + t.name + (tiers.length > 1 ? ' ★' : '') : ' ↳ ' + t.name),
        statCell(t.hp), statCell(t.attack), rngCell(t.range), spdCell(t.speed),
        el('td', {}, i === 0 ? costNodes(t.cost) : el('span', {}, '↑ ', costNodes(t.cost))))));
    }
    return rows;
  };
  const keyUnitRows = unitRows(f.keyUnits || []);

  // Regional units/buildings + unique buildings come from the generated regional layer
  // (data/regional.json → civ.regional). Unique buildings join the "Unique techs" section;
  // regional units/buildings get their own section. itemLine renders icon + name + cost.
  const uniqBuildings = ((civ.regional && civ.regional.buildings) || []).filter((b) => b.kind === 'unique');
  const regionalUnits = (civ.regional && civ.regional.units) || [];
  const regionalBuildings = ((civ.regional && civ.regional.buildings) || []).filter((b) => b.kind === 'regional');
  const itemLine = (it, cat) => el('p', { class: 'bonus' },
    (it.pic != null) ? el('img', { class: 'gap-icon', src: `img/${cat || it.cat}/${it.pic}.png`, alt: it.name || it.display, loading: 'lazy', onerror: function () { this.style.display = 'none'; } }) : null,
    ' ' + (it.display || it.name || ''),
    it.cost ? el('span', { class: 'small' }, ' — ', costNodes(it.cost)) : null,
    it.desc ? el('span', { class: 'small muted' }, ' ' + it.desc) : null);

  const hasStrategy = s && Object.keys(s).length && (asArr(s.buildOrders).length || asArr(s.recommendations).length || s.buildNote || asArr(s.timings).length);

  return el('main', { class: 'container detail civ' },
    el('button', { class: 'back-btn', onclick: onBack }, '← All civilizations'),
    el('div', { class: 'detail-head' },
      el('img', { class: 'civ-icon lg', src: iconUrl(civ.internalName), alt: civ.id,
        onerror: function () { this.style.visibility = 'hidden'; } }),
      el('div', {},
        el('h2', {}, civ.id),
        el('div', { class: 'civ-army' }, f.armyType || ''),
      ),
    ),

    civ.stats ? el('section', { class: 'block' },
      el('h3', {}, 'Ranked (1v1 Random Map)'),
      (civ.stats.winRate == null)
        ? el('p', { class: 'muted' }, civ.stats.noData || 'No ranked 1v1 data for this civilization yet.')
        : el('table', { class: 'stats' },
            el('tbody', {},
              el('tr', {}, el('td', {}, 'Win rate'), el('td', {},
                el('span', { class: 'wr-pill ' + wrClass(civ.stats.winRate) }, civ.stats.winRate.toFixed(2) + '%'))),
              el('tr', {}, el('td', {}, 'Play rate'), el('td', {},
                civ.stats.playRate.toFixed(2) + '%  ·  ' + civ.stats.picks.toLocaleString() + ' games')),
              el('tr', {}, el('td', {}, 'Sample'), el('td', {},
                [civ.stats.ladder, civ.stats.rating, civ.stats.patch ? 'patch ' + civ.stats.patch : null, civ.stats.window].filter(Boolean).join(' · '))),
            )),
      civ.stats.winRate == null ? null
        : el('p', { class: 'muted small' }, ['Self-aggregated from live ranked 1v1 matches', civ.stats.window ? ` (${civ.stats.window})` : '', '. ',
            el('a', { href: civ.stats.sourceCiv, target: '_blank', rel: 'noopener' }, 'Compare on aoestats.io'),
            '. A high win rate can mean a niche civ picked into good spots — read it with the play rate.']),
    ) : null,


    section('Civilization bonuses',
      ...(f.bonuses || []).map((b) => el('p', { class: 'bonus' }, '• ' + b)),
      f.teamBonus ? el('p', { class: 'team-bonus' }, ['Team bonus: ', el('strong', {}, f.teamBonus)]) : null,
    ),

    (keyUnitRows.length || (f.uniqueTechs || []).length || uniqBuildings.length)
      ? section('Unique techs',
          keyUnitRows.length
            ? el('table', { class: 'stats' },
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Unit'), el('th', {}, 'HP'), el('th', {}, 'Atk'),
                  el('th', {}, 'Rng'), el('th', {}, 'Speed'), el('th', {}, 'Cost'))),
                el('tbody', {}, ...keyUnitRows),
              )
            : null,
          ...uniqBuildings.map((b) => itemLine(b)),
          uniqBuildings.length ? el('hr', { class: 'sub-div' }) : null,
          ...(f.uniqueTechs || []).map((t) => itemLine(typeof t === 'string' ? { display: t } : t, 'Tech')),
        )
      : null,
    // Region-shared units & buildings from the tech tree (Battle Elephant, Steppe Lancer,
    // Caravanserai, …) — available to a subset of civs, not unique to this one.
    (regionalUnits.length || regionalBuildings.length)
      ? section('Regional units & buildings',
          regionalUnits.length
            ? el('table', { class: 'stats' },
                el('thead', {}, el('tr', {},
                  el('th', {}, 'Unit'), el('th', {}, 'HP'), el('th', {}, 'Atk'),
                  el('th', {}, 'Rng'), el('th', {}, 'Speed'), el('th', {}, 'Cost'))),
                el('tbody', {}, ...unitRows(regionalUnits)))
            : null,
          ...regionalBuildings.map((b) => itemLine(b)),
        )
      : null,

    (f.techGaps && f.techGaps.length)
      ? section('Notable tech gaps', el('div', { class: 'gap-tags' }, ...f.techGaps.map((g) => {
          const obj = typeof g === 'string' ? { label: g } : g;
          const pid = obj.pic != null ? obj.pic : obj.id;
          return el('span', { class: 'tag gap' },
            (pid != null) ? el('img', { class: 'gap-icon', src: `img/${obj.cat}/${pid}.png`, alt: obj.name || obj.label, loading: 'lazy', onerror: function () { this.style.display = 'none'; } }) : null,
            ' ' + (obj.label || obj.name));
        })))
      : section('Notable tech gaps', el('p', { class: 'muted' }, 'None of the key upgrades are missing.')),

    (civ.stats && (civ.stats.strongAgainst?.length || civ.stats.weakAgainst?.length))
      ? section('Matchups (ranked)',
          el('div', { class: 'do-dont' },
            el('div', { class: 'do' },
              el('div', { class: 'dd-head' }, '✓ Strong against'),
              realMatchupTable(civ.stats.strongAgainst)),
            el('div', { class: 'dont' },
              el('div', { class: 'dd-head' }, '✗ Weak against'),
              realMatchupTable(civ.stats.weakAgainst))),
          el('p', { class: 'muted small' }, ['Civ-vs-civ 1v1 win rate, self-aggregated from live ranked matches', civ.stats.window ? ` (${civ.stats.window})` : '', '. Cells with few games are noisy.']))
      : (f.matchups && (f.matchups.strongAgainst?.length || f.matchups.weakAgainst?.length))
        ? section('Matchups (heuristic)',
            el('div', { class: 'do-dont' },
              el('div', { class: 'do' },
                el('div', { class: 'dd-head' }, '✓ Strong against'),
                matchupTable(f.matchups.strongAgainst)),
              el('div', { class: 'dont' },
                el('div', { class: 'dd-head' }, '✗ Weak against'),
                matchupTable(f.matchups.weakAgainst))),
            el('p', { class: 'muted small' }, ['From army composition & tech gaps — a guide, not gospel.']))
        : null,
    (civ.stats && civ.stats.byMapType && Object.keys(civ.stats.byMapType).length)
      ? section('Maps (ranked)',
          realMapsTable(civ.stats.byMapType),
          el('p', { class: 'muted small' }, ['This civ\'s 1v1 win rate by map type, self-aggregated from live ranked matches', civ.stats.window ? ` (${civ.stats.window})` : '', '.']))
      : (f.maps && f.maps.affinity)
        ? section('Maps (heuristic)',
            el('table', { class: 'stats' },
              el('thead', {}, el('tr', {},
                el('th', {}, 'Map type'), el('th', { style: 'width:72px' }, 'This civ'),
                el('th', {}, 'Strong on this map'), el('th', {}, 'Weak on this map'))),
              el('tbody', {}, ...['open', 'closed', 'hybrid', 'water'].map((t) => {
                const aff = (f.maps.affinity || {})[t] || 'OK';
                const m = (f.maps.byMap && f.maps.byMap[t]) || { strong: [], weak: [] };
                return el('tr', {},
                  el('td', {}, t.charAt(0).toUpperCase() + t.slice(1)),
                  el('td', {}, el('span', { class: 'tag ' + (aff === 'Strong' ? 'sotl-rank' : aff === 'Weak' ? 'gap' : '') }, aff)),
                  el('td', { class: 'small' }, civListWithWr(m.strong)),
                  el('td', { class: 'small' }, civListWithWr(m.weak)));
              }))),
            el('p', { class: 'muted small' }, 'Heuristic from composition & bonuses.'))
        : null,
    hasStrategy
      ? el('section', { class: 'block strategy' },
          el('h3', {}, 'Strategy & build orders'),
          s.buildNote ? el('p', { class: 'bonus' }, s.buildNote) : null,
          ...(asArr(s.buildOrders)).map((b) =>
            el('div', { class: 'card' },
              el('div', { class: 'card-title' }, b.title),
              el('p', {}, b.detail),
              b.map ? el('p', { class: 'muted small' }, 'Map: ' + b.map) : null,
              sourceTag(b.source, b.sourceUrl),
            ),
          ),
          (asArr(s.timings).length) ? section('Key timings', list(asArr(s.timings).map((t) => `${t.label}: ${t.detail}`))) : null,
          (asArr(s.recommendations).length) ? section('Recommendations', list(asArr(s.recommendations))) : null,
        )
      : el('section', { class: 'block' },
          el('h3', {}, 'Strategy & build orders'),
          el('p', { class: 'muted' }, 'No curated strategy for this civilization yet — the tech-tree facts, unique units/techs/buildings, tech gaps, matchups and ranked stats above are auto-derived. Curated build orders and recommendations are added for civilizations covered by the source channel.'),
        )
  );
}

// ---- Tips & best practices (tagged, per-source) ----
function allTags(sources) {
  const counts = {};
  for (const s of sources) for (const t of (s.tips || [])) for (const tag of (t.tags || [])) counts[tag] = (counts[tag] || 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
}
function tagBar(tags, activeTag, onTag) {
  return el('div', { class: 'tag-bar' },
    el('button', { class: 'tag-chip' + (activeTag ? '' : ' active'), onclick: () => onTag(null) }, 'all'),
    ...tags.map(({ tag, count }) => el('button', {
      class: 'tag-chip' + (activeTag === tag ? ' active' : ''),
      onclick: () => onTag(activeTag === tag ? null : tag),
      title: count + ' tip' + (count > 1 ? 's' : ''),
    }, tag + ' · ' + count)));
}
function tipItem(t) {
  return el('li', { class: 'tip' }, t.text,
    el('div', { class: 'tip-tags' }, ...(t.tags || []).map((tag) => el('span', { class: 'tag' }, tag))));
}

export function renderTipsHub(data, opts = {}) {
  const activeTag = opts.activeTag || null;
  const onTag = opts.onTag || (() => {});
  const tags = allTags(data.sources || []);
  const blocks = (data.sources || []).map((s) => {
    const tips = (s.tips || []).filter((t) => !activeTag || (t.tags || []).includes(activeTag));
    return el('section', { class: 'block' },
      el('h3', {}, el('a', { href: `#/tips/${s.key}` }, s.name),
        ' ', el('span', { class: 'muted small' }, '(' + (s.tips || []).length + ' tips →)')),
      el('p', { class: 'muted small' }, s.blurb || ''),
      tips.length ? el('ul', { class: 'tip-list' }, ...tips.map(tipItem)) : el('p', { class: 'muted small' }, 'No tips with this tag.'),
    );
  });
  return el('main', { class: 'container detail' },
    el('h2', {}, data.title || 'Tips'),
    el('p', { class: 'lede' }, data.intro || ''),
    tagBar(tags, activeTag, onTag),
    ...blocks,
  );
}

export function renderTipsSource(data, key, sotl, opts = {}) {
  const activeTag = opts.activeTag || null;
  const onTag = opts.onTag || (() => {});
  const s = (data.sources || []).find((x) => x.key === key);
  if (!s) return el('main', { class: 'container detail' }, el('p', { class: 'muted' }, 'Unknown source.'));
  const tags = allTags([s]);
  const tips = (s.tips || []).filter((t) => !activeTag || (t.tags || []).includes(activeTag));
  const extra = [];
  if (key === 'sotl' && sotl) {
    if (sotl.metaPrinciples && sotl.metaPrinciples.length) {
      extra.push(el('section', { class: 'block' }, el('h3', {}, 'Analysis principles'), list(sotl.metaPrinciples)));
    }
    if (sotl.civs) {
      const rows = Object.entries(sotl.civs).map(([slug, c]) => ({ slug, ...c }))
        .sort((a, b) => (a.rank === 'HM' ? 99 : a.rank) - (b.rank === 'HM' ? 99 : b.rank));
      const ranking = el('table', { class: 'stats' },
        el('thead', {}, el('tr', {},
          el('th', { style: 'width:56px' }, 'Rank'),
          el('th', {}, 'Civilization'),
          el('th', {}, 'Takeaway'))),
        el('tbody', {}, ...rows.map((c) => el('tr', {},
          el('td', {}, el('span', { class: c.rank === 'HM' ? 'tag' : 'tag sotl-rank' }, c.rank === 'HM' ? 'HM' : '#' + c.rank)),
          el('td', {}, el('a', { href: `#/civ/${c.slug}` }, civDisplayName(c.slug))),
          el('td', { class: 'small' }, c.takeaway)))));
      extra.push(el('section', { class: 'block' },
        el('h3', {}, `Top 1v1 Arabia civs — ${sotl.rankingYear || ''}`),
        el('p', { class: 'muted small' }, 'Ranked by win rate at Elo ≥1200 (Spirit of the Law).'),
        ranking));
    }
  }
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: () => { location.hash = '/tips'; } }, '← All tips'),
    el('h2', {}, el('a', { href: s.url, target: '_blank', rel: 'noopener' }, s.name)),
    el('p', { class: 'lede' }, s.blurb || ''),
    tagBar(tags, activeTag, onTag),
    tips.length ? el('ul', { class: 'tip-list' }, ...tips.map(tipItem)) : el('p', { class: 'muted' }, 'No tips with this tag.'),
    ...extra,
  );
}

export function renderLogs(data, onBack) {
  const badge = (s) => el('span', { class: 'tag ' + (s === 'used' ? 'sotl-rank' : s === 'failed' ? 'gap' : '') }, s);
  const groups = (data.groups || []).map((g) =>
    el('section', { class: 'block' },
      el('h3', {}, el('a', { href: g.url, target: '_blank', rel: 'noopener' }, g.source)),
      g.blurb ? el('p', { class: 'muted small' }, g.blurb) : null,
      el('table', { class: 'stats' },
        el('thead', {}, el('tr', {},
          el('th', { style: 'width:84px' }, 'Status'), el('th', { style: 'width:160px' }, 'Item'),
          el('th', {}, 'Summary & where used'))),
        el('tbody', {}, ...(g.entries || []).map((e) => el('tr', {},
          el('td', {}, badge(e.status)),
          el('td', {}, el('a', { href: e.url, target: '_blank', rel: 'noopener' }, e.ref || 'link')),
          el('td', { class: 'small' }, e.summary || '',
            (e.usedIn && e.usedIn.length) ? el('div', { class: 'muted' }, '→ ' + e.usedIn.join(', ')) : null)))))));
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: onBack }, '← About'),
    el('h2', {}, data.title || 'Source usage log'),
    el('p', { class: 'lede' }, data.intro || ''),
    ...groups,
  );
}

export function renderAbout(meta, onBack) {
  const src = (label, url, desc) => el('div', { class: 'card' },
    el('div', { class: 'card-title' }, el('a', { href: url, target: '_blank', rel: 'noopener' }, label)),
    el('p', { class: 'muted small' }, desc));
  return el('main', { class: 'container detail' },
    el('button', { class: 'back-btn', onclick: onBack }, '← All civilizations'),
    el('h2', {}, 'About this guide'),
    el('p', { class: 'lede' }, 'An offline Age of Empires II civilization companion. Facts (tech trees, units, gaps, matchups) are auto-derived from aoe2techtree.net by a daily background rebuild — the app reads only the cached data. Strategy is curated and translated to English from the sources below.'),
    el('section', { class: 'block' },
      el('h3', {}, 'Data sources & how each is used'),
      src('aoe2techtree.net', 'https://aoe2techtree.net/', 'The tech-tree dataset (MIT-licensed). Used to auto-derive every civilization\'s facts on every page: army type, civ/team bonuses, unique-unit stats, the notable tech gaps, and the heuristic matchups and map affinities. Rebuilt daily by a background job; the ↻ Refresh button syncs the app to the latest deployed data.'),
      src('aoestats.io', 'https://aoestats.io/', 'Aggregated ranked match statistics. Used for the win-rate chip on every grid card, the "Ranked" block on each civ page, and the win-rate figures beside opposing civs in the Matchups and Maps sections.'),
      src('kiritastrich (Telegram)', 'https://t.me/s/kiritastrich', 'Russian-language strategy channel, translated to English. Used for the curated build orders and civ recommendations, the economy math tables, the water-economy notes, the May-2026 patch notes, and the kiritastrich tips.'),
      src('Spirit of the Law (YouTube)', 'https://www.youtube.com/@SpiritOfTheLaw', 'Data-driven AoE2 analysis. Used for the Spirit of the Law tips page + analysis principles.'),
      src('Hera (YouTube)', 'https://www.youtube.com/@HeraAgeOfEmpires2', 'Pro-player coaching and gameplay. Used for the Hera tips (macro, scouting, booming, map control).'),
      src('CyberDabVinc (YouTube)', 'https://www.youtube.com/@CyberDabVinc', 'Defensive/boom-focused ladder coaching. Used for the CyberDabVinc tips (walls, timings, retreating from bad matchups).'),
      src('Age of Empires Wiki (Fandom)', 'https://ageofempires.fandom.com/', 'Community wiki. Used for the sheep, boar, deer, shore-fish and deep-fish icons in the Economy resource-rate table.'),
    ),
    el('section', { class: 'block' },
      el('h3', {}, 'Provenance & source usage'),
      el('p', {}, 'See exactly which posts, videos and datasets fed each part of the app — every item marked ', el('span', { class: 'tag sotl-rank' }, 'used'), ', ', el('span', { class: 'tag' }, 'skipped'), ' or ', el('span', { class: 'tag gap' }, 'failed'), ' — and where it is used.'),
      el('p', {}, el('a', { href: '#/about/logs' }, '→ Open the source usage log')),
    ),
    el('section', { class: 'block' },
      el('h3', {}, 'How it works'),
      el('p', {}, 'Data is bundled and works offline; the app makes no external requests. A background job rebuilds it from aoe2techtree.net daily — click ', el('strong', {}, '↻ Refresh'),
        ' to sync to the latest deployed data. Curated strategy is never overwritten.'),
      el('p', {}, 'Each civilization page links its specific sources as tags (e.g. a build order links the exact Telegram post it came from). The full source list lives only here.'),
    ),
    el('p', { class: 'sources' }, meta ? `Built ${meta.generatedAt || ''} · data hash ${meta.hash || ''}` : ''),
  );
}

export function toast(msg, kind = 'info') {
  const t = el('div', { class: `toast ${kind}` }, msg);
  document.getElementById('toast').appendChild(t);
  setTimeout(() => t.remove(), 5000);
}

export function showLoading(msg) {
  document.getElementById('view').replaceChildren(el('main', { class: 'container' }, el('p', { class: 'muted' }, msg || 'Loading…')));
}
