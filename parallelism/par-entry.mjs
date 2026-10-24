// par-entry.mjs: runs INSIDE one task container (one cgroup, one memory ceiling) and starts
// PAR_N copies of runner/entry.mjs side by side. Each copy gets its own working copy of the task,
// result dir, HOME, core port and loopback forwarder port, and tags its own inference calls
// (BENCH_PROXY_PREFIX) so the metering proxy attributes every call to the right agent.
//
// Env: PAR_N PAR_RUN_ID PAR_STAGGER_S (delay between agent starts, default 0)
//      BENCH_HARNESS BENCH_TASK_ID (container-level id) plus the usual task-container env.
// Writes /results/timeline.jsonl: one cgroup sample per second (memory, cpu, throttling, oom).

import { spawn } from "node:child_process";
import fs from "node:fs";

const env = (k, d) => process.env[k] ?? d;
const n = Number(env("PAR_N", "1"));
const runId = env("PAR_RUN_ID", "par");
const stagger = Number(env("PAR_STAGGER_S", "0")) * 1000;
const harness = env("BENCH_HARNESS", "openhuman");
const cg = env("BENCH_CGROUP_ROOT", "/sys/fs/cgroup");

const read = (f) => {
  try {
    return fs.readFileSync(`${cg}/${f}`, "utf8");
  } catch {
    return "";
  }
};
const kv = (text) => Object.fromEntries(text.split("\n").filter(Boolean).map((l) => l.split(/\s+/)).map(([k, v]) => [k, Number(v)]));

const timeline = fs.createWriteStream("/results/timeline.jsonl");
let running = 0;
function sample() {
  const stat = kv(read("memory.stat"));
  const cpu = kv(read("cpu.stat"));
  const events = kv(read("memory.events"));
  const psi = read("memory.pressure").match(/some avg10=([\d.]+)/);
  timeline.write(
    `${JSON.stringify({
      t: Date.now(),
      running,
      mem: Number(read("memory.current")) || null,
      anon: stat.anon ?? null,
      file: stat.file ?? null,
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
const results = await Promise.all(
  Array.from({ length: n }, (_, k) => k + 1).map(async (i) => {
    await new Promise((r) => setTimeout(r, (i - 1) * stagger));
    const id = `a${i}`;
    const dir = `/work/${id}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.cpSync("/bench/task/seed", dir, { recursive: true });
    fs.mkdirSync(`/results/${id}`, { recursive: true });
    running += 1;
    const t0 = Date.now();
    const child = spawn("/opt/harness/node/bin/node", ["/opt/bench/runner/entry.mjs"], {
      env: {
        ...process.env,
        BENCH_TASK_ID: id,
        WORKDIR: dir,
        RESULT_DIR: `/results/${id}`,
        PROMPT_FILE: "/bench/task/prompt.txt",
        CHECK_SCRIPT: "/bench/task/check.sh",
        BENCH_HOME: `/tmp/bench-home-${i}`,
        BENCH_FWD_PORT: String(18100 + i),
        BENCH_OH_PORT: String(7800 + i),
        BENCH_PROXY_PREFIX: `/__tag/${encodeURIComponent(runId)}/${encodeURIComponent(harness)}/${id}`,
      },
      stdio: ["ignore", "inherit", "inherit"],
    });
    const code = await new Promise((r) => child.on("exit", (c) => r(c ?? 1)));
    running -= 1;
    return { id, exit: code, started_ms: t0 - start, ended_ms: Date.now() - start };
  }),
);
clearInterval(timer);
sample();
timeline.end();
fs.writeFileSync("/results/par.json", JSON.stringify({ n, run_id: runId, stagger_s: stagger / 1000, wall_ms: Date.now() - start, agents: results }, null, 2));
process.exit(results.every((r) => r.exit === 0) ? 0 : 1);
