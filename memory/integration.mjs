#!/usr/bin/env node
// The integration arm of issue #38: memory measured through OpenHuman, not the
// library in isolation.
//
// OpenHuman runs purely as an engine. For each task this starts a fresh
// CortexDB and a fresh `openhuman-core run` with its own workspace, then:
//
//   1. points the core's memory at that CortexDB (`openhuman.memory_engine_set`);
//   2. writes the task's history as chat threads (`openhuman.threads_create_new`,
//      `openhuman.threads_message_append`), one thread per session;
//   3. stores those threads in memory through the core's own past-chats
//      backfill (`memory_conversations_backfill_start`), so every write goes
//      through the bound engine, the scrubber and the core's identity binding;
//   4. waits for CortexDB enrichment with the library arm's rule;
//   5. asks each question as a live agent turn (`openhuman.inference_agent_chat`)
//      on its own thread, so pre-turn recall, the "Wait for memory" deadline,
//      the pack middleware and post-turn logging are all in the path;
//   6. deletes the question's thread, which also forgets its memory, so a later
//      question cannot recall an earlier one.
//
// History enters through the backfill, not live capture. Capture decisions
// ("log every turn") act only on the question turns. Rows are appended to
// the run's answers.jsonl with system `oh-integration` (or
// `oh-integration-wait<ms>` when the deadline is not the product default).
//
// usage: integration.mjs <run-id> --core <openhuman-core binary>
//          [--task ID] [--wait-ms N] [--date-hint] [--budget USD] [--glm-provider NAME]
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startGateway } from './gateway.mjs';
import { describeRoutes, glmRoutes, loadEnv } from './env.mjs';
import { startCortex, CORTEX_API_KEY } from './cortex.mjs';
import { DEFAULT_WAIT_MS, SYSTEM, coreConfig, nextQuiet, preTurnTimeouts, questionPrompt, replyText,
  threadId, threadMessages, unwrap } from './integration-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const MODEL = 'z-ai/glm-5.3-flash';
const JUDGE = 'openai/gpt-4o-mini-2024-07-18';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const [runId, ...rest] = argv;
  if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error('usage: integration.mjs <run-id> --core <binary> [options]');
  const opts = { runId, waitMs: DEFAULT_WAIT_MS, dateHint: false, budget: 10, glmProvider: 'together' };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i], value = () => { if (rest[i + 1] === undefined) throw new Error(`${flag} needs a value`); return rest[++i]; };
    if (flag === '--core') opts.core = value();
    else if (flag === '--task') opts.task = value();
    else if (flag === '--wait-ms') opts.waitMs = Number(value());
    else if (flag === '--date-hint') opts.dateHint = true;
    else if (flag === '--budget') opts.budget = Number(value());
    else if (flag === '--glm-provider') opts.glmProvider = value();
    else throw new Error(`unknown option ${flag}`);
  }
  if (!opts.core || !fs.existsSync(opts.core)) throw new Error('--core must name an openhuman-core binary');
  if (!(Number.isInteger(opts.waitMs) && opts.waitMs > 0)) throw new Error('--wait-ms must be a positive integer');
  if (!(opts.budget > 0)) throw new Error('--budget must be positive');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const system = opts.waitMs === DEFAULT_WAIT_MS ? SYSTEM : `${SYSTEM}-wait${opts.waitMs}`;
const out = path.join(root, 'results', opts.runId);
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY required');
fs.mkdirSync(out, { recursive: true });

// Same pinned inputs as the library arm.
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json')));
const verify = (file, expected) => {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error(`hash mismatch: ${file}`);
};
for (const [name, hash] of Object.entries(manifest.sha256)) verify(path.join(here, 'source', name), hash);
for (const task of manifest.tasks) verify(path.join(here, 'data', `${task.id}.json`), task.sha256);
verify(path.join(here, 'data/references.json'), manifest.references_sha256);
const refs = JSON.parse(fs.readFileSync(path.join(here, 'data/references.json')));
if (opts.task && !manifest.tasks.some(t => t.id === opts.task)) throw new Error('unknown task ID');

// The budget ceiling is the cap recorded on the issue for this phase; it has
// to be passed explicitly above the gateway's default $10.
// memory/.env can route GLM 5.3 Flash to another provider (Surplus AI).
const routes = glmRoutes(loadEnv(path.join(here, '.env')));
const gateway = await startGateway({ dir: out, key: process.env.OPENROUTER_API_KEY, limit: opts.budget,
  maxLimit: Math.max(10, opts.budget), glmProvider: opts.glmProvider, allowTools: true, allowStream: true, routes });
delete process.env.OPENROUTER_API_KEY; // Neither the core nor the scorers need it.
const inference = `http://127.0.0.1:${gateway.port}/v1`;
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2) + '\n');

async function chat(messages, phase, max_tokens, model) {
  const r = await fetch(`${inference}/chat/completions`, { method: 'POST', headers: { 'x-bench-phase': phase },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens }), signal: AbortSignal.timeout(245000) });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body;
}
// The library arm's scoring, unchanged: official scorer, official judge prompt.
async function score(row) {
  const child = spawn(path.join(here, '.venv/bin/python'), [path.join(here, 'score.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.stdin.end(JSON.stringify(row));
  await new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  const result = JSON.parse(stdout);
  if (result.prompt) {
    const judged = await chat([{ role: 'user', content: result.prompt }], 'judge', 10, JUDGE);
    return { score: judged.choices?.[0]?.message?.content?.trim().toLowerCase().includes('yes') ? 1 : 0,
      metric: 'official-judge-prompt', judge: judged.choices?.[0]?.message?.content, judge_model: JUDGE };
  }
  return result;
}

async function freePort() {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  await new Promise(r => server.close(r));
  return port;
}

/** Start `openhuman-core run` with its own HOME and workspace. */
async function startCore(taskId, endpoint) {
  const dir = path.join(out, `${taskId}-oh`);
  fs.rmSync(dir, { recursive: true, force: true });
  const home = path.join(dir, 'home'), workspace = path.join(dir, 'workspace'), cwd = path.join(dir, 'cwd');
  for (const d of [home, workspace, cwd]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'config.toml'), coreConfig({ endpoint, waitMs: opts.waitMs, dateHint: opts.dateHint }));
  const port = await freePort();
  const token = randomBytes(16).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: home, OPENHUMAN_WORKSPACE: workspace,
    OPENHUMAN_CORE_TOKEN: token, OPENHUMAN_COMPOSIO_MODE: 'disabled',
    // The bench adapter's convention (bundles/adapters/openhuman.sh): the core
    // needs a credential before it runs a turn even on a per-call route, and
    // an ephemeral workspace has no OS keyring.
    OPENHUMAN_BACKEND_API_KEY: 'memory-bench-dummy',
    OPENHUMAN_KEYRING_BACKEND: 'encrypted_file', OPENHUMAN_KEYRING_MASTER_KEY: randomBytes(32).toString('hex'),
    RUST_LOG: process.env.RUST_LOG ?? 'info',
  };
  const log = fs.openSync(path.join(out, `${taskId}-oh-core.log`), 'w');
  // Not --headless-api: that mode starts no memory queue workers.
  const child = spawn(opts.core, ['run', '--jsonrpc-only', '--host', '127.0.0.1', '--port', String(port)],
    { env, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`openhuman-core exited with ${child.exitCode}; see ${taskId}-oh-core.log`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (i > 600) throw new Error('openhuman-core did not become healthy');
    await sleep(100);
  }
  let id = 0;
  // node:http, not fetch: an agent turn can hold the response open longer
  // than undici's five-minute headers timeout.
  const rpc = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
    const req = http.request(`${base}/rpc`, { method: 'POST', timeout: timeoutMs, headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (reply.error) reject(new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 500)}`));
          else resolve(reply.result);
        } catch (e) { reject(new Error(`${method}: HTTP ${res.statusCode}: ${e.message}`)); }
      });
    });
    req.on('timeout', () => req.destroy(new Error(`${method}: timed out after ${timeoutMs} ms`)));
    req.on('error', reject);
    req.end(body);
  });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      for (let i = 0; i < 100 && child.exitCode === null; i++) await sleep(100);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
    fs.closeSync(log);
  };
  return { rpc, stop, cwd, logFile: path.join(out, `${taskId}-oh-core.log`) };
}

/** What the running core reports about its memory, recorded with each task. */
async function memoryState(rpc) {
  const slots = unwrap(await rpc('openhuman.subsystems_status'));
  const engine = unwrap(await rpc('openhuman.memory_engine_get'));
  const policy = unwrap(await rpc('openhuman.memory_policy_get'));
  const memory = slots?.subsystems?.find(row => row.slot === 'memory');
  const state = { driver: memory?.driver ?? null, fell_back_from: memory?.fell_back_from ?? null,
    engine: engine?.engine ?? null, engine_status: engine?.status ?? null,
    auto_recall: policy?.recall?.enabled ?? null, auto_capture: policy?.log_conversations ?? null,
    pre_turn_timeout_ms: policy?.recall?.pre_turn_timeout_ms ?? null, policy };
  if (state.engine !== 'cortexdb' || state.auto_recall !== true || state.auto_capture !== true) {
    throw new Error(`memory is not on as configured: ${JSON.stringify(state).slice(0, 400)}`);
  }
  return state;
}

/** Write the history as threads and store it through the core's backfill. */
async function loadHistory(rpc, task) {
  const started = Date.now();
  let messages = 0;
  for (const [i, session] of task.sessions.entries()) {
    const thread = threadId(await rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, session.id] }));
    for (const message of threadMessages(task, session, i)) {
      await rpc('openhuman.threads_message_append', { thread_id: thread, message });
      messages++;
    }
  }
  const startView = unwrap(await rpc('openhuman.memory_conversations_backfill_start', { consent: true }));
  let view = startView;
  for (let i = 0; ; i++) {
    const phase = view?.state?.phase;
    if (phase === 'done') break;
    if (phase === 'error') throw new Error(`backfill failed: ${view.state.error ?? 'unknown'}`);
    if (i > 1800) throw new Error('backfill did not finish within an hour');
    await sleep(2000);
    view = unwrap(await rpc('openhuman.memory_conversations_backfill_status'));
  }
  return { threads: task.sessions.length, messages, backfill_start: startView, backfill: view, load_ms: Date.now() - started };
}

/** The library arm's enrichment barrier, polled against this task's CortexDB. */
async function waitForEnrichment(cortexBase) {
  const polls = [];
  let state = { quiet: 0, lastQueued: undefined };
  for (let i = 0; i < 600; i++) {
    const response = await fetch(`${cortexBase}/v1/admin/usage`, { headers: { authorization: `Bearer ${CORTEX_API_KEY}` } });
    if (!response.ok) throw new Error(`CortexDB usage: HTTP ${response.status}`);
    state = nextQuiet(state, await response.json());
    polls.push({ at: new Date().toISOString(), pending: state.pending, queued: state.queued });
    if (state.settled) return { polls, rule: 'nothing pending and no new job for three polls 3 s apart' };
    await sleep(3000);
  }
  throw new Error(`enrichment failed to drain: ${JSON.stringify(polls.at(-1))}`);
}

const rowsFile = path.join(out, 'answers.jsonl');
const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const done = q => rows.some(r => r.id === q.id && r.system === system);
try {
  write(`run-meta-${system}.json`, { system, model: MODEL, glm_provider: routes[MODEL]?.name ?? opts.glmProvider,
    routes: describeRoutes(routes), reasoning: 'low', judge: JUDGE,
    wait_ms: opts.waitMs, date_hint: opts.dateHint, budget_usd: opts.budget, task_filter: opts.task ?? null,
    core_binary: path.resolve(opts.core), core_sha256: createHash('sha256').update(fs.readFileSync(opts.core)).digest('hex'),
    mode: 'history via threads + memory_conversations_backfill_start; questions as live inference_agent_chat turns',
    manifest });
  for (const entry of [...manifest.tasks].sort((a, b) => a.turns - b.turns)) {
    if (opts.task && entry.id !== opts.task) continue;
    const task = JSON.parse(fs.readFileSync(path.join(here, 'data', `${entry.id}.json`)));
    if (task.questions.every(done)) continue;
    const name = `bench-${opts.runId}-${entry.id}-int`;
    console.log(`integration ${entry.id}: ${entry.sessions} sessions, ${entry.turns} turns`);
    const cortex = await startCortex({ name, gatewayPort: gateway.port, model: MODEL, configFile: path.join(here, 'cortex.toml'), out });
    let core;
    try {
      core = await startCore(entry.id, cortex.base);
      await core.rpc('openhuman.memory_engine_set', { engine: 'cortexdb', endpoint: cortex.base, api_key: CORTEX_API_KEY });
      const memory = await memoryState(core.rpc);
      const history = await loadHistory(core.rpc, task);
      const enrichment = await waitForEnrichment(cortex.base);
      write(`${entry.id}-${system}.json`, { memory, history, enrichment });
      console.log(`integration ${entry.id}: ${history.messages} messages stored in ${history.load_ms} ms, enrichment settled`);
      for (const q of task.questions) {
        if (done(q)) continue;
        const logBefore = fs.statSync(core.logFile).size;
        const thread = threadId(await core.rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, 'question'] }));
        const started = Date.now();
        const reply = replyText(await core.rpc('openhuman.inference_agent_chat', {
          message: questionPrompt(q), thread_id: thread, model_override: MODEL, cwd: core.cwd,
          inference_url: inference, api_key: 'memory-bench-dummy',
          inference_headers: [['x-bench-phase', `${system}/${q.id}`]],
        }, 900_000));
        const turnMs = Date.now() - started;
        await core.rpc('openhuman.threads_delete', { thread_id: thread, deleted_at: new Date().toISOString() });
        const logTail = fs.readFileSync(core.logFile, 'utf8').slice(logBefore);
        const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system,
          answer: reply.text, empty_answer: !reply.text.trim(), hit_cap: reply.hitCap, reference: refs[q.id],
          turn_ms: turnMs, wait_ms: opts.waitMs, pre_turn_timeouts: preTurnTimeouts(logTail).length };
        Object.assign(row, await score(row)); rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
        console.log(`${system} ${q.id}: ${row.score}${row.pre_turn_timeouts ? ' (pre-turn timed out)' : ''}`);
      }
    } finally {
      if (core) await core.stop();
      await cortex.stop(path.join(out, `${entry.id}-${system}-cortex-server.log`));
    }
  }
  const mine = rows.filter(r => r.system === system);
  write(`summary-${system}.json`, summarize(mine));
} catch (e) {
  write(`run-error-${system}.json`, { error: e.message, at: new Date().toISOString() });
  console.error(e.message); process.exitCode = 1;
} finally {
  await new Promise(r => gateway.server.close(r));
  console.log(`budget: ${JSON.stringify(gateway.budget.state)}`);
}

function summarize(list) {
  const groups = {};
  for (const r of list) {
    const key = `${r.dataset}/${r.system}/${r.category}`;
    const g = groups[key] ??= { n: 0, total: 0, empty: 0, pre_turn_timeouts: 0, metric: r.metric };
    g.n++; g.total += r.score; g.empty += r.empty_answer ? 1 : 0; g.pre_turn_timeouts += r.pre_turn_timeouts ? 1 : 0;
  }
  return Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, { ...v, mean: v.total / v.n }]));
}
