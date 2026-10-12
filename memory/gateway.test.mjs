import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Budget, requestBound, startGateway, streamUsage } from './gateway.mjs';

test('concurrent reservations and restart cannot exceed the global $10 cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-budget-'));
  try {
    const file = path.join(dir, 'budget.json');
    const b = new Budget(file);
    b.reserve(6); assert.throws(() => b.reserve(5), /exhausted/);
    const restarted = new Budget(file);
    assert.throws(() => restarted.reserve(5), /exhausted/);
    restarted.settle(6, null); assert.equal(restarted.state.charged, 6);
    restarted.settle(6, 2); restarted.reserve(8);
    assert.equal(restarted.state.charged, 10);
    assert.throws(() => restarted.reserve(0.01));
    assert.throws(() => new Budget(file, 11));
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('an unexpected upstream charge freezes further calls and is retained after restart', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-budget-'));
  try {
    const file = path.join(dir, 'budget.json');
    const b = new Budget(file);
    b.reserve(0.01); b.settle(0.01, 0.02);
    assert.equal(b.state.actual, 0.02);
    assert.throws(() => b.reserve(0.01), /price bound/);
    assert.throws(() => new Budget(file).reserve(0.01), /price bound/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('unknown models, unbounded output and paid plugins are refused', () => {
  assert.throws(() => requestBound({ model: 'unknown' }));
  assert.throws(() => requestBound({ model: 'z-ai/glm-5.3-flash' }));
  assert.throws(() => requestBound({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, plugins: [] }));
  assert.throws(() => requestBound({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, max_completion_tokens: 10000 }));
  assert.throws(() => requestBound({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, messages: [{ content: [{ type: 'image_url', image_url: { url: 'example' } }] }] }));
  assert.ok(requestBound({ model: 'openai/text-embedding-3-small', input: 'hello' }) > 0);
});
test('embedding calls are metered and credentials are never captured', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  const g = await startGateway({ dir, key: 'secret-key', fetchImpl: async (_url, options) => {
    assert.equal(options.headers.authorization, 'Bearer secret-key');
    return new Response(JSON.stringify({ usage: { cost: 0.0001 }, data: [{ embedding: [1, 2] }] }));
  } });
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/embeddings`, { method: 'POST', body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: 'hello' }) });
    assert.equal(r.status, 200);
    const log = fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8');
    assert.equal(log.includes('secret-key'), false);
    assert.equal(JSON.parse(log).route, '/v1/embeddings');
    assert.ok(g.budget.state.charged < 0.00011);
  } finally { await new Promise(r => g.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});
test('gateway refuses before forwarding when the persisted cap is exhausted', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  let forwarded = 0;
  const g = await startGateway({ dir, key: 'k', fetchImpl: async () => { forwarded++; throw new Error('unexpected'); } });
  try {
    g.budget.reserve(10);
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST', body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', messages: [], max_tokens: 100 }) });
    assert.equal(r.status, 402); assert.equal(forwarded, 0);
  } finally { await new Promise(r => g.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});
test('an authorised ceiling above $10 must be passed explicitly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-budget-'));
  try {
    assert.throws(() => new Budget(path.join(dir, 'a.json'), 15));
    const b = new Budget(path.join(dir, 'b.json'), 15, 15);
    b.reserve(12); assert.throws(() => b.reserve(4), /exhausted/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});
test('agent-turn requests need the opt-ins, and images stay refused', () => {
  const turn = { model: 'z-ai/glm-5.3-flash', max_tokens: 16384, stream: true, tools: [{ type: 'function' }],
    messages: [{ role: 'user', content: 'hi' }, { role: 'assistant', content: null, tool_calls: [] }, { role: 'tool', content: 'ok' }] };
  assert.throws(() => requestBound(turn), /nonstream/);
  assert.throws(() => requestBound({ ...turn, stream: false }), /nonstream/);
  assert.ok(requestBound(turn, { allowTools: true, allowStream: true }) > 0);
  assert.throws(() => requestBound({ ...turn, messages: [{ role: 'user', content: null }] }, { allowTools: true, allowStream: true }), /text-only messages/);
  assert.throws(() => requestBound({ ...turn, messages: [{ role: 'user', content: [{ type: 'image_url' }] }] }, { allowTools: true, allowStream: true }), /text-only messages/);
});
test('streamed calls pass through and settle from the last usage event', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  const sse = 'data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[],"usage":{"cost":0.0002}}\n\ndata: [DONE]\n\n';
  let sent;
  const g = await startGateway({ dir, key: 'k', glmProvider: 'together', allowTools: true, allowStream: true,
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); } });
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST', headers: { 'x-bench-phase': 'integration/q1' },
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, stream: true, tools: [], messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(await r.text(), sse);
    assert.deepEqual(sent.provider.only, ['together']);
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8'));
    assert.equal(row.phase, 'integration/q1'); assert.equal(row.usage.cost, 0.0002);
    assert.ok(Math.abs(g.budget.state.actual - 0.0002) < 1e-12);
  } finally { await new Promise(r => g.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});
test('stream usage comes from the last event that reports it', () => {
  assert.equal(streamUsage('data: {"usage":{"cost":1}}\n\ndata: {"usage":{"cost":2}}\n\ndata: [DONE]\n').cost, 2);
  assert.equal(streamUsage('data: {"choices":[]}\n\ndata: [DONE]\n'), null);
});
