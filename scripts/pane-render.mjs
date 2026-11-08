// pane-render - pure helpers for ardia-pane: draw a PNG in a terminal pane with
// the kitty graphics protocol (Ghostty speaks it; tmux needs it passed through)
// and turn the pane's mouse and key input into CDP input events.

/** Wraps an escape sequence so tmux passes it to the outer terminal (allow-passthrough on). */
export function tmuxWrap(seq) {
  return `\x1bPtmux;${seq.replaceAll('\x1b', '\x1b\x1b')}\x1b\\`;
}

/** kitty graphics commands that show a base64 PNG as image `id`, scaled to cols x rows cells. */
export function kittyImage(b64, { id = 1, cols, rows, chunk = 4096 } = {}) {
  const out = [];
  for (let i = 0; i < b64.length; i += chunk) {
    const more = i + chunk < b64.length ? 1 : 0;
    const head = i === 0 ? `a=T,f=100,i=${id},c=${cols},r=${rows},C=1,q=2,m=${more}` : `m=${more},q=2`;
    out.push(`\x1b_G${head};${b64.slice(i, i + chunk)}\x1b\\`);
  }
  return out;
}

/** Deletes image `id` and its placements. */
export function kittyDelete(id = 1) {
  return `\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`;
}

/** The largest cols x rows box with the page's aspect that fits in the pane's area. */
export function fitBox(page, area, cell) {
  const aspect = page.width / page.height;
  let cols = area.cols;
  let rows = Math.round((cols * cell.width) / aspect / cell.height);
  if (rows > area.rows) {
    rows = area.rows;
    cols = Math.round((rows * cell.height * aspect) / cell.width);
  }
  return { cols: Math.max(1, cols), rows: Math.max(1, rows) };
}

/** A pane cell (1-based, relative to the image's top-left cell) -> CSS px on the page, or null if outside. */
export function cellToPage(col, row, box, page) {
  if (col < 1 || row < 1 || col > box.cols || row > box.rows) return null;
  return {
    x: Math.round(((col - 0.5) / box.cols) * page.width),
    y: Math.round(((row - 0.5) / box.rows) * page.height),
  };
}

/** SGR mouse report (ESC [ < b ; x ; y M|m) -> {kind, button, col, row}. */
export function parseMouse(s) {
  const m = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(s);
  if (!m) return null;
  const b = Number(m[1]), col = Number(m[2]), row = Number(m[3]);
  if (b & 64) return { kind: 'wheel', dy: b & 1 ? 1 : -1, col, row };
  if (b & 32) return { kind: 'move', col, row };
  return { kind: m[4] === 'M' ? 'down' : 'up', button: ['left', 'middle', 'right'][b & 3] || 'left', col, row };
}

const KEYS = {
  '\r': { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  '\x7f': { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  '\t': { key: 'Tab', code: 'Tab', keyCode: 9 },
  '\x1b': { key: 'Escape', code: 'Escape', keyCode: 27 },
  '\x1b[A': { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  '\x1b[B': { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  '\x1b[C': { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  '\x1b[D': { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  '\x1b[3~': { key: 'Delete', code: 'Delete', keyCode: 46 },
  '\x1b[5~': { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  '\x1b[6~': { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};

/** Splits raw terminal input into tokens: mouse reports, known key sequences, single characters. */
export function tokenize(s) {
  const out = [];
  let i = 0;
  while (i < s.length) {
    const mouse = /^\x1b\[<\d+;\d+;\d+[Mm]/.exec(s.slice(i));
    if (mouse) { out.push(mouse[0]); i += mouse[0].length; continue; }
    const seq = Object.keys(KEYS).filter(k => k.length > 1 && s.startsWith(k, i)).sort((a, b) => b.length - a.length)[0];
    if (seq) { out.push(seq); i += seq.length; continue; }
    const ch = String.fromCodePoint(s.codePointAt(i));
    out.push(ch);
    i += ch.length;
  }
  return out;
}

/** A key token -> {special: CDP key event fields} or {text} to insert, or null (unhandled control key). */
export function keyEvent(tok) {
  if (KEYS[tok]) return { special: KEYS[tok] };
  if (tok >= ' ' ) return { text: tok };
  return null;
}

// Page.captureScreenshot's clip.scale works by overriding the page's device metrics, which
// visibly resizes the tab in Ardia (and can stick). So capture at full size and let the
// terminal decode and scale the PNG, handed over as a temp file rather than through tmux.

// ── Unicode placeholders ──
// A directly placed image is erased whenever tmux redraws the pane, which is often (status
// line, window switches), so it flickers. With a virtual placement (U=1) the pane holds
// U+10EEEE placeholder characters instead: tmux redraws them like any text and the terminal
// paints the image behind them. Each row's first cell carries its row and column diacritics
// (kitty's rowcolumn-diacritics.txt); the rest of the row continues from it.
const DIACRITICS = [0x0305,0x030D,0x030E,0x0310,0x0312,0x033D,0x033E,0x033F,0x0346,0x034A,0x034B,0x034C,0x0350,0x0351,0x0352,0x0357,0x035B,0x0363,0x0364,0x0365,0x0366,0x0367,0x0368,0x0369,0x036A,0x036B,0x036C,0x036D,0x036E,0x036F,0x0483,0x0484,0x0485,0x0486,0x0487,0x0592,0x0593,0x0594,0x0595,0x0597,0x0598,0x0599,0x059C,0x059D,0x059E,0x059F,0x05A0,0x05A1,0x05A8,0x05A9,0x05AB,0x05AC,0x05AF,0x05C4,0x0610,0x0611,0x0612,0x0613,0x0614,0x0615,0x0616,0x0617,0x0657,0x0658,0x0659,0x065A,0x065B,0x065D,0x065E,0x06D6,0x06D7,0x06D8,0x06D9,0x06DA,0x06DB,0x06DC,0x06DF,0x06E0,0x06E1,0x06E2,0x06E4,0x06E7,0x06E8,0x06EB,0x06EC,0x0730,0x0732,0x0733,0x0735,0x0736,0x073A,0x073D,0x073F,0x0740,0x0741,0x0743,0x0745,0x0747,0x0749,0x074A,0x07EB,0x07EC,0x07ED,0x07EE,0x07EF,0x07F0,0x07F1,0x07F3,0x0816,0x0817,0x0818,0x0819,0x081B,0x081C,0x081D,0x081E,0x081F,0x0820,0x0821,0x0822];
const PLACEHOLDER = String.fromCodePoint(0x10eeee);

/** kitty command: transmit the PNG in temp file `path` as image `id` with a virtual placement. */
export function kittyVirtual(path, { id, cols, rows }) {
  return `\x1b_Ga=T,t=t,f=100,i=${id},U=1,c=${cols},r=${rows},q=2;${Buffer.from(path).toString('base64')}\x1b\\`;
}

/** The placeholder text for each row of image `id` (id < 256, sent as its 256-colour foreground). */
export function placeholderRows(id, cols, rows) {
  if (rows > DIACRITICS.length) throw new Error(`at most ${DIACRITICS.length} rows`);
  return Array.from({ length: rows }, (_, r) =>
    `\x1b[38;5;${id}m${PLACEHOLDER}${String.fromCodePoint(DIACRITICS[r], DIACRITICS[0])}${PLACEHOLDER.repeat(cols - 1)}\x1b[39m`);
}

// ── Live frames from ardia-frames (ScreenCaptureKit) ──

/** kitty command: show the RGB frame in shared-memory object `name` as image `id` (virtual placement). */
export function kittyShm(name, { id, width, height, cols, rows }) {
  return `\x1b_Ga=T,t=s,f=24,s=${width},v=${height},i=${id},U=1,c=${cols},r=${rows},q=2;${Buffer.from(name).toString('base64')}\x1b\\`;
}

/**
 * Where the page sits in the Ardia window, in window points. The web view is right-aligned
 * (the sidebar is on the left) with the same margin above, below and to the right of it.
 */
export function cropForViewport(win, vp) {
  const m = Math.max(0, Math.round((win.height - vp.height) / 2));
  return { x: Math.max(0, win.width - vp.width - m), y: m, width: vp.width, height: vp.height };
}

/**
 * Double buffering over images 42 and 43: send the next frame to the image that isn't on screen,
 * then point the placeholders at it. Replacing the shown image in place leaves a moment with
 * nothing to draw (flicker). Used for live frames and screenshots alike.
 */
export function swapFrame(shown, transmit, cols, rows) {
  const next = shown === 42 ? 43 : 42;
  return { next, transmit: transmit(next), rows: placeholderRows(next, cols, rows) };
}

/**
 * Milliseconds to wait before the next round of the frame loop. A background tab draws a new
 * frame only when it's screenshotted (its animations and video are otherwise paused). Right after
 * input, take screenshots back to back so the result shows at once; while the picture is changing,
 * 5 a second (back to back, ~10 a second, cost Ardia ~45% CPU). When the front tab is streamed
 * live, the loop only checks visibility and size.
 */
export function frameGap({ live, visible, sinceInput, sinceChange }) {
  if (live && visible) return 150;
  if (sinceInput < 3000) return 0;
  return sinceChange < 2000 ? 200 : 400;
}

/**
 * A line from ardia-frames: "ready" (it now reads commands), a live frame "<name> <w> <h>",
 * or a converted screenshot "png <name> <w> <h>" / "png -".
 */
export function parseHelperLine(line) {
  const p = line.trim().split(' ');
  if (p[0] === 'ready') return { kind: 'ready' };
  if (p[0] === 'png') return p[1] && p[1] !== '-' ? { kind: 'png', name: p[1], w: +p[2], h: +p[3] } : { kind: 'png', name: null };
  return p[0] ? { kind: 'live', name: p[0], w: +p[1], h: +p[2] } : null;
}
