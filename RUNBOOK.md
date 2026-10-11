# Runbook: running the benches on an x86_64 Linux box

For an agent that has to run this rig end to end and hand back results. Read `README.md` for
what the controls are; this file is only the procedure. Do the steps in order and stop at
any "Gate" that fails.

Why x86_64 Linux: the SWE-bench Verified instance images (`swebench/sweb.eval.x86_64.*`) are
published for x86_64 only. On an arm64 host (Apple Silicon) they fail with
`no matching manifest for linux/arm64/v8`. The bundle Dockerfiles pick the Node build from
`uname -m`, so they should build on x86_64, but this has not been tested there; treat the
first build as the test.

## 0. Prerequisites

- Linux x86_64, Docker with the compose plugin, Node >= 22 (host driver; the harnesses
  carry their own), `uv`, `git`, `jq`.
- Resources: 4 CPUs and 8 GB are the task container limits (`BENCH_CPUS`, `BENCH_MEM`), so
  the box needs at least 6 CPUs / 12 GB free for the task plus the proxy, and about 60 GB of
  disk (SWE images are several GB each; the OpenHuman build is large).
- cgroup v2 on the host (`stat -fc %T /sys/fs/cgroup` prints `cgroup2fs`). The runner samples
  CPU and RAM from the container's cgroup.
- `OPENROUTER_API_KEY` in the environment or in `.env`. Never print it, log it or commit it.
  Only the proxy container holds it; harnesses get a dummy token.
- **Egress that does not hang.** An ISP can drop one of a CDN's anycast addresses while DNS
  keeps handing it out; a client that picks it waits out its connect timeout, and `uv` gives up
  after three tries, so a verifier that installs Python at grade time fails a solved task
  (db-wal-recovery, 2026-10-07). 84 of the 89 Terminal-Bench 2.0 verifiers download `uv` and a
  CPython from GitHub's CDN. Before a run, on the Docker host, as root:
  `bash egress-blackholes.sh` (on the Lima rig: `limactl shell ohbench -- sudo bash "$PWD/egress-blackholes.sh"`,
  also wired into the VM's boot provisioning). It probes every address of the common package
  hosts and blackholes the dead ones so clients fail over at once. It changes nothing a task does.
- **Nothing else heavy running on the box.** Harnesses run one at a time on purpose; the
  orchestrator refuses to start if the host is busy (it reads `/proc`). Do not set
  `BENCH_ALLOW_CONCURRENT=1`; that override exists only for macOS, where `/proc` is missing,
  and it makes the CPU and latency numbers unreliable.

## 1. Check out the repo

```bash
git clone git@github.com:tinyhumansai/openhuman-benchmarks.git && cd openhuman-benchmarks
# OpenHuman is vendored as a submodule; the openhuman bundle compiles it.
# Move the pin (cd vendor/openhuman && git checkout <sha>) to benchmark another build.
git submodule update --init --recursive vendor/openhuman
cp .env.example .env     # then set OPENROUTER_API_KEY; leave the rest at the defaults
export BENCH_UID=$(id -u) BENCH_GID=$(id -g)
```

Controlled variables (defaults in `.env.example`, enforced by the proxy; do not change them
between harnesses or runs you intend to compare): `BENCH_MODEL=deepseek/deepseek-v4.1-flash`,
`BENCH_REASONING=high`, `BENCH_PROVIDER=DeepSeek`, `BENCH_CPUS=4`, `BENCH_MEM=8g`.

## 2. Build the harness bundles

```bash
for h in openhuman deepseek-harness; do ./bundles/build.sh $h; done
```

Add `claude-code codex opencode openclaw hermes deepseek-harness-minimal` for the full
lineup. OpenHuman compiles the Rust core (10-20 minutes cold). It is built from this
checkout, so the report records this checkout's git SHA as its version.

**Gate:** each build finishes, and `ls .cache/harness/<name>` shows the bundle. If a build
fails, stop and report the exact error; do not work around it silently.

## 3. Smoke test (micro suite)

```bash
HARNESSES="openhuman deepseek-harness" REPEAT=1 ./run-micro.sh smoke-x86
```

**Gate:** every harness passes 5/5 checks and `results/smoke-x86/summary.md` shows non-zero
LLM calls. If a harness gets 0 calls, read its adapter log under
`results/smoke-x86/<harness>/<task>/` before going further.

## 4. SWE-bench Verified sample (10 instances)

```bash
uv venv --python 3.12 .cache/swebench-venv
uv pip install --python .cache/swebench-venv/bin/python swebench datasets
.cache/swebench-venv/bin/python swebench/prepare.py --n 10 --seed 20261001 \
    --out tasks/generated/swe --pull
```

The instance list is fixed in `swebench/instances-10.txt`. Do not re-sample or change the
seed. A harmless `ResourceTracker.__del__ ... _recursion_count` traceback at the end of
`prepare.py` is interpreter-shutdown noise.

**Gate:** `ls tasks/generated/swe` lists the 10 instance dirs plus `tasks.json`, and
`docker images | grep sweb.eval` shows 10 images.

Run the lineup. `run-swe.sh` loops harnesses sequentially, grades each with the official
evaluator, then writes the report:

```bash
HARNESSES="openhuman deepseek-harness" TASK_TIMEOUT_S=1200 ./run-swe.sh swe-x86-1 \
  2>&1 | tee /tmp/swe-x86-1.log
```

harness to the same run (newest attempt wins in the report; every `meter.jsonl` record and `runs.jsonl` row carries an `attempt` id, and the summary and viewer keep only the graded attempt's records. Runs from before the id existed fall back to timestamps):
harness to the same run (newest attempt wins in the report):

```bash
./run-swe-extra.sh swe-x86-1 openhuman sympy__sympy-13031
```

**Gate:** `results/swe-x86-1/summary.md` exists, each harness has `grade.json`, and the
"LLM calls" row is non-zero. Check `docker ps -a` for leftover task containers if a run
was interrupted.

## 5. Report and inspect

```bash
node report.mjs --run-id swe-x86-1
node charts.mjs --run swe-x86-1 --png
node viewer/server.mjs        # http://127.0.0.1:8787, read-only
```

Hand back: `results/swe-x86-1/summary.md`, the chart, and the viewer's per-harness prompt
and cache views. `results/` is git-ignored; copy it out, or tar
`results/swe-x86-1` (it holds the captures, which include full prompts and responses).

## 6. What to report

- The resolved count per harness (from the official grader only) and cost per solved task.
- Cache hit % per harness, and the main-agent vs side-request / sub-agent split.
- Anything that looks wrong: a harness with 0 calls, provider errors (404/429), tasks that
  hit the timeout, or a rejected override. Quote the exact error.
- The state of the box (CPU model, core count, RAM, kernel, Docker version) and the
  checkout SHA, so the numbers can be compared later.

## Do not

- Run harnesses concurrently, or run anything else heavy meanwhile.
- Change the model, provider, reasoning level or resource limits mid-comparison.
- Compare numbers with `RESULTS.md` or the arm64 `smoke-*` runs. They were measured on an
  older setup and a different architecture.
- Write the API key to disk, a log or a commit.
- Skip a failing gate and carry on.

## Known caveats

- **Pull task images before a run.** Harbor's 600 s environment-start window includes the
  image pull; four Terminal-Bench 2.0 images are 5.8–8.4 GB and cannot arrive in time on a
  slow link, so the trial errors (`EnvironmentStartTimeoutError`) before the agent runs.
  `tbench/prepull.sh 2 tbench/instances-tb2-all.txt` pulls what the list needs and skips what
  is present; it changes no timeout. (2026-10-08)
- **Debian 11 images cannot be graded any more.** `qemu-startup` and `qemu-alpine-ssh` run on
  `debian:bullseye-slim`; bullseye left LTS in 2026-08 and its security pool is gone from
  `deb.debian.org`, so the verifiers' own `apt-get install curl` fails (404) before `uv` can
  be installed: reward 0 for every agent until the dataset is re-pinned. Separately, the
  OpenHuman bundle is built on Ubuntu 22.04 and needs glibc 2.34, which bullseye (2.31) lacks,
  so the agent cannot even start in those two images (`GLIBC_2.34 not found`); lowering the
  builder's floor is a bundle follow-up, worth doing for older SWE-bench images. (2026-10-08)
- **Prune Docker networks before a Terminal-Bench run.** Harbor creates one network per trial
  and does not remove it when a trial errors or the Docker host restarts mid-run; after a
  full 89-task pass the daemon answered every new trial with "all predefined address pools
  have been fully subnetted" and 25 trials failed before a container started. Run
  `docker network prune -f` (removes only networks with no containers) before starting. (2026-10-08)
- **Verifiers that download gigabytes share the link.** Some Terminal-Bench verifiers install
  PyTorch with the CUDA wheels (several GB) at grade time; on a ~5 MB/s link that fits the
  900 s verifier timeout only when the trial has the link to itself. With three trials in
  flight `torch-pipeline-parallelism` graded as `VerifierTimeoutError` while still
  downloading (2026-10-08). Run such tasks one at a time, or on a host with real bandwidth;
  the timeout itself is the benchmark's and stays. (2026-10-08)
- **Rosetta cannot run a binary inside a `chroot`.** On the arm64 Lima rig, amd64 task
  containers run under Rosetta, which opens `/proc/self/exe` at start; a jail with no
  `/proc` gives `rosetta error: Unable to open /proc/self/exe: 2` (exit 133). Two
  Terminal-Bench 2.0 verifiers run the agent's binary that way (`path-tracing`,
  `path-tracing-reverse`), so those tasks can never pass here whatever the agent did: count
  them as unmeasurable on this rig, not as failures, and run the submission on an x86_64
  host. The same message with `: 13` during `apt-get` is apt's sandboxed download user and
  is harmless. (2026-10-08)

- Results use the proxy's pinned provider `DeepSeek`. Hermes's title requests 404 under the
  strict provider pin (its `json_schema` response format is not supported). It does not affect
  Hermes's task results.
- `results/meter.jsonl` is append-only and not cleared between runs. Reusing a run id
  double-counts, so use a fresh id for every run.
- One attempt per task, no repeats: treat differences between harnesses as indicative, not
  as a ranking.

# Memory smoke audit (issue #27)

Run in an isolated benchmark worktree with the recursive OpenHuman pin. The
20-question subset covers seven LongMemEval-S categories and thirteen LoCoMo
questions. `memory/manifest.json` pins dataset/scorer revisions, SHA-256 hashes,
seed and IDs. Raw datasets and generated transcripts stay local.

```bash
python3 memory/download.py
python3 memory/prepare.py
uv venv --python 3.12 memory/.venv
uv pip install --python memory/.venv/bin/python nltk==3.9.2 regex==2025.9.18 numpy==2.3.3
cargo build --locked --manifest-path memory/Cargo.toml
node --test memory/*.test.mjs
memory/.venv/bin/python -m unittest discover -s memory -p 'test_*.py'
# OPENROUTER_API_KEY must already be in the environment; never paste it here.
node memory/run.mjs memory27-glm53flash
node memory/report.mjs results/memory27-glm53flash
node memory/diagnose.mjs results/memory27-glm53flash
# Only after the run has stopped: move full wire bodies to ignored captures.
node memory/archive-captures.mjs results/memory27-glm53flash
```

The answer/extraction model is `z-ai/glm-5.3-flash`, pinned to Z.ai with low
reasoning. The embedding model is `openai/text-embedding-3-small`; LongMemEval's
official judge prompt uses the separate pinned `openai/gpt-4o-mini-2024-07-18`.
LoCoMo uses the pinned upstream category-specific F1/abstention functions.
Its F1 values are not binary answer accuracy.

This measures direct transcript ingestion into the pinned TinyMemory engine
and fresh-thread pre-turn recall. It does not establish desktop JSON-RPC
wiring, scrubbing, the core's recall deadline, or an agent's choice to store.
`reference-memory` is TinyMemory's deterministic reference engine, not a
competitive hosted memory product. No-memory and full-context controls are
labelled separately. CortexDB runs on a Docker internal network; only the
gateway holds a real model credential. Each history has its own namespace;
probe questions are removed before the next query.

`results/<run>/meter.jsonl` records embeddings and model calls, tokens,
reported cost and latency. The archive step retains wire pins and capture
hashes in that file and moves request bodies and chat responses into local
`captures/memory/`, matching the repository's existing capture policy.
Embedding responses retain model/vector counts and metered usage; vector
arrays are omitted. Response hashes describe the recorded JSON, including
that summary for embeddings.
`budget.json` reserves a conservative cost
before each upstream call under a persistent **$10 global cap**, with provider
price ceilings. In-flight calls, missing costs and failed calls retain their
full reservation across restarts. Reuse the same run ID to resume and preserve
the budget; run only one driver for that ID at a time. Creating a new ID starts
a separate budget. Setup failures are
saved as failures and never scored as memory misses. Inspect the packs, engine
logs and discarded setup records before interpreting scores.
If a native setup fails, use `--native-task <manifest-task-id>` to attempt a
different remaining history under the same ledger; do not repeat failed
ingestion without addressing its cause.

Native runs require all receipt IDs to be readable and three quiet enrichment
polls. Audit completed indexing batches with `memory/diagnose.mjs`: readable
receipts and aggregate enrichment counters do not certify every turn's
derived-index readiness. These native results are snapshots of that policy;
desktop replay and an independent memory competitor remain to be added.
