import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreConfig, nextQuiet, preTurnTimeouts, questionPrompt, replyText, threadId, threadMessages, unwrap } from './integration-lib.mjs';

test('the core config points memory at the relay and keeps product defaults', () => {
  const toml = coreConfig({ endpoint: 'http://127.0.0.1:4321', waitMs: 1500 });
  assert.match(toml, /\[memory\]\nengine = "cortexdb"/);
  assert.match(toml, /endpoint = "http:\/\/127\.0\.0\.1:4321"/);
  assert.match(toml, /\[memory\.conversations\]\nenabled = true/);
  assert.match(toml, /pre_turn_timeout_ms = 1500\ndate_hint = false/);
  assert.match(coreConfig({ endpoint: 'http://127.0.0.1:1' }), /pre_turn_timeout_ms = 10000/);
  assert.throws(() => coreConfig({ endpoint: 'https://api-v1.cortexdb.ai' }), /loopback/);
  assert.throws(() => coreConfig({ endpoint: 'http://127.0.0.1:1', waitMs: 0 }), /positive/);
});

test('session turns become user and agent messages at the session date', () => {
  const task = { id: 'locomo-0' };
  const session = { id: 'session_1', timestamp: '2023-05-08T13:56:00+00:00', turns: [
    { role: 'user', text: 'D1:1 Caroline: Hi Mel!' }, { role: 'assistant', text: 'D1:2 Melanie: Hey!' }] };
  const messages = threadMessages(task, session, 0);
  assert.deepEqual(messages.map(m => [m.sender, m.content, m.createdAt]), [
    ['user', 'D1:1 Caroline: Hi Mel!', '2023-05-08T13:56:00+00:00'],
    ['agent', 'D1:2 Melanie: Hey!', '2023-05-08T13:56:00+00:00']]);
  assert.equal(new Set(messages.map(m => m.id)).size, 2);
  assert.throws(() => threadMessages(task, { id: 'x', turns: [] }, 1), /timestamp/);
});

test('envelopes, thread ids and agent replies are read from the core shapes', () => {
  assert.deepEqual(unwrap({ result: { data: { mode: 'on' } } }), { mode: 'on' });
  assert.equal(threadId({ data: { id: 'thread-1', title: 'Chat' } }), 'thread-1');
  assert.equal(threadId({ result: { data: { id: 'thread-2' } } }), 'thread-2');
  assert.throws(() => threadId({ data: {} }), /no thread id/);
  assert.deepEqual(replyText({ result: 'Blue.', logs: [], hit_cap: false }), { text: 'Blue.', hitCap: false });
  assert.deepEqual(replyText({ result: 'partial', hit_cap: true }), { text: 'partial', hitCap: true });
  assert.throws(() => replyText({ logs: [] }), /unexpected/);
});

test('the question carries its date and the answer instruction', () => {
  const prompt = questionPrompt({ question: 'Where did I go?', question_date: '2023/05/30 (Tue) 10:00' });
  assert.match(prompt, /^Where did I go\?\nCurrent date: 2023\/05\/30/);
  assert.match(prompt, /no information available/);
  assert.doesNotMatch(questionPrompt({ question: 'Q?' }), /Current date/);
});

test('enrichment settles after three quiet polls, and any new job restarts the count', () => {
  const usage = (pending, queued) => ({ enrichment_backlog: { jobs_pending: pending, jobs_queued_total: queued } });
  let s = { quiet: 0, lastQueued: undefined };
  s = nextQuiet(s, usage(0, 5)); assert.equal(s.quiet, 0);
  s = nextQuiet(s, usage(0, 5)); s = nextQuiet(s, usage(0, 5)); assert.equal(s.settled, false);
  s = nextQuiet(s, usage(0, 6)); assert.equal(s.quiet, 0, 'a new job resets the count');
  s = nextQuiet(s, usage(0, 6)); s = nextQuiet(s, usage(0, 6)); s = nextQuiet(s, usage(0, 6));
  assert.equal(s.settled, true);
  assert.throws(() => nextQuiet(s, {}), /missing/);
});

test('pre-turn timeouts are found in the core log', () => {
  const log = 'a\n[memory:hooks] pre_turn timed out; the turn runs without a pack timeout_ms=1500\nb';
  assert.equal(preTurnTimeouts(log).length, 1);
});
