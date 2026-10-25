// par-entry.mjs: runs INSIDE one task container (one cgroup, one memory ceiling) and starts
// PAR_N agents side by side, each on its own working copy of a task from the pool
// (agent i gets tasks.json[(i-1) % K]).
//
//   PAR_MODE=isolated  one openhuman-core per agent: N copies of runner/entry.mjs, each with its own
//                      HOME, core port, forwarder port and proxy tag.
//   PAR_MODE=shared    ONE openhuman-core (via the normal adapter) serving N concurrent
//                      `inference_agent_chat` turns, each with its own `cwd` and proxy tag.
//
// Env: PAR_N PAR_RUN_ID PAR_MODE PAR_STAGGER_S, plus the usual task-container env.
// Writes /results/timeline.jsonl (1 Hz cgroup + openhuman-core RSS), /results/par.json and, per agent,
// /results/a<i>/result.json.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { turnTimeoutSecs } from "/opt/bench/runner/turn-budget.mjs";

const env = (k, d) => process.env[k] ?? d;
const n = Number(env("PAR_N", "1"));
const runId = env("PAR_RUN_ID", "par");
const mode = env("PAR_MODE", "isolated");
const stagger = Number(env("PAR_STAGGER_S", "0")) * 1000;
const harness = env("BENCH_HARNESS", "openhuman");
const cg = env("BENCH_CGROUP_ROOT", "/sys/fs/cgroup");
const order = JSON.parse(fs.readFileSync("/bench/task/tasks.json", "utf8"));
const taskOf = (i) => order[(i - 1) % order.length];
const tagOf = (id) => `/__tag/${encodeURIComponent(runId)}/${encodeURIComponent(harness)}/${id}`;

const read = (f) => {
  try {
    return fs.readFileSync(`${cg}/${f}`, "utf8");
  } catch {
    return "";
  }
};
const kv = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => l.split(/\s+/)).map(([k, v]) => [k, Number(v)]));

/** Resident memory of every openhuman-core process, in bytes, and how many there are. */
function coreRss() {
  let bytes = 0;
  let count = 0;
  for (const pid of fs.readdirSync("/proc").filter((p) => /^\d+$/.test(p))) {
    try {
      if (fs.readFileSync(`/proc/${pid}/comm`, "utf8").trim() !== "openhuman-core") continue;
      const m = fs.readFileSync(`/proc/${pid}/status`, "utf8").match(/^VmRSS:\s+(\d+) kB/m);
      if (m) {
        bytes += Number(m[1]) * 1024;
        count += 1;
      }
    } catch {
      // exited between readdir and read
    }
  }
  return { bytes, count };
}

const timeline = fs.createWriteStream("/results/timeline.jsonl");
let running = 0;
function sample() {
  const stat = kv(read("memory.stat"));
  const cpu = kv(read("cpu.stat"));
  const events = kv(read("memory.events"));
  const psi = read("memory.pressure").match(/some avg10=([\d.]+)/);
  const core = coreRss();
  timeline.write(
    `${JSON.stringify({
      t: Date.now(),
      running,
      mem: Number(read("memory.current")) || null,
      anon: stat.anon ?? null,
      file: stat.file ?? null,
      core_rss: core.bytes,
      cores: core.count,
      cpu_usec: cpu.usage_usec ?? null,
      throttled_usec: cpu.throttled_usec ?? 0,
      oom_kill: events.oom_kill ?? 0,
      mem_high: events.high ?? 0,
      mem_pressure_avg10: psi ? Number(psi[1]) : null,
    })}\n`,
  );
}
const timer = setInterval(sample, 1000);
sample();

const start = Date.now();
const agents = Array.from({ length: n }, (_, k) => {
  const i = k + 1;
  const id = `a${i}`;
  const task = taskOf(i);
  const dir = `/work/${id}`;
  fs.mkdirSync(dir, { recursive: true });
  fs.cpSync(`/bench/task/${task}/seed`, dir, { recursive: true });
  fs.mkdirSync(`/results/${id}`, { recursive: true });
  return { i, id, task, dir, prompt_file: `/bench/task/${task}/prompt.txt`, check: `/bench/task/${task}/check.sh`, tag: tagOf(id) };
});

const exitOf = (child) => new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
let results;

if (mode === "isolated") {
  results = await Promise.all(
    agents.map(async (a) => {
      await new Promise((r) => setTimeout(r, (a.i - 1) * stagger));
      running += 1;
      const t0 = Date.now();
      const child = spawn("/opt/harness/node/bin/node", ["/opt/bench/runner/entry.mjs"], {
        env: {
          ...process.env,
          BENCH_TASK_ID: a.id,
          WORKDIR: a.dir,
          RESULT_DIR: `/results/${a.id}`,
          PROMPT_FILE: a.prompt_file,
          CHECK_SCRIPT: a.check,
          BENCH_HOME: `/tmp/bench-home-${a.i}`,
          BENCH_FWD_PORT: String(18100 + a.i),
          BENCH_OH_PORT: String(7800 + a.i),
          BENCH_PROXY_PREFIX: a.tag,
        },
        stdio: ["ignore", "inherit", "inherit"],
      });
      const code = await exitOf(child);
      running -= 1;
      return { id: a.id, task: a.task, exit: code, started_ms: t0 - start, ended_ms: Date.now() - start };
    }),
  );
} else if (mode === "shared") {
  // Baseline each working copy so its patch is only what the agent changed.
  for (const a of agents) {
    spawnSync("git", ["init", "-q"], { cwd: a.dir });
    spawnSync("git", ["add", "-A"], { cwd: a.dir });
    spawnSync("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "--allow-empty", "-m", "bench-baseline"], { cwd: a.dir });
    a.baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: a.dir, encoding: "utf8" }).stdout.trim();
  }
  fs.writeFileSync("/results/agents.json", JSON.stringify(agents.map(({ id, dir, prompt_file, tag }) => ({ id, dir, prompt_file, tag }))));
  const turn = turnTimeoutSecs();
  const adapterEnv = {
    ...process.env,
    OH_TURN_SCRIPT: "/opt/bench/par/shared-turns.mjs",
    PAR_AGENTS: "/results/agents.json",
    PROMPT_FILE: agents[0].prompt_file, // the adapter reads one prompt for its own bookkeeping
    RESULT_DIR: "/results",
    WORKDIR: "/work",
    BENCH_TASK_ID: "shared",
    ...(turn !== null ? { OPENHUMAN_AGENT_TURN_TIMEOUT_SECS: turn } : {}),
  };
  running = n;
  const child = spawn("bash", ["-lc", "/opt/harness/adapter.sh"], { cwd: "/work", env: adapterEnv, stdio: ["ignore", fs.openSync("/results/harness.log", "w"), fs.openSync("/results/harness.log", "a")] });
  const timeoutMs = Number(env("TASK_TIMEOUT_S", "1800")) * 1000;
  const killer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  const code = await exitOf(child);
  clearTimeout(killer);
  running = 0;
  const endedAt = Date.now();
  results = [];
  for (const a of agents) {
    const turnFile = `/results/${a.id}/turn.json`;
    const t = fs.existsSync(turnFile) ? JSON.parse(fs.readFileSync(turnFile, "utf8")) : null;
    const diff = spawnSync("sh", ["-c", `git add -A && git diff --cached ${a.baseline}`], { cwd: a.dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
    fs.writeFileSync(`/results/${a.id}/patch.diff`, diff.stdout ?? "");
    const c = spawnSync("bash", [a.check], { cwd: a.dir, encoding: "utf8", timeout: 300_000 });
    fs.writeFileSync(`/results/${a.id}/check.log`, `${c.stdout ?? ""}${c.stderr ?? ""}`);
    const startedAt = t?.started_epoch_ms ?? start;
    const endedTurn = t?.ended_epoch_ms ?? endedAt;
    fs.writeFileSync(
      `/results/${a.id}/result.json`,
      JSON.stringify({ harness, task: a.id, started_epoch_ms: startedAt, ended_epoch_ms: endedTurn, wall_ms: endedTurn - startedAt, exit_code: t?.error ? 1 : code, turn_error: t?.error ?? null, patch_bytes: Buffer.byteLength(diff.stdout ?? ""), check: { exit_code: c.status, passed: c.status === 0 } }, null, 2),
    );
    results.push({ id: a.id, task: a.task, exit: t && !t.error ? 0 : 1, started_ms: startedAt - start, ended_ms: endedTurn - start });
  }
} else {
  throw new Error(`unknown PAR_MODE ${mode}`);
}

clearInterval(timer);
sample();
timeline.end();
fs.writeFileSync("/results/par.json", JSON.stringify({ n, mode, run_id: runId, stagger_s: stagger / 1000, tasks: order, wall_ms: Date.now() - start, agents: results }, null, 2));
process.exit(results.every((r) => r.exit === 0) ? 0 : 1);
