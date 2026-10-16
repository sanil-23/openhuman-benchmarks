// Pure pieces of the integration arm (issue #38), kept apart from the runner
// in integration.mjs so they can be tested without a core, CortexDB or the
// gateway.

/** The `system` label integration rows carry in answers.jsonl. */
export const SYSTEM = 'oh-integration';

/** Product default for `[memory.recall] pre_turn_timeout_ms` (OpenHuman 9b7ae8e1f3). */
export const DEFAULT_WAIT_MS = 10000;

/**
 * The core's config.toml for one task: CortexDB as the engine, turns logged,
 * a recall pack before every turn, and the "Wait for memory" deadline under
 * test. Everything else keeps the product default, so the arm measures what a
 * user gets. Search is off: the benchmark asks about the history, not the web.
 */
export function coreConfig({ endpoint, waitMs = DEFAULT_WAIT_MS, dateHint = false, capture = true, memory = true }) {
  if (!memory) {
    // Memory off: no engine, nothing logged, nothing recalled (the
    // history-in-thread arm, where the thread itself holds the history).
    return [
      'embeddings_provider = "none"', '',
      '[memory]', 'engine = "none"', 'embedding_provider = "none"', '',
      '[memory.conversations]', 'enabled = false', '',
      '[memory.recall]', 'enabled = false', '',
      '[search]', 'enabled = false', '',
      '[runtime]', 'reasoning_effort = "low"', '',
    ].join('\n');
  }
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(endpoint)) throw new Error('CortexDB endpoint must be the loopback relay');
  if (!(Number.isInteger(waitMs) && waitMs > 0)) throw new Error('waitMs must be a positive integer');
  return [
    'embeddings_provider = "none"',
    '',
    '[memory]',
    'engine = "cortexdb"',
    'embedding_provider = "none"',
    '',
    '[memory.engines.cortexdb]',
    `endpoint = "${endpoint}"`,
    '',
    '[memory.conversations]',
    `enabled = ${capture ? 'true' : 'false'}`,
    '',
    '[memory.recall]',
    'enabled = true',
    `pre_turn_timeout_ms = ${waitMs}`,
    `date_hint = ${dateHint ? 'true' : 'false'}`,
    '',
    '[search]',
    'enabled = false',
    '',
    '[runtime]',
    'reasoning_effort = "low"',
    '',
  ].join('\n');
}

/**
 * One prepared session as thread messages for `openhuman.threads_message_append`.
 * Roles map to the core's senders: `user` opens a turn and every other role is
 * the agent's reply, which is how the memory backfill reads a thread. LoCoMo's
 * two speakers were mapped to user/assistant by prepare.py, and each text
 * already carries the speaker's name. Every message gets the session's
 * timestamp, so the backfill stores the dialogue at the date it happened.
 */
export function threadMessages(task, session, sessionIndex) {
  if (!session.timestamp) throw new Error(`session ${session.id} has no timestamp`);
  return session.turns.map((turn, i) => ({
    id: `${task.id}-s${sessionIndex}-t${i}`,
    content: turn.text,
    type: 'text',
    extraMetadata: { benchmark: 'memory', task: task.id, session: session.id },
    sender: turn.role === 'user' ? 'user' : 'agent',
    createdAt: session.timestamp,
  }));
}

/** Strip the core's `{result: …}` / `{data: …}` envelopes. */
export function unwrap(value) {
  while (value && typeof value === 'object' && !Array.isArray(value) && ('result' in value || 'data' in value)) {
    value = value.result ?? value.data;
  }
  return value;
}

/** The id of a thread created by `openhuman.threads_create_new`. */
export function threadId(result) {
  let value = result;
  for (let i = 0; i < 4 && value && typeof value === 'object'; i++) {
    if (typeof value.id === 'string') return value.id;
    value = value.result ?? value.data ?? value.thread;
  }
  throw new Error(`no thread id in ${JSON.stringify(result).slice(0, 200)}`);
}

/**
 * The reply of `openhuman.inference_agent_chat`: `{result: <text>, logs,
 * hit_cap}` (OpenHuman `AgentChatReply::into_rpc_json`).
 */
export function replyText(result) {
  if (typeof result === 'string') return { text: result, hitCap: false };
  if (result && typeof result.result === 'string') return { text: result.result, hitCap: result.hit_cap === true };
  throw new Error(`unexpected agent chat reply: ${JSON.stringify(result).slice(0, 200)}`);
}

/**
 * The question as the user sends it. The library arm's reader gets the same
 * question and current date; the instruction (answer briefly, resolve relative
 * dates, say when the information is missing) matches its system prompt
 * (prompt v6), so the two arms are scored on comparable answers.
 */
export function questionPrompt(q) {
  return `${q.question}${q.question_date ? `\nCurrent date: ${q.question_date}` : ''}\n\n` +
    'Answer briefly from what you remember of our earlier conversations. ' +
    'For a question about when something happened, give the date, week, month or year it happened, ' +
    'working out words such as "yesterday", "last week" or "this past weekend" from the date of the message that says them ' +
    '(a message of 3 March 2023 saying "last week" means "the week before 3 March 2023"). ' +
    'If the information is missing, say "no information available".';
}

/** Which question instruction `questionPrompt` gives (see run.mjs ANSWER_PROMPT_VERSION). */
export const QUESTION_PROMPT_VERSION = 'v6';

/**
 * One step of the CortexDB enrichment barrier, the same rule the library arm
 * uses (memory/src/main.rs): quiet means nothing pending and no new job
 * queued since the last poll; three quiet polls in a row end the wait.
 */
export function nextQuiet(state, usage) {
  const pending = usage?.enrichment_backlog?.jobs_pending;
  const queued = usage?.enrichment_backlog?.jobs_queued_total;
  if (!Number.isInteger(pending) || !Number.isInteger(queued)) throw new Error('missing enrichment counts');
  const quiet = pending === 0 && state.lastQueued === queued ? state.quiet + 1 : 0;
  return { quiet, lastQueued: queued, pending, queued, settled: quiet >= 3 };
}

/** Lines of the core log that mention a memory pre-turn timeout. */
export function preTurnTimeouts(log) {
  return log.split('\n').filter(line => /pre_turn timed out/.test(line));
}

/** How long the gateway must see no model call before CortexDB counts as settled. */
export const QUIET_MS = 90_000;

/**
 * Whether CortexDB has finished its background work. `jobs_pending` alone is
 * not enough: CortexDB v0.10.4 also drains enrichment in scheduler cycles
 * (16 events every ~30 s) that this counter does not show, and a restart
 * re-queues work. Every model call CortexDB makes passes through the budget
 * gateway, so settled means nothing pending, no call open at the gateway, and
 * none for `quietMs` (longer than a drain cycle). integration.mjs counts only
 * the GLM calls that change stored facts (see its gateway options).
 */
export function isSettled({ pending, inFlight, idleMs }, quietMs = QUIET_MS) {
  if (!Number.isInteger(pending) || !Number.isInteger(inFlight) || !Number.isFinite(idleMs)) throw new Error('missing settle inputs');
  return pending === 0 && inFlight === 0 && idleMs >= quietMs;
}

/** System-prompt prefixes of CortexDB v0.10.4's concept abstraction calls (see integration.mjs). */
export const CONCEPT_ABSTRACTION_PREFIXES = ['You are a concept abstraction engine.'];

/**
 * The indexer's state in a `/v1/admin/metrics` body: `done` once nothing is
 * waiting to be indexed and nothing is in flight. A body without an indexer
 * lag is an error, never "done".
 */
export function indexerState(metrics) {
  const indexer = metrics?.indexer;
  if (!indexer || !Number.isInteger(indexer.lag)) throw new Error('CortexDB metrics carry no indexer lag');
  const inflight = indexer.inflight ?? 0;
  return { lag: indexer.lag, inflight, captured_head: indexer.captured_head, done: indexer.lag === 0 && inflight === 0 };
}

/** Whether every scope's `/v1/derivation/status` says `caught_up`. */
export function derivationCaughtUp(scopes) {
  return Object.values(scopes).every(status => status?.caught_up === true);
}
