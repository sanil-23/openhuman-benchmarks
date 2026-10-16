#!/usr/bin/env node
import fs from 'node:fs';
import http from 'node:http';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { PRICES, startGateway } from './gateway.mjs';
import { describeRoutes, glmRoutes, loadEnv } from './env.mjs';
import { ANSWER_PROMPT_VERSION, ANSWER_SYSTEM } from './reader-prompt.mjs';
import { cortexNetworkMode, startCortex } from './cortex.mjs';
import { CORTEX_IDLE_IGNORE, settleCortex } from './settle.mjs';
import { QUIET_MS } from './integration-lib.mjs';
const exec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const runId = process.argv[2] || 'memory27-glm53flash';
let nativeTaskLimit = Infinity;
let nativeTaskFilter = null;
// --task runs every arm on one task; --question-limit keeps each task's first
// N questions (a smoke test). Both are recorded in run-meta.
let onlyTask = null;
let questionLimit = null;
// --reader-model answers every arm's questions (the store is still built with
// GLM 5.3 Flash); --packs-from reuses another run's recalled packs, so the
// reference and library arms skip ingestion and differ only in the reader.
let readerModel = null;
let packsFrom = null;
// --library-snapshot DIR reads the library arm's CortexDB store from DIR
// (`<DIR>/<task>/`, built by an earlier run) instead of ingesting it.
let librarySnapshotFrom = null;
for (let i = 3; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (value === undefined) throw new Error('usage: run.mjs <run-id> [--native-task-limit N | --native-task ID] [--task ID] [--question-limit N] [--reader-model ID] [--packs-from RUN-ID] [--library-snapshot DIR]');
  if (flag === '--native-task-limit') {
    nativeTaskLimit = Number(value);
    if (!Number.isInteger(nativeTaskLimit) || nativeTaskLimit < 1) throw new Error('native task limit must be a positive integer');
  } else if (flag === '--native-task') nativeTaskFilter = value;
  else if (flag === '--task') onlyTask = value;
  else if (flag === '--question-limit') {
    questionLimit = Number(value);
    if (!Number.isInteger(questionLimit) || questionLimit < 1) throw new Error('question limit must be a positive integer');
  } else if (flag === '--reader-model') readerModel = value;
  else if (flag === '--library-snapshot') librarySnapshotFrom = path.resolve(value);
  else if (flag === '--packs-from') {
    if (!/^[a-z0-9-]+$/.test(value)) throw new Error('invalid --packs-from run id');
    packsFrom = value;
  } else throw new Error('unknown run option');
}
if (!/^[a-z0-9-]+$/.test(runId)) throw new Error('invalid run id');
const out = path.join(root, 'results', runId);
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY required');
fs.mkdirSync(out, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json')));
for (const id of [nativeTaskFilter, onlyTask]) if (id && !manifest.tasks.some(t => t.id === id)) throw new Error(`unknown task ID ${id}`);
if (onlyTask) nativeTaskFilter = onlyTask;
function verify(file, expected) {
  if (createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) throw new Error(`hash mismatch: ${file}`);
}
for (const [name, hash] of Object.entries(manifest.sha256)) verify(path.join(here, 'source', name), hash);
for (const task of manifest.tasks) verify(path.join(here, 'data', `${task.id}.json`), task.sha256);
verify(path.join(here, 'data/references.json'), manifest.references_sha256);
const refs = JSON.parse(fs.readFileSync(path.join(here, 'data/references.json')));
const MODEL = 'z-ai/glm-5.3-flash';
// The reader's instruction: reader-prompt.mjs.
const JUDGE = 'openai/gpt-4o-mini-2024-07-18';
// GLM 5.3 Flash defaults to Z.AI, the audit's provider; an account without it
// can route to another (MEMORY_GLM_PROVIDER=together), recorded in run-meta.
const glmProvider = process.env.MEMORY_GLM_PROVIDER || 'z-ai';
// memory/.env can route GLM 5.3 Flash to another provider (Surplus AI).
const routes = glmRoutes(loadEnv(path.join(here, '.env')));
const READER = readerModel ?? MODEL;
if (!PRICES[READER] || (READER !== MODEL && !routes[READER])) throw new Error(`reader model ${READER} is not approved or has no memory/.env route`);
const gateway = await startGateway({ dir: out, key: process.env.OPENROUTER_API_KEY, glmProvider, routes, ...CORTEX_IDLE_IGNORE });
const idleUrl = `http://127.0.0.1:${gateway.port}/idle?quiet_ms=${QUIET_MS}`;
const librarySnapshots = librarySnapshotFrom ?? path.join(out, 'snapshots', 'library');
delete process.env.OPENROUTER_API_KEY; // Scorer subprocesses need no inference credential.
const base = `http://127.0.0.1:${gateway.port}/v1`;
let cortex = null; // the running CortexDB, from cortex.mjs
let cortexBase = '';
let activeTaskId = 'setup';
const write = (name, value) => fs.writeFileSync(path.join(out, name), JSON.stringify(value, null, 2)+'\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function chat(messages, phase, max_tokens = 4096, model = MODEL, extra = {}) {
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'x-bench-phase': phase },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens, reasoning: { effort: 'low' }, ...extra }),
    signal: AbortSignal.timeout(245000) });
  const body = await r.json();
  if (!r.ok) throw new Error(JSON.stringify(body));
  return body;
}
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
/** A task with at most `questionLimit` questions, and the file the Rust runner reads for it. */
function loadTask(id) {
  const task = JSON.parse(fs.readFileSync(path.join(here, 'data', `${id}.json`)));
  if (!questionLimit || task.questions.length <= questionLimit) return { task, file: path.join(here, 'data', `${id}.json`) };
  task.questions = task.questions.slice(0, questionLimit);
  const file = path.join(out, `${id}-first${questionLimit}.json`);
  fs.writeFileSync(file, JSON.stringify(task));
  return { task, file };
}
async function retrieve(engine, task, benchEnv = {}, label = engine) {
  const file = path.join(out, `${task.id}-${label}.json`);
  if (fs.existsSync(file)) {
    const saved = JSON.parse(fs.readFileSync(file));
    if (!saved.error) return saved;
  }
  const started = Date.now();
  try {
    const result = await exec(path.join(here, 'target/debug/memory-bench'), [engine, task.file], {
      env: { PATH: process.env.PATH, CORTEX_DB_URL: cortexBase, ...benchEnv }, timeout: 7200000, maxBuffer: 8e6,
    });
    fs.writeFileSync(path.join(out, `${task.id}-${label}.log`), result.stderr);
    const parsed = JSON.parse(result.stdout); write(`${task.id}-${label}.json`, parsed); return parsed;
  } catch (e) {
    const result = { engine, error: e.message, wall_ms: Date.now()-started, probes: [] };
    fs.writeFileSync(path.join(out, `${task.id}-${label}.log`), e.stderr ?? '');
    write(`${task.id}-${label}.json`, result); return result;
  }
}
try {
  write('run-meta.json', { model: MODEL, reader_model: READER, library_snapshots: librarySnapshots, library_snapshot_reused: Boolean(librarySnapshotFrom), settle: { quiet_ms: QUIET_MS, ...CORTEX_IDLE_IGNORE }, answer_prompt: ANSWER_PROMPT_VERSION, answer_system: ANSWER_SYSTEM, packs_from: packsFrom, provider: routes[MODEL]?.name ?? glmProvider, routes: describeRoutes(routes), reasoning: 'low', judge: JUDGE,
    native_task_limit: Number.isFinite(nativeTaskLimit) ? nativeTaskLimit : null,
    native_task_filter: nativeTaskFilter, task_filter: onlyTask, question_limit: questionLimit,
    cortex_network: cortexNetworkMode(),
    embedding: 'openai/text-embedding-3-small', budget_usd: 10,
    mode: 'direct-ingest/pre-turn; text plus supplied captions; default RecallPolicy',
    openhuman_sha: (await exec('git', ['-C', path.join(root, 'vendor/openhuman-memory'), 'rev-parse', 'HEAD'])).stdout.trim(),
    tinymemory_sha: (await exec('git', ['-C', path.join(root, 'vendor/openhuman-memory/vendor/tinymemory'), 'rev-parse', 'HEAD'])).stdout.trim(), manifest });
  // Reproduce the small-output extraction hazard separately from QA.
  if (!fs.existsSync(path.join(out, 'extraction-probe.json'))) {
    const probes = [];
    for (const max of [512, 2048, 8192]) {
      const body = await chat([{ role: 'system', content: 'Extract facts from the conversation as JSON. Return only {"facts":[{"subject":"...","predicate":"...","object":"..."}]}.' },
        { role: 'user', content: '2026-09-01: My project budget is $5000. 2026-09-10: The budget was increased to $6500. My timezone is Asia/Kuwait.' }], 'extraction-probe', max, MODEL, { response_format: { type: 'json_object' } });
      probes.push({ max_tokens: max, ...body });
    }
    write('extraction-probe.json', probes);
  }
  if (packsFrom) {
    for (const entry of manifest.tasks) {
      if (onlyTask && entry.id !== onlyTask) continue;
      const { task } = loadTask(entry.id);
      for (const engine of ['reference', 'cortex']) {
        const name = `${entry.id}-${engine}.json`, from = path.join(root, 'results', packsFrom, name);
        if (fs.existsSync(path.join(out, name))) continue;
        const saved = JSON.parse(fs.readFileSync(from));
        const missing = task.questions.filter(q => !saved.probes?.some(p => p.id === q.id)).map(q => q.id);
        if (saved.error || missing.length) throw new Error(`${from} lacks packs for ${missing.join(', ') || 'this task'}`);
        write(name, { ...saved, copied_from: path.relative(root, from) });
      }
    }
  }
  const rowsFile = path.join(out, 'answers.jsonl');
  const rows = fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  // Cheapest controls first: record them even if real ingestion later fails.
  for (const entry of manifest.tasks) {
    if (onlyTask && entry.id !== onlyTask) continue;
    const { task, file } = loadTask(entry.id);
    const reference = await retrieve('reference', { ...task, file });
    if (reference.error) throw new Error(`reference setup failed: ${reference.error}`);
    const full = task.sessions.map(s => `[${s.date}]\n${s.turns.map(t => `${t.role}: ${t.text}`).join('\n')}`).join('\n\n');
    for (const system of ['no-memory', 'full-context', 'reference-memory']) {
      for (const q of task.questions) {
        if (rows.some(r => r.id === q.id && r.system === system)) continue;
        const pack = system === 'full-context' ? full : system === 'reference-memory' ? reference.probes.find(p => p.id === q.id)?.pack || '' : '';
        const response = await chat([{ role: 'system', content: ANSWER_SYSTEM },
          { role: 'user', content: `${pack}\n\nQuestion: ${q.question}${q.question_date ? '\nCurrent date: '+q.question_date : ''}` }], `${system}/${q.id}`, 4096, READER);
        const answer = response.choices?.[0]?.message?.content || '';
        const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system, reader_model: READER, answer,
          empty_answer: !answer, finish_reason: response.choices?.[0]?.finish_reason, usage: response.usage, reference: refs[q.id] };
        Object.assign(row, await score(row)); rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row)+'\n');
        console.log(`${system} ${q.id}: ${row.score}${row.empty_answer ? ' (empty)' : ''}`);
      }
    }
  }
  // Same CortexDB image, environment and network rules as the integration
  // arm (cortex.mjs).
  async function launchCortex(dataDir, suffix = 'lib') {
    cortex = await startCortex({ name: `bench-${runId}-${activeTaskId}-${suffix}`, gatewayPort: gateway.port, model: MODEL,
      configFile: path.join(here, 'cortex.toml'), out, dataDir });
    cortex.suffix = suffix;
    cortexBase = cortex.base;
  }
  async function stopCortex() {
    if (cortex) { await cortex.stop(path.join(out, `${activeTaskId}-cortex-${cortex.suffix}-server.log`)); cortex = null; }
  }
  /**
   * The library arm's packs. Like the integration arm, the store is built
   * once into a snapshot (ingest, settle, restart, settle again), and the
   * questions are recalled on a fresh copy of it, each after the engine has
   * gone quiet (memory-bench MEMORY_BENCH_IDLE_URL). Leaves the copy's
   * CortexDB running for the caller to stop.
   */
  async function libraryPacks(entry, task, file) {
    const saved = path.join(out, `${entry.id}-cortex.json`);
    if (fs.existsSync(saved) && !JSON.parse(fs.readFileSync(saved)).error) return retrieve('cortex', { ...task, file });
    const snap = path.join(librarySnapshots, entry.id);
    if (!fs.existsSync(path.join(snap, 'snapshot.json'))) {
      if (librarySnapshotFrom) throw new Error(`no finished library snapshot for ${entry.id} in ${librarySnapshots}`);
      fs.rmSync(snap, { recursive: true, force: true });
      console.log(`ingest cortex ${entry.id} (${entry.turns} turns) into a snapshot`);
      await launchCortex(path.join(snap, 'cortex'), 'libsnap');
      const ingest = await retrieve('cortex', { ...task, file }, { MEMORY_BENCH_PHASE: 'ingest', MEMORY_BENCH_IDLE_URL: idleUrl }, 'cortex-ingest');
      await stopCortex();
      if (ingest.error) throw new Error(`library ingest failed: ${ingest.error}`);
      await launchCortex(path.join(snap, 'cortex'), 'libsettle');
      const restartSettle = await settleCortex({ base: cortexBase, gateway, label: `${entry.id} library snapshot after restart` });
      await stopCortex();
      fs.writeFileSync(path.join(snap, 'snapshot.json'), JSON.stringify({ task: entry.id, built_by_run: runId,
        built_at: new Date().toISOString(), store_model: MODEL, ingest, restart_settle: restartSettle }, null, 2) + '\n');
    }
    const work = path.join(out, `${entry.id}-lib-state`);
    fs.rmSync(work, { recursive: true, force: true });
    fs.cpSync(path.join(snap, 'cortex'), path.join(work, 'cortex'), { recursive: true });
    await launchCortex(path.join(work, 'cortex'), 'lib');
    const restoreSettle = await settleCortex({ base: cortexBase, gateway, label: `${entry.id} library restored copy` });
    const result = await retrieve('cortex', { ...task, file }, { MEMORY_BENCH_PHASE: 'probe', MEMORY_BENCH_IDLE_URL: idleUrl });
    if (!result.error) write(`${entry.id}-cortex.json`, { ...result, snapshot: snap, restore_settle: restoreSettle });
    return result;
  }
  // Fresh physical storage per dataset instance. Run LoCoMo first to obtain a
  // useful multi-question diagnostic before the longer LME histories.
  let nativeTasks = 0;
  for (const entry of [...manifest.tasks].sort((a,b) => a.turns-b.turns)) {
    if (nativeTaskFilter && entry.id !== nativeTaskFilter) continue;
    const { task, file } = loadTask(entry.id);
    if (task.questions.every(q => rows.some(r => r.id === q.id && r.system === 'oh-tinymemory-cortex-direct'))) continue;
    if (nativeTasks >= nativeTaskLimit) break;
    nativeTasks++;
    activeTaskId = entry.id;
    // Saved packs (an interrupted run, or --packs-from) need no store.
    const retrieval = await libraryPacks(entry, task, file);
    if (retrieval.error) { console.log(`cortex ${entry.id}: setup failed (see saved log)`); process.exitCode = 1; await stopCortex(); break; }
    for (const q of task.questions) {
      if (rows.some(r => r.id === q.id && r.system === 'oh-tinymemory-cortex-direct')) continue;
      const pack = retrieval.probes.find(p => p.id === q.id)?.pack || '';
      const response = await chat([{ role: 'system', content: ANSWER_SYSTEM },
        { role: 'user', content: `${pack}\n\nQuestion: ${q.question}${q.question_date ? '\nCurrent date: '+q.question_date : ''}` }], `cortex/${q.id}`, 4096, READER);
      const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system: 'oh-tinymemory-cortex-direct', reader_model: READER,
        answer: response.choices?.[0]?.message?.content || '', usage: response.usage, reference: refs[q.id],
        query_ms: retrieval.probes.find(p => p.id === q.id)?.query_ms, pack_bytes: Buffer.byteLength(pack) };
      Object.assign(row, await score(row)); rows.push(row); fs.appendFileSync(rowsFile, JSON.stringify(row)+'\n');
      console.log(`cortex ${q.id}: ${row.score}`);
    }
    await stopCortex();
  }
  write('summary.json', summarize(rows));
  const expected = onlyTask || questionLimit ? null : 80; // the full manifest: 20 questions x 4 arms
  write('coverage.json', { expected_scores: expected, completed_scores: rows.length, complete: expected === null ? null : rows.length === expected,
    arms: ['no-memory', 'full-context', 'reference-memory', 'oh-tinymemory-cortex-direct'] });
  if (fs.existsSync(path.join(out, 'run-error.json'))) fs.renameSync(path.join(out, 'run-error.json'), path.join(out, 'recovered-run-error.json'));
} catch (e) {
  write('run-error.json', { error: e.message, at: new Date().toISOString() });
  console.error(e.message); process.exitCode = 1;
} finally {
  if (cortex) await cortex.stop(path.join(out, `${activeTaskId}-cortex-server.log`));
  await new Promise(r => gateway.server.close(r));
  console.log(`budget: ${JSON.stringify(gateway.budget.state)}`);
}
function summarize(rows) {
  const groups = {};
  for (const r of rows) {
    const key = `${r.dataset}/${r.system}/${r.category}`;
    const g = groups[key] ??= { n: 0, total: 0, empty: 0, metric: r.metric };
    g.n++; g.total += r.score; g.empty += !r.answer;
  }
  return Object.fromEntries(Object.entries(groups).map(([k,v]) => [k, { ...v, mean: v.total/v.n }]));
}
