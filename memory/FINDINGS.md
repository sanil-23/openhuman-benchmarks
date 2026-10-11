# Memory audit: GLM 5.3 Flash, issue #27

This is an initial audit, not completion of [issue #27](https://github.com/tinyhumansai/openhuman-benchmarks/issues/27).
The controls cover 20 pinned questions: seven LongMemEval-S questions, one per
category including abstention, and thirteen LoCoMo questions from a complete
dialogue. Native ingestion was attempted for all eight histories; 19 native
questions were scored and one remained unscored after the readiness timeout.
There are **79/80** graded comparisons across the four arms. GLM 5.3 Flash uses Z.ai and low reasoning. Embeddings use
`openai/text-embedding-3-small`. LongMemEval uses its official judge prompt with
`openai/gpt-4o-mini-2024-07-18`; LoCoMo uses its official category-specific
F1/abstention functions, including stemming and its multi-answer rules.

Results, effective pins, per-category metrics and charged cost are in
[`results/memory27-glm53flash/`](../results/memory27-glm53flash/).
[`audit.md`](../results/memory27-glm53flash/audit.md) summarizes the results;
[`audit.json`](../results/memory27-glm53flash/audit.json) holds timings and
failure details. The persistent [`budget.json`](../results/memory27-glm53flash/budget.json)
covers the whole experiment, including aborted calls, failed setup and the
packing ablation. A new call reserves its upper cost before forwarding;
provider price ceilings and output bounds apply to every call. Unknown costs
retain their reservations. The limit is $10; reported cost and the conservative
charged total are different fields.
Final reported cost was **$2.0559**, with **$2.2528** charged including
uncertain reservations, against the $10 cap. Paid execution has stopped.

On the six LongMemEval questions scored by every arm, native recall scored
3/6, full context 4/6, reference retrieval 2/6 and no memory 1/6. Native recall
correctly computed the charity event's **$50** surplus (`078150f1`), where
both full context and reference retrieval failed. The snapshots contain useful
memory wins as well as failures; they do not support a general ranking.

## What was measured

The memory arm imports individual historical turns through the pinned
TinyMemory `CortexEngine`, then runs `AgentMemory::pre_turn` in fresh threads.
It measures the memory library OH uses, not the desktop agent. It does not
exercise core binding, scrubbing, automatic capture decisions, date-hint
inference, the core timeout wrapper, or JSON-RPC session replay. The reference
engine is a deterministic retrieval control, not an independent competitor.

The initial native LoCoMo run used visible writes and did not explicitly wait
for all enrichment. Its packs contain no earlier probe questions in their
gathered hit metadata. Subsequent runner changes use accepted writes, check
every receipt's visibility, require three quiet enrichment polls and verify
probe-question deletion. Each new native task now gets a fresh CortexDB
container and physical storage on a Docker internal network. These method
differences matter when reproducing the initial artifacts.

Listing receipt IDs proves readability, not vector readiness. The saved
server logs are audited separately for completed indexing batches. For the
isolated temporal instance they account for all **471 historical turns**
plus the probe. Its enrichment counter reported only 256 queued jobs, so
that counter must not be treated as proof that every turn was enriched.
During the `3d86fd0a` run, the queue later increased from 256 to 512 jobs
while the harness was still waiting. Three quiet polls are a pragmatic
barrier, not a certificate of complete derived indexing. A future comparable
run needs per-import readiness or an explicitly disabled enrichment lane.
The runner now logs timestamped polling observations for further diagnosis.

The first LongMemEval native attempt shared the preceding LoCoMo server. It
was left **unscored** after its ten-minute enrichment wait expired with 16 jobs
pending. Its record is preserved as
[`initial-shared-lme-gpt4-fe651585-cortex.json`](../results/memory27-glm53flash/initial-shared-lme-gpt4-fe651585-cortex.json).
That failure cannot establish isolated LongMemEval performance. The one-task
rerun uses fresh storage; its outcome is recorded separately as
[`lme-gpt4-fe651585-cortex.json`](../results/memory27-glm53flash/lme-gpt4-fe651585-cortex.json).
It ingested in **237,936 ms**, recalled in **1,601 ms**, and answered “No
information available.” The pack contained unrelated PDF and workplace
material; this is a recorded miss on the direct path, not proof of a desktop
retrieval defect. Appending the benchmark's current date to the query is
another ablation to test before changing temporal ranking.

## Findings and concrete OH improvements

### 1. The core recall deadline needs a production-path regression

The initial native LoCoMo pre-turn calls had median **1,586 ms**; **9 of 13**
exceeded **1,500 ms**, and the slowest took **9,943 ms**. See the per-probe
timings in [`locomo-0-cortex.json`](../results/memory27-glm53flash/locomo-0-cortex.json).
OH's default `DEFAULT_PRE_TURN_TIMEOUT_MS` is 1,500. Its hook logs
“pre_turn timed out; the turn runs without a pack.”

Targets: `vendor/openhuman/crates/openhuman-core/src/config/schema/memory.rs`
and `src/memory/lifecycle/hooks.rs`. Add a slow-engine regression through the
core hook, expose timeout distinctly from an empty retrieval, and preserve an
explicit unavailable-memory notice for the model. Measure pooled v3 recall
before changing the default deadline: this audit's unpooled direct path does
not prove that nine desktop turns would time out.

### 2. A retrieved answer can disappear during pack trimming

For LongMemEval `561fabcd`, full history answered **Fissionator** correctly,
while the 1,200-token reference pack did not. An offline diagnostic regenerated
the **exact same pack** and found a retrieved turn containing “Fissionator”
at character 96. That hit was absent from the final cited refs. The final
pack used only 1,067 estimated tokens because trimming dropped a whole bullet.

Evidence: [`diagnostic-561fabcd-reference.json`](../results/memory27-glm53flash/diagnostic-561fabcd-reference.json).
The 2,400-token ablation retained the name in a 1,367-token pack, but the model
still denied that a name had been decided:
[`ablation-budget2400-answer.json`](../results/memory27-glm53flash/ablation-budget2400-answer.json).
Increasing the budget alone is therefore **not a verified fix**.

The isolated native run also retained “Fissionator,” in a 951-token pack,
but answered that there was no final decision. See
[`lme-561fabcd-cortex.json`](../results/memory27-glm53flash/lme-561fabcd-cortex.json)
and its answer row. Keeping a name mention and keeping the decision evidence
are separate requirements.

Targets: TinyMemory's `crates/tinymemory-tools/src/recall/gather.rs` and
`recall/render.rs`, vendored under OH. Add a fixture proving that a decision
already retrieved survives rendering within the normal budget. Compare
query-relevant excerpts and relevance across sections against whole-bullet
removal. Keep the model-answer regression as well as the “string in pack”
check; one did not imply the other here.

### 3. Unpooled “Team conversations” includes the current agent

With one agent and twelve stored turns, the default lifecycle returned six
own turns under “This agent's history” and **three more own turns** under
“Team conversations.” Its documented contract says the latter holds other
agents' turns. No peer agent was ingested.

Run `node memory/repro-team.mjs`; it deliberately exits 1 while this behavior
exists. The saved [`team-section-repro.json`](../results/memory27-glm53flash/team-section-repro.json)
includes every wrongly attributed hit and its `agent_id`.

Target: TinyMemory's `crates/tinymemory-tools/src/lifecycle/mod.rs`,
`standard_sections`, and recall filtering. Add a regression with more own
turns than `history_limit` plus a relevant peer turn; exclude the current
agent before filling the team limit. This is an unpooled-layout attribution
bug, not evidence of a cross-tenant leak. The pooled v3 layout suppresses this
section and is not implicated by this repro.

### 4. Temporal answers need both relevant events and their ordering

On `gpt4_fe651585`, the reference arm answered **Rachel** while full history
and the official reference said **Alex**. The recalled sample emphasized a
recent adoption and an older birthday, which reversed the comparison.
See the answers and judge outputs in
[`answers.jsonl`](../results/memory27-glm53flash/answers.jsonl).

Targets: TinyMemory's time-hint ranking and recall rendering; OH's
`src/memory/lifecycle/date_hint.rs`. Test a parenthood/adoption timeline through
the product hook. Preserve within-session turn ordering in rendered evidence,
and distinguish a relevant ranked sample from a complete timeline. Do not infer
“never recorded” from the absence of a fact in a small recalled pack.

### 5. Low LoCoMo F1 can reflect answer formatting as well as retrieval

For `locomo-0-74`, the full-history answer correctly said the road trip was
the weekend before October 20, 2023, then added accident and Grand Canyon
details. Official F1 was **0.3125**. For `locomo-0-8`, the answer described the
correct week but added explanation; F1 was **0.3226**. Other answers also
missed required facts, so these examples do not explain all low scores.

Benchmark improvement: use an identical, answer-only prompt in every arm and
keep date answers concise; retain the official scorer unchanged. Product
improvement: add concise-answer regressions for direct factual questions,
without imposing terse formatting on unrelated conversations. Report F1 as
F1, not as the percentage of answers that are factually correct.

### 6. Small extraction probes passed; batched extraction needed salvage

The existing TinyMemory eval documentation reports GLM 5.3 Flash exhausting
small extraction limits on reasoning. Here simple structured probes returned
valid JSON at **512, 2,048 and 8,192** tokens. The observed live extraction
calls also returned content. See
[`extraction-probe.json`](../results/memory27-glm53flash/extraction-probe.json)
and wire records/captures. Live batched knowledge extraction used a
**16,384-token** bound, so the small probes do not establish that a small cap
is safe for real histories. Test the current provider and reasoning settings
on representative payloads before changing extraction limits.

However, the isolated temporal server logged **three** incomplete batched
knowledge extractions, with **34 missing event indexes** salvaged through
per-event retries. Those calls are included in the ledger. This is a concrete
counterexample to treating valid JSON as complete extraction. The log and
its digest/counts are in
[`server-diagnostics.json`](../results/memory27-glm53flash/server-diagnostics.json).
[`extraction-coverage-examples.json`](../results/memory27-glm53flash/extraction-coverage-examples.json)
records two valid-JSON responses with only three and two indexes out of
sixteen, despite a normal `stop` finish at the larger output bound.
Add a multi-event fixture to the extraction path that checks coverage and
measures salvage overhead before changing model or batching settings.

### 7. Aggregate enrichment readiness can block an otherwise indexed history

The fresh-server `3d86fd0a` attempt reached its ten-minute enrichment limit.
Its setup took **619,205 ms**, ending with 557 completed jobs, 65 pending and
622 queued. It is **unscored**, with evidence in
[`lme-3d86fd0a-cortex.json`](../results/memory27-glm53flash/lme-3d86fd0a-cortex.json)
and its server log. The completed raw indexing batches account for all 526
imported turns. This is a harness readiness failure, not a recorded wrong
answer or proof that raw recall was unavailable.

Target: the benchmark readiness barrier and Cortex/TinyMemory readiness
telemetry. Fence the imported receipt set independently of recurring
background work. Compare a separately labelled raw-only retrieval arm with
derived-memory readiness; keep setup availability separate from graded QA.
Do not repeat the same failed import until its cause or readiness policy is
addressed. The runner can select another remaining history with
`--native-task <manifest-task-id>` while retaining the same budget ledger.

## What remains before closing #27

Run the desktop/session-replay arm through the actual core; address readiness
and rerun the unscored native category. Add an independent memory system;
the reference engine does not satisfy that comparison. Attribute asynchronous
ingestion and query costs by lane, record TTFT and storage size, and integrate
embedding metering into the shared proxy/viewer. This audit's `memory-background`
cost includes both ingestion and recall and must not be presented as an exact
split. The latest OH pin exposes `tinyhumans` and `cortexdb` engines; the
issue's older driver list also needs reconciliation with that code.

Validation: the Rust runner builds and passes Clippy with warnings denied;
the regression suite covers the 100-item ingestion limit and probe isolation;
official scoring tests pin category-specific behavior; gateway tests cover
concurrent reservations, restart, price-bound failures and refusal before
forwarding. The team-scope diagnostic intentionally fails on the pinned bug.
Reproduction commands are in [`RUNBOOK.md`](../RUNBOOK.md).
