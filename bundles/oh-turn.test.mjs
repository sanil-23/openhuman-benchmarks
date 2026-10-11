import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';

async function runTurn({ active = false, smoke = false, unsupported = false, memoryOperationsActive = false } = {}) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end('ok');
    let body = '';
    for await (const chunk of req) body += chunk;
    const { method, id } = JSON.parse(body);
    calls.push(method);
    const values = {
      'openhuman.subsystems_status': { subsystems: [{ slot: 'memory', driver: active ? 'tinyhumans' : 'null', fell_back_from: null }] },
      'openhuman.memory_engine_get': { engine: active ? 'tinyhumans' : null, status: active ? 'ok' : 'off' },
      'openhuman.memory_policy_get': { log_conversations: false, recall: { enabled: false } },
      'openhuman.embeddings_get_settings': { result: { effective_provider: 'none', model: 'embedding-v1' }, logs: [] },
      'openhuman.inference_agent_chat': { reply: 'READY' },
    };
    if (['openhuman.memory_learn', 'openhuman.memory_recall'].includes(method)) {
      res.end(JSON.stringify(memoryOperationsActive
        ? { jsonrpc: '2.0', id, result: { id: 'unexpected' } }
        : { jsonrpc: '2.0', id, error: { code: -32000, data: { code: 'MEMORY_OFF' } } }));
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(unsupported && method !== 'openhuman.inference_agent_chat'
      ? { jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found' } }
      : { jsonrpc: '2.0', id, result: values[method] }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-turn-'));
  try {
    fs.writeFileSync(path.join(dir, 'prompt.txt'), 'READY');
    const script = process.env.OH_TURN_SCRIPT || new URL('./oh-turn.mjs', import.meta.url).pathname;
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, OH_PORT: String(server.address().port), OH_TOKEN: 'test',
        RESULT_DIR: dir, PROMPT_FILE: path.join(dir, 'prompt.txt'),
        BENCH_TASK_ID: smoke ? 'm6-memory-policy' : 'm1-hello' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (c) => output += c);
    child.stderr.on('data', (c) => output += c);
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });
    const file = path.join(dir, 'memory-state.json');
    return { code, calls, output, memory: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : null };
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('an enabled memory engine stops setup before inference and records failure', async () => {
  const r = await runTurn({ active: true });
  assert.equal(r.code, 3, r.output);
  assert.equal(r.memory.verified, false);
  assert.equal(r.memory.driver, 'tinyhumans');
  assert.equal(r.calls.includes('openhuman.inference_agent_chat'), false);
});

test('an old bundle with no memory status RPC fails visibly', async () => {
  const r = await runTurn({ unsupported: true });
  assert.equal(r.code, 3, r.output);
  assert.equal(r.memory.verified, false);
  assert.match(r.memory.error, /RPC.*failed/);
  assert.equal(r.calls.includes('openhuman.inference_agent_chat'), false);
});

test('memory policy micro smoke verifies the running core without inference', async () => {
  const r = await runTurn({ smoke: true });
  assert.equal(r.code, 0, r.output);
  assert.equal(r.memory.verified, true);
  assert.equal(r.calls.length, 6);
  assert.deepEqual(r.memory.off_smoke, { learn: "MEMORY_OFF", recall: "MEMORY_OFF" });
  assert.equal(r.calls.includes('openhuman.inference_agent_chat'), false);
});

test('verified ordinary tasks proceed to inference', async () => {
  const r = await runTurn();
  assert.equal(r.code, 0, r.output);
  assert.equal(r.memory.verified, true);
  assert.equal(r.calls.at(-1), 'openhuman.inference_agent_chat');
});

test('the off smoke rejects a core that unexpectedly allows memory writes', async () => {
  const r = await runTurn({ smoke: true, memoryOperationsActive: true });
  assert.equal(r.code, 3, r.output);
  assert.equal(r.memory.verified, false);
});
