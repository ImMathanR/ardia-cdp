// ardia-spaces - Ardia's own view of profiles (Arc's spaces) and tabs.
//
// CDP sees loaded pages and their browser context, but not which Ardia profile
// a context is or which tab is in front. The `ardia` command's control socket
// (Settings > "Let the ardia command control Ardia") lists every window's tabs
// with their profile, and runs Ardia's commands (Next/Previous Profile, New
// Tab). ardia-cdp uses this for `open` (reuse an already-open page, else open
// it in the requested profile) and `tabs`.

import { execFileSync } from 'child_process';
import { readFileSync } from 'fs';
import { homedir } from 'os';
import { resolve } from 'path';

// What the user says -> the Ardia profile it means (Arc's spaces import as profiles).
export const SPACE_ALIASES = { per: 'Personal', personal: 'Personal', work: 'Work' };

/** "per" / "work" / an exact profile name (any case) -> the profile's real name. */
export function resolveSpace(wanted, titles) {
  if (!wanted) return null;
  const name = SPACE_ALIASES[wanted.toLowerCase()] || wanted;
  const hit = titles.find(t => t.toLowerCase() === name.toLowerCase());
  if (!hit) throw new Error(`No Ardia profile "${wanted}". Profiles: ${titles.join(', ')}`);
  return hit;
}

/** Adds a scheme when the user gave a bare host (localhost gets http). */
export function withScheme(url) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  return (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url) ? 'http://' : 'https://') + url;
}

/** Same page? Ignores http/https, default ports, a trailing slash, and #fragment. */
export function samePageKey(url) {
  try {
    const u = new URL(withScheme(url));
    if (!/^https?:$/.test(u.protocol)) return url;
    const port = u.port && !['80', '443'].includes(u.port) ? `:${u.port}` : '';
    const path = u.pathname.replace(/\/+$/, '') || '/';
    return `${u.hostname.toLowerCase()}${port}${path}${u.search}`;
  } catch {
    return url;
  }
}

/**
 * Which existing tab to reuse. Only a tab in the requested profile counts
 * (profiles are signed in to different accounts); matches elsewhere are reported.
 * With no profile requested, any profile counts, the active one first.
 */
export function pickExisting(tabs, url, space, activeSpace) {
  const key = samePageKey(url);
  const matches = tabs.filter(t => samePageKey(t.url) === key);
  const order = t => (t.space === (space || activeSpace) ? 0 : 1);
  const usable = space ? matches.filter(t => t.space === space) : [...matches].sort((a, b) => order(a) - order(b));
  const elsewhere = space ? matches.filter(t => t.space !== space) : [];
  return { tab: usable[0] || null, elsewhere };
}

/** `ardia windows --json` -> {active, tabs: [{space, profile, id, url, title, windowId}]}. */
export function tabsFromWindows(windows, profiles) {
  const name = id => profiles.find(p => p.id === id)?.name || id;
  const front = windows.find(w => w.focused) || windows[0];
  const tabs = [];
  for (const w of windows) {
    for (const t of w.tabs) {
      if (!t.url) continue;  // New Tab
      tabs.push({ space: name(t.profile), profile: t.profile, id: t.id, url: t.url, title: t.title || '', windowId: w.id });
    }
  }
  return { active: front ? front.profileName : null, tabs };
}

/**
 * browserContextId -> profile id. A context is a profile when the URLs of its
 * pages appear among that profile's tabs and no other's.
 */
export function contextMap(tabs, pages) {
  const byKey = new Map();
  for (const t of tabs) {
    const k = samePageKey(t.url);
    if (!byKey.has(k)) byKey.set(k, new Set());
    byKey.get(k).add(t.profile);
  }
  const candidates = new Map();
  for (const p of pages) {
    const owners = byKey.get(samePageKey(p.url));
    if (!owners || !p.browserContextId) continue;
    const prev = candidates.get(p.browserContextId);
    candidates.set(p.browserContextId, prev ? new Set([...prev].filter(x => owners.has(x))) : new Set(owners));
  }
  // One context per profile: a profile pinned to one context is ruled out for the others.
  const map = new Map();
  for (let changed = true; changed;) {
    changed = false;
    for (const [ctx, set] of candidates) {
      if (map.has(ctx) || set.size !== 1) continue;
      const profile = [...set][0];
      map.set(ctx, profile);
      for (const [other, s] of candidates) if (other !== ctx) s.delete(profile);
      changed = true;
    }
  }
  return map;
}

/** The loaded CDP page showing this tab, or null (the tab is asleep or not loaded yet). */
export function targetForTab(tab, pages, ctxMap) {
  const key = samePageKey(tab.url);
  const same = pages.filter(p => samePageKey(p.url) === key);
  const mine = same.filter(p => ctxMap.get(p.browserContextId) === tab.profile);
  if (mine.length) return mine[0];
  const unknown = same.filter(p => !ctxMap.has(p.browserContextId));
  return same.length === 1 && unknown.length === 1 ? unknown[0] : null;
}

/** Which profile command, how many times, to get from one profile id to another. */
export function profileSteps(order, from, to) {
  const n = order.length, a = order.indexOf(from), b = order.indexOf(to);
  if (a < 0 || b < 0 || a === b) return { command: null, count: 0 };
  const fwd = (b - a + n) % n, back = (a - b + n) % n;
  return fwd <= back ? { command: 'nextProfile', count: fwd } : { command: 'previousProfile', count: back };
}

/**
 * The token path's browser WebSocket URL from <data dir>/Chromium/ArdiaControl.json, or null.
 * The signed Ardia ignores ARDIA_REMOTE_DEBUGGING_PORT on the real profile; this is how it's reached instead.
 */
export function controlWsUrl(control) {
  const { port, browser, token } = control || {};
  if (!(Number.isInteger(port) && port > 0 && port < 65536)) return null;
  if (typeof browser !== 'string' || !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(browser)) return null;
  if (typeof token !== 'string' || token.length < 16) return null;
  return `ws://127.0.0.1:${port}${browser}?token=${encodeURIComponent(token)}`;
}

// ── Ardia plumbing ──────────────────────────────────────────────────────────

/** The running Ardia's token-path URL, or null when control is off or Ardia isn't running. */
export function controlFileWsUrl() {
  const path = resolve(dataDir(), 'Chromium/ArdiaControl.json');
  try {
    const control = JSON.parse(readFileSync(path, 'utf8'));
    try { process.kill(control.pid, 0); } catch { return null; }
    return controlWsUrl(control);
  } catch {
    return null;
  }
}
export function dataDir() {
  return process.env.ARDIA_DATA_DIR || resolve(homedir(), 'Library/Application Support/com.ardia.browser');
}

/** Profiles in Ardia's order: [{id, name}]. */
export function ardiaProfiles() {
  const s = JSON.parse(readFileSync(resolve(dataDir(), 'session.json'), 'utf8'));
  return (s.profileOrder || Object.keys(s.profiles)).map(id => ({ id, name: s.profiles[id]?.name || id }));
}

function ardia(args) {
  try {
    return execFileSync('ardia', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    const msg = (e.stderr || e.stdout || e.message || '').toString().trim();
    throw new Error(`ardia ${args.join(' ')}: ${msg}\n(Is "Let the ardia command control Ardia" on in Ardia's Settings?)`);
  }
}

export function ardiaWindows() {
  return JSON.parse(ardia(['windows', '--json']));
}

/** Every tab across Ardia's windows, plus the profile in front. */
export function ardiaTabs() {
  return tabsFromWindows(ardiaWindows(), ardiaProfiles());
}

/** Bring the front window to the named profile; returns once Ardia reports it. */
export function switchToProfile(name) {
  const profiles = ardiaProfiles();
  const want = profiles.find(p => p.name === name);
  if (!want) throw new Error(`No Ardia profile "${name}"`);
  for (let attempt = 0; attempt < 3; attempt++) {
    const front = ardiaWindows().find(w => w.focused) || ardiaWindows()[0];
    if (!front) throw new Error('Ardia has no window open');
    if (front.profile === want.id) return;
    const { command, count } = profileSteps(profiles.map(p => p.id), front.profile, want.id);
    for (let i = 0; i < count; i++) ardia(['run', command]);
  }
  throw new Error(`Couldn't switch Ardia to profile "${name}"`);
}
