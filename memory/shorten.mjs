// Score the OpenHuman integration arm's answers as short answers.
//
// The integration arm's agent answers like a chat assistant: the fact, then
// where it came from. LoCoMo's F1 counts word overlap with a short reference
// answer, so a correct answer with its provenance scores far below the same
// fact alone, and the arm cannot be compared with the reader arms on memory.
// This step gives each agent answer to the same reader model with the reader
// arms' exact instruction (reader-prompt.mjs) and message layout, the agent's
// answer standing in for the memory pack, and scores the short answer with
// the same scorer. It adds no retrieval: the reader sees only what the agent
// answered.
//
// Rows are appended to the run's answers.jsonl with system `<system>-short`
// (`agent_answer` keeps the original), beside the original rows, which stay
// the arm's score.
//
// By default the integration arm's rows are shortened. `--system NAME`
// (repeatable) shortens those systems' rows instead, so a reader arm (whose
// answer is one brief reader call) can be put through the same second call
// and compared on equal terms.
//
// usage: shorten.mjs [--system NAME ...] <run-id> [<run-id> ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startGateway } from './gateway.mjs';
import { glmRoutes, loadEnv } from './env.mjs';
import { ANSWER_PROMPT_VERSION, ANSWER_SYSTEM } from './reader-prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const runIds = [];
const systems = [];
for (let args = process.argv.slice(2), i = 0; i < args.length; i++) {
  if (args[i] === '--system') {
    if (!args[i + 1]) throw new Error('--system needs a name');
    systems.push(args[++i]);
  } else runIds.push(args[i]);
}
if (!runIds.length || runIds.some(id => !/^[a-z0-9-]+$/.test(id))) throw new Error('usage: shorten.mjs [--system NAME ...] <run-id> [<run-id> ...]');
const chosen = (system) => (systems.length ? systems.includes(system) : system.startsWith('oh-integration')) && !system.endsWith('-short');
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY required');
const key = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY; // the scorer subprocess needs no inference credential
const routes = glmRoutes(loadEnv(path.join(here, '.env')));
const glmProvider = process.env.MEMORY_GLM_PROVIDER || 'z-ai';

// The question dates, where a dataset has them (LoCoMo's do not).
const manifest = JSON.parse(fs.readFileSync(path.join(here, 'manifest.json')));
const questions = new Map();
for (const task of manifest.tasks) {
  const file = path.join(here, 'data', `${task.id}.json`);
  if (!fs.existsSync(file)) continue;
  for (const q of JSON.parse(fs.readFileSync(file)).questions) questions.set(q.id, q);
}

/** The reader arms' message for `question` over `memory` (run.mjs). */
export function readerMessages(memory, q) {
  return [{ role: 'system', content: ANSWER_SYSTEM },
    { role: 'user', content: `${memory}\n\nQuestion: ${q.question}${q.question_date ? '\nCurrent date: ' + q.question_date : ''}` }];
}

async function score(row) {
  const child = spawn(path.join(here, '.venv/bin/python'), [path.join(here, 'score.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.stdin.end(JSON.stringify(row));
  await new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  const result = JSON.parse(stdout);
  if (result.prompt) throw new Error(`${row.id}: this scorer needs a judge, which shorten.mjs does not run`);
  return result;
}

for (const runId of runIds) {
  const out = path.join(root, 'results', runId);
  const rowsFile = path.join(out, 'answers.jsonl');
  const rows = fs.readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  const todo = rows.filter(r => chosen(r.system) &&
    !rows.some(s => s.id === r.id && s.system === `${r.system}-short`));
  if (!todo.length) { console.log(`${runId}: nothing to shorten`); continue; }
  const gateway = await startGateway({ dir: out, key, glmProvider, routes });
  const base = `http://127.0.0.1:${gateway.port}/v1`;
  try {
    for (const row of todo) {
      const q = questions.get(row.id) ?? { question: row.question };
      const system = `${row.system}-short`;
      const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'x-bench-phase': `${system}/${row.id}` },
        body: JSON.stringify({ model: row.reader_model, messages: readerMessages(row.answer, q), temperature: 0, max_tokens: 4096,
          reasoning: { effort: 'low' } }), signal: AbortSignal.timeout(245000) });
      const body = await r.json();
      if (!r.ok) throw new Error(JSON.stringify(body));
      const answer = body.choices?.[0]?.message?.content || '';
      const short = { dataset: row.dataset, id: row.id, question: row.question, category: row.category, system,
        reader_model: row.reader_model, answer, empty_answer: !answer.trim(), agent_answer: row.answer, agent_score: row.score,
        shorten_prompt: ANSWER_PROMPT_VERSION, finish_reason: body.choices?.[0]?.finish_reason, usage: body.usage, reference: row.reference };
      Object.assign(short, await score(short));
      fs.appendFileSync(rowsFile, JSON.stringify(short) + '\n');
      console.log(`${system} ${row.id}: ${short.score.toFixed(2)} (agent ${row.score.toFixed(2)})`);
    }
  } finally {
    await new Promise(r => gateway.server.close(r));
  }
}
