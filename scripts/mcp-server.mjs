#!/usr/bin/env node
// ardia-mcp - ardia-cdp as an MCP server, so any MCP client (Claude Code, Cursor, Codex, Zed…)
// can open, read, drive and screenshot pages in the Ardia the user already has open, in the right
// profile, without needing an extension in the browser.
//
// Run: node mcp-server.mjs          (stdio, newline-delimited JSON-RPC; nothing on stdout but replies)
//
// Every tool is a thin call to ardia-cdp.mjs next to this file, so the two can't drift apart.
// Pages open in the background by default (see "open" in ardia-cdp.mjs): the user's own tab and
// profile stay where they are while the agent works.

import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLIENT = join(HERE, 'ardia-cdp.mjs');
const PROTOCOL = '2025-06-18';

const target = { type: 'string', description: 'A target id (or unique prefix) from list_tabs.' };

export const TOOLS = [
  {
    name: 'open_page',
    description: 'Open a URL in Ardia. Reuses the tab already showing it, in the profile asked for if given. ' +
      'Quiet by default: the tab opens in the background and the user\'s page and profile do not move. ' +
      'Pass foreground only when the user asked to see the page in Ardia.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'The page to open.' },
        profile: { type: 'string', description: 'Ardia profile name, e.g. "Personal" or "Work" (per/work also work). Omit for the profile in front.' },
        foreground: { type: 'boolean', description: 'Show the tab in Ardia instead of leaving it in the background.' },
      },
      required: ['url'],
    },
  },
  {
    name: 'list_tabs',
    description: 'Every Ardia tab, by profile, with the target id to use for the other tools.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'read_page',
    description: 'The page\'s structure as an accessibility tree. Prefer this over HTML for reading a page.',
    inputSchema: { type: 'object', properties: { target }, required: ['target'] },
  },
  {
    name: 'evaluate',
    description: 'Run JavaScript in the page and return its value (JSON for objects).',
    inputSchema: {
      type: 'object',
      properties: { target, expression: { type: 'string', description: 'A JavaScript expression; await is allowed.' } },
      required: ['target', 'expression'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the tab to a URL and wait for it to load.',
    inputSchema: { type: 'object', properties: { target, url: { type: 'string' } }, required: ['target', 'url'] },
  },
  {
    name: 'click',
    description: 'Click the first element matching a CSS selector.',
    inputSchema: { type: 'object', properties: { target, selector: { type: 'string' } }, required: ['target', 'selector'] },
  },
  {
    name: 'type_text',
    description: 'Type text into whatever has focus in the page (works inside cross-origin frames).',
    inputSchema: { type: 'object', properties: { target, text: { type: 'string' } }, required: ['target', 'text'] },
  },
  {
    name: 'screenshot',
    description: 'A PNG of the tab\'s viewport, returned as an image.',
    inputSchema: { type: 'object', properties: { target }, required: ['target'] },
  },
  {
    name: 'wait_for',
    description: 'Wait for the user to finish something in the tab: a login, a 2FA code, a payment. ' +
      'Evaluates a JS expression in the page until it is truthy. Run it, tell the user what to do, ' +
      'and continue when it returns. With hand, the tab is brought to the front first.',
    inputSchema: {
      type: 'object',
      properties: {
        target,
        until: { type: 'string', description: 'JS expression that becomes truthy when the user is done, e.g. "!!document.querySelector(\'#inbox\')".' },
        timeout: { type: 'number', description: 'Seconds to wait (default 300).' },
        hand: { type: 'boolean', description: 'Bring the tab to the front for the user first.' },
      },
      required: ['target', 'until'],
    },
  },
];

/** Tool name -> the ardia-cdp arguments. */
const ARGV = {
  open_page: a => ['open', a.url, ...(a.profile ? ['--space', String(a.profile)] : []), ...(a.foreground ? ['--foreground'] : [])],
  list_tabs: () => ['tabs'],
  read_page: a => ['snap', a.target],
  evaluate: a => ['eval', a.target, String(a.expression)],
  navigate: a => ['nav', a.target, a.url],
  click: a => ['click', a.target, a.selector],
  type_text: a => ['type', a.target, String(a.text)],
  screenshot: a => ['shot', a.target],
  wait_for: a => ['wait', a.target, '--until', String(a.until), '--timeout', String(a.timeout ?? 300), ...(a.hand ? ['--hand'] : [])],
};

/** Runs one ardia-cdp command in a child process and collects its output. */
function runCli(argv) {
  return new Promise(resolve => {
    const p = spawn(process.execPath, [CLIENT, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    p.stdout.setEncoding('utf8').on('data', d => out += d);
    p.stderr.setEncoding('utf8').on('data', d => err += d);
    p.on('error', e => resolve({ code: 1, out, err: e.message }));
    p.on('close', code => resolve({ code: code ?? 1, out, err }));
  });
}

const text = t => ({ type: 'text', text: t });

/**
 * The protocol, with the CLI and the file reader injectable so it can be tested without a browser.
 * handle(msg) resolves to the JSON-RPC reply, or null for a notification.
 */
export function createServer({ run = runCli, readImage = path => readFileSync(path).toString('base64'), version = '1.0.0' } = {}) {
  async function callTool(name, args = {}) {
    const tool = TOOLS.find(t => t.name === name);
    if (!tool) return { content: [text(`Unknown tool "${name}". Tools: ${TOOLS.map(t => t.name).join(', ')}`)], isError: true };
    let argv;
    try { argv = ARGV[name](args); } catch (e) { return { content: [text(`Bad arguments for ${name}: ${e.message}`)], isError: true }; }
    const { code, out, err } = await run(argv);
    const output = [out.trim(), err.trim()].filter(Boolean).join('\n');
    const content = [];
    if (output) content.push(text(output));
    // A screenshot is more useful as pixels: the image itself, plus the path and DPR note as text.
    if (name === 'screenshot' && code === 0) {
      const path = out.trim().split('\n')[0];
      try { content.unshift({ type: 'image', data: await readImage(path), mimeType: 'image/png' }); } catch {}
    }
    return { content: content.length ? content : [text(code === 0 ? 'done' : `ardia-cdp ${name} failed (exit ${code})`)], isError: code !== 0 };
  }

  return {
    async handle(msg) {
      const { id, method, params } = msg || {};
      const reply = result => ({ jsonrpc: '2.0', id, result });
      if (id === undefined || id === null) return null;  // notification: no reply
      switch (method) {
        case 'initialize':
          return reply({ protocolVersion: params?.protocolVersion || PROTOCOL, capabilities: { tools: {} },
            serverInfo: { name: 'ardia-cdp', version, title: 'Ardia browser control' } });
        case 'ping': return reply({});
        case 'tools/list': return reply({ tools: TOOLS });
        case 'tools/call': return reply(await callTool(params?.name, params?.arguments));
        default: return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
      }
    },
  };
}

// ── stdio: one JSON-RPC message per line, replies on stdout, logs on stderr ──
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const server = createServer();
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n'); continue; }
      server.handle(msg).then(r => { if (r) process.stdout.write(JSON.stringify(r) + '\n'); },
        e => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id ?? null, error: { code: -32603, message: String(e?.message || e) } }) + '\n'));
    }
  });
  process.stdin.on('end', () => process.exit(0));
  process.stderr.write(`ardia-mcp: ready (client ${CLIENT})\n`);
}
