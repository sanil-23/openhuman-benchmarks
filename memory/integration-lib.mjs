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
export function coreConfig({ endpoint, waitMs = DEFAULT_WAIT_MS, dateHint = false }) {
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
    'enabled = true',
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
 * question and current date; the instruction to answer briefly and to say
 * when the information is missing matches its system prompt, so the two
 * arms are scored on comparable answers.
 */
export function questionPrompt(q) {
  return `${q.question}${q.question_date ? `\nCurrent date: ${q.question_date}` : ''}\n\n` +
    'Answer briefly from what you remember of our earlier conversations. ' +
    'If the information is missing, say "no information available".';
}

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
