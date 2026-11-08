// Checks for ardia-spaces.mjs. Run: node test_ardia_spaces.mjs
import assert from 'node:assert/strict';
import { resolveSpace, withScheme, samePageKey, pickExisting, tabsFromWindows, contextMap,
  targetForTab, profileSteps, controlWsUrl, openPlan, parseWaitArgs, pollUntil } from './ardia-spaces.mjs';

const PROFILES = [{ id: 'default', name: 'Personal' }, { id: 'p-work', name: 'Work' }];
const WINDOWS = [{
  id: 'w1', kind: 'normal', focused: true, profile: 'p-work', profileName: 'Work',
  tabs: [
    { id: 't1', url: 'https://github.com/immathanr/zap/', title: 'zap', profile: 'default', active: false },
    { id: 't2', url: 'http://127.0.0.1:8790/#top', title: 'zap local', profile: 'p-work', active: true },
    { id: 't3', url: 'https://docs.example.com/wiki/abc?from=x', title: 'wiki', profile: 'p-work', active: false },
    { id: 't4', url: 'https://github.com/immathanr/zap', title: 'zap', profile: 'p-work', active: false },
  ],
}];
const PAGES = [
  { targetId: 'AAA1', url: 'https://github.com/immathanr/zap/', browserContextId: 'C-PER' },
  { targetId: 'BBB1', url: 'http://127.0.0.1:8790/', browserContextId: 'C-WORK' },
  { targetId: 'BBB2', url: 'https://github.com/immathanr/zap', browserContextId: 'C-WORK' },
];

const tests = {
  'per and work map to Personal and Work': () => {
    assert.equal(resolveSpace('per', ['Personal', 'Work']), 'Personal');
    assert.equal(resolveSpace('WORK', ['Personal', 'Work']), 'Work');
    assert.equal(resolveSpace(undefined, ['Personal']), null);
    assert.throws(() => resolveSpace('home', ['Personal', 'Work']), /No Ardia profile "home"/);
  },
  'bare hosts get a scheme, localhost gets http': () => {
    assert.equal(withScheme('127.0.0.1:8790'), 'http://127.0.0.1:8790');
    assert.equal(withScheme('github.com/x'), 'https://github.com/x');
  },
  'same page ignores scheme, trailing slash and fragment but not query': () => {
    assert.equal(samePageKey('http://github.com/a'), samePageKey('https://github.com/a/#x'));
    assert.notEqual(samePageKey('https://x.com/a?p=1'), samePageKey('https://x.com/a?p=2'));
  },
  'windows become tabs named by profile, active profile from the focused window': () => {
    const { active, tabs } = tabsFromWindows(WINDOWS, PROFILES);
    assert.equal(active, 'Work');
    assert.deepEqual(tabs.map(t => t.space), ['Personal', 'Work', 'Work', 'Work']);
    assert.equal(tabs[1].profile, 'p-work');
  },
  'empty New Tab rows are left out': () => {
    const w = [{ ...WINDOWS[0], tabs: [{ id: 'n', url: '', title: '', profile: 'default' }] }];
    assert.deepEqual(tabsFromWindows(w, PROFILES).tabs, []);
  },
  'reuses the tab in the requested profile only': () => {
    const { tabs, active } = tabsFromWindows(WINDOWS, PROFILES);
    const { tab, elsewhere } = pickExisting(tabs, 'github.com/immathanr/zap', 'Personal', active);
    assert.equal(tab.id, 't1');
    assert.equal(elsewhere[0].space, 'Work');
  },
  'browser contexts map to profiles from unambiguous URLs': () => {
    const { tabs } = tabsFromWindows(WINDOWS, PROFILES);
    const map = contextMap(tabs, PAGES);
    assert.equal(map.get('C-PER'), 'default');
    assert.equal(map.get('C-WORK'), 'p-work');
  },
  'the CDP target for a tab is the same URL in that profile\'s context': () => {
    const { tabs } = tabsFromWindows(WINDOWS, PROFILES);
    const map = contextMap(tabs, PAGES);
    assert.equal(targetForTab(tabs.find(t => t.id === 't4'), PAGES, map).targetId, 'BBB2');
    assert.equal(targetForTab(tabs.find(t => t.id === 't1'), PAGES, map).targetId, 'AAA1');
    assert.equal(targetForTab(tabs.find(t => t.id === 't3'), PAGES, map), null);  // asleep: no target
  },
  'the token path URL comes from ArdiaControl.json': () => {
    const c = { browser: '/devtools/browser/ea05', generation: 1, pid: 38099, port: 59549, token: 'a+b/c=0123456789abcdef' };
    assert.equal(controlWsUrl(c), 'ws://127.0.0.1:59549/devtools/browser/ea05?token=a%2Bb%2Fc%3D0123456789abcdef');
    assert.equal(controlWsUrl({ ...c, token: '' }), null);
    assert.equal(controlWsUrl({ ...c, port: 0 }), null);
    assert.equal(controlWsUrl({ ...c, browser: '/x' }), null);
  },
  'profile switching takes the shorter way round': () => {
    const order = ['a', 'b', 'c', 'd'];
    assert.deepEqual(profileSteps(order, 'a', 'b'), { command: 'nextProfile', count: 1 });
    assert.deepEqual(profileSteps(order, 'a', 'd'), { command: 'previousProfile', count: 1 });
    assert.deepEqual(profileSteps(order, 'b', 'b'), { command: null, count: 0 });
  },
  // A quiet open: the user's page and the profile in front must not change.
  'a page already open is reused where it is, in the background': () => {
    assert.deepEqual(openPlan({ found: 't1', target: 'Work', front: 'Work' }), { kind: 'reuse', quiet: true });
    assert.deepEqual(openPlan({ found: 't1', target: 'Personal', front: 'Work' }), { kind: 'reuse', quiet: true });
  },
  'a new tab in the profile already in front is made without switching': () => {
    assert.deepEqual(openPlan({ found: null, target: 'Work', front: 'Work' }), { kind: 'create', quiet: true });
  },
  'another profile means switch there, create, switch back': () => {
    assert.deepEqual(openPlan({ found: null, target: 'Personal', front: 'Work' }), { kind: 'roundtrip', back: 'Work', quiet: true });
  },
  // Handoff: wait for the user to finish something in the tab, then carry on.
  'wait takes a condition, a timeout and a hand flag': () => {
    assert.deepEqual(parseWaitArgs(['1A2B3C4D', '--until', '!!document.querySelector("#inbox")']),
      { target: '1A2B3C4D', until: '!!document.querySelector("#inbox")', timeoutMs: 300000, intervalMs: 500, hand: false });
    assert.deepEqual(parseWaitArgs(['1A2B3C4D', '--until=x > 2', '--timeout', '30', '--hand', '--interval=2000']),
      { target: '1A2B3C4D', until: 'x > 2', timeoutMs: 30000, intervalMs: 2000, hand: true });
    assert.throws(() => parseWaitArgs(['1A2B3C4D']), /--until/);
    assert.throws(() => parseWaitArgs(['--until', 'x']), /target/);
  },
  'pollUntil returns the value that ended the wait': async () => {
    let clock = 0;
    const values = [false, false, 'signed in'];
    const r = await pollUntil(async () => values.shift() ?? 'signed in', { intervalMs: 500, timeoutMs: 10000,
      now: () => clock, sleep: async ms => { clock += ms; } });
    assert.deepEqual(r, { ok: true, value: 'signed in', elapsed: 1000 });
  },
  'pollUntil gives up after the timeout and says what it last saw': async () => {
    let clock = 0;
    const r = await pollUntil(async () => false, { intervalMs: 500, timeoutMs: 1200,
      now: () => clock, sleep: async ms => { clock += ms; } });
    assert.deepEqual(r, { ok: false, value: false, elapsed: 1500 });
  },
  'pollUntil reports a failing check rather than hanging': async () => {
    let clock = 0;
    const r = await pollUntil(async () => { throw new Error('target closed'); }, { intervalMs: 500, timeoutMs: 5000,
      now: () => clock, sleep: async ms => { clock += ms; } });
    assert.equal(r.ok, false);
    assert.match(r.error, /target closed/);
  },
  '--foreground keeps the old, visible behaviour': () => {
    assert.deepEqual(openPlan({ found: 't1', target: 'Work', front: 'Work', foreground: true }), { kind: 'reuse', quiet: false });
    assert.deepEqual(openPlan({ found: null, target: 'Personal', front: 'Work', foreground: true }), { kind: 'create', quiet: false, switchTo: 'Personal' });
  },
};
let failed = 0;
for (const [name, fn] of Object.entries(tests)) {
  try { await fn(); console.log('pass', name); } catch (e) { failed++; console.log('FAIL', name, '-', e.message); }
}
process.exit(failed);

