#!/usr/bin/env node
// run.mjs — Terminal-Bench through Harbor (the benchmark's own harness), OpenHuman only.
//
//   node tbench/run.mjs --bench 2|4 --run-id ID [--instances FILE | --task NAME ...] [--n-concurrent 1]
//                       [--bundle NAME] [--convert-only] [-- <extra harbor run args>]
//
// Harbor builds/pulls each task's environment, applies its resources, network and agent timeout,
// and runs its verifier exactly as on the Terminal-Bench leaderboard. The bench adds only:
//   - tbench/openhuman_agent.py: OpenHuman as a Harbor agent, run through runner/entry.mjs;
//   - a compose overlay that mounts the bundle, the runner and the meter proxy's unix socket.
//     It declares no networks: the task's networking (internet on or off, Harbor's egress
//     sidecar, `network_mode` set by the task) stays exactly as Harbor sets it up, and every
//     inference call still goes through the meter;
//   - a conversion of Harbor's job dir into results/<run>/openhuman/<task>/ (result.json,
//     harness.log, verifier output) + runs.jsonl + grade.json, which report.mjs and the
//     viewer read. Harbor's raw job dir stays under .cache/harbor-jobs/<run>/.
//     --convert-only redoes just this step for an existing job dir.
//   --bundle NAME runs .cache/harness/NAME (a BUNDLE_NAME build) instead of .cache/harness/openhuman;
//     results are still filed under openhuman, and the build is recorded per row.
//
// Each call is tagged per request (a path prefix the proxy strips), so --n-concurrent > 1 meters
// correctly. Trials still run one at a time by default: CPU and latency figures are only
// comparable across serial runs, and the summary records the concurrency used.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForQuietHost } from "../quiet-host.mjs";
import { runMeta } from "../run-meta.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const HARNESS = "openhuman";
const DATASETS = {
  2: "terminal-bench@2.0",
  4: "terminal-bench/terminal-bench@4.0.0",
};

const argv = process.argv.slice(2);
const dash = argv.indexOf("--");
const own = dash === -1 ? argv : argv.slice(0, dash);
const extra = dash === -1 ? [] : argv.slice(dash + 1);
const opt = (k, d) => (own.includes(k) ? own[own.indexOf(k) + 1] : d);
const bench = opt("--bench");
if (!DATASETS[bench]) throw new Error("--bench 2 or --bench 4 is required");
const runId = opt("--run-id", `tbench${bench}-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "")}`);
const tasks = own.flatMap((a, i) => (a === "--task" ? [own[i + 1]] : []));
const instances = opt("--instances");
if (instances) {
  tasks.push(
    ...fs
      .readFileSync(path.resolve(root, instances), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#")),
  );
}
/** Harbor's agent timeout multiplier from extra harbor args (defaults to --timeout-multiplier, then 1). */
function agentTimeoutMultiplier(args) {
  const flag = (name) => {
    const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
    if (i === -1) return null;
    const v = Number(args[i].includes("=") ? args[i].split("=")[1] : args[i + 1]);
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  return flag("--agent-timeout-multiplier") ?? flag("--timeout-multiplier") ?? 1;
}
/** Harbor's resolved job config can override or cap the task's agent timeout. */
function resolvedAgentTimeoutSettings(args) {
  const result = spawnSync("harbor", [...args, "--print-config"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(":") },
  });
  if (result.status !== 0) throw new Error(`harbor --print-config failed: ${result.stderr || result.stdout}`);
  const config = JSON.parse(result.stdout);
  const agent = config.agents?.[0] ?? {};
  return {
    multiplier: config.agent_timeout_multiplier ?? config.timeout_multiplier ?? agentTimeoutMultiplier(extra),
    override: agent.override_timeout_sec ?? "",
    maximum: agent.max_timeout_sec ?? "",
  };
}
const nConcurrent = opt("--n-concurrent", "1");
const convertOnly = own.includes("--convert-only");
const suite = `terminal-bench-${bench}`;

// Same compose project / proxy port per checkout as orchestrate.mjs.
const checkout = path.basename(path.resolve(root, "..", ".."));
const projectName = process.env.COMPOSE_PROJECT_NAME || `hb-${checkout.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
const hostPort =
  process.env.METER_HOST_PORT ||
  String(18100 + ([...checkout].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 800));
const composeEnv = { ...process.env, COMPOSE_PROJECT_NAME: projectName, METER_HOST_PORT: hostPort };

const bundleName = opt("--bundle", HARNESS);
const bundle = path.join(root, ".cache", "harness", bundleName);
if (!fs.existsSync(path.join(bundle, "adapter.sh"))) throw new Error(`no bundle at ${bundle}: run ./bundles/build.sh ${HARNESS}`);
const meta = runMeta(root, bundleName);
const jobsDir = path.join(root, ".cache", "harbor-jobs", runId);
const jobName = `${HARNESS}-tb${bench}`;
const startedAt = Date.now();

if (!convertOnly) {
  await waitForQuietHost();
  fs.mkdirSync(path.join(root, "results"), { recursive: true });
  const sockDir = path.join(root, ".cache", "meter-sock", projectName);
  fs.mkdirSync(sockDir, { recursive: true }); // owned by us, so the proxy (our uid) can bind in it
  const up = spawnSync("docker", ["compose", "up", "-d", "--build", "--wait", "meter-proxy"], { cwd: root, env: composeEnv, stdio: "inherit" });
  if (up.status !== 0) throw new Error("meter-proxy failed to start");
  if (!fs.existsSync(path.join(sockDir, "meter.sock"))) throw new Error(`meter-proxy did not create ${sockDir}/meter.sock (recreate it: docker compose up -d --force-recreate meter-proxy)`);

  const overlayDir = path.join(root, ".cache", "tbench");
  fs.mkdirSync(overlayDir, { recursive: true });
  const overlay = path.join(overlayDir, `${projectName}-overlay.yaml`);
  // BENCH_AGENT_ENV: comma-separated names of host environment variables the agent
  // container receives (for example a search provider's key, `EXA_API_KEY`, which the
  // harness reads to configure its web-search provider). Only the names are written
  // into the overlay; compose resolves each value from the runner's own environment,
  // so no secret lands in a file. Unset names are skipped.
  const agentEnv = (process.env.BENCH_AGENT_ENV || "")
    .split(",")
    .map((s) => s.trim())
    .filter((name) => /^[A-Z_][A-Z0-9_]*$/.test(name) && process.env[name] !== undefined);
  const environment = agentEnv.length
    ? `    environment:\n${agentEnv.map((name) => `      - ${name}\n`).join("")}`
    : "";
  fs.writeFileSync(
    overlay,
    `# Generated by tbench/run.mjs: bench bundle, runner and the meter proxy's socket. No networks:
# declaring any would take \`main\` out of Harbor's egress control (and clash with a task's network_mode).
services:
  main:
    volumes:
      - ${fs.realpathSync(bundle)}:/opt/harness:ro
      - ${path.join(root, "runner")}:/opt/bench/runner:ro
      - ${sockDir}:/opt/bench/sock
${environment}`,
  );

  const harborArgs = [
    "run",
    "-d", DATASETS[bench],
    "-a", "tbench.openhuman_agent:OpenHuman",
    "--extra-docker-compose", overlay,
    "-n", nConcurrent,
    "-o", jobsDir,
    "--job-name", jobName,
    "-y",
    // Registry names are "<org>/<task>" for 4.0 and bare for 2.0; match either, never a suffix of another.
    ...tasks.flatMap((t) => ["-i", t, "-i", `*/${t}`]),
    ...extra,
  ];
  const timeoutSettings = resolvedAgentTimeoutSettings(harborArgs);
  process.stdout.write(`[tbench] ${HARNESS} ${meta.harness_version ?? "(unknown build)"}: harbor ${harborArgs.join(" ")}\n`);
  const h = spawnSync("harbor", harborArgs, {
    cwd: root,
    stdio: "inherit",
    env: {
      ...process.env,
      PYTHONPATH: [root, process.env.PYTHONPATH].filter(Boolean).join(":"),
      BENCH_RUN_ID: runId,
      BENCH_METER_LOG: path.join(root, "results", "meter.jsonl"),
      BENCH_HARNESS_VERSION: meta.harness_version ?? "",
      // The agent derives OpenHuman's turn timeout from the task's budget, which these scale.
      BENCH_AGENT_TIMEOUT_MULTIPLIER: String(timeoutSettings.multiplier),
      BENCH_AGENT_TIMEOUT_OVERRIDE_S: String(timeoutSettings.override),
      BENCH_AGENT_TIMEOUT_MAX_S: String(timeoutSettings.maximum),
    },
  });
  process.stdout.write(`[tbench] harbor exited ${h.status}\n`);
}

// ---- Harbor job dir -> results/<run>/ -------------------------------------------------------
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, "utf8"));
  } catch {
    return null;
  }
};
const jobDir = path.join(jobsDir, jobName);
const runDir = path.join(root, "results", runId);
const outRoot = path.join(runDir, HARNESS);
fs.mkdirSync(outRoot, { recursive: true });
const gradeFile = path.join(outRoot, "grade.json");
const grade = readJson(gradeFile) ?? {};
const index = path.join(runDir, "runs.jsonl");
const epoch = (s) => (s ? Date.parse(s) : null);

/** Passed/total from the verifier's own report, when it has one (CTRF tests or graded cases). */
function verifierTests(dir) {
  const ctrf = readJson(path.join(dir, "ctrf.json"))?.results?.summary;
  if (ctrf && typeof ctrf.tests === "number") return { passed: ctrf.passed ?? 0, total: ctrf.tests };
  const trace = readJson(path.join(dir, "trace_results.json"));
  if (trace && typeof trace.total_cases === "number") return { passed: trace.passed_cases ?? 0, total: trace.total_cases };
  return null;
}

const jobConcurrency = Number(readJson(path.join(jobDir, "config.json"))?.n_concurrent_trials ?? nConcurrent);

const trials = fs.existsSync(jobDir)
  ? fs.readdirSync(jobDir).filter((d) => fs.existsSync(path.join(jobDir, d, "result.json")) && fs.statSync(path.join(jobDir, d)).isDirectory())
  : [];
const rows = [];
for (const t of trials.sort()) {
  const tdir = path.join(jobDir, t);
  const hr = readJson(path.join(tdir, "result.json"));
  const key = (hr.task_name ?? t.replace(/__[^_]+$/, "")).split("/").pop();
  const out = path.join(outRoot, key);
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const benchDir = path.join(tdir, "agent", "bench");
  for (const f of ["harness.log", "core.log", "memory-state.json"]) if (fs.existsSync(path.join(benchDir, f))) fs.copyFileSync(path.join(benchDir, f), path.join(out, f));
  fs.copyFileSync(path.join(tdir, "result.json"), path.join(out, "harbor-result.json"));
  for (const f of ["exception.txt", "trial.log"]) if (fs.existsSync(path.join(tdir, f))) fs.copyFileSync(path.join(tdir, f), path.join(out, f));
  if (fs.existsSync(path.join(tdir, "verifier"))) fs.cpSync(path.join(tdir, "verifier"), path.join(out, "verifier"), { recursive: true });

  const exc = hr.exception_info ?? null;
  const timedOut = /Timeout/i.test(exc?.exception_type ?? "");
  // entry.mjs's own result (cgroup resources, wall); synthesized from Harbor's timing when the
  // agent phase never finished (Harbor's timeout cancels it before entry.mjs writes one).
  const entry = readJson(path.join(benchDir, "result.json"));
  const agentStart = epoch(hr.agent_execution?.started_at);
  const agentEnd = epoch(hr.agent_execution?.finished_at);
  const result = entry
    ? { ...entry, timed_out: entry.timed_out || timedOut }
    : {
        harness: HARNESS,
        task: key,
        started_epoch_ms: agentStart,
        ended_epoch_ms: agentEnd,
        wall_ms: agentStart && agentEnd ? agentEnd - agentStart : null,
        exit_code: null,
        timed_out: timedOut,
        patch_bytes: 0,
        resources: null,
        check: null,
      };
  const rewards = hr.verifier_result?.rewards ?? null;
  const reward = rewards ? (rewards.reward ?? Object.values(rewards)[0]) : null;
  result.check = { passed: reward === 1, reward, verifier: "harbor" };
  result.harbor = { exception: exc?.exception_type ?? null, trial: t, job: path.relative(root, jobDir) };
  fs.writeFileSync(path.join(out, "result.json"), JSON.stringify(result, null, 2));

  const testsPassed = verifierTests(path.join(tdir, "verifier"));
  grade[key] = { resolved: reward === 1, empty_patch: false, error: reward === null, reward, tests: testsPassed };
  // A fresh run records this checkout's bundle and knobs; a re-conversion knows only what Harbor kept.
  const version = hr.agent_info?.version;
  const rowMeta = convertOnly ? { harness_version: version && version !== "unknown" ? version : null } : meta;
  rows.push({
    run_id: runId,
    harness: HARNESS,
    suite,
    task: key,
    task_key: key,
    // The adapter's attempt id (written beside the trial's logs); absent for trials run before it existed.
    attempt: fs.existsSync(path.join(tdir, "agent", "attempt.txt")) ? fs.readFileSync(path.join(tdir, "agent", "attempt.txt"), "utf8").trim() : null,
    dataset: DATASETS[bench],
    harbor_exception: exc?.exception_type ?? null,
    n_concurrent: jobConcurrency,
    ...rowMeta,
    memory: runMeta(root, HARNESS, {}, out).memory,
    started_epoch_ms: epoch(hr.started_at) ?? startedAt,
    ended_epoch_ms: epoch(hr.finished_at) ?? Date.now(),
  });
  process.stdout.write(`[tbench] ${key}: reward=${reward}${exc ? ` (${exc.exception_type})` : ""}\n`);
}
// A trial converted again (--convert-only) replaces its earlier row instead of adding another.
const fresh = new Set(rows.map((r) => `${r.harness}/${r.task_key}/${r.started_epoch_ms}`));
const kept = (fs.existsSync(index) ? fs.readFileSync(index, "utf8").split("\n").filter(Boolean) : []).filter((l) => {
  const r = JSON.parse(l);
  return !fresh.has(`${r.harness}/${r.task_key}/${r.started_epoch_ms}`);
});
fs.writeFileSync(index, [...kept, ...rows.map((r) => JSON.stringify(r))].map((l) => `${l}\n`).join(""));
fs.writeFileSync(gradeFile, JSON.stringify(grade, null, 2));
const solved = Object.values(grade).filter((g) => g.resolved).length;
process.stdout.write(`[tbench] ${runId}: ${solved}/${Object.keys(grade).length} resolved -> ${path.relative(root, runDir)}\n`);
