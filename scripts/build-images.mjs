#!/usr/bin/env node
// scripts/build-images.mjs — mirror every aoe2techtree.net image the SPA will request into ./img/,
// so the app serves its own icons and makes NO external image requests. Run after build.mjs /
// build-regional.mjs (it walks the generated data/ to learn which images are needed); re-run when a
// patch adds units/techs. Idempotent: skips files already present.
//
//   node scripts/build-images.mjs
//
// URL construction mirrors js/render.js exactly (civ banners, unit icons, tech-gap icons, regional
// items, resources, favicon). Anything it misses is hidden by render.js's `onerror` fallback.
// Downloads via curl (Node's fetch trips on MITM-proxy TLS in some sandboxes; curl trusts the OS CA
// bundle and works in both the sandbox and CI).

import { readFile, mkdir, rm } from 'node:fs/promises';
import { existsSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const DATA = join(ROOT, 'data');
const IMG = join(ROOT, 'img');
const SRC = 'https://aoe2techtree.net/img';
const UA = 'aoe2-civ-tools/1.0 (build-images)';

const want = new Set();
const add = (rel) => { if (rel) want.add(rel); };
const readJson = async (p) => { try { return JSON.parse(await readFile(p, 'utf8')); } catch { return null; } };

// Fixed assets.
for (const r of ['food', 'wood', 'gold', 'stone']) add(`${r}.png`);
add('favicon.png');

// Civ banners + per-civ unit/gap/regional icons (mirrors js/render.js).
const meta = await readJson(join(DATA, 'meta.json'));
for (const c of meta?.civOrder || []) {
  const civ = await readJson(join(DATA, 'civs', `${c.slug}.json`));
  if (!civ) continue;
  if (civ.internalName) add(`Civs/${civ.internalName.toLowerCase()}.png`);
  // Units (key + regional): each tier carries its own pic; legacy fallback pic ?? id.
  for (const u of [...(civ.facts?.keyUnits || []), ...(civ.regional?.units || [])]) {
    const tiers = (u.tiers && u.tiers.length) ? u.tiers : [{ pic: u.pic != null ? u.pic : u.id }];
    for (const t of tiers) if (t.pic != null) add(`Unit/${t.pic}.png`);
  }
  // Tech gaps + unique techs: cat + (pic ?? id).
  for (const g of [...(civ.facts?.techGaps || []), ...(civ.facts?.uniqueTechs || [])]) {
    const pid = g.pic != null ? g.pic : g.id;
    if (pid != null && g.cat) add(`${g.cat}/${pid}.png`);
  }
  // Regional / unique buildings: cat + pic.
  for (const it of civ.regional?.buildings || []) {
    if (it.pic != null && it.cat) add(`${it.cat}/${it.pic}.png`);
  }
}

// Download (skip existing; sequential via curl — a few hundred small PNGs, politeness over speed).
let ok = 0, miss = 0, skip = 0;
const paths = [...want].sort();
for (let i = 0; i < paths.length; i++) {
  const rel = paths[i];
  const dest = join(IMG, rel);
  if (existsSync(dest)) { skip++; continue; }
  await mkdir(dirname(dest), { recursive: true });
  const r = spawnSync('curl', ['-sSL', '-f', '-m', '20', '-A', UA, `${SRC}/${rel}`, '-o', dest], { stdio: 'ignore' });
  if (r.status === 0 && existsSync(dest) && statSync(dest).size > 0) ok++;
  else { await rm(dest, { force: true }); miss++; }
  if ((i + 1) % 25 === 0) process.stdout.write(` …${i + 1}/${paths.length}\n`);
}
console.log(`images: ${ok} downloaded, ${skip} cached, ${miss} missing of ${paths.length} wanted → img/`);
