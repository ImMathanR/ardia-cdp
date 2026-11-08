#!/usr/bin/env node
// ardia-pane - an Ardia tab, live, inside a terminal pane.
//
//   ardia-pane.mjs <url> [--space per|work] [--split]   open (or reuse) the page, show it here
//   ardia-pane.mjs --target <prefix>                    show a tab already open (from `ardia-cdp tabs`)
//
// --split opens it in a new tmux pane to the right. The page keeps running in Ardia
// with its logins; this pane shows it (kitty graphics, via tmux passthrough), whether or
// not it's the tab in front, and sends clicks, scrolls and keys back over CDP.
// Keys: ^L go to URL, ^R reload, ^O back, ^Q quit. Everything else goes to the page.

import { execFileSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { controlFileWsUrl } from './ardia-spaces.mjs';
import { appendFileSync, existsSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { tmuxWrap, kittyDelete, kittyVirtual, kittyShm, cropForViewport, swapFrame, frameGap, parseHelperLine, fitBox, cellToPage, parseMouse, tokenize, keyEvent } from './pane-render.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const args = process.argv.slice(2);
const flag = n => { const i = args.indexOf(n); return i >= 0 ? args.splice(i, 2)[1] : null; };
const split = args.includes('--split') && args.splice(args.indexOf('--split'), 1);
const space = flag('--space');
let prefix = flag('--target');
const url = args[0];

if (!prefix && !url) {
  console.error('usage: ardia-pane.mjs <url> [--space per|work] [--split] | --target <prefix>');
  process.exit(2);
}
if (!prefix) {
  const out = execFileSync('node', [HERE + 'ardia-cdp.mjs', 'open', url, ...(space ? ['--space', space] : [])], { encoding: 'utf8' });
  prefix = (/:\s+([0-9A-F]{6,})\s/.exec(out) || [])[1];
  if (!prefix) { console.error(out.trim()); process.exit(1); }
}
if (split) {
  execFileSync('tmux', ['split-window', '-h', ...(process.env.TMUX_PANE ? ['-t', process.env.TMUX_PANE] : []), '-c', process.cwd(), 'node', HERE + 'ardia-pane.mjs', '--target', prefix]);
  process.exit(0);
}

// ── CDP ──
let live = null, win = null, visible = true;  // the live-frame helper (declared early: quit() uses it)
async function wsUrl() {
  const port = process.env.ARDIA_CDP_PORT || '9224';
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(500) });
    return (await r.json()).webSocketDebuggerUrl;
  } catch {}
  const t = controlFileWsUrl();
  if (!t) throw new Error('Ardia is not reachable (is "Let the ardia command control Ardia" on?)');
  return t;
}
const ws = new WebSocket(await wsUrl());
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('WebSocket error')); });
let nextId = 0, session;
const pending = new Map();
ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id); pending.delete(m.id);
    m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
  } else if (m.method === 'Target.detachedFromTarget' || m.method === 'Inspector.detached') quit('The tab closed.');
};
ws.onclose = () => quit('Lost the connection to Ardia.');
function send(method, params = {}, sid = session) {
  const id = ++nextId;
  ws.send(JSON.stringify({ id, method, params, ...(sid ? { sessionId: sid } : {}) }));
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => pending.delete(id) && reject(new Error(`Timeout: ${method}`)), 10000);
  });
}
const { targetInfos } = await send('Target.getTargets', {}, null);
const target = targetInfos.find(t => t.type === 'page' && t.targetId.startsWith(prefix));
if (!target) { console.error(`No loaded tab ${prefix} (asleep? open it with ardia-cdp open)`); process.exit(1); }
({ sessionId: session } = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true }, null));

// ── Screen ──
const out = s => process.stdout.write(s);
const inTmux = !!process.env.TMUX;
const gfx = s => out(inTmux ? tmuxWrap(s) : s);
const cell = (() => {
  try {
    const [w, h] = execFileSync('tmux', ['display', '-p', '#{client_cell_width} #{client_cell_height}'], { encoding: 'utf8' }).trim().split(' ').map(Number);
    if (w > 0 && h > 0) return { width: w, height: h };
  } catch {}
  return { width: 9, height: 18 };
})();

let page = { width: 1280, height: 800 }, box = { cols: 1, rows: 1 }, header = '', prompt = null, dirty = true;

function drawHeader() {
  const cols = process.stdout.columns;
  const text = prompt !== null ? `URL: ${prompt}` : `${header}  ^L url ^R reload ^O back ^Q quit`;
  out(`\x1b[1;1H\x1b[7m${text.slice(0, cols).padEnd(cols)}\x1b[0m`);
}

// ── Drawing ──
const dbg = process.env.ARDIA_PANE_LOG ? m => appendFileSync(process.env.ARDIA_PANE_LOG, `${new Date().toISOString().slice(11, 23)} ${m}\n`) : () => {};
const IMG = 42;  // images 42 and 43 take turns (swapFrame)
let shown = 0, lastInput = 0, lastShot = '', lastChange = 0;
const SHOT = `${tmpdir()}/tty-graphics-protocol-ardia-pane-${process.pid}.png`;
function show(transmit) {
  const f = swapFrame(shown, transmit, box.cols, box.rows);
  gfx(f.transmit);
  if (dirty) { out('\x1b[2J'); dirty = false; liveConfig(); }
  out(f.rows.map((row, i) => `\x1b[${i + 2};1H${row}`).join(''));
  shown = f.next;
  dbg(`show ${f.next} ${box.cols}x${box.rows} ${f.transmit.slice(2, 40)}`);
  drawHeader();
}
// A screenshot of our tab, also when it's in the background. Full size, no clip: clip.scale
// resizes the tab inside Ardia. With the helper running, it scales the PNG to the pane's pixel
// size and hands it over in shared memory like a live frame; a full-size PNG per frame (3192x2124
// on a Retina screen) is slow for the terminal to decode and upload, which showed as flicker.
// Without the helper, the terminal reads and deletes the temp file itself.
async function shot() {
  const { data } = await send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
  dbg(`shot ${data.length} same=${data === lastShot} dirty=${dirty}`);
  if (data === lastShot && !dirty) return;
  lastShot = data; lastChange = Date.now();
  const g = live && helperReady && await helperPng(Buffer.from(data, 'base64'));
  if (g) return show(id => kittyShm(g.name, { id, width: g.w, height: g.h, cols: box.cols, rows: box.rows }));
  writeFileSync(SHOT, Buffer.from(data, 'base64'));
  show(id => kittyVirtual(SHOT, { id, cols: box.cols, rows: box.rows }));
}

// ── Input ──
const mouseBtn = { left: 'left', middle: 'middle', right: 'right' };
async function onMouse(ev) {
  const at = cellToPage(ev.col, ev.row - 1, box, page);
  if (!at) return;
  if (ev.kind === 'wheel') return send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...at, deltaX: 0, deltaY: ev.dy * 120 });
  if (ev.kind === 'move') return send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...at, button: 'left', buttons: 1 });
  await send('Input.dispatchMouseEvent', {
    type: ev.kind === 'down' ? 'mousePressed' : 'mouseReleased', ...at, button: mouseBtn[ev.button], clickCount: 1,
  });
}
async function onKey(tok) {
  if (prompt !== null) {
    if (tok === '\r') {
      const to = prompt.trim(); prompt = null;
      if (to) await send('Page.navigate', { url: /^[a-z]+:/i.test(to) ? to : 'https://' + to });
    } else if (tok === '\x1b') prompt = null;
    else if (tok === '\x7f') prompt = prompt.slice(0, -1);
    else if (tok >= ' ') prompt += tok;
    return drawHeader();
  }
  if (tok === '\x11') return quit();
  if (tok === '\x0c') { prompt = ''; return drawHeader(); }
  if (tok === '\x12') return send('Page.reload');
  if (tok === '\x0f') return send('Runtime.evaluate', { expression: 'history.back()' });
  const k = keyEvent(tok);
  if (!k) return;
  if (k.text) return send('Input.insertText', { text: k.text });
  const { key, code, keyCode, text } = k.special;
  await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', key, code, windowsVirtualKeyCode: keyCode, text });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode });
}


function quit(msg) {
  live?.stdin.end();
  gfx(kittyDelete(IMG)); gfx(kittyDelete(IMG + 1));
  out('\x1b[?1006l\x1b[?1002l\x1b[?1000l\x1b[?25h\x1b[2J\x1b[H');
  if (msg) console.error(msg);
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.on('data', s => {
  lastInput = Date.now();
  for (const tok of tokenize(s)) {
    const ev = parseMouse(tok);
    (ev ? onMouse(ev) : onKey(tok)).catch(() => {});
  }
});
process.stdout.on('resize', () => { dirty = true; });
process.on('SIGINT', () => quit());
process.on('SIGTERM', () => quit());
process.on('SIGHUP', () => quit());
out('\x1b[?25l\x1b[?1000h\x1b[?1002h\x1b[?1006h\x1b[2J');

// ── Frames ──
// The pane follows its own tab, wherever it is in Ardia (one window only: no second window).
//  - Our tab in front: ardia-frames streams the Ardia window through ScreenCaptureKit (only on
//    change, GPU-scaled, via shared memory). That shows whatever tab is in front, so each frame
//    is shown only after checking ours is still the visible one.
//  - Our tab in the background (or no helper / no Screen Recording): screenshots over CDP,
//    about 100 ms each, back to back while the picture moves (a background tab only draws a
//    frame when screenshotted, so that is also how fast its video plays), slower when still.
const FRAMES = HERE + '../bin/ardia-frames';

async function isVisible() {
  const r = await send('Runtime.evaluate', { expression: 'document.visibilityState', returnByValue: true });
  return r.result.value === 'visible';
}
async function refreshPage() {
  const m = await send('Page.getLayoutMetrics');
  const vp = m.cssVisualViewport || m.layoutViewport;
  page = { width: vp.clientWidth, height: vp.clientHeight };
  const info = await send('Runtime.evaluate', { expression: '[document.visibilityState, document.title + "  " + location.href]', returnByValue: true });
  const [vis, title] = info.result.value || [];
  visible = vis === 'visible';
  header = (live && !visible ? '[background] ' : '') + (title || '');
  const nb = fitBox(page, { cols: process.stdout.columns, rows: process.stdout.rows - 1 }, cell);
  if (nb.cols !== box.cols || nb.rows !== box.rows) { box = nb; dirty = true; }
}
function liveConfig() {
  if (!live || !win) return;
  const c = cropForViewport(win, page);
  live.stdin.write(`crop ${c.x} ${c.y} ${c.width} ${c.height}\nsize ${box.cols * cell.width} ${box.rows * cell.height}\n`);
}

let latest = null, checking = false;
async function onLiveFrame(f) {
  latest = f;
  if (checking) return;  // the running check picks up the newest frame
  checking = true;
  try {
    while (latest) {
      const g = latest; latest = null;
      visible = await isVisible();
      dbg(`live ${g.name} visible=${visible}`);
      if (visible) show(id => kittyShm(g.name, { id, width: g.w, height: g.h, cols: box.cols, rows: box.rows }));
    }
  } catch {} finally { checking = false; }
}

// One screenshot at a time goes to the helper; it answers with "png <name> <w> <h>" (or "png -").
const HELPER_PNG = `${tmpdir()}/ardia-pane-shot-${process.pid}.png`;
let pngWait = null, helperReady = false;
function helperPng(buf) {
  return new Promise(resolve => {
    const done = g => { if (pngWait === done) { pngWait = null; resolve(g); } };
    pngWait = done;
    writeFileSync(HELPER_PNG, buf);
    live.stdin.write(`png ${HELPER_PNG} ${box.cols * cell.width} ${box.rows * cell.height}\n`);
    setTimeout(() => done(null), 1000);
  });
}

function startLive() {
  if (!existsSync(FRAMES) || process.env.ARDIA_PANE_LIVE === '0') return;
  live = spawn(FRAMES, [String(box.cols * cell.width), String(box.rows * cell.height), '0', '0', String(page.width), String(page.height)],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  let errs = '';
  live.stderr.setEncoding('utf8').on('data', d => {
    const w = /window (\d+)x(\d+)/.exec(d);
    if (w) { win = { width: +w[1], height: +w[2] }; liveConfig(); } else errs += d;
  });
  let buf = '';
  live.stdout.setEncoding('utf8').on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const f = parseHelperLine(buf.slice(0, i)); buf = buf.slice(i + 1);
      if (f?.kind === 'ready') helperReady = true;
      else if (f?.kind === 'png') pngWait?.(f.name ? f : null);
      else if (f) onLiveFrame(f);
    }
  });
  live.on('exit', () => { live = null; helperReady = false; pngWait?.(null); header = `(live view stopped: ${errs.trim().split('\n').pop() || 'helper exited'}; using screenshots)`; drawHeader(); });
}

await refreshPage();
startLive();
for (let n = 0; ; n++) {
  const t0 = Date.now();
  const wasVisible = visible;
  try {
    if (n % 5 === 0 || dirty) await refreshPage(); else visible = await isVisible();
    if (dirty) liveConfig();
    // Screenshots while live frames can't show our tab, plus one when it comes back to the front.
    if (!live || !visible || !wasVisible) await shot();
    if (n % 5 === 0) drawHeader();
  } catch (e) { header = `(${e.message})`; drawHeader(); }
  const gap = frameGap({ live, visible, sinceInput: Date.now() - lastInput, sinceChange: Date.now() - lastChange });
  await new Promise(r => setTimeout(r, Math.max(0, gap - (Date.now() - t0))));
}
