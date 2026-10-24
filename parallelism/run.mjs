#!/usr/bin/env node
// parallelism/run.mjs: how many OpenHuman agents fit in one memory-capped container?
//
//   node parallelism/run.mjs [--levels 1,2,4,8,12,16] [--mem 4g] [--cpus 4] [--group ID]
//        [--bundle openhuman-par] [--stagger 0] [--timeout 1500] [--repeat 1]
//
// For each level N it starts ONE container (cgroup limits --mem/--cpus, no swap) that runs N
// independent agents on the same medium task (parallelism/task), all inference through the metering
// proxy. Then `node parallelism/report.mjs <group>` turns meter rows + the cgroup timeline into
// the table. Levels run one after another; the host is checked for quiet first.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitForQuietHost } from "../quiet-host.mjs";
import { writeTask } from "./task.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const levels = opt("--levels", "1,2,4,8,12,16").split(",").map(Number);
const mem = opt("--mem", "4g");
const cpus = opt("--cpus", "4");
const bundle = opt("--bundle", "openhuman-par");
const stagger = opt("--stagger", "0");
const timeout = opt("--timeout", "1500");
const repeat = Number(opt("--repeat", "1"));
const group = opt("--group", `par-${new Date().toISOString().replace(/[:.]/g, "-")}`);

const checkout = path.basename(root);
const projectName = process.env.COMPOSE_PROJECT_NAME || `hb-${checkout.replace(/[^a-z0-9_-]/gi, "-").toLowerCase()}`;
const hostPort =
  process.env.METER_HOST_PORT ||
  String(18100 + ([...checkout].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 800));
const composeEnv = { ...process.env, COMPOSE_PROJECT_NAME: projectName, METER_HOST_PORT: hostPort };
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: root, encoding: "utf8", stdio: "inherit", ...o, env: { ...composeEnv, ...(o.env ?? {}) } });

if (!fs.existsSync(path.join(root, ".cache", "harness", bundle, "adapter.sh"))) {
  throw new Error(`no bundle ${bundle}: BUNDLE_NAME=${bundle} ./bundles/build.sh openhuman`);
}
await waitForQuietHost();
const taskDir = writeTask(path.join(root, "parallelism", "generated", "task"));
if (sh("docker", ["compose", "--profile", "build", "build", "micro-image"]).status !== 0) throw new Error("building bench-micro failed");
fs.mkdirSync(path.join(root, "results"), { recursive: true });
fs.mkdirSync(path.join(root, ".cache", "meter-sock", projectName), { recursive: true });
if (sh("docker", ["compose", "up", "-d", "--build", "--wait", "meter-proxy"]).status !== 0) throw new Error("meter-proxy failed to start");

const groupDir = path.join(root, "results", group);
fs.mkdirSync(groupDir, { recursive: true });
fs.writeFileSync(path.join(groupDir, "parallelism.config.json"), JSON.stringify({ levels, mem, cpus, bundle, stagger, timeout, repeat, task: "csvstats", at: new Date().toISOString() }, null, 2));

for (const n of levels) {
  for (let rep = 1; rep <= repeat; rep += 1) {
    const runId = `${group}-n${n}${repeat > 1 ? `-r${rep}` : ""}`;
    const dir = path.join(root, "results", runId, "openhuman", "par");
    // Files in here are written as root by the container, so a stale dir cannot be cleaned up from the host.
    if (fs.existsSync(dir)) throw new Error(`${dir} exists: pick a new --group`);
    fs.mkdirSync(dir, { recursive: true });
    process.stdout.write(`[par] ${runId}: ${n} agents in ${mem} / ${cpus} cpus\n`);
    const r = sh("docker", [
      "compose", "--profile", "task", "run", "--rm", "--no-deps",
      "-v", `${path.join(root, "parallelism")}:/opt/bench/par:ro`,
      "-e", `PAR_N=${n}`, "-e", `PAR_RUN_ID=${runId}`, "-e", `PAR_STAGGER_S=${stagger}`,
      "--entrypoint", "/opt/harness/node/bin/node",
      "task", "/opt/bench/par/par-entry.mjs",
    ], {
      env: {
        TASK_IMAGE: "bench-micro:latest",
        HARNESS: "openhuman",
        HARNESS_BUNDLE: bundle,
        TASK_ID: "par",
        WORKDIR: "/work",
        TASK_DIR: taskDir,
        RUN_ID: runId,
        BENCH_MEM: mem,
        BENCH_CPUS: cpus,
        TASK_TIMEOUT_S: timeout,
      },
    });
    fs.appendFileSync(path.join(groupDir, "levels.jsonl"), `${JSON.stringify({ run_id: runId, n, rep, compose_exit: r.status })}\n`);
    process.stdout.write(`[par] ${runId} compose_exit=${r.status}\n`);
  }
}
process.stdout.write(`[par] done: node parallelism/report.mjs ${group}\n`);
