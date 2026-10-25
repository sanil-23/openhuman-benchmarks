// Materialises the benchmark task pool as one bench task dir: <out>/<id>/{seed,check.sh,prompt.txt}
// plus <out>/tasks.json (the assignment order). Agent i runs task `order[(i-1) % order.length]`.
// Each task's reference/ overlay is never copied: it only proves the task is solvable (see
// tasks/CONTRACT.md and task.test.mjs).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const TASKS_SRC = path.join(here, "tasks");

/** Task ids in assignment order: every directory under tasks/ that has a seed/, sorted. */
export function taskIds(src = TASKS_SRC) {
  return fs
    .readdirSync(src, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(src, d.name, "seed")))
    .map((d) => d.name)
    .sort();
}

/** Which task agent `i` (1-based) gets. */
export const taskFor = (order, i) => order[(i - 1) % order.length];

export function writeTasks(out, only = null, src = TASKS_SRC) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  const order = taskIds(src).filter((id) => !only || only.includes(id));
  if (!order.length) throw new Error("no tasks selected");
  for (const id of order) {
    const d = path.join(out, id);
    fs.mkdirSync(d, { recursive: true });
    fs.cpSync(path.join(src, id, "seed"), path.join(d, "seed"), { recursive: true });
    fs.copyFileSync(path.join(src, id, "check.sh"), path.join(d, "check.sh"));
    fs.copyFileSync(path.join(src, id, "prompt.txt"), path.join(d, "prompt.txt"));
  }
  fs.writeFileSync(path.join(out, "tasks.json"), JSON.stringify(order));
  return { dir: out, order };
}
