import assert from 'node:assert/strict';
import { test } from 'node:test';
import { tmuxWrap, kittyImage, fitBox, cellToPage, parseMouse, tokenize, keyEvent } from './pane-render.mjs';

test('tmuxWrap doubles ESC and frames it', () => {
  assert.equal(tmuxWrap('\x1b_Ga=d\x1b\\'), '\x1bPtmux;\x1b\x1b_Ga=d\x1b\x1b\\\x1b\\');
});

test('kittyImage chunks with m flags, header only on the first', () => {
  const parts = kittyImage('A'.repeat(10), { cols: 4, rows: 2, chunk: 4 });
  assert.equal(parts.length, 3);
  assert.match(parts[0], /^\x1b_Ga=T,f=100,i=1,c=4,r=2,C=1,q=2,m=1;AAAA\x1b\\$/);
  assert.equal(parts[1], '\x1b_Gm=1,q=2;AAAA\x1b\\');
  assert.equal(parts[2], '\x1b_Gm=0,q=2;AA\x1b\\');
});

test('fitBox keeps the page aspect within the pane', () => {
  const cell = { width: 17, height: 37 };
  // 1600x1000 page in an 86x54 pane: width-bound
  assert.deepEqual(fitBox({ width: 1600, height: 1000 }, { cols: 86, rows: 54 }, cell), { cols: 86, rows: 25 });
  // tall page: height-bound
  assert.deepEqual(fitBox({ width: 400, height: 1000 }, { cols: 86, rows: 20 }, cell), { cols: 17, rows: 20 });
});

test('cellToPage maps cell centres and rejects outside cells', () => {
  const box = { cols: 10, rows: 5 }, page = { width: 1000, height: 500 };
  assert.deepEqual(cellToPage(1, 1, box, page), { x: 50, y: 50 });
  assert.deepEqual(cellToPage(10, 5, box, page), { x: 950, y: 450 });
  assert.equal(cellToPage(11, 1, box, page), null);
  assert.equal(cellToPage(1, 0, box, page), null);
});

test('parseMouse reads SGR clicks, releases, wheel', () => {
  assert.deepEqual(parseMouse('\x1b[<0;12;7M'), { kind: 'down', button: 'left', col: 12, row: 7 });
  assert.deepEqual(parseMouse('\x1b[<0;12;7m'), { kind: 'up', button: 'left', col: 12, row: 7 });
  assert.deepEqual(parseMouse('\x1b[<65;3;4M'), { kind: 'wheel', dy: 1, col: 3, row: 4 });
  assert.deepEqual(parseMouse('\x1b[<64;3;4M'), { kind: 'wheel', dy: -1, col: 3, row: 4 });
  assert.equal(parseMouse('x'), null);
});

test('tokenize splits mouse, arrows and text', () => {
  assert.deepEqual(tokenize('hi\x1b[A\x1b[<0;1;2M\r'), ['h', 'i', '\x1b[A', '\x1b[<0;1;2M', '\r']);
  assert.deepEqual(tokenize('\x1b'), ['\x1b']);
});

test('keyEvent: special keys, text, ignored controls', () => {
  assert.equal(keyEvent('\r').special.key, 'Enter');
  assert.deepEqual(keyEvent('a'), { text: 'a' });
  assert.equal(keyEvent('\x01'), null);
});

import { kittyVirtual, placeholderRows } from './pane-render.mjs';

test('placeholderRows: row/col diacritics on the first cell, id as 256-colour fg', () => {
  const rows = placeholderRows(7, 3, 2);
  const P = '\u{10EEEE}';
  assert.equal(rows[0], `\x1b[38;5;7m${P}̅̅${P}${P}\x1b[39m`);
  assert.equal(rows[1], `\x1b[38;5;7m${P}̍̅${P}${P}\x1b[39m`);
});

test('kittyVirtual asks for a virtual placement', () => {
  assert.match(kittyVirtual('/tmp/a', { id: 7, cols: 2, rows: 1 }), /^\x1b_Ga=T,t=t,f=100,i=7,U=1,c=2,r=1,q=2;/);
});

import { kittyShm, cropForViewport } from './pane-render.mjs';

test('kittyShm sends a shared-memory RGB frame with a virtual placement', () => {
  assert.equal(kittyShm('/ardia-pane-1-2', { id: 42, width: 8, height: 4, cols: 2, rows: 1 }),
    `\x1b_Ga=T,t=s,f=24,s=8,v=4,i=42,U=1,c=2,r=1,q=2;${Buffer.from('/ardia-pane-1-2').toString('base64')}\x1b\\`);
});

test('cropForViewport: web content sits right-aligned with equal top/bottom/right margins', () => {
  assert.deepEqual(cropForViewport({ width: 1920, height: 1080 }, { width: 1596, height: 1062 }), { x: 315, y: 9, width: 1596, height: 1062 });
  // full-bleed window (no sidebar, no margins)
  assert.deepEqual(cropForViewport({ width: 1200, height: 800 }, { width: 1200, height: 800 }), { x: 0, y: 0, width: 1200, height: 800 });
});

import { swapFrame } from './pane-render.mjs';

test('swapFrame transmits to the image not on screen and points the placeholders at that same image', () => {
  // Whatever the source (live frame or screenshot), the placeholders must name the id just sent.
  for (const [shown, next] of [[0, 42], [42, 43], [43, 42]]) {
    const f = swapFrame(shown, id => `T${id}`, 2, 1);
    assert.equal(f.next, next);
    assert.equal(f.transmit, `T${next}`);
    assert.deepEqual(f.rows, placeholderRows(next, 2, 1));
  }
});

import { frameGap } from './pane-render.mjs';

test('frameGap: a moving background tab is screenshotted 5 times a second, input gets them back to back', () => {
  // A background tab only draws a frame when screenshotted, so a video there plays at the screenshot rate.
  // Back to back (~10/s) cost Ardia ~45% CPU; 5/s keeps a video watchable for about half that.
  assert.equal(frameGap({ live: true, visible: false, sinceInput: 60000, sinceChange: 100 }), 200);
  assert.equal(frameGap({ live: false, visible: true, sinceInput: 60000, sinceChange: 100 }), 200);
  // right after a click or key, show the result as fast as possible
  assert.equal(frameGap({ live: true, visible: false, sinceInput: 500, sinceChange: 100 }), 0);
  assert.equal(frameGap({ live: true, visible: false, sinceInput: 500, sinceChange: 60000 }), 0);
  // still picture, no input: slow down
  assert.equal(frameGap({ live: true, visible: false, sinceInput: 60000, sinceChange: 60000 }), 400);
  // front tab with the live stream: only the visibility/size check runs
  assert.equal(frameGap({ live: true, visible: true, sinceInput: 0, sinceChange: 0 }), 150);
});

import { parseHelperLine } from './pane-render.mjs';

test('parseHelperLine tells live frames from converted screenshots', () => {
  assert.deepEqual(parseHelperLine('/ardia-pane-9-3 800 600'), { kind: 'live', name: '/ardia-pane-9-3', w: 800, h: 600 });
  assert.deepEqual(parseHelperLine('png /ardia-pane-9-4 400 300'), { kind: 'png', name: '/ardia-pane-9-4', w: 400, h: 300 });
  assert.deepEqual(parseHelperLine('png -'), { kind: 'png', name: null });
  assert.deepEqual(parseHelperLine('ready'), { kind: 'ready' });
  assert.equal(parseHelperLine(''), null);
});
