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
//   4. waits until CortexDB has settled (`settle`: nothing pending and no
//      model call through the gateway for 90 s), restarts it, and waits again;
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
// Steps 1-4 build a snapshot: once enrichment settles, the core and CortexDB
// stop and their state (CortexDB's data directory, the core's home and
// workspace, the core's keyring key) is kept in `<snapshot dir>/<task>/`.
// Questions always run on a fresh copy of that snapshot, never on the
// snapshot itself: OpenHuman logs every question turn into memory, so a
// reused store would recall earlier runs' questions and answers.
// `--from-snapshot DIR` skips steps 1-4 and reads a snapshot an earlier run
// built, so a different reader can be measured on the same memory.
//
// `--reader-model` is who answers: the OpenHuman agent's model and CortexDB's
// answer and verifier models. The store is built with GLM 5.3 Flash either way.
//
// usage: integration.mjs <run-id> --core <openhuman-core binary>
//          [--task ID] [--question-limit N] [--wait-ms N] [--date-hint] [--budget USD] [--glm-provider NAME]
//          [--reader-model ID] [--from-snapshot DIR] [--memory-tool-timeout-ms N] [--memory-tool-recall pack]
//          [--cortex-env KEY=VALUE ...] [--no-capture] [--memory-tool-run-budget-ms N] [--no-enrichment]
//          [--task-file PATH] [--snapshot-only] [--paste-history-tokens N]
//          [--compaction-turn-tokens N [--compaction-strategy task_state|summary]]
//
// `--memory-tool-recall cortex-pack` (core with the BENCH-ONLY prototype)
// makes the memory tool recall as CortexDB's own Hermes provider does: one
// `/v1/recall` over the conversations scope, CortexDB's `context_block`, no
// `/v1/answer`. `--no-capture` turns the core's turn logging off while the
// questions run (the history is already stored): Hermes stores an exchange
// only after the reply, so the question being asked is not in memory when
// it recalls. Rows get a `-nocapture` suffix.
//
// `--cortex-env` (repeatable) sets a CORTEX_* variable on the CortexDB that
// answers the questions (not on the one that builds the snapshot), for
// query-time experiments on an unchanged store. Recorded in run metadata.
//
// `--no-enrichment` runs every CortexDB of the run (the one building the
// snapshot, the restart settle, the one answering) with no enrichment model:
// CortexDB then keeps events, their embeddings and keyword index, and
// episodes; no facts, beliefs or entity graph. The snapshot records it, and
// a snapshot built the other way is refused. Rows get a `-noenrich` suffix.
//
// `--task-file PATH` runs one task that is not in the pinned manifest (for
// example a LongMemEval_M history, see prepare_lme_m.py) instead of the
// manifest's tasks; its references come from `references.json` beside it.
// Run metadata records the file and its sha256. `--snapshot-only` builds
// (and settles) the snapshot and asks no questions.
//
// `--paste-history-tokens N` is a no-memory arm: no CortexDB,
// OpenHuman's memory off, and the newest sessions that fit in about N tokens
// pasted into the question's own message ahead of the question (formatted as
// the full-context reader arm formats them). Rows are labelled
// `oh-paste-<N/1000>k` and say how many sessions, and answer sessions, were
// pasted. A provider refusal of the pasted history is recorded, not scored.
// OpenHuman trims a turn to 90% of the model's window (115,200 tokens of
// 128k) by dropping whole messages, and the pasted message is one message:
// over that it is dropped and the agent sees no history. N = 110000 fits;
// a run whose core log shows that trim stops rather than score the answer.
//
// `--compaction-turn-tokens N` gives the same no-memory agent the whole
// history as a conversation instead: one thread per question, the sessions
// sent oldest first as user turns of about N tokens each (whole sessions,
// the agent asked to reply "ok"), then the question as the last turn.
// OpenHuman's context ladder runs at its defaults: compaction fires at 80% of
// the window, keeps the newest ~20k tokens and folds the rest into a rolling
// checkpoint. A turn has to stay under that 20k, because compaction always
// keeps the newest message whole. Rows are labelled `oh-compaction-<N/1000>k`
// and record the compactions (from the core log), any trims, and how many
// answer sessions were still verbatim in the question's request.
// OpenHuman's prompt-injection guard scans every chat message and rejects one
// it scores for review (there is no switch for it). A rejected turn is sent
// again one session at a time, as a user would split it; a session the guard
// still rejects never reaches the thread, and the row lists it
// (`guard_blocked_sessions`, and whether it held an answer).
// `--compaction-strategy` sets OpenHuman's `[context] compaction_strategy`
// (default `task_state`; `summary` is the free-form model summary). The
// summarizer's model calls carry no output bound, which the gateway refuses
// by default, so this arm runs it with `clampMaxTokens` (16384): such a call is
// sent with that bound and its meter row says what it asked for.
//
// `--memory-tool-timeout-ms` needs a core built with the BENCH-ONLY override
// (OPENHUMAN_MEMORY_TOOL_CALL_TIMEOUT_MS); it raises the memory tool's
// per-call limit (product: 15 s) to N and the per-turn total (product: 30 s)
// to 2N, and labels the rows `oh-integration-tool<N/1000>s`.
// `--memory-tool-recall pack` needs a core with the BENCH-ONLY pack prototype
// (OPENHUMAN_MEMORY_TOOL_RECALL=pack): the memory tool's recall returns the
// memory pack, without the calling thread, instead of the engine's answer.
// Rows are labelled with a `-pack` suffix.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { PRICES, startGateway } from './gateway.mjs';
import { describeRoutes, glmRoutes, loadEnv } from './env.mjs';
import { cortexNetworkMode, startCortex, CORTEX_API_KEY } from './cortex.mjs';
import { CORTEX_IDLE_IGNORE, settleCortex } from './settle.mjs';
import { DEFAULT_WAIT_MS, QUESTION_PROMPT_VERSION, SYSTEM, coreConfig, nextQuiet, preTurnTimeouts, questionPrompt, replyText, threadId, threadMessages, unwrap, indexerState, derivationCaughtUp } from './integration-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const MODEL = 'z-ai/glm-5.3-flash';
const JUDGE = 'openai/gpt-4o-mini-2024-07-18';
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseArgs(argv) {
  const [runId, ...rest] = argv;
  if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error('usage: integration.mjs <run-id> --core <binary> [options]');
  const opts = { runId, waitMs: DEFAULT_WAIT_MS, dateHint: false, budget: 10, glmProvider: 'together', readerModel: MODEL };
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i], value = () => { if (rest[i + 1] === undefined) throw new Error(`${flag} needs a value`); return rest[++i]; };
    if (flag === '--core') opts.core = value();
    else if (flag === '--task') opts.task = value();
    else if (flag === '--question-limit') opts.questionLimit = Number(value());
    else if (flag === '--wait-ms') opts.waitMs = Number(value());
    else if (flag === '--date-hint') opts.dateHint = true;
    else if (flag === '--budget') opts.budget = Number(value());
    else if (flag === '--glm-provider') opts.glmProvider = value();
    else if (flag === '--reader-model') opts.readerModel = value();
    else if (flag === '--from-snapshot') opts.fromSnapshot = path.resolve(value());
    else if (flag === '--memory-tool-timeout-ms') opts.toolTimeoutMs = Number(value());
    else if (flag === '--memory-tool-recall') opts.toolRecall = value();
    else if (flag === '--no-capture') opts.noCapture = true;
    else if (flag === '--no-enrichment') opts.noEnrichment = true;
    else if (flag === '--task-file') opts.taskFile = path.resolve(value());
    else if (flag === '--snapshot-only') opts.snapshotOnly = true;
    else if (flag === '--paste-history-tokens') opts.pasteTokens = Number(value());
    else if (flag === '--compaction-turn-tokens') opts.compactionTurnTokens = Number(value());
    else if (flag === '--compaction-strategy') opts.compactionStrategy = value();
    // The per-turn total alone (product: 30 s), keeping the per-call limit.
    else if (flag === '--memory-tool-run-budget-ms') opts.toolRunBudgetMs = Number(value());
    else if (flag === '--cortex-env') {
      const m = /^(CORTEX_[A-Z0-9_]+)=(.*)$/.exec(value());
      if (!m) throw new Error('--cortex-env takes CORTEX_NAME=value');
      (opts.cortexEnv ??= {})[m[1]] = m[2];
    }
    else throw new Error(`unknown option ${flag}`);
  }
  if (!opts.core || !fs.existsSync(opts.core)) throw new Error('--core must name an openhuman-core binary');
  if (!(Number.isInteger(opts.waitMs) && opts.waitMs > 0)) throw new Error('--wait-ms must be a positive integer');
  if (!(opts.budget > 0)) throw new Error('--budget must be positive');
  if (!PRICES[opts.readerModel]) throw new Error(`--reader-model must be one of ${Object.keys(PRICES).filter(m => !m.includes('embedding')).join(', ')}`);
  if (opts.toolTimeoutMs !== undefined && !(Number.isInteger(opts.toolTimeoutMs) && opts.toolTimeoutMs >= 1000)) throw new Error('--memory-tool-timeout-ms must be an integer of at least 1000');
  if (opts.toolRunBudgetMs !== undefined && !(Number.isInteger(opts.toolRunBudgetMs) && opts.toolRunBudgetMs >= 1000)) throw new Error('--memory-tool-run-budget-ms must be an integer of at least 1000');
  if (opts.toolRecall !== undefined && !['pack', 'cortex-pack'].includes(opts.toolRecall)) throw new Error('--memory-tool-recall must be pack or cortex-pack');
  if (opts.fromSnapshot && !fs.existsSync(opts.fromSnapshot)) throw new Error('--from-snapshot names no directory');
  if (opts.questionLimit !== undefined && !(Number.isInteger(opts.questionLimit) && opts.questionLimit > 0)) throw new Error('--question-limit must be a positive integer');
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
if (opts.compactionStrategy && !['task_state', 'summary'].includes(opts.compactionStrategy)) throw new Error('--compaction-strategy must be task_state or summary');
const system = opts.compactionTurnTokens ? `oh-compaction-${Math.round(opts.compactionTurnTokens / 1000)}k${opts.compactionStrategy === 'summary' ? '-summary' : ''}` : opts.pasteTokens ? `oh-paste-${Math.round(opts.pasteTokens / 1000)}k` : (opts.waitMs === DEFAULT_WAIT_MS ? SYSTEM : `${SYSTEM}-wait${opts.waitMs}`) +
  (opts.toolTimeoutMs ? `-tool${opts.toolTimeoutMs / 1000}s` : '') + (opts.toolRecall ? `-${opts.toolRecall}` : '') + (opts.noCapture ? '-nocapture' : '') +
  (opts.toolRunBudgetMs ? `-turn${opts.toolRunBudgetMs / 1000}s` : '') + (opts.noEnrichment ? '-noenrich' : '');
// What every CortexDB of this run is started with on top of the defaults.
const ENRICHMENT_OFF = { CORTEX_ENRICHMENT_URL: null, CORTEX_ENRICHMENT_API_KEY: null, CORTEX_ENRICHMENT_MODEL: null,
  CORTEX_ENRICHMENT_DELAY_SECONDS: null };
const storeEnv = opts.noEnrichment ? ENRICHMENT_OFF : {};
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
// The tasks this run reads: the manifest's, or one off-manifest task file.
let tasks = manifest.tasks;
let offManifest = null;
if (opts.taskFile) {
  const raw = fs.readFileSync(opts.taskFile);
  const task = JSON.parse(raw);
  Object.assign(refs, JSON.parse(fs.readFileSync(path.join(path.dirname(opts.taskFile), 'references.json'))));
  tasks = [{ id: task.id, dataset: task.dataset, questions: task.questions.map(q => q.id), sessions: task.sessions.length,
    turns: task.sessions.reduce((n, s) => n + s.turns.length, 0), file: opts.taskFile }];
  offManifest = { file: opts.taskFile, sha256: createHash('sha256').update(raw).digest('hex') };
}
if (opts.task && !tasks.some(t => t.id === opts.task)) throw new Error('unknown task ID');

// The budget ceiling is the cap recorded on the issue for this phase; it has
// to be passed explicitly above the gateway's default $10.
// memory/.env can route GLM 5.3 Flash to another provider (Surplus AI).
const routes = glmRoutes(loadEnv(path.join(here, '.env')));
if (opts.readerModel !== MODEL && !routes[opts.readerModel]) throw new Error(`${opts.readerModel} has no route in memory/.env`);
const snapshots = opts.fromSnapshot ?? path.join(out, 'snapshots');
const gateway = await startGateway({ dir: out, key: process.env.OPENROUTER_API_KEY, limit: opts.budget,
  maxLimit: Math.max(10, opts.budget), glmProvider: opts.glmProvider, allowTools: true, allowStream: true, routes,
  ...CORTEX_IDLE_IGNORE, clampMaxTokens: opts.compactionTurnTokens ? 16384 : 0 });
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

/**
 * Start `openhuman-core run` on `dir` (its HOME, workspace and cwd), creating
 * them if absent. `masterKey` unlocks the core's file keyring, so a copied
 * core reads the keyring it was snapshotted with.
 */
async function startCore(dir, endpoint, masterKey, logName, capture = true, memory = true) {
  const home = path.join(dir, 'home'), workspace = path.join(dir, 'workspace'), cwd = path.join(dir, 'cwd');
  for (const d of [home, workspace, cwd]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'config.toml'), coreConfig({ endpoint, waitMs: opts.waitMs, dateHint: opts.dateHint, capture, memory }) +
    (opts.compactionStrategy ? `\n[context]\ncompaction_strategy = "${opts.compactionStrategy}"\n` : ''));
  const port = await freePort();
  const token = randomBytes(16).toString('hex');
  const env = {
    PATH: process.env.PATH, HOME: home, OPENHUMAN_WORKSPACE: workspace,
    OPENHUMAN_CORE_TOKEN: token, OPENHUMAN_COMPOSIO_MODE: 'disabled',
    // The bench adapter's convention (bundles/adapters/openhuman.sh): the core
    // needs a credential before it runs a turn even on a per-call route, and
    // an ephemeral workspace has no OS keyring.
    OPENHUMAN_BACKEND_API_KEY: 'memory-bench-dummy',
    OPENHUMAN_KEYRING_BACKEND: 'encrypted_file', OPENHUMAN_KEYRING_MASTER_KEY: masterKey,
    RUST_LOG: process.env.RUST_LOG ?? 'info',
    ...(opts.toolTimeoutMs ? { OPENHUMAN_MEMORY_TOOL_CALL_TIMEOUT_MS: String(opts.toolTimeoutMs),
      OPENHUMAN_MEMORY_TOOL_RUN_BUDGET_MS: String(2 * opts.toolTimeoutMs) } : {}),
    ...(opts.toolRunBudgetMs ? { OPENHUMAN_MEMORY_TOOL_RUN_BUDGET_MS: String(opts.toolRunBudgetMs) } : {}),
    ...(opts.toolRecall ? { OPENHUMAN_MEMORY_TOOL_RECALL: opts.toolRecall } : {}),
    // The one scope TinyMemory writes this core's conversations to.
    ...(opts.toolRecall === 'cortex-pack' ? { OPENHUMAN_MEMORY_TOOL_CORTEX_SCOPE: 'app:tinymemory/agent:orchestrator/app:conversations' } : {}),
  };
  const logFile = path.join(out, logName);
  const log = fs.openSync(logFile, 'w');
  // Not --headless-api: that mode starts no memory queue workers.
  const child = spawn(opts.core, ['run', '--jsonrpc-only', '--host', '127.0.0.1', '--port', String(port)],
    { env, stdio: ['ignore', log, log] });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    if (child.exitCode !== null) throw new Error(`openhuman-core exited with ${child.exitCode}; see ${logName}`);
    try { if ((await fetch(`${base}/health`)).ok) break; } catch {}
    if (i > 600) throw new Error('openhuman-core did not become healthy');
    await sleep(100);
  }
  let id = 0;
  // node:http, not fetch: an agent turn can hold the response open longer
  // than undici's five-minute headers timeout.
  // A call settles exactly once: on its reply, on an error of the request or
  // of a reply that stalls part-way, or at `timeoutMs` whatever the socket is
  // doing. (A socket-idle timeout alone left a reply that stalled after its
  // headers unsettled for good: the destroyed response's error had no
  // listener, and the run hung with nothing left to wake it.)
  const rpc = (method, params = {}, timeoutMs = 60_000) => new Promise((resolve, reject) => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params });
    let settled = false;
    const finish = (fn, value) => { if (!settled) { settled = true; clearTimeout(deadline); fn(value); } };
    const req = http.request(`${base}/rpc`, { method: 'POST', timeout: timeoutMs, headers: {
      'content-type': 'application/json', authorization: `Bearer ${token}`, 'content-length': Buffer.byteLength(body) } }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('error', e => finish(reject, new Error(`${method}: reply failed: ${e.message}`)));
      res.on('aborted', () => finish(reject, new Error(`${method}: reply aborted`)));
      res.on('end', () => {
        try {
          const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (reply.error) finish(reject, new Error(`${method}: ${JSON.stringify(reply.error).slice(0, 500)}`));
          else finish(resolve, reply.result);
        } catch (e) { finish(reject, new Error(`${method}: HTTP ${res.statusCode}: ${e.message}`)); }
      });
    });
    const deadline = setTimeout(() => {
      req.destroy();
      finish(reject, new Error(`${method}: timed out after ${timeoutMs} ms`));
    }, timeoutMs);
    req.on('timeout', () => req.destroy(new Error(`${method}: timed out after ${timeoutMs} ms`)));
    req.on('error', e => finish(reject, e));
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
  return { rpc, stop, cwd, logFile };
}

/** What the running core reports about its memory, recorded with each task. */
async function memoryState(rpc, capture = true) {
  const slots = unwrap(await rpc('openhuman.subsystems_status'));
  const engine = unwrap(await rpc('openhuman.memory_engine_get'));
  const policy = unwrap(await rpc('openhuman.memory_policy_get'));
  const memory = slots?.subsystems?.find(row => row.slot === 'memory');
  const state = { driver: memory?.driver ?? null, fell_back_from: memory?.fell_back_from ?? null,
    engine: engine?.engine ?? null, engine_status: engine?.status ?? null,
    auto_recall: policy?.recall?.enabled ?? null, auto_capture: policy?.log_conversations ?? null,
    pre_turn_timeout_ms: policy?.recall?.pre_turn_timeout_ms ?? null, policy };
  if (state.engine !== 'cortexdb' || state.auto_recall !== true || state.auto_capture !== capture) {
    throw new Error(`memory is not on as configured: ${JSON.stringify(state).slice(0, 400)}`);
  }
  return state;
}

/** Write the history as threads and store it through the core's backfill. */
async function loadHistory(core, task) {
  const { rpc } = core;
  const started = Date.now();
  let messages = 0;
  for (const [i, session] of task.sessions.entries()) {
    const thread = threadId(await rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, session.id] }));
    for (const message of threadMessages(task, session, i)) {
      await rpc('openhuman.threads_message_append', { thread_id: thread, message });
      messages++;
    }
  }
  const logFrom = fs.statSync(core.logFile).size;
  const startView = unwrap(await rpc('openhuman.memory_conversations_backfill_start', { consent: true }, 600_000));
  // Completion is read from the core's own log line, not by polling
  // `memory_conversations_backfill_status`: that call recomputes the plan
  // (one engine lookup per thread), which takes minutes on a history of
  // hundreds of threads. It is read once at the end, for the record.
  const deadline = Date.now() + 3 * 3600_000;
  for (;;) {
    const tail = fs.readFileSync(core.logFile, 'utf8').slice(logFrom);
    if (/\[memory:backfill\] done items=/.test(tail)) break;
    const failed = tail.match(/\[memory:backfill\] storing a batch failed[^\n]*/);
    if (failed) throw new Error(`backfill failed: ${failed[0]}`);
    if (Date.now() > deadline) throw new Error('backfill did not finish within three hours');
    await sleep(2000);
  }
  const load_ms = Date.now() - started;
  let view = null;
  try {
    view = unwrap(await rpc('openhuman.memory_conversations_backfill_status', {}, 30_000));
  } catch (error) {
    view = { status_error: error.message };
  }
  return { threads: task.sessions.length, messages, backfill_start: startView, backfill: view, load_ms };
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

/**
 * What CortexDB says each layer is derived from and which model roles it has
 * (`/v1/admin/layers/stats` health), and the layer counts it reports. Kept in
 * snapshot.json; a failure is recorded, not thrown.
 */
async function layerStats(cortexBase) {
  try {
    const response = await fetch(`${cortexBase}/v1/admin/layers/stats`, {
      headers: { authorization: `Bearer ${CORTEX_API_KEY}`, 'x-cortex-actor': 'user:local' } });
    const body = await response.json();
    if (!response.ok) return { error: `HTTP ${response.status}: ${body.message ?? ''}` };
    const { health = {}, ...rest } = body;
    return { layer_sources: health.layer_sources, llm_roles: health.llm_roles, stats: rest };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Wait until CortexDB has indexed everything it captured: `indexer.lag` and
 * `indexer.inflight` (`/v1/admin/metrics`) at 0 for three polls 2 s apart.
 * A backfill that writes with `WaitFor::Accepted` returns before its events
 * are indexed (embedded), and settling ignores embedding calls, so without
 * this a snapshot could hold messages recall cannot find yet.
 */
async function waitIndexed(cortexBase) {
  const started = Date.now();
  let quiet = 0, last = null;
  for (let i = 0; i < 5400; i++) {
    const response = await fetch(`${cortexBase}/v1/admin/metrics`, {
      headers: { authorization: `Bearer ${CORTEX_API_KEY}`, 'x-cortex-actor': 'user:local' } });
    if (!response.ok) throw new Error(`CortexDB metrics: HTTP ${response.status}`);
    const { done, ...state } = indexerState(await response.json());
    last = state;
    quiet = done ? quiet + 1 : 0;
    if (quiet >= 3) return { wait_ms: Date.now() - started, ...last };
    await sleep(2000);
  }
  throw new Error(`indexing did not catch up: ${JSON.stringify(last)}`);
}

/**
 * Wait until CortexDB's background derivation has caught up with ingest in
 * every scope it derives (`/v1/derivation/status`, which CortexDB documents
 * for connectors to poll after a bulk sync): `caught_up` for two polls 5 s
 * apart. With automatic derivation on, episodes, beliefs and concepts are
 * rebuilt after writes (with their own embedding and model calls), so a
 * store whose indexer has caught up can still be building them.
 */
async function waitDerived(cortexBase) {
  const headers = { authorization: `Bearer ${CORTEX_API_KEY}`, 'x-cortex-actor': 'user:local' };
  const started = Date.now();
  let quiet = 0, last = {};
  for (let i = 0; i < 1440; i++) {
    const stats = await fetch(`${cortexBase}/v1/admin/layers/stats`, { headers });
    if (!stats.ok) throw new Error(`CortexDB layer stats: HTTP ${stats.status}`);
    const scopes = Object.keys((await stats.json())?.by_scope ?? {});
    last = {};
    for (const scope of scopes) {
      const r = await fetch(`${cortexBase}/v1/derivation/status?scope=${encodeURIComponent(scope)}`, { headers });
      if (!r.ok) throw new Error(`CortexDB derivation status: HTTP ${r.status}`);
      const d = await r.json();
      last[scope] = { caught_up: d.caught_up, state: d.state, built: d.built };
    }
    quiet = derivationCaughtUp(last) ? quiet + 1 : 0;
    if (quiet >= 2) return { wait_ms: Date.now() - started, scopes: last };
    await sleep(5000);
  }
  throw new Error(`derivation did not catch up: ${JSON.stringify(last)}`);
}

/** Wait until this task's CortexDB has settled (settle.mjs); the gateway serves only it. */
function settle(cortexBase, label) {
  return settleCortex({ base: cortexBase, gateway, label });
}

/**
 * Restart CortexDB on a snapshot's store and wait until it settles again, so
 * work a restart re-queues is done before questions are asked. Recorded in
 * snapshot.json as `restart_settle`; a snapshot that has one is ready.
 */
async function settleSnapshot(entry, snap) {
  const cortex = await startCortex({ name: `bench-${opts.runId}-${entry.id}-settle`, gatewayPort: gateway.port, model: MODEL,
    configFile: path.join(here, 'cortex.toml'), out, dataDir: path.join(snap, 'cortex'), extraEnv: storeEnv });
  const callsBefore = gateway.budget.state.calls;
  let record;
  try {
    record = await settle(cortex.base, `${entry.id} snapshot after restart`);
    record.derived = await waitDerived(cortex.base);
  } finally {
    await cortex.stop(path.join(out, `${entry.id}-${system}-cortex-settle.log`));
  }
  const file = path.join(snap, 'snapshot.json');
  const snapshot = JSON.parse(fs.readFileSync(file));
  snapshot.restart_settle = { ...record, by_run: opts.runId, gateway_calls: gateway.budget.state.calls - callsBefore };
  fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Build `<snapshots>/<task>/`: a CortexDB data directory and a core holding the
 * task's history, enrichment settled, both stopped. `snapshot.json` is written
 * last, so a directory without it is an interrupted build and is rebuilt.
 */
async function buildSnapshot(entry, task, snap) {
  fs.rmSync(snap, { recursive: true, force: true });
  const masterKey = randomBytes(32).toString('hex');
  const cortex = await startCortex({ name: `bench-${opts.runId}-${entry.id}-snap`, gatewayPort: gateway.port, model: MODEL,
    configFile: path.join(here, 'cortex.toml'), out, dataDir: path.join(snap, 'cortex'), extraEnv: storeEnv });
  let core;
  try {
    core = await startCore(path.join(snap, 'core'), cortex.base, masterKey, `${entry.id}-oh-core-ingest.log`);
    await core.rpc('openhuman.memory_engine_set', { engine: 'cortexdb', endpoint: cortex.base, api_key: CORTEX_API_KEY });
    const memory = await memoryState(core.rpc);
    const history = await loadHistory(core, task);
    const indexed = await waitIndexed(cortex.base);
    const enrichment = await waitForEnrichment(cortex.base);
    const settled = await settle(cortex.base, `${entry.id} after ingest`);
    const derived = await waitDerived(cortex.base);
    const layers = await layerStats(cortex.base);
    console.log(`integration ${entry.id}: ${history.messages} messages stored in ${history.load_ms} ms, enrichment settled`);
    await core.stop(); core = null;
    await cortex.stop(path.join(out, `${entry.id}-${system}-cortex-ingest.log`));
    // The keyring key is a random local value guarding only this throwaway
    // core; it is kept beside the state it unlocks, owner-readable only.
    fs.writeFileSync(path.join(snap, 'snapshot.json'), JSON.stringify({ task: entry.id, built_by_run: opts.runId,
      built_at: new Date().toISOString(), core_sha256: createHash('sha256').update(fs.readFileSync(opts.core)).digest('hex'),
      store_model: MODEL, enrichment_off: !!opts.noEnrichment, keyring_master_key: masterKey, memory, history, indexed, enrichment, settled, derived,
      layers }, null, 2) + '\n', { mode: 0o600 });
  } catch (e) {
    if (core) await core.stop();
    await cortex.stop(path.join(out, `${entry.id}-${system}-cortex-ingest.log`));
    throw e;
  }
}

/**
 * The pasted-history arm for one task (`--paste-history-tokens`): a fresh
 * core with memory off; each question asked in a new thread with the newest
 * sessions that fit pasted ahead of it.
 */
async function pastedHistory(entry, task) {
  const dir = path.join(out, `${entry.id}-paste-state`);
  fs.rmSync(dir, { recursive: true, force: true });
  const logName = `${entry.id}-oh-core-paste.log`;
  const trims = () => (fs.readFileSync(path.join(out, logName), 'utf8').match(/message_trim evicted/g) ?? []).length;
  const core = await startCore(dir, null, randomBytes(32).toString('hex'), logName, false, false);
  try {
    const blocks = task.sessions.map(s => ({ id: s.id, text: `[${s.date}]\n${s.turns.map(t => `${t.role}: ${t.text}`).join('\n')}` }));
    const budget = opts.pasteTokens * 4;
    const kept = [];
    let size = 0;
    for (let i = blocks.length - 1; i >= 0 && size + blocks[i].text.length + 2 <= budget; i--) {
      kept.unshift(blocks[i]); size += blocks[i].text.length + 2;
    }
    const pasted = kept.map(b => b.text).join('\n\n');
    for (const q of task.questions) {
      if (done(q)) continue;
      const answerIds = new Set(refs[q.id]?.answer_session_ids ?? []);
      const seen = kept.filter(b => answerIds.has(b.id)).length;
      const thread = threadId(await core.rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, 'pasted-history'] }));
      const message = `Here is our earlier conversation history, oldest first:\n\n${pasted}\n\n---\n\n${questionPrompt(q)}`;
      const asked = Date.now();
      const trimmedBefore = trims();
      const base = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system, reader_model: opts.readerModel,
        reference: refs[q.id], pasted_sessions: kept.length, total_sessions: blocks.length, pasted_chars: pasted.length,
        answer_sessions_seen: seen, answer_sessions_total: answerIds.size };
      let reply;
      try {
        reply = replyText(await core.rpc('openhuman.inference_agent_chat', {
          message, thread_id: thread, model_override: opts.readerModel, cwd: core.cwd,
          inference_url: inference, api_key: 'memory-bench-dummy',
          inference_headers: [['x-bench-phase', `${system}/${q.id}`]],
        }, 1_800_000));
      } catch (error) {
        if (!/DataInspectionFailed|inappropriate content/i.test(error.message)) throw error;
        const row = { ...base, provider_refused: error.message.slice(0, 400), turn_ms: Date.now() - asked };
        rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
        console.log(`${system} ${q.id}: REFUSED by the provider's content filter`);
        continue;
      }
      if (trims() > trimmedBefore) throw new Error(`${q.id}: OpenHuman trimmed the pasted history out of the turn; paste fewer tokens`);
      const row = { ...base, answer: reply.text, empty_answer: !reply.text.trim(), hit_cap: reply.hitCap, turn_ms: Date.now() - asked };
      Object.assign(row, await score(row)); rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
      console.log(`${system} ${q.id}: ${row.score} (pasted ${kept.length}/${blocks.length} sessions, ${seen}/${answerIds.size} answer sessions)`);
    }
  } finally {
    await core.stop();
  }
}

/** The first request the gateway logged for `phase`, read line by line. */
async function firstRequest(phase) {
  const lines = readline.createInterface({ input: fs.createReadStream(path.join(out, 'meter.jsonl')) });
  const tag = JSON.stringify(phase);
  for await (const line of lines) {
    if (!line.includes(tag)) continue;
    const row = JSON.parse(line);
    if (row.phase === phase && row.request) { lines.close(); return row; }
  }
  return null;
}

/**
 * The compaction arm for one task (`--compaction-turn-tokens`): a fresh core
 * with memory off; the history fed into one thread as user turns, then the
 * question asked in that thread.
 */
async function compactedHistory(entry, task) {
  const dir = path.join(out, `${entry.id}-compaction-state`);
  fs.rmSync(dir, { recursive: true, force: true });
  const logName = `${entry.id}-oh-core-compaction.log`;
  const log = () => fs.readFileSync(path.join(out, logName), 'utf8');
  const core = await startCore(dir, null, randomBytes(32).toString('hex'), logName, false, false);
  try {
    const blocks = task.sessions.map(s => ({ id: s.id,
      head: `[${s.date}]\n${s.turns[0] ? `${s.turns[0].role}: ${s.turns[0].text}`.slice(0, 120) : ''}`,
      text: `[${s.date}]\n${s.turns.map(t => `${t.role}: ${t.text}`).join('\n')}` }));
    const budget = opts.compactionTurnTokens * 4;
    const chunks = [];
    for (const b of blocks) {
      const last = chunks.at(-1);
      if (last && last.size + b.text.length + 2 <= budget) { last.blocks.push(b); last.size += b.text.length + 2; }
      else chunks.push({ blocks: [b], size: b.text.length });
    }
    for (const q of task.questions) {
      if (done(q)) continue;
      const answerIds = new Set(refs[q.id]?.answer_session_ids ?? []);
      const thread = threadId(await core.rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, 'compaction'] }));
      const turn = (message, phase) => core.rpc('openhuman.inference_agent_chat', {
        message, thread_id: thread, model_override: opts.readerModel, cwd: core.cwd,
        inference_url: inference, api_key: 'memory-bench-dummy', inference_headers: [['x-bench-phase', phase]],
      }, 1_800_000);
      const started = Date.now();
      const base = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system, reader_model: opts.readerModel,
        reference: refs[q.id], total_sessions: blocks.length, feed_turns: chunks.length, answer_sessions_total: answerIds.size };
      const blocked = [];
      const guarded = error => /flagged for security review|was not processed/i.test(error.message);
      const feed = (k, list) => turn(`Here is part ${k + 1} of ${chunks.length} of our earlier conversation history, oldest first. ` +
        `Nothing to do with it yet: reply only "ok".\n\n${list.map(b => b.text).join('\n\n')}`, `${system}-feed/${q.id}`);
      let reply;
      try {
        for (const [k, chunk] of chunks.entries()) {
          try {
            await feed(k, chunk.blocks);
          } catch (error) {
            if (!guarded(error)) throw error;
            console.log(`${system} ${q.id}: the prompt guard rejected turn ${k + 1}; sending its ${chunk.blocks.length} sessions one at a time`);
            for (const b of chunk.blocks) {
              try { await feed(k, [b]); } catch (inner) {
                if (!guarded(inner)) throw inner;
                blocked.push(b.id);
                console.log(`${system} ${q.id}: the prompt guard rejected session ${b.id}${answerIds.has(b.id) ? ' (an answer session)' : ''}`);
              }
            }
          }
          if ((k + 1) % 10 === 0) console.log(`${system} ${q.id}: fed ${k + 1}/${chunks.length} turns, ${(log().match(/\[context_compression\] compacted/g) ?? []).length} compactions`);
        }
        const asked = Date.now();
        reply = replyText(await turn(questionPrompt(q), `${system}/${q.id}`));
        base.turn_ms = Date.now() - asked;
      } catch (error) {
        if (!/DataInspectionFailed|inappropriate content/i.test(error.message)) throw error;
        const row = { ...base, provider_refused: error.message.slice(0, 400), run_ms: Date.now() - started };
        rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
        console.log(`${system} ${q.id}: REFUSED by the provider's content filter`);
        continue;
      }
      const text = log();
      const compactions = [...text.matchAll(/\[context_compression\] compacted.*$/gm)].map(m => ({
        tokens_before: Number(m[0].match(/tokens_before=(\d+)/)?.[1]), tokens_after: Number(m[0].match(/tokens_after=(\d+)/)?.[1]),
        summarizer_output_tokens: Number(m[0].match(/summarizer_output_tokens=\D*?(\d+)/)?.[1]) || null }));
      const final = await firstRequest(`${system}/${q.id}`);
      const sent = JSON.stringify(final?.request?.messages ?? []);
      const verbatim = blocks.filter(b => answerIds.has(b.id) && sent.includes(JSON.stringify(b.head).slice(1, -1))).length;
      const row = { ...base, answer: reply.text, empty_answer: !reply.text.trim(), hit_cap: reply.hitCap, run_ms: Date.now() - started,
        compactions: compactions.length, last_compaction: compactions.at(-1) ?? null,
        trims: (text.match(/message_trim evicted/g) ?? []).length, overflow_recoveries: (text.match(/context overflow reported/g) ?? []).length,
        question_prompt_tokens: final?.usage?.prompt_tokens ?? null, question_messages: final?.request?.messages?.length ?? null,
        answer_sessions_verbatim: verbatim, guard_blocked_sessions: blocked,
        guard_blocked_answer_sessions: blocked.filter(id => answerIds.has(id)).length };
      Object.assign(row, await score(row)); rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
      console.log(`${system} ${q.id}: ${row.score} (${chunks.length} turns, ${compactions.length} compactions, ${row.trims} trims, ` +
        `${verbatim}/${answerIds.size} answer sessions verbatim, question prompt ${row.question_prompt_tokens} tokens)`);
    }
  } finally {
    await core.stop();
  }
}

/** A fresh working copy of a snapshot for this run's questions. */
function restore(snap, work) {
  fs.rmSync(work, { recursive: true, force: true });
  fs.cpSync(path.join(snap, 'cortex'), path.join(work, 'cortex'), { recursive: true });
  fs.cpSync(path.join(snap, 'core'), path.join(work, 'core'), { recursive: true });
  return JSON.parse(fs.readFileSync(path.join(snap, 'snapshot.json')));
}

const rowsFile = path.join(out, 'answers.jsonl');
const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
const done = q => rows.some(r => r.id === q.id && r.system === system);
try {
  write(`run-meta-${system}.json`, { system, model: MODEL, reader_model: opts.readerModel, question_prompt: QUESTION_PROMPT_VERSION, glm_provider: routes[MODEL]?.name ?? opts.glmProvider,
    routes: describeRoutes(routes), reasoning: 'low', judge: JUDGE,
    wait_ms: opts.waitMs, memory_tool_timeout_ms: opts.toolTimeoutMs ?? null,
    memory_tool_run_budget_ms: opts.toolRunBudgetMs ?? (opts.toolTimeoutMs ? 2 * opts.toolTimeoutMs : null), memory_tool_recall: opts.toolRecall ?? 'answer', capture_during_questions: !opts.noCapture, cortex_env_overrides: opts.cortexEnv ?? {}, enrichment: !opts.noEnrichment, date_hint: opts.dateHint, budget_usd: opts.budget, task_filter: opts.task ?? null,
    question_limit: opts.questionLimit ?? null, cortex_network: cortexNetworkMode(), snapshots, from_snapshot: Boolean(opts.fromSnapshot),
    off_manifest_task: offManifest, snapshot_only: Boolean(opts.snapshotOnly),
    core_binary: path.resolve(opts.core), core_sha256: createHash('sha256').update(fs.readFileSync(opts.core)).digest('hex'),
    paste_history_tokens: opts.pasteTokens ?? null, compaction_turn_tokens: opts.compactionTurnTokens ?? null,
    compaction_strategy: opts.compactionTurnTokens ? (opts.compactionStrategy ?? 'task_state') : null,
    gateway_clamp_max_tokens: opts.compactionTurnTokens ? 16384 : null,
    mode: opts.compactionTurnTokens ? 'memory off; whole history fed as user turns in one thread, OpenHuman compaction at its defaults, then the question'
      : opts.pasteTokens ? 'memory off; newest history that fits pasted into each question\'s inference_agent_chat message'
      : 'history via threads + memory_conversations_backfill_start into a snapshot; questions as live inference_agent_chat turns on a fresh copy',
    manifest });
  for (const entry of [...tasks].sort((a, b) => a.turns - b.turns)) {
    if (opts.task && entry.id !== opts.task) continue;
    const task = JSON.parse(fs.readFileSync(entry.file ?? path.join(here, 'data', `${entry.id}.json`)));
    if (opts.questionLimit) task.questions = task.questions.slice(0, opts.questionLimit);
    if (task.questions.every(done)) continue;
    console.log(`integration ${entry.id}: ${entry.sessions} sessions, ${entry.turns} turns`);
    if (opts.pasteTokens) { await pastedHistory(entry, task); continue; }
    if (opts.compactionTurnTokens) { await compactedHistory(entry, task); continue; }
    const snap = path.join(snapshots, entry.id);
    if (!fs.existsSync(path.join(snap, 'snapshot.json'))) {
      if (opts.fromSnapshot) throw new Error(`no finished snapshot for ${entry.id} in ${snapshots}`);
      await buildSnapshot(entry, task, snap);
    }
    if (!JSON.parse(fs.readFileSync(path.join(snap, 'snapshot.json'))).restart_settle) await settleSnapshot(entry, snap);
    if (opts.snapshotOnly) { console.log(`integration ${entry.id}: snapshot ready in ${snap}`); continue; }
    const work = path.join(out, `${entry.id}-int-state`);
    const snapshot = restore(snap, work);
    if (snapshot.store_model !== MODEL) throw new Error(`snapshot was built with ${snapshot.store_model}`);
    if (!!snapshot.enrichment_off !== !!opts.noEnrichment) {
      throw new Error(`snapshot was built with enrichment ${snapshot.enrichment_off ? 'off' : 'on'}; pass --no-enrichment to match`);
    }
    const cortex = await startCortex({ name: `bench-${opts.runId}-${entry.id}-int`, gatewayPort: gateway.port, model: MODEL,
      answerModel: opts.readerModel, configFile: path.join(here, 'cortex.toml'), out, dataDir: path.join(work, 'cortex'),
      extraEnv: { ...storeEnv, ...opts.cortexEnv } });
    let core;
    try {
      // Nothing may still be enriching when the first question is asked.
      const restoreSettle = await settle(cortex.base, `${entry.id} restored copy`);
      restoreSettle.derived = await waitDerived(cortex.base);
      // The copy serves CortexDB on a new port; startCore rewrites config.toml for it.
      core = await startCore(path.join(work, 'core'), cortex.base, snapshot.keyring_master_key, `${entry.id}-oh-core.log`, !opts.noCapture);
      await core.rpc('openhuman.memory_engine_set', { engine: 'cortexdb', endpoint: cortex.base, api_key: CORTEX_API_KEY });
      const memory = await memoryState(core.rpc, !opts.noCapture);
      const { keyring_master_key: _, ...recorded } = snapshot;
      write(`${entry.id}-${system}.json`, { snapshot: snap, ...recorded, restore_settle: restoreSettle, memory_at_questions: memory });
      for (const q of task.questions) {
        if (done(q)) continue;
        // The previous question's turn was logged (and its thread forgotten):
        // let CortexDB finish that before the next question.
        const questionSettle = await settle(cortex.base, `before ${q.id}`);
        const logBefore = fs.statSync(core.logFile).size;
        const thread = threadId(await core.rpc('openhuman.threads_create_new', { labels: ['memory-bench', task.id, 'question'] }));
        const started = Date.now();
        const reply = replyText(await core.rpc('openhuman.inference_agent_chat', {
          message: questionPrompt(q), thread_id: thread, model_override: opts.readerModel, cwd: core.cwd,
          inference_url: inference, api_key: 'memory-bench-dummy',
          inference_headers: [['x-bench-phase', `${system}/${q.id}`]],
        }, 900_000));
        const turnMs = Date.now() - started;
        await core.rpc('openhuman.threads_delete', { thread_id: thread, deleted_at: new Date().toISOString() });
        const logTail = fs.readFileSync(core.logFile, 'utf8').slice(logBefore);
        const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system,
          reader_model: opts.readerModel, answer: reply.text, empty_answer: !reply.text.trim(), hit_cap: reply.hitCap,
          reference: refs[q.id], settle_wait_ms: questionSettle.wait_ms, turn_ms: turnMs, wait_ms: opts.waitMs, pre_turn_timeouts: preTurnTimeouts(logTail).length };
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
