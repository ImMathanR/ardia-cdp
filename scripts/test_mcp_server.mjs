// Checks for mcp-server.mjs. Run: node --test test_mcp_server.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, TOOLS } from './mcp-server.mjs';

/** A server whose CLI is a recording stub: `calls` holds the argv of every command. */
function stub(out = 'ok', code = 0) {
  const calls = [];
  const server = createServer({
    run: async argv => { calls.push(argv); return { code, out, err: code ? 'boom' : '' }; },
    readImage: async () => 'aGVsbG8=',
  });
  return { server, calls };
}
const call = (server, name, args) =>
  server.handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });

test('initialize answers with a protocol version and the tools capability', async () => {
  const { server } = stub();
  const r = await server.handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'x' } } });
  assert.equal(r.result.protocolVersion, '2025-06-18');
  assert.deepEqual(r.result.capabilities.tools, {});
  assert.equal(r.result.serverInfo.name, 'ardia-cdp');
});

test('tools/list describes every tool with an input schema', async () => {
  const { server } = stub();
  const r = await server.handle({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(r.result.tools.map(t => t.name).sort(), TOOLS.map(t => t.name).sort());
  for (const t of r.result.tools) {
    assert.equal(typeof t.description, 'string');
    assert.equal(t.inputSchema.type, 'object');
  }
});

test('open_page runs the client quietly, with the profile when given', async () => {
  const { server, calls } = stub('Opened tab in the background in Work: ABCD1234  title  https://x.test');
  const r = await call(server, 'open_page', { url: 'https://x.test', profile: 'Work' });
  assert.deepEqual(calls[0], ['open', 'https://x.test', '--space', 'Work']);
  assert.match(r.result.content[0].text, /ABCD1234/);
  assert.ok(!r.result.isError);
});

test('wait_for maps to the wait command, with hand and timeout', async () => {
  const { server, calls } = stub('ready after 2.0s: true');
  await call(server, 'wait_for', { target: 'ABCD1234', until: '!!document.querySelector("#inbox")', timeout: 60, hand: true });
  assert.deepEqual(calls[0], ['wait', 'ABCD1234', '--until', '!!document.querySelector("#inbox")', '--timeout', '60', '--hand']);
});

test('evaluate passes the expression as one argument', async () => {
  const { server, calls } = stub('"Example Domain"');
  await call(server, 'evaluate', { target: 'ABCD1234', expression: 'document.title' });
  assert.deepEqual(calls[0], ['eval', 'ABCD1234', 'document.title']);
});

test('a failing command comes back as an error with its output', async () => {
  const { server } = stub('', 1);
  const r = await call(server, 'evaluate', { target: 'ABCD1234', expression: 'x' });
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /boom/);
});

test('an unknown tool is an error, not a crash', async () => {
  const { server } = stub();
  const r = await call(server, 'nope', {});
  assert.equal(r.result.isError, true);
  assert.match(r.result.content[0].text, /Unknown tool/);
});

test('screenshot returns the image itself, not just a path', async () => {
  const { server, calls } = stub('/tmp/shot.png\nScreenshot saved. Device pixel ratio (DPR): 2');
  const r = await call(server, 'screenshot', { target: 'ABCD1234' });
  assert.equal(calls[0][0], 'shot');
  const img = r.result.content.find(c => c.type === 'image');
  assert.deepEqual(img, { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' });
});

test('notifications get no reply; unknown methods get a JSON-RPC error', async () => {
  const { server } = stub();
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  const r = await server.handle({ jsonrpc: '2.0', id: 9, method: 'resources/list' });
  assert.equal(r.error.code, -32601);
});

test('ping is answered', async () => {
  const { server } = stub();
  assert.deepEqual((await server.handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
});
