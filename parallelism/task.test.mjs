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
