# OpenHuman benchmarks

Public cross-harness benchmarks for [OpenHuman](https://github.com/tinyhumansai/openhuman).
Browse the results at **https://tinyhumansai.github.io/openhuman-benchmarks/**.

- `results/<run>/` is committed: summaries, grades, per-task patches, harness logs and the
  meter proxy's per-call records (`results/meter.jsonl`). Raw request captures
  (`results/<run>/captures/`, the full prompts and responses) are gitignored and stay on the
  bench host; `node viewer/server.mjs` there shows them alongside everything else.
- Every push to `main` rebuilds the site (`viewer/build-static.mjs`, `.github/workflows/pages.yml`).
- OpenHuman is vendored as a submodule at `vendor/openhuman`; `./bundles/build.sh openhuman`
  compiles that checkout. Move the pin to benchmark a different build.

See [RUNBOOK.md](RUNBOOK.md) to reproduce a run.

## Cross-harness benchmark

Runs OpenHuman, Claude Code, Codex, OpenCode, OpenClaw and Hermes on the same
tasks with the same model, the same OpenRouter key and the same reasoning
level, inside identically limited containers, and reports resource use,
latency, cache efficiency, prompt size, cost and SWE-bench Verified resolve rate.

## How the comparison is kept fair

| Control | Mechanism |
|---|---|
| Same model | The metering proxy rewrites `model` on every request to `BENCH_MODEL`, except models in `BENCH_PASSTHROUGH_MODELS` (default: OpenHuman's pinned vision sub-agent model, `qwen/qwen3.5-flash-02-23`, a text-only `BENCH_MODEL` could not replace). Those keep their model, reasoning and provider, and their meter rows carry `passthrough: true` and a cost only when upstream reports one. |
| Same provider | The proxy pins `provider: {order: [BENCH_PROVIDER], allow_fallbacks: false}` on every request, so the prompt cache is not split across OpenRouter backends. |
| Same reasoning level | The proxy strips each protocol's own spelling (`thinking`, `reasoning_effort`, ...) and injects `reasoning: {effort: BENCH_REASONING}`. |
| Same key | Only the proxy holds `OPENROUTER_API_KEY`; harnesses get a dummy token. |
| Same resources | One compose `task` service: `cpus: 4`, `mem_limit: 8g`, no swap, same for every harness. |
| Same metering | Latency, TTFT, tokens, cache and cost are measured by the proxy from the wire, not from each harness's own accounting. |
| Same tasks | Fixed instance list (`swebench/instances-10.txt`, seeded, pinned dataset revision) and a single prompt wrapper. |
| Memory | OpenHuman memory is explicitly off: no engine, embeddings, automatic recall or conversation capture. The running core must confirm this before inference. |
| Same grader | The official `swebench.harness.run_evaluation`. |

The proxy logs what each harness *tried* to send (`overridden`), so a harness
that insists on a different model or effort is visible rather than silently
normalised.

## Layout

```
docker-compose.yml     meter-proxy + the `task` service (limits live here)
meter-proxy/           wire parsers (chat / Anthropic / Responses), pricing, proxy, capture
viewer/                zero-dependency web UI over results/ (prompts, tools, cache diagnostics)
runner/                in-container entry (cgroup CPU/RAM sampler, patch capture, check)
bundles/               per-harness build (/opt/harness) + adapters/*.sh headless entry points
tasks/micro.mjs        5 task smokes + an OpenHuman memory-policy smoke
swebench/              prepare.py (select + task dirs), grade.mjs (official evaluator)
tbench/                Terminal-Bench via Harbor: OpenHuman agent, run + result conversion
orchestrate.mjs        host driver: tags the proxy, runs one container per task
quiet-host.mjs         one benchmark run per host (shared by orchestrate.mjs and tbench/run.mjs)
run-meta.mjs           harness build + knobs recorded on every runs.jsonl row
report.mjs             merges everything into results/<run>/summary.{json,md}
harnesses.lock         pinned harness versions
```

## OpenHuman-only benchmarks and stress tests

Moved here from `tinyhumansai/openhuman` with their history. Each builds or runs the
OpenHuman checkout at `vendor/openhuman` (set `OPENHUMAN_DIR` to use another one), and
none of them runs in CI.

| Path | What it measures |
|---|---|
| [`profile/`](profile/scripts/README.md) | The core as an embedded library: the `library-profile`, `rss-bench`, `tool-search-bench` and `tool-dialect-bench` binaries (its own Cargo workspace over the vendored crates) and the `scripts/` that drive them. Method in [`profile/docs/library-benchmarking.md`](profile/docs/library-benchmarking.md). |
| [`agent-scale/`](agent-scale/README.md) | A real `openhuman-core` server process at concurrency against a mock LLM: RSS, CPU and leak verdicts. |
| [`life-scenarios/`](life-scenarios/README.md) | Six everyday assistant tasks run through the desktop composer path and graded on what lands on disk. |
| [`onboarding-stress/`](onboarding-stress/run.mjs) | 25 onboarding conversations against a running core, each judged, with a Markdown report. |

## Run it

```bash
export OPENROUTER_API_KEY=...          # or put it in .env (see .env.example)
export BENCH_UID=$(id -u) BENCH_GID=$(id -g)

# 1. build harness bundles (once; openhuman compiles the core, ~10-20 min cold)
for h in claude-code codex opencode openclaw hermes deepseek-harness deepseek-harness-minimal openhuman; do ./bundles/build.sh $h; done

# 2. micro suite (cheap smoke test of every adapter, cold start, steady state)
for h in claude-code codex opencode openclaw hermes openhuman; do
  node orchestrate.mjs --harness $h --suite micro --run-id micro-1 --repeat 3
done
node report.mjs --run-id micro-1

# 3. SWE-bench Verified, 10 instances
uv venv --python 3.12 .cache/swebench-venv
uv pip install --python .cache/swebench-venv/bin/python swebench datasets
.cache/swebench-venv/bin/python swebench/prepare.py --n 10 --out tasks/generated/swe --pull
for h in claude-code codex opencode openclaw hermes openhuman; do
  node orchestrate.mjs --harness $h --suite swe --tasks-dir tasks/generated/swe --run-id swe-1
  node swebench/grade.mjs --run-id swe-1 --harness $h
done
node report.mjs --run-id swe-1
```

Harnesses run one at a time on purpose: two harnesses sharing the host would
contend for CPU and distort the CPU and latency columns.

## Terminal-Bench 2.0 / 4.0 (OpenHuman only)

Terminal-Bench runs through [Harbor](https://github.com/harbor-framework/harbor), the
benchmark's own harness, so each task keeps its own environment (prebuilt image or
Dockerfile), CPU/memory, network policy (public internet, as Terminal-Bench specifies), agent
timeout and verifier (2.0 grades the agent's container; 4.0 a separate verifier image fed the
declared artifacts). The bench adds three things:

- `tbench/openhuman_agent.py`: OpenHuman as a Harbor agent. It runs the usual
  `runner/entry.mjs` + `bundles/adapters/openhuman.sh` inside the task container, so CPU/RAM
  sampling and the adapter are the same as for every other suite.
- A compose overlay (written by `tbench/run.mjs`) that mounts the bundle and runner read-only
  and the meter proxy's unix socket (`.cache/meter-sock/<compose project>/`). It declares no networks, so the
  task's own networking stays exactly as Harbor sets it up: internet on or off, Harbor's
  egress-control sidecar, or a `network_mode` the task's compose file sets. Every call is
  metered and captured under `results/<run>/captures/` like any other run.
- A conversion of Harbor's job dir (kept at `.cache/harbor-jobs/<run>/`) into
  `results/<run>/openhuman/<task>/` (`result.json`, `harness.log`, `verifier/`,
  `harbor-result.json`), `runs.jsonl` and `grade.json` (resolved = verifier reward 1), which
  `report.mjs` and the viewer read.

```bash
uv tool install harbor
./run-tbench.sh 2 tb2-sample5     # tbench/instances-tb2-5.txt, dataset terminal-bench@2.0
./run-tbench.sh 4 tb4-sample5     # tbench/instances-tb4-5.txt, terminal-bench/terminal-bench@4.0.0
```

Each call carries its trial's tag as a path prefix (`/__tag/<run>/<harness>/<task>/`) that the
proxy strips, so `--n-concurrent N` is metered correctly. Trials still run one at a time by
default, because CPU and latency are only comparable between serial runs; a summary notes when
trials ran concurrently. OpenHuman's own turn ceiling (60 min by default) is set to the task's agent timeout from
`task.toml` (times Harbor's agent/timeout multiplier) minus 120 s (`BENCH_TURN_MARGIN_S`), so the
turn ends itself and records a stop reason before Harbor's kill; the SWE and DeepSWE suites derive it
the same way from `TASK_TIMEOUT_S` (`runner/turn-budget.mjs`). An explicit
`OPENHUMAN_AGENT_TURN_TIMEOUT_SECS` wins, and `0` removes the ceiling. Each row in `runs.jsonl`, and Harbor's
`agent_info.version`, records the OpenHuman build (the bundle's `GIT_SHA`). The sample lists are seeded draws over tasks that need no GPU, at most 16 GB, and a
public network. Unlike the other suites, these containers have internet access, because
Terminal-Bench is defined that way and its verifiers install their own tooling. The task
solutions are public on GitHub, so check `captures/` before trusting a pass.

## OpenHuman memory policy

The cross-harness adapter selects no memory engine (`[memory] engine = ""`), sets
`embeddings_provider = "none"` and disables `[memory.recall]` and
`[memory.conversations]`. This measures fresh, stateless task containers and prevents
unmetered memory model or embedding traffic. Memory-enabled product behaviour is outside
these comparisons.

Before inference, `oh-turn.mjs` reads `openhuman.subsystems_status`,
`openhuman.memory_engine_get`, `openhuman.memory_policy_get` and
`openhuman.embeddings_get_settings` from the running core. It writes the bound driver,
engine, effective embedder, embedding model, automatic recall and capture settings to
`memory-state.json` beside `core.log`. Each `runs.jsonl` row includes that runtime state
under `memory`. An unexpected setting, failed RPC or unsupported older bundle fails setup;
missing evidence in older results is marked `verified: false`. Rebuild bundles after
updating the adapter.

The micro task `m6-memory-policy` boots the actual core, checks these settings and
asserts that write (`memory_learn`) and recall RPCs both return `MEMORY_OFF`, without
making a model request:

```bash
node orchestrate.mjs --harness openhuman --suite micro --only m6-memory-policy --run-id memory-smoke --repeat 1
```

For an offline regression check with a compiled bundle and `bench-micro` image:

```bash
OH_LIVE_TEST_BUNDLE="$PWD/.cache/harness/openhuman" node --test bundles/oh-live.test.mjs
```

This also sends a normal turn to a local mock model with external networking disabled.
The adapter uses an ephemeral encryption key for the task's credential store, so its
required dummy credential works without an OS keyring.

This checks the chosen **memory-off** contract. A store/recall round trip requires a
separate memory-enabled run and a metered engine. The current pin uses the `memory` tool
with actions; the historical `prompts/openhuman/` capture contains the older
`memory_store` / `memory_recall` / `retrieve_memory` tools and an invalid `memory_search`
reference. It is evidence of that older run, not the current prompt.

## Seeing what each harness sends

The proxy sits between every harness and OpenRouter, so it records the request as the
harness built it (before model/reasoning are pinned). Per run, under
`results/<run>/captures/`: one JSON per call (`<harness>/<task>/<seq>.json`) holding the
sampling parameters, headers (credentials dropped), `cache_control` marker count, any
`prompt_cache_key`, the raw response, and, for caching, whether the system prompt and tool
list matched the previous call and how many earlier messages were re-sent byte-for-byte.
System prompts, tool schemas and messages are stored once each in `captures/blobs/`, so a long
task costs the system prompt once. `METER_CAPTURE=0` turns it off.

```bash
node viewer/server.mjs            # http://127.0.0.1:8787, read-only, loopback, reads files on demand
node viewer/server.mjs --port 9000 --results /path/to/results
./run-deepseek.sh                 # DeepSeek harness (minimal + full) micro suite, one at a time
```

The viewer shows per-harness aggregates (tokens, cache %, cost, system-prompt and tool-schema
size, rejected overrides), the system prompt each harness actually sent, tool schemas, every
call's cache diagnostics, the conversation, and the provider's raw response.

## Charts

```bash
node report.mjs --run-id swe-1                 # writes results/swe-1/summary.json
node charts.mjs --run swe-1 --png              # results/swe-1/charts.{svg,png}
node charts.mjs --run swe-1 --theme dark --png
node charts.mjs --run swe-1 --only resolved,cost_task,cache   # a subset of panels
```

One panel per KPI, one column per harness, OpenHuman highlighted, each panel on its own
scale from zero, with a star on the best column (direction-aware). The SVG has no
dependencies; `--png` installs `@resvg/resvg-js` into `.cache/` on first use. Rendered
examples are in `charts/`.

![swe-1](charts/swe-1.png)

## Metrics

- **CPU / RAM**: container-wide cgroup v2 (`cpu.stat usage_usec`, `memory.current`,
  kernel `memory.peak`), sampled at 2 Hz around the harness only (setup and the
  correctness check are not charged). Memory includes page cache.
- **TTFT / latency / cache % / tokens**: from the proxy. TTFT is time from the
  request being sent upstream to the first reasoning-or-text token. Cache % is
  cached prompt tokens over all prompt tokens across a task's calls.
- **System prompt size**: first request of each task, tokenised with o200k_base.
  Reported as system prompt, tool schemas, and their sum: harnesses differ in
  whether the tool catalogue is API `tools` or text inside the system prompt, so
  only the sum is comparable.
- **Cost**: OpenRouter's reported `usage.cost` when present, otherwise computed
  from the model's price list with the cached-token discount (`cost_source` in
  `meter.jsonl` says which). Also cost per resolved task.
- **Cold start**: harness start to its first model call.

## Harness lineup

`openhuman` (native only: provider JSON tool calls, `OPENHUMAN_TOOL_DISPATCHER=native`; no other variants), `claude-code`, `codex`, `opencode`, `openclaw`,
`hermes`, `deepseek-harness` (DeepSeek's `dsh` through its Python SDK, full `sdk` profile) and
`deepseek-harness-minimal` (the `sdk-minimal` profile, a shell only, which DeepSeek's own
`BENCHMARK.md` prescribes). `openhuman-python` is the retired python-dispatcher default: its
data stays under `results/` but it is excluded from reports and charts (`--include-archived`
brings it back). `rename-harness.mjs` relabels a finished run's data when a variant is promoted.

Only one benchmark may run on a host at a time: `orchestrate.mjs` and `tbench/run.mjs` wait
while another of them, a `harbor run`, or a SWE-bench / DeepSWE grading pass is active
(`quiet-host.mjs`; `BENCH_ALLOW_CONCURRENT=1` skips the wait), and each checkout gets its own
compose project and proxy port, so two worktrees never share a proxy.

Every `runs.jsonl` row records the harness build (`harness_version`: the OpenHuman bundle's
`GIT_SHA`, or the version pinned in `harnesses.lock`) and the bench knobs the run set
(`knobs`: `OPENHUMAN_*`, `TASK_TIMEOUT_S`, ...), and the summary header lists the builds.

## Caveats

- Ten tasks with one attempt is a smoke test, not a ranking.
- Terminal-Bench containers have whatever network the task declares (most allow the
  internet); the other suites' containers reach only the meter proxy.
- OpenHuman reaches the proxy through a loopback forwarder (it refuses to send a
  bearer to a non-loopback `http` endpoint); the forwarder is a few KB of node.
- Hermes's installer clones its `main` branch rather than the tag in
  `harnesses.lock`; the commit used is whatever `main` was at bundle build time.
  Hermes also copies its installed tree to a writable `HOME` at start, which
  counts in its cold start.
- Claude Code needs `IS_SANDBOX=1` to accept the permission bypass as root.
- Codex only speaks the Responses API; this works because OpenRouter serves
  `/v1/responses`.
