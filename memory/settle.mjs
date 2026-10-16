// Waiting until a CortexDB has finished its background work, shared by the
// library arm (run.mjs) and the integration arm (integration.mjs).
//
// `jobs_pending` alone is not enough (integration-lib `isSettled`): CortexDB
// v0.10.4 keeps extracting, profiling and consolidating after it reads 0.
// Every model call it makes passes through the budget gateway, so settled
// means nothing pending, no counted call open at the gateway, and none for
// QUIET_MS. Which calls count is the gateway's `idleIgnore` /
// `idleIgnoreEmbeddings` (see CORTEX_IDLE_IGNORE below).
import { CORTEX_API_KEY } from './cortex.mjs';
import { CONCEPT_ABSTRACTION_PREFIXES, QUIET_MS, isSettled } from './integration-lib.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * The gateway options both arms settle with: only GLM calls count. CortexDB's
 * concept abstraction runs on long after everything else, and its knowledge
 * compaction (every 300 s in cortex.toml) re-embeds the entity facts one call
 * at a time, taking longer than the interval, so embeddings never stop.
 * Neither changes the facts recall reads; every change to them is a GLM call.
 */
export const CORTEX_IDLE_IGNORE = { idleIgnore: CONCEPT_ABSTRACTION_PREFIXES, idleIgnoreEmbeddings: true };

/**
 * Wait until the CortexDB at `base` has settled, given the gateway that serves
 * only it. Returns a record for run metadata; throws after `limitMs`.
 */
export async function settleCortex({ base, gateway, label, limitMs = 3_600_000, log = console.log }) {
  const started = Date.now();
  const polls = [];
  for (let poll = 0; ; poll++) {
    const response = await fetch(`${base}/v1/admin/usage`, { headers: { authorization: `Bearer ${CORTEX_API_KEY}` } });
    if (!response.ok) throw new Error(`CortexDB usage: HTTP ${response.status}`);
    const pending = (await response.json())?.enrichment_backlog?.jobs_pending;
    const state = { pending, inFlight: gateway.activity.inFlight, idleMs: Date.now() - gateway.activity.last,
      ignored_calls: gateway.activity.ignored };
    if (poll % 10 === 0) polls.push({ at: new Date().toISOString(), ...state });
    if (isSettled(state)) {
      log(`settle ${label}: quiet after ${Math.round((Date.now() - started) / 1000)} s`);
      return { label, settled_at: new Date().toISOString(), wait_ms: Date.now() - started, quiet_ms: QUIET_MS,
        gateway_calls_total: gateway.budget.state.calls, polls };
    }
    if (Date.now() - started > limitMs) throw new Error(`CortexDB did not settle within ${limitMs / 60000} min (${label}): ${JSON.stringify(state)}`);
    await sleep(3000);
  }
}
