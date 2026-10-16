import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Budget, requestBound, routeCost, startGateway, streamUsage } from './gateway.mjs';

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
const surplus = { 'z-ai/glm-5.3-flash': { name: 'surplus', upstream: 'https://api.surplus.example/v1', key: 'surplus-key',
  model: 'glm-5.3-flash', reasoningEffort: 'low', prices: { prompt: 0.1e-6, completion: 0.4e-6, cached: 0.02e-6 } } };
test('a routed model goes to its provider with its key and id, and settles from tokens', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  const calls = [];
  const g = await startGateway({ dir, key: 'openrouter-key', routes: surplus, fetchImpl: async (url, options) => {
    calls.push({ url, auth: options.headers.authorization, body: JSON.parse(options.body) });
    return new Response(JSON.stringify(url.includes('surplus')
      ? { choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 400 } } }
      : { usage: { cost: 0.0001 }, data: [{ embedding: [1] }] }));
  } });
  try {
    const glm = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(glm.status, 200);
    await fetch(`http://127.0.0.1:${g.port}/v1/embeddings`, { method: 'POST', body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: 'x' }) });
    assert.equal(calls[0].url, 'https://api.surplus.example/v1/chat/completions');
    assert.equal(calls[0].auth, 'Bearer surplus-key');
    assert.equal(calls[0].body.model, 'glm-5.3-flash');
    assert.equal(calls[0].body.reasoning_effort, 'low');
    for (const field of ['provider', 'usage', 'reasoning']) assert.equal(field in calls[0].body, false, `${field} is OpenRouter-only`);
    assert.equal(calls[1].url, 'https://openrouter.ai/api/v1/embeddings', 'embeddings stay on OpenRouter');
    assert.equal(calls[1].auth, 'Bearer openrouter-key');
    const expected = 600 * 0.1e-6 + 400 * 0.02e-6 + 100 * 0.4e-6 + 0.0001;
    assert.ok(Math.abs(g.budget.state.actual - expected) < 1e-12);
    const log = fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8');
    assert.equal(log.includes('surplus-key') || log.includes('openrouter-key'), false, 'no key reaches the meter log');
    assert.equal(JSON.parse(log.split('\n')[0]).provider, 'surplus');
  } finally { await new Promise(r => g.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});
test('routed streams ask for usage and settle from it; no usage keeps the reservation', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  let sent;
  const sse = 'data: {"choices":[{"delta":{"content":"a"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\ndata: [DONE]\n\n';
  const g = await startGateway({ dir, key: 'k', routes: surplus, allowTools: true, allowStream: true,
    fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); } });
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 100, stream: true, tools: [], messages: [{ role: 'user', content: 'hi' }] }) });
    assert.equal(await r.text(), sse);
    assert.deepEqual(sent.stream_options, { include_usage: true });
    assert.ok(Math.abs(g.budget.state.actual - (10 * 0.1e-6 + 5 * 0.4e-6)) < 1e-15);
  } finally { await new Promise(r => g.server.close(r)); fs.rmSync(dir, { recursive: true }); }
  assert.equal(routeCost(null, surplus['z-ai/glm-5.3-flash'].prices), undefined, 'no usage keeps the reservation');
});
test('a reported charge in microdollars wins over the configured prices', () => {
  const prices = surplus['z-ai/glm-5.3-flash'].prices;
  assert.equal(routeCost({ prompt_tokens: 1000, completion_tokens: 100, buyer_cost_micro: 42 }, prices), 0.000042);
  assert.ok(Math.abs(routeCost({ prompt_tokens: 1000, completion_tokens: 100 }, prices) - (1000 * 0.1e-6 + 100 * 0.4e-6)) < 1e-15);
});

test('activity counts open requests and when the last one moved', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-activity-'));
  let release;
  const fetchImpl = () => new Promise(r => { release = () => r(new Response(JSON.stringify({ data: [{ embedding: [0] }],
    usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } }), { status: 200 })); });
  const gw = await startGateway({ dir, key: 'k', fetchImpl });
  try {
    const before = gw.activity.last;
    const pending = fetch(`http://127.0.0.1:${gw.port}/v1/embeddings`, { method: 'POST',
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: 'x' }) });
    while (!release) await new Promise(r => setTimeout(r, 5));
    assert.equal(gw.activity.inFlight, 1);
    release(); await (await pending).text();
    await new Promise(r => setTimeout(r, 20));
    assert.equal(gw.activity.inFlight, 0);
    assert.ok(gw.activity.last >= before);
  } finally { await new Promise(r => gw.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});

test('calls matching idleIgnore are counted apart and do not count as activity', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-ignore-'));
  const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'x' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }), { status: 200 });
  const gw = await startGateway({ dir, key: 'k', fetchImpl, idleIgnore: ['You are a concept'] });
  try {
    const call = system => fetch(`http://127.0.0.1:${gw.port}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ model: 'z-ai/glm-5.3-flash', max_tokens: 5, messages: [{ role: 'system', content: system }, { role: 'user', content: 'u' }] }) })
      .then(r => r.text());
    const before = gw.activity.last;
    await new Promise(r => setTimeout(r, 5));
    await call('You are a concept abstraction engine.');
    assert.equal(gw.activity.ignored, 1);
    assert.equal(gw.activity.last, before, 'an ignored call leaves the idle clock alone');
    await call('You are a precise knowledge extraction engine.');
    await new Promise(r => setTimeout(r, 20));
    assert.ok(gw.activity.last > before);
    assert.equal(gw.activity.inFlight, 0);
  } finally { await new Promise(r => gw.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});

test('idleIgnoreEmbeddings leaves the idle clock to chat calls', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-emb-'));
  const fetchImpl = async () => new Response(JSON.stringify({ data: [{ embedding: [0] }], usage: { prompt_tokens: 1, total_tokens: 1, cost: 0 } }), { status: 200 });
  const gw = await startGateway({ dir, key: 'k', fetchImpl, idleIgnoreEmbeddings: true });
  try {
    const before = gw.activity.last;
    await new Promise(r => setTimeout(r, 5));
    await (await fetch(`http://127.0.0.1:${gw.port}/v1/embeddings`, { method: 'POST',
      body: JSON.stringify({ model: 'openai/text-embedding-3-small', input: 'x' }) })).text();
    assert.equal(gw.activity.ignored, 1);
    assert.equal(gw.activity.last, before);
  } finally { await new Promise(r => gw.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});

test('GET /idle reports quiet by the settle rule', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-idle-'));
  const gw = await startGateway({ dir, key: 'k', fetchImpl: async () => new Response('{}') });
  try {
    const idle = async ms => (await fetch(`http://127.0.0.1:${gw.port}/idle?quiet_ms=${ms}`)).json();
    await new Promise(r => setTimeout(r, 30));
    assert.equal((await idle(10)).idle, true);
    assert.equal((await idle(600000)).idle, false);
    gw.activity.inFlight = 1;
    assert.equal((await idle(10)).idle, false, 'an open call is not quiet');
    gw.activity.inFlight = 0;
  } finally { await new Promise(r => gw.server.close(r)); fs.rmSync(dir, { recursive: true }); }
});

test('clampMaxTokens sends an unbounded chat call with the cap and logs what it asked for', async () => {
  for (const clamp of [0, 16384]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
    let sent;
    const g = await startGateway({ dir, key: 'k', allowTools: true, clampMaxTokens: clamp, fetchImpl: async (_url, options) => {
      sent = JSON.parse(options.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
    } });
    try {
      const r = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST',
        body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }] }) });
      if (clamp === 0) {
        assert.equal(r.status, 402, 'off by default: an unbounded call is refused');
        assert.equal(sent, undefined);
      } else {
        assert.equal(r.status, 200);
        assert.equal(sent.max_tokens, 16384);
        const row = JSON.parse(fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8').trim().split('\n').at(-1));
        assert.equal(row.max_tokens_clamped_from, null, 'the call asked for no bound');
      }
    } finally { await new Promise(res => g.server.close(res)); fs.rmSync(dir, { recursive: true }); }
  }
});

test('clampMaxTokens leaves a call that is already within the cap alone', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-gateway-'));
  let sent;
  const g = await startGateway({ dir, key: 'k', clampMaxTokens: 16384, fetchImpl: async (_url, options) => {
    sent = JSON.parse(options.body);
    return new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1, cost: 0 } }));
  } });
  try {
    const r = await fetch(`http://127.0.0.1:${g.port}/v1/chat/completions`, { method: 'POST',
      body: JSON.stringify({ model: 'deepseek/deepseek-v4.1-flash', messages: [{ role: 'user', content: 'hi' }], max_tokens: 200 }) });
    assert.equal(r.status, 200);
    assert.equal(sent.max_tokens, 200);
    const row = JSON.parse(fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8').trim().split('\n').at(-1));
    assert.equal('max_tokens_clamped_from' in row, false);
  } finally { await new Promise(res => g.server.close(res)); fs.rmSync(dir, { recursive: true }); }
});
