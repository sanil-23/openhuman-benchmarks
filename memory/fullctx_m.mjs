// The bare-model full-context arm for LongMemEval_M (longmemeval-m-13.json).
//
// One call to the reader model per question, with the reader arms' exact
// instruction (reader-prompt.mjs) and message layout (run.mjs), the history
// formatted as run.mjs formats it: as many of the most recent sessions as fit
// in the window budget, oldest first. A history of ~1.1M tokens does not fit
// a 128k window, so this arm sees only the newest part of it; each row says
// how many sessions it saw and whether the answer sessions were among them.
// A prompt the provider refuses as too long is retried 10% smaller.
// Scored with the harness's scorer (LongMemEval's judge prompt).
//
// usage: node fullctx_m.mjs <run-id> [--window-tokens N] [--reader-model ID]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { startGateway } from './gateway.mjs';
import { glmRoutes, loadEnv } from './env.mjs';
import { ANSWER_PROMPT_VERSION, ANSWER_SYSTEM } from './reader-prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const JUDGE = 'openai/gpt-4o-mini-2024-07-18';
const args = process.argv.slice(2);
const runId = args[0];
if (!runId || !/^[a-z0-9-]+$/.test(runId)) throw new Error('usage: fullctx_m.mjs <run-id> [--window-tokens N] [--reader-model ID]');
const flag = (name, fallback) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : fallback; };
const windowTokens = Number(flag('--window-tokens', '120000'));
const reader = flag('--reader-model', 'deepseek/deepseek-v4.1-flash');
// Characters per token used to size the window before the call; the
// provider's own prompt_tokens is recorded on every row.
const CHARS_PER_TOKEN = 4.0;
if (!process.env.OPENROUTER_API_KEY) throw new Error('OPENROUTER_API_KEY required');
const key = process.env.OPENROUTER_API_KEY;
delete process.env.OPENROUTER_API_KEY;
const out = path.join(root, 'results', runId);
fs.mkdirSync(out, { recursive: true });
const routes = glmRoutes(loadEnv(path.join(here, '.env')));
const gateway = await startGateway({ dir: out, key, glmProvider: 'z-ai', routes });
const base = `http://127.0.0.1:${gateway.port}/v1`;
const set = JSON.parse(fs.readFileSync(path.join(here, 'longmemeval-m-13.json')));
const refs = JSON.parse(fs.readFileSync(path.join(here, 'data-m/references.json')));
const rowsFile = path.join(out, 'answers.jsonl');
const done = new Set(fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l).id) : []);
const system = `full-context-recent-${Math.round(windowTokens / 1000)}k`;

async function chat(messages, phase, max_tokens, model) {
  const r = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'x-bench-phase': phase },
    body: JSON.stringify({ model, messages, temperature: 0, max_tokens, reasoning: { effort: 'low' } }), signal: AbortSignal.timeout(600000) });
  const body = await r.json();
  return { ok: r.ok, status: r.status, body };
}

async function score(row) {
  const child = spawn(path.join(here, '.venv/bin/python'), [path.join(here, 'score.py')], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', x => stdout += x); child.stderr.on('data', x => stderr += x);
  child.stdin.end(JSON.stringify(row));
  await new Promise((resolve, reject) => child.on('exit', code => code === 0 ? resolve() : reject(new Error(stderr))));
  const result = JSON.parse(stdout);
  if (!result.prompt) return result;
  const judged = await chat([{ role: 'user', content: result.prompt }], 'judge', 10, JUDGE);
  if (!judged.ok) throw new Error(`judge: ${JSON.stringify(judged.body).slice(0, 300)}`);
  const verdict = judged.body.choices?.[0]?.message?.content;
  return { score: verdict?.trim().toLowerCase().includes('yes') ? 1 : 0, metric: 'official-judge-prompt', judge: verdict, judge_model: JUDGE };
}

try {
  for (const entry of set.questions) {
    if (done.has(entry.id)) continue;
    const task = JSON.parse(fs.readFileSync(path.join(here, 'data-m', `${entry.task_id}.json`)));
    const q = task.questions[0];
    const blocks = task.sessions.map(s => ({ id: s.id, text: `[${s.date}]\n${s.turns.map(t => `${t.role}: ${t.text}`).join('\n')}` }));
    let budget = windowTokens * CHARS_PER_TOKEN, response, kept;
    for (let attempt = 0; attempt < 8; attempt++) {
      kept = [];
      let size = 0;
      for (let i = blocks.length - 1; i >= 0 && size + blocks[i].text.length + 2 <= budget; i--) {
        kept.unshift(blocks[i]); size += blocks[i].text.length + 2;
      }
      const pack = kept.map(b => b.text).join('\n\n');
      response = await chat([{ role: 'system', content: ANSWER_SYSTEM },
        { role: 'user', content: `${pack}\n\nQuestion: ${q.question}${q.question_date ? '\nCurrent date: ' + q.question_date : ''}` }],
        `${system}/${q.id}`, 4096, reader);
      if (response.ok) break;
      const message = JSON.stringify(response.body);
      if (/DataInspectionFailed|inappropriate content/i.test(message)) break;
      if (!/context|too long|maximum|length|token/i.test(message)) throw new Error(`${q.id}: ${message.slice(0, 300)}`);
      console.log(`${q.id}: refused at ~${Math.round(budget / CHARS_PER_TOKEN)} tokens; retrying 10% smaller`);
      budget *= 0.9;
    }
    if (!response.ok && /DataInspectionFailed|inappropriate content/i.test(JSON.stringify(response.body))) {
      // The provider's content filter refused the history itself: recorded,
      // not scored, so the arm is not marked wrong for the provider's policy.
      const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system, reader_model: reader,
        provider_refused: JSON.stringify(response.body).slice(0, 400), window_sessions: kept.length, total_sessions: blocks.length,
        reference: refs[q.id] };
      fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
      console.log(`${system} ${q.id}: REFUSED by the provider's content filter (window of ${kept.length} sessions)`);
      continue;
    }
    if (!response.ok) throw new Error(`${q.id}: still refused at ~${Math.round(budget / CHARS_PER_TOKEN)} tokens`);
    const answerIds = new Set(refs[q.id].answer_session_ids);
    const seen = kept.filter(b => answerIds.has(b.id)).length;
    const answer = response.body.choices?.[0]?.message?.content || '';
    const row = { dataset: task.dataset, id: q.id, question: q.question, category: q.category, system, reader_model: reader,
      answer, empty_answer: !answer.trim(), answer_prompt: ANSWER_PROMPT_VERSION, usage: response.body.usage,
      window_sessions: kept.length, total_sessions: blocks.length, answer_sessions_seen: seen, answer_sessions_total: answerIds.size,
      reference: refs[q.id] };
    Object.assign(row, await score(row));
    fs.appendFileSync(rowsFile, JSON.stringify(row) + '\n');
    console.log(`${system} ${q.id}: ${row.score} (saw ${kept.length}/${blocks.length} sessions, ${seen}/${answerIds.size} answer sessions, ${response.body.usage?.prompt_tokens} prompt tokens)`);
  }
} finally {
  await new Promise(r => gateway.server.close(r));
}
