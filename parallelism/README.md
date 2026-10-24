# `parallelism/`: how many OpenHuman agents fit in a small box

Runs N OpenHuman agents **in one container** (one cgroup, default 4 GB RAM, no swap, 4 CPUs) on the
same medium task, with a real model through the metering proxy, and reports per level N: pass
rate, wall time, aggregate and per-agent tokens/s, decode speed, TTFT, cache hit %, cost, peak RAM
(total and process memory), CPU, throttling and OOM kills.

The task (`task/`) is a four-module Python feature (CSV parser, stats, renderer, CLI) behind a
19-test suite; a correct solution takes the agent tens of tool calls. `task/reference` solves it and
is never shown to the agent.

## Run

```bash
BUNDLE_NAME=openhuman-par ./bundles/build.sh openhuman      # compiles vendor/openhuman once
node parallelism/run.mjs --levels 1,2,4,8,12,16 --mem 4g --cpus 4
node parallelism/report.mjs <group>                         # prints and writes results/<group>/parallelism.{md,json}
```

`--stagger S` starts agents S seconds apart (default 0: worst-case simultaneous start);
`--repeat R` repeats each level. Each agent has its own HOME, core port and loopback forwarder port
(`BENCH_HOME`, `BENCH_OH_PORT`, `BENCH_FWD_PORT` in `bundles/adapters/openhuman.sh`) and tags its
own calls (`BENCH_PROXY_PREFIX`), so the proxy attributes every call to `a<i>`.

## Caveats

- One model/provider account is shared by all agents, so provider rate limits show up as 429s and
  slower calls. The report counts them; they are a property of the API, not of OpenHuman.
- CPU and RAM in each agent's `result.json` are container-wide. Read the per-level numbers from
  `timeline.jsonl`, not from a single agent.
