// entry.mjs — runs inside the task container. Executes one task with one
// harness: optional setup, the harness adapter under a wall-clock budget, a
// container-wide CPU/memory sampler around it, then captures the produced
// patch and runs the (uncharged) check. Writes result.json for the host.
//
// Env: BENCH_HARNESS BENCH_TASK_ID WORKDIR PROMPT_FILE RESULT_DIR
//      TASK_TIMEOUT_S (default 1800). BENCH_TURN_BUDGET_S (the budget OpenHuman's turn ceiling is derived
//      from, default TASK_TIMEOUT_S) and BENCH_TURN_MARGIN_S (default 120); see turn-budget.mjs. /bench/task/{setup,check}.sh run when present.
//      BENCH_CAPTURE_PATCH=0 leaves the workdir's git state alone (Terminal-Bench tasks grade
//      the container itself, some of them its git history).

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { startSampler, summarize } from "./cgroup.mjs";
import { turnTimeoutSecs } from "./turn-budget.mjs";

const env = (k, d) => process.env[k] ?? d;
const harness = env("BENCH_HARNESS");
const taskId = env("BENCH_TASK_ID");
const workdir = env("WORKDIR", "/testbed");
const resultDir = env("RESULT_DIR", "/results");
const timeoutMs = Number(env("TASK_TIMEOUT_S", "1800")) * 1000;
if (!harness || !taskId) throw new Error("BENCH_HARNESS and BENCH_TASK_ID are required");

fs.mkdirSync(resultDir, { recursive: true });
// A rerun must never report the earlier attempt's runtime evidence, even if
// task setup fails before the adapter can boot the core.
if (harness.startsWith("openhuman")) fs.rmSync(path.join(resultDir, "memory-state.json"), { force: true });
const log = (m) => process.stderr.write(`[entry ${harness}/${taskId}] ${m}\n`);

// Conda-based SWE-bench images keep the project's deps in a `testbed` env; give
// the harness's shell tool the same environment a developer would have.
const activate = fs.existsSync("/opt/miniconda3/bin/activate")
  ? "source /opt/miniconda3/bin/activate testbed && "
  : "";

function runShell(script, { cwd, timeout, outFile }) {
  return new Promise((resolve) => {
    const out = fs.openSync(outFile, "w");
    const child = spawn("bash", ["-lc", `${activate}${script}`], {
      cwd,
      stdio: ["ignore", out, out],
      detached: true,
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL"); // whole process group
      } catch {
        // already gone
      }
    }, timeout);
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out);
      resolve({ code: code ?? (signal ? 128 : 1), timedOut });
    });
  });
}

const setupScript =
  process.env.SETUP_SCRIPT ||
  (fs.existsSync("/bench/task/setup.sh") ? "/bench/task/setup.sh" : null);
const checkScript =
  process.env.CHECK_SCRIPT ||
  (fs.existsSync("/bench/task/check.sh") ? "/bench/task/check.sh" : null);

if (setupScript) {
  log("setup");
  const r = await runShell(`bash ${setupScript}`, {
    cwd: workdir,
    timeout: 300_000,
    outFile: path.join(resultDir, "setup.log"),
  });
  if (r.code !== 0) throw new Error(`setup failed (${r.code})`);
}

const capturePatch = env("BENCH_CAPTURE_PATCH", "1") !== "0";
// Baseline so the patch contains only what the harness changed.
let baseline = null;
if (capturePatch) {
  // `git add` needs a repository. Most task images are not one, so every step
  // here failed quietly, `rev-parse HEAD` returned "", and `git diff --cached ""`
  // produced nothing -- patch_bytes was 0 for EVERY task in every run, including
  // ones that passed their tests. A silent 0 is worse than no field: it reads as
  // "the agent wrote nothing" and was used as evidence for exactly that.
  if (!fs.existsSync(path.join(workdir, ".git"))) {
    spawnSync("git", ["init", "-q"], { cwd: workdir });
  }
  spawnSync("git", ["add", "-A"], { cwd: workdir });
  spawnSync("git", ["-c", "user.email=bench@local", "-c", "user.name=bench", "commit", "-q", "--allow-empty", "-m", "bench-baseline"], { cwd: workdir });
  baseline = spawnSync("git", ["rev-parse", "HEAD"], { cwd: workdir, encoding: "utf8" }).stdout.trim();
  if (!baseline) log("WARNING: no git baseline; patch.diff and patch_bytes will be empty");
}

// OpenHuman ends its own turn a margin before the task budget, so the run records a stop reason.
if (harness.startsWith("openhuman")) {
  const turn = turnTimeoutSecs();
  if (turn !== null) process.env.OPENHUMAN_AGENT_TURN_TIMEOUT_SECS = turn;
  log(`openhuman turn timeout ${turn ?? "default"}s`);
}
log("running adapter");
const sampler = startSampler(500);
const startedAt = Date.now();
const run = await runShell("/opt/harness/adapter.sh", {
  cwd: workdir,
  timeout: timeoutMs,
  outFile: path.join(resultDir, "harness.log"),
});
const endedAt = Date.now();
const resources = summarize(sampler.stop());

let diff = { stdout: "" };
if (capturePatch && baseline) {
  spawnSync("git", ["add", "-A"], { cwd: workdir });
  diff = spawnSync("git", ["diff", "--cached", baseline], {
    cwd: workdir,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
}
fs.writeFileSync(path.join(resultDir, "patch.diff"), diff.stdout ?? "");

let check = null;
if (checkScript) {
  const c = await runShell(`bash ${checkScript}`, {
    cwd: workdir,
    timeout: 300_000,
    outFile: path.join(resultDir, "check.log"),
  });
  check = { exit_code: c.code, passed: c.code === 0 };
}

fs.writeFileSync(
  path.join(resultDir, "result.json"),
  JSON.stringify(
    {
      harness,
      task: taskId,
      started_epoch_ms: startedAt,
      ended_epoch_ms: endedAt,
      wall_ms: endedAt - startedAt,
      exit_code: run.code,
      timed_out: run.timedOut,
      patch_bytes: Buffer.byteLength(diff.stdout ?? ""),
      resources,
      check,
    },
    null,
    2,
  ),
);
log(`done exit=${run.code} timed_out=${run.timedOut} wall=${endedAt - startedAt}ms`);
