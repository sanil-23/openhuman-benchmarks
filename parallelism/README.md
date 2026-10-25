# `parallelism/`: how many OpenHuman agents fit in a small box

Runs N OpenHuman agents **in one container** (one cgroup, default 4 GB RAM, no swap, 4 CPUs) with a
real model through the metering proxy, in one of two shapes, and reports per level N: pass rate,
wall time, aggregate and per-agent tokens/s, decode speed, TTFT, cache hit %, cost, peak RAM (total,
process memory, `openhuman-core` resident memory), CPU, throttling and OOM kills.

| `--mode` | what runs | what is shared |
|---|---|---|
| `isolated` | one `openhuman-core` process per agent, each with its own HOME, ports and workspace | the container's cgroup only |
| `shared` | ONE `openhuman-core` serving all N agents: N concurrent `inference_agent_chat` RPCs, each with its own `cwd` and proxy tag | the core process: its runtime, thread pools, caches |

Each agent gets one task from the pool in `tasks/` (agent i gets task `i mod 6`): six moderate
Python tasks, each a README spec, a 19-30 test `unittest` suite and a deterministic pass/fail check.

| task | shape |
|---|---|
| `csvstats` | implement 4 stub modules: CSV parser with type inference, stats, table renderer, CLI |
| `ttlcache` | LRU + TTL cache with injected clock, memoising decorator, counters, thread safety |
| `minimd` | Markdown subset to HTML: inline spans, blocks, renderer, CLI |
| `calc` | expression language: lexer, precedence parser, evaluator with errors, CLI |
| `schemalite` | JSON-Schema subset validator with `$ref`, combinators, pointer paths, CLI |
| `taskboard` | bug hunt: a working-looking kanban library with six seeded bugs, fix the source not the tests |

`tasks/CONTRACT.md` is the format; `reference/` in each task is a full solution that is never shown to
the agent and exists so `task.test.mjs` can prove every task is solvable and that its seed fails.

## Run

```bash
BUNDLE_NAME=openhuman-par ./bundles/build.sh openhuman      # compiles vendor/openhuman once
node parallelism/run.mjs --mode isolated --levels 1,6,12,24,36,48 --group par-pool-iso
node parallelism/run.mjs --mode shared   --levels 1,6,12,24,36,48 --group par-pool-shared
node parallelism/report.mjs par-pool-iso                    # results/<group>/parallelism.{md,json}
node parallelism/report.mjs par-pool-shared
node parallelism/compare.mjs par-pool-iso par-pool-shared   # the two modes side by side
node --test parallelism/                                    # tasks are solvable, report maths
```

`--tasks a,b` restricts the pool, `--mem`/`--cpus` set the container limits, `--stagger S` starts agents
S seconds apart (default 0: worst-case simultaneous start), `--repeat R` repeats each level. In isolated
mode each agent has its own `BENCH_HOME`, `BENCH_OH_PORT`, `BENCH_FWD_PORT` (see
`bundles/adapters/openhuman.sh`) and tags its own calls (`BENCH_PROXY_PREFIX`); in shared mode the tag is
part of each turn's `inference_url`. Either way the proxy attributes every call to `a<i>`.

## Caveats

- One model/provider account is shared by all agents, so provider rate limits show up as 429s and
  slower calls. The report counts them; they are a property of the API, not of OpenHuman.
- CPU and RAM in each agent's `result.json` are container-wide (isolated mode). Read the per-level
  numbers from `timeline.jsonl`, not from a single agent.
- Result directories are written by root inside the container; clean a stale one with
  `docker run --rm -v $PWD/results:/r alpine rm -rf /r/<run>`. `run.mjs` refuses to reuse one.
