import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coreConfig, derivationCaughtUp, indexerState, isSettled, nextQuiet, preTurnTimeouts, questionPrompt, replyText, threadId, threadMessages, unwrap } from './integration-lib.mjs';

test('the core config points memory at the relay and keeps product defaults', () => {
  const toml = coreConfig({ endpoint: 'http://127.0.0.1:4321', waitMs: 1500 });
  assert.match(toml, /\[memory\]\nengine = "cortexdb"/);
  assert.match(toml, /endpoint = "http:\/\/127\.0\.0\.1:4321"/);
  assert.match(toml, /\[memory\.conversations\]\nenabled = true/);
  assert.match(toml, /pre_turn_timeout_ms = 1500\ndate_hint = false/);
  assert.match(coreConfig({ endpoint: 'http://127.0.0.1:1' }), /pre_turn_timeout_ms = 10000/);
  assert.match(coreConfig({ endpoint: 'http://127.0.0.1:1', capture: false }), /\[memory\.conversations\]\nenabled = false/);
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
  assert.match(prompt, /the week before 3 March 2023/);
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

test('settled needs no pending job, no open call and a quiet gateway', () => {
  assert.equal(isSettled({ pending: 0, inFlight: 0, idleMs: 90_000 }), true);
  assert.equal(isSettled({ pending: 1, inFlight: 0, idleMs: 600_000 }), false, 'a pending job');
  assert.equal(isSettled({ pending: 0, inFlight: 1, idleMs: 600_000 }), false, 'a call in flight');
  assert.equal(isSettled({ pending: 0, inFlight: 0, idleMs: 30_000 }), false, 'a drain cycle can still come');
  assert.equal(isSettled({ pending: 0, inFlight: 0, idleMs: 5_000 }, 1_000), true);
  assert.throws(() => isSettled({ pending: 0, inFlight: 0 }), /missing/);
});

test('with memory off the core has no engine and logs and recalls nothing', () => {
  const config = coreConfig({ memory: false });
  assert.match(config, /\[memory\]\nengine = "none"/);
  assert.match(config, /\[memory\.conversations\]\nenabled = false/);
  assert.match(config, /\[memory\.recall\]\nenabled = false/);
  assert.doesNotMatch(config, /cortexdb/);
});

test('the indexer is done only with nothing lagging and nothing in flight', () => {
  assert.equal(indexerState({ indexer: { lag: 0, inflight: 0, captured_head: 9 } }).done, true);
  assert.equal(indexerState({ indexer: { lag: 0 } }).done, true, 'no inflight count means none');
  assert.equal(indexerState({ indexer: { lag: 3, inflight: 0 } }).done, false);
  assert.equal(indexerState({ indexer: { lag: 0, inflight: 2 } }).done, false);
  assert.throws(() => indexerState({}), /no indexer lag/);
  assert.throws(() => indexerState({ indexer: { lag: 'soon' } }), /no indexer lag/);
});

test('derivation has caught up only when every scope says so', () => {
  assert.equal(derivationCaughtUp({ a: { caught_up: true }, b: { caught_up: true } }), true);
  assert.equal(derivationCaughtUp({ a: { caught_up: true }, b: { caught_up: false, state: 'building' } }), false);
  assert.equal(derivationCaughtUp({ a: { state: 'settling' } }), false, 'a missing flag is not caught up');
  assert.equal(derivationCaughtUp({}), true, 'nothing to derive');
});
