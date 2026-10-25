import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { taskFor, taskIds, writeTasks } from "./task.mjs";

test("agents are assigned tasks round-robin in sorted order", () => {
  const order = ["a", "b", "c"];
  assert.deepEqual([1, 2, 3, 4, 5].map((i) => taskFor(order, i)), ["a", "b", "c", "a", "b"]);
});

test("every task has what the container needs and nothing from reference/", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "par-tasks-"));
  const { order } = writeTasks(out);
  assert.deepEqual(order, taskIds());
  assert.ok(order.length >= 1);
  for (const id of order) {
    for (const f of ["seed", "check.sh", "prompt.txt"]) assert.ok(fs.existsSync(path.join(out, id, f)), `${id}/${f}`);
    assert.ok(!fs.existsSync(path.join(out, id, "reference")), `${id} leaked reference/`);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "tasks.json"), "utf8")), order);
});

import { spawnSync } from "node:child_process";
import { TASKS_SRC } from "./task.mjs";

function runCheck(id, withReference) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `par-check-${id}-`));
  fs.cpSync(path.join(TASKS_SRC, id, "seed"), dir, { recursive: true });
  if (withReference) fs.cpSync(path.join(TASKS_SRC, id, "reference"), dir, { recursive: true });
  const r = spawnSync("bash", [path.join(TASKS_SRC, id, "check.sh")], { cwd: dir, encoding: "utf8", timeout: 60_000 });
  fs.rmSync(dir, { recursive: true, force: true });
  return r;
}

for (const id of taskIds()) {
  test(`task ${id}: seed fails its check, seed + reference passes it`, () => {
    assert.notEqual(runCheck(id, false).status, 0, "seed must not already pass");
    const solved = runCheck(id, true);
    assert.equal(solved.status, 0, `${solved.stdout}\n${solved.stderr}`.slice(-1500));
  });
  test(`task ${id}: the prompt does not leak the reference`, () => {
    const prompt = fs.readFileSync(path.join(TASKS_SRC, id, "prompt.txt"), "utf8");
    assert.ok(prompt.trim().length > 40 && !/reference/i.test(prompt));
  });
}
