'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ctx', version: '0.3' };
const LOG_FILE = path.join(os.homedir(), '.config', 'ctx', 'mcp.log');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function makeServer({ tools = [], config = {} } = {}) {
  const toolMap = new Map();
  for (const t of tools) toolMap.set(t.name, t);

  let initialized = false;

  async function dispatch(msg) {
    const { id, method, params } = msg;

    try {
      if (method === 'initialize') {
        initialized = true;
        log(`initialize client=${params?.clientInfo?.name || '?'} proto=${params?.protocolVersion || '?'}`);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        };
      }

      if (method === 'notifications/initialized' || method === 'initialized') {
        return null;
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        const list = [];
        for (const t of toolMap.values()) {
          list.push({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          });
        }
        return { jsonrpc: '2.0', id, result: { tools: list } };
      }

      if (method === 'tools/call') {
        const name = params?.name;
        const args = params?.arguments || {};
        const tool = toolMap.get(name);
        if (!tool) {
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: `error: unknown tool "${name}"` }],
              isError: true,
            },
          };
        }
        log(`tools/call ${name} args=${JSON.stringify(args).slice(0, 200)}`);
        let result;
        try {
          result = await tool.handler(args, { config });
        } catch (err) {
          log(`tool ${name} ERROR: ${err.message}`);
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: `error: ${err.message}` }],
              isError: true,
            },
          };
        }
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return {
          jsonrpc: '2.0', id,
          result: {
            content: [{ type: 'text', text }],
            isError: false,
          },
        };
      }

      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
    } catch (err) {
      log(`dispatch error: ${err.message}`);
      return {
        jsonrpc: '2.0', id,
        error: { code: -32000, message: err.message },
      };
    }
  }

  function handleLine(line, write) {
    const trimmed = line.trim();
    if (!trimmed) return Promise.resolve();
    let msg;
    try { msg = JSON.parse(trimmed); }
    catch { log(`parse error: ${trimmed.slice(0, 120)}`); return Promise.resolve(); }
    return Promise.resolve(dispatch(msg)).then((resp) => {
      if (resp) write(JSON.stringify(resp) + '\n');
    });
  }

  async function runStdio({ stdin = process.stdin, stdout = process.stdout } = {}) {
    stdin.setEncoding('utf8');
    let buf = '';
    const write = (s) => stdout.write(s);
    const queue = [];
    let processing = false;

    async function drain() {
      if (processing) return;
      processing = true;
      while (queue.length) {
        const line = queue.shift();
        await handleLine(line, write);
      }
      processing = false;
    }

    stdin.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        queue.push(line);
      }
      drain();
    });

    return new Promise((resolve) => {
      stdin.on('end', () => { log('stdin closed'); drain().then(resolve); });
    });
  }

  return { dispatch, handleLine, runStdio, toolMap, get initialized() { return initialized; } };
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_INFO,
  LOG_FILE,
  log,
  makeServer,
};
