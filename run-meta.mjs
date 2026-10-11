// run-meta.mjs — what built and configured a harness run, recorded on every runs.jsonl row so a
// result can be traced back to the exact harness build without reconstructing it from dates.

import fs from "node:fs";
import path from "node:path";

/** Bench-only harness knobs a run may set; recorded when non-empty. */
const KNOB = /^(OPENHUMAN_|TASK_TIMEOUT_S$|BENCH_(MODEL|REASONING|TURN_MARGIN_S|PROVIDER|CPUS|MEM|NET_INTERNAL)$)/;

/**
 * @param root    bench checkout
 * @param harness harness name (bundle under .cache/harness/<harness>)
 * @param resultDir optional per-task artifact directory; memory evidence comes from the core RPCs
 * @returns {{harness_version: string|null, knobs: object, memory?: object}}
 */
export function runMeta(root, harness, env = process.env, resultDir = null) {
  let version = null;
  if (harness.startsWith("openhuman")) {
    // Written by bundles/Dockerfile.openhuman from the built tree's HEAD (or OPENHUMAN_SRC's).
    try {
      version = fs.readFileSync(path.join(root, ".cache", "harness", harness, "openhuman", "GIT_SHA"), "utf8").trim() || null;
    } catch {
      // bundle built before the stamp existed
    }
  } else {
    try {
      const lock = fs.readFileSync(path.join(root, "harnesses.lock"), "utf8");
      const key = `${harness.replace(/-/g, "_").toUpperCase()}_VERSION`;
      version = lock.match(new RegExp(`^${key}=(\\S+)`, "m"))?.[1] ?? null;
    } catch {
      // no lock
    }
  }
  const knobs = Object.fromEntries(Object.entries(env).filter(([k, v]) => KNOB.test(k) && !/^OPENHUMAN_KEYRING_MASTER_KEY(?:_FILE)?$/.test(k) && v !== ""));
  const meta = { harness_version: version, knobs };
  if (harness.startsWith("openhuman") && resultDir) {
    try {
      const memory = JSON.parse(fs.readFileSync(path.join(resultDir, "memory-state.json"), "utf8"));
      if (!memory || typeof memory.verified !== "boolean") throw new Error("invalid memory state");
      meta.memory = memory;
    } catch (error) {
      meta.memory = { verified: false, error: error.code === "ENOENT" ? "memory-state.json missing" : "memory-state.json unreadable" };
    }
  }
  return meta;
}
