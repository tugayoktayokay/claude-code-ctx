'use strict';

const test   = require('node:test');
const assert = require('node:assert/strict');
const fs     = require('fs');
const os     = require('os');
const path   = require('path');
const { makeServer } = require('../mcp.js');

function mkServer() {
  return makeServer({
    tools: [
      {
        name: 'echo',
        description: 'echo back',
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
        handler: async (args) => `echoed: ${args.text}`,
      },
      {
        name: 'boom',
        description: 'throws',
        inputSchema: { type: 'object' },
        handler: async () => { throw new Error('kaboom'); },
      },
    ],
    config: {},
  });
}

test('initialize returns protocolVersion + tools capability', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test' } },
  });
  assert.equal(resp.id, 1);
  assert.ok(resp.result.protocolVersion);
  assert.ok(resp.result.capabilities.tools);
  assert.equal(resp.result.serverInfo.name, 'ctx');
});

test('tools/list returns registered tools with inputSchema', async () => {
  const s = mkServer();
  const resp = await s.dispatch({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.equal(resp.result.tools.length, 2);
  const echo = resp.result.tools.find(t => t.name === 'echo');
  assert.ok(echo);
  assert.equal(echo.inputSchema.required[0], 'text');
});

test('tools/call invokes handler and wraps content', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 'hi' } },
  });
  assert.equal(resp.result.isError, false);
  assert.equal(resp.result.content[0].text, 'echoed: hi');
});

test('tools/call unknown tool returns isError=true', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'missing', arguments: {} },
  });
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /unknown tool/);
});

test('tools/call handler throw is caught and reported', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 5, method: 'tools/call',
    params: { name: 'boom', arguments: {} },
  });
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /kaboom/);
});

test('notifications/initialized returns null (no response)', async () => {
  const s = mkServer();
  const resp = await s.dispatch({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(resp, null);
});

test('unknown method returns jsonrpc error', async () => {
  const s = mkServer();
  const resp = await s.dispatch({ jsonrpc: '2.0', id: 6, method: 'frobnicate' });
  assert.ok(resp.error);
  assert.equal(resp.error.code, -32601);
});

test('roots/list + prompts/list + resources/list return empty arrays not errors', async () => {
  const s = mkServer();
  const roots  = await s.dispatch({ jsonrpc: '2.0', id: 7,  method: 'roots/list' });
  const prompts = await s.dispatch({ jsonrpc: '2.0', id: 8,  method: 'prompts/list' });
  const resources = await s.dispatch({ jsonrpc: '2.0', id: 9,  method: 'resources/list' });
  const tmpls = await s.dispatch({ jsonrpc: '2.0', id: 10, method: 'resources/templates/list' });
  assert.deepEqual(roots.result.roots, []);
  assert.deepEqual(prompts.result.prompts, []);
  assert.deepEqual(resources.result.resources, []);
  assert.deepEqual(tmpls.result.resourceTemplates, []);
});

test('logging/setLevel returns success without doing anything', async () => {
  const s = mkServer();
  const resp = await s.dispatch({ jsonrpc: '2.0', id: 11, method: 'logging/setLevel', params: { level: 'debug' } });
  assert.ok(resp.result);
  assert.equal(resp.error, undefined);
});

test('tools/call with missing required arg returns -32602', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 12, method: 'tools/call',
    params: { name: 'echo', arguments: {} },
  });
  assert.ok(resp.error);
  assert.equal(resp.error.code, -32602);
  assert.match(resp.error.message, /text/);
});

test('tools/call with wrong type returns -32602', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 13, method: 'tools/call',
    params: { name: 'echo', arguments: { text: 123 } },
  });
  assert.ok(resp.error);
  assert.equal(resp.error.code, -32602);
  assert.match(resp.error.message, /string/);
});

test('notifications/cancelled triggers in-flight abort', async () => {
  let started = false;
  const s = makeServerWith({
    tools: [{
      name: 'long',
      description: 'sleeps unless aborted',
      inputSchema: { type: 'object' },
      handler: async (_args, { signal }) => {
        started = true;
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => resolve('done'), 5000);
          signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
        });
      },
    }],
  });

  const pending = s.dispatch({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'long', arguments: {} } });
  await new Promise(r => setTimeout(r, 30));
  assert.ok(started, 'handler started before cancel');
  assert.equal(s._inflight.size, 1);
  await s.dispatch({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } });
  const resp = await pending;
  assert.equal(resp.result.isError, true);
  assert.match(resp.result.content[0].text, /cancelled/);
  assert.equal(s._inflight.size, 0);
});

test('initialize negotiates back the client protocol version if supported', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 100, method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'x' } },
  });
  assert.equal(resp.result.protocolVersion, '2025-06-18');
});

test('initialize falls back to default on unknown protocol version', async () => {
  const s = mkServer();
  const resp = await s.dispatch({
    jsonrpc: '2.0', id: 101, method: 'initialize',
    params: { protocolVersion: '1999-01-01', capabilities: {}, clientInfo: { name: 'x' } },
  });
  assert.equal(resp.result.protocolVersion, '2024-11-05');
});

test('progress notifications fire when progressToken present', async () => {
  const notes = [];
  const s = makeServerWith({
    tools: [{
      name: 'tick',
      description: 'ticks',
      inputSchema: { type: 'object' },
      handler: async (_args, { sendProgress }) => {
        sendProgress(1, 3);
        sendProgress(2, 3);
        sendProgress(3, 3);
        return 'done';
      },
    }],
  });

  const resp = await s.dispatch(
    {
      jsonrpc: '2.0', id: 200, method: 'tools/call',
      params: { name: 'tick', arguments: {}, _meta: { progressToken: 'abc' } },
    },
    { sendNotification: (n) => notes.push(n) },
  );
  assert.equal(resp.result.isError, false);
  assert.equal(notes.length, 3);
  assert.equal(notes[0].method, 'notifications/progress');
  assert.equal(notes[2].params.progress, 3);
});

test('handleLine strips trailing CR (CRLF tolerant)', async () => {
  const s = mkServer();
  const lines = [];
  const write = (s) => lines.push(s);
  await s.handleLine('{"jsonrpc":"2.0","id":5,"method":"ping"}\r', write);
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.id, 5);
  assert.deepEqual(parsed.result, {});
});

function makeServerWith(opts) {
  const { makeServer } = require('../mcp.js');
  return makeServer({ ...opts, config: {} });
}
