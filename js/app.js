// js/app.js — routing + wiring. Imports store, updater, render.
import * as store from './store.js';
import * as updater from './updater.js';
import { renderGrid, renderDetail, renderEconomy, renderBuildOrders, renderHeader, renderAbout, renderTipsHub, renderTipsSource, renderLogs, paintFooter, toast, showLoading } from './render.js';

const view = () => document.getElementById('view');

function paintHeader() {
  const meta = store.getMeta();
  const old = document.querySelector('.app-header');
  const hdr = renderHeader(meta, {
    onRefresh: manualRefresh,
    onHome: () => { location.hash = '/'; },
    onBuilds: () => { location.hash = '/buildorders'; },
    onEconomy: () => { location.hash = '/economy'; },
    onTips: () => { location.hash = '/tips'; },
    onAbout: () => { location.hash = '/about'; },
  });
  if (old) old.replaceWith(hdr); else document.body.insertBefore(hdr, view());
  paintFooter(meta);
}

async function route() {
  const hash = location.hash.replace(/^#\/?/, ''); // e.g. "civ/turks", "tips/sotl"
  if (hash.startsWith('civ/')) {
    await showCiv(decodeURIComponent(hash.slice(4)));
  } else if (hash === 'economy') {
    await showEconomy();
  } else if (hash === 'buildorders') {
    await showBuildOrders();
  } else if (hash === 'tips') {
    await showTips();
  } else if (hash.startsWith('tips/')) {
    await showTipsSource(decodeURIComponent(hash.slice(5)));
  } else if (hash === 'about') {
    await showAbout();
  } else if (hash === 'about/logs') {
    await showLogs();
  } else {
    await showGrid();
  }
}

async function showEconomy() {
  showLoading('Loading economy guide…');
  try {
    const guide = await updater.loadData('economy');
    view().replaceChildren(renderEconomy(guide, () => { location.hash = '/'; }));
    paintHeader();
  } catch (e) {
    toast('Failed to load economy guide: ' + e.message, 'error');
    location.hash = '/';
  }
}

let tipsTag = null;
function setTipsTag(tag) { tipsTag = tag; route(); }

async function showTips() {
  showLoading('Loading tips…');
  try {
    const data = await updater.loadData('tips');
    view().replaceChildren(renderTipsHub(data, { activeTag: tipsTag, onTag: setTipsTag }));
    paintHeader();
  } catch (e) {
    toast('Failed to load tips: ' + e.message, 'error');
    location.hash = '/';
  }
}

async function showTipsSource(key) {
  showLoading('Loading tips…');
  try {
    const data = await updater.loadData('tips');
    const sotl = key === 'sotl' ? await updater.loadData('sotl') : null;
    view().replaceChildren(renderTipsSource(data, key, sotl, { activeTag: tipsTag, onTag: setTipsTag }));
    paintHeader();
  } catch (e) {
    toast('Failed to load tips: ' + e.message, 'error');
    location.hash = '/tips';
  }
}

async function showBuildOrders() {
  showLoading('Loading build orders…');
  try {
    const bo = await updater.loadData('buildorders');
    view().replaceChildren(renderBuildOrders(bo, () => { location.hash = '/'; }));
    paintHeader();
  } catch (e) {
    toast('Failed to load build orders: ' + e.message, 'error');
    location.hash = '/';
  }
}

async function showLogs() {
  showLoading('Loading source log…');
  try {
    const data = await updater.loadData('sources-log');
    view().replaceChildren(renderLogs(data, () => { location.hash = '/about'; }));
    paintHeader();
  } catch (e) {
    toast('Failed to load source log: ' + e.message, 'error');
    location.hash = '/about';
  }
}

async function showAbout() {
  view().replaceChildren(renderAbout(store.getMeta(), () => { location.hash = '/'; }));
  paintHeader();
}

async function showGrid() {
  const meta = store.getMeta();
  if (!meta) { showLoading('Loading civilizations…'); return; }
  view().replaceChildren(renderGrid(meta.civOrder, (slug) => { location.hash = `/civ/${slug}`; }));
}

async function showCiv(slug) {
  showLoading(`Loading ${slug}…`);
  try {
    const civ = await updater.loadCiv(slug);
    view().replaceChildren(renderDetail(civ, () => { location.hash = '/'; }));
    paintHeader();
  } catch (e) {
    toast('Failed to load civilization: ' + e.message, 'error');
    location.hash = '/';
  }
}

async function manualRefresh() {
  const btn = document.querySelector('.refresh-btn');
  if (btn) { btn.disabled = true; btn.textContent = '↻ Refreshing…'; }
  const parts = [];
  let warn = false;
  // Techtree facts (live, from aoe2techtree.net) — R4. Strategy preserved (R5).
  try {
    const res = await updater.liveRefresh({ onProgress: (m) => console.log('[refresh]', m) });
    if (res.error) { parts.push(`facts skipped: ${res.error}`); warn = true; }
    else if (res.changed) parts.push(`facts → ${res.hash} (${res.updated} civs)`);
    else parts.push(`facts up to date (${res.hash})`);
  } catch (e) {
    parts.push(`facts failed: ${e.message}`); warn = true;
  }
  // Ranked stats snapshot (rebuilt server-side by build-stats-live.mjs) — pull the latest file.
  try {
    const s = await updater.refreshData('aoestats');
    parts.push(s.changed ? 'stats refreshed' : 'stats unchanged');
  } catch (e) {
    parts.push(`stats failed: ${e.message}`); warn = true;
  }
  toast(parts.join(' · ') + '. Strategy preserved.', warn ? 'warn' : 'ok');
  if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  paintHeader();
  route();
}

async function boot() {
  paintHeader();
  showLoading('Loading…');
  const res = await updater.ensureData({ onProgress: (m) => showLoading(m) });
  if (!res.ok) { toast(res.error, 'error'); showLoading('Could not load data.'); return; }
  if (res.reconciled) toast('Local data synchronized with the bundled snapshot.', 'ok');
  if (res.live?.error) console.warn('[updater] live refresh deferred:', res.live.error);
  else if (res.live?.changed) toast(`Live update found: hash ${res.live.hash}.`, 'ok');
  paintHeader();
  window.addEventListener('hashchange', route);
  route();
}

boot();
