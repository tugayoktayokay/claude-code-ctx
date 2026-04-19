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
