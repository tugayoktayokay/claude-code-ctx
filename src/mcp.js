'use strict';

const fs   = require('fs');
const os   = require('os');
const path = require('path');

const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';
const SERVER_INFO = { name: 'ctx', version: '0.3' };
const LOG_FILE = path.join(os.homedir(), '.config', 'ctx', 'mcp.log');

function log(line) {
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function validateArgs(args, schema) {
  if (!schema || typeof schema !== 'object') return null;
  if (schema.type && schema.type !== 'object') return null;
  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (args == null || !(key in args) || args[key] === undefined || args[key] === null) {
      return `missing required argument: ${key}`;
    }
  }
  if (schema.properties && args && typeof args === 'object') {
    for (const [key, def] of Object.entries(schema.properties)) {
      if (!(key in args)) continue;
      const v = args[key];
      if (v == null) continue;
      const t = def && def.type;
      if (!t) continue;
      if (t === 'string'  && typeof v !== 'string')  return `arg ${key}: expected string`;
      if (t === 'integer' && !Number.isInteger(v))   return `arg ${key}: expected integer`;
      if (t === 'number'  && typeof v !== 'number')  return `arg ${key}: expected number`;
      if (t === 'boolean' && typeof v !== 'boolean') return `arg ${key}: expected boolean`;
      if (t === 'array'   && !Array.isArray(v))      return `arg ${key}: expected array`;
      if (t === 'object'  && (typeof v !== 'object' || Array.isArray(v))) return `arg ${key}: expected object`;
      if (def.enum && !def.enum.includes(v)) return `arg ${key}: must be one of ${def.enum.join('|')}`;
    }
  }
  return null;
}

function negotiateProtocolVersion(clientVersion) {
  if (clientVersion && SUPPORTED_PROTOCOL_VERSIONS.includes(clientVersion)) return clientVersion;
  return DEFAULT_PROTOCOL_VERSION;
}

function makeServer({ tools = [], config = {} } = {}) {
  const toolMap = new Map();
  for (const t of tools) toolMap.set(t.name, t);

  const inflight = new Map();
  let initialized = false;

  function cancelInflight(requestId, reason) {
    const entry = inflight.get(requestId);
    if (!entry) return false;
    try { entry.cancel && entry.cancel(reason || 'cancelled by client'); } catch {}
    inflight.delete(requestId);
    log(`cancelled id=${requestId} reason="${reason || '-'}"`);
    return true;
  }

  async function dispatch(msg, { sendNotification } = {}) {
    const { id, method, params } = msg;
    const send = typeof sendNotification === 'function' ? sendNotification : () => {};

    try {
      if (method === 'initialize') {
        initialized = true;
        const negotiated = negotiateProtocolVersion(params?.protocolVersion);
        log(`initialize client=${params?.clientInfo?.name || '?'} requested=${params?.protocolVersion || '?'} negotiated=${negotiated}`);
        return {
          jsonrpc: '2.0', id,
          result: {
            protocolVersion: negotiated,
            capabilities: {
              tools:     { listChanged: false },
              prompts:   { listChanged: false },
              resources: { listChanged: false, subscribe: false },
              logging:   {},
            },
            serverInfo: SERVER_INFO,
          },
        };
      }

      if (method === 'notifications/initialized' || method === 'initialized') return null;

      if (method === 'notifications/cancelled') {
        const rid = params?.requestId;
        if (rid != null) cancelInflight(rid, params?.reason);
        return null;
      }

      if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

      if (method === 'logging/setLevel') {
        log(`logging/setLevel level=${params?.level || '?'}`);
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        const list = [];
        for (const t of toolMap.values()) {
          list.push({ name: t.name, description: t.description, inputSchema: t.inputSchema });
        }
        return { jsonrpc: '2.0', id, result: { tools: list } };
      }

      if (method === 'prompts/list')   return { jsonrpc: '2.0', id, result: { prompts: [] } };
      if (method === 'prompts/get') {
        return {
          jsonrpc: '2.0', id,
          error: { code: -32602, message: `unknown prompt: ${params?.name || ''}` },
        };
      }
      if (method === 'resources/list')           return { jsonrpc: '2.0', id, result: { resources: [] } };
      if (method === 'resources/templates/list') return { jsonrpc: '2.0', id, result: { resourceTemplates: [] } };
      if (method === 'resources/read') {
        return {
          jsonrpc: '2.0', id,
          error: { code: -32602, message: `unknown resource: ${params?.uri || ''}` },
        };
      }
      if (method === 'resources/subscribe' || method === 'resources/unsubscribe') {
        return { jsonrpc: '2.0', id, result: {} };
      }
      if (method === 'roots/list') return { jsonrpc: '2.0', id, result: { roots: [] } };
      if (method === 'completion/complete') {
        return { jsonrpc: '2.0', id, result: { completion: { values: [], total: 0, hasMore: false } } };
      }

      if (method === 'tools/call') {
        const name = params?.name;
        const args = params?.arguments || {};
        const tool = toolMap.get(name);
        if (!tool) {
          return {
            jsonrpc: '2.0', id,
            result: { content: [{ type: 'text', text: `error: unknown tool "${name}"` }], isError: true },
          };
        }

        const validationErr = validateArgs(args, tool.inputSchema);
        if (validationErr) {
          return {
            jsonrpc: '2.0', id,
            error: { code: -32602, message: `Invalid params: ${validationErr}` },
          };
        }

        const progressToken = params?._meta?.progressToken;
        const abortController = new AbortController();

        inflight.set(id, {
          cancel: (reason) => abortController.abort(reason),
        });

        const sendProgress = (progress, total) => {
          if (progressToken == null) return;
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress, ...(total == null ? {} : { total }) },
          });
        };

        log(`tools/call id=${id} ${name} args=${JSON.stringify(args).slice(0, 200)}`);

        let result;
        try {
          result = await tool.handler(args, {
            config,
            signal: abortController.signal,
            sendProgress,
            requestId: id,
          });
        } catch (err) {
          inflight.delete(id);
          const aborted = abortController.signal.aborted;
          log(`tool ${name} ${aborted ? 'CANCELLED' : 'ERROR'}: ${err.message}`);
          return {
            jsonrpc: '2.0', id,
            result: {
              content: [{ type: 'text', text: aborted ? 'cancelled' : `error: ${err.message}` }],
              isError: true,
            },
          };
        }
        inflight.delete(id);
        const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return {
          jsonrpc: '2.0', id,
          result: { content: [{ type: 'text', text }], isError: false },
        };
      }

      return {
        jsonrpc: '2.0', id,
        error: { code: -32601, message: `method not found: ${method}` },
      };
    } catch (err) {
      inflight.delete(id);
      log(`dispatch error: ${err.message}`);
      return {
        jsonrpc: '2.0', id,
        error: { code: -32000, message: err.message },
      };
    }
  }

  function handleLine(line, write) {
    const trimmed = line.replace(/\r$/, '').trim();
    if (!trimmed) return Promise.resolve();
    let msg;
    try { msg = JSON.parse(trimmed); }
    catch { log(`parse error: ${trimmed.slice(0, 120)}`); return Promise.resolve(); }

    const sendNotification = (note) => write(JSON.stringify(note) + '\n');
    return Promise.resolve(dispatch(msg, { sendNotification })).then((resp) => {
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
        handleLine(line, write);
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
      stdin.on('end', () => { log('stdin closed'); resolve(); });
    });
  }

  return {
    dispatch,
    handleLine,
    runStdio,
    toolMap,
    cancelInflight,
    get initialized() { return initialized; },
    _inflight: inflight,
  };
}

module.exports = {
  PROTOCOL_VERSION: DEFAULT_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
  SERVER_INFO,
  LOG_FILE,
  log,
  makeServer,
  validateArgs,
  negotiateProtocolVersion,
};
