// micro.mjs — generates the micro suite: five small fixed tasks that exercise
// cold start, a read, an edit, a shell run and a multi-step change, plus memory policy. Each task
// is a directory {prompt.txt, setup.sh, check.sh} mounted at /bench/task.
// Checks are deterministic shell tests, so "passed" never needs a judge.

import fs from "node:fs";
import path from "node:path";

export const MICRO_TASKS = [
  {
    id: "m1-hello",
    prompt: "Reply with the single word READY and do not touch any files.",
    setup: "echo seed > seed.txt",
    // nothing should change (entry.mjs stages the harness's edits against the baseline commit)
    check: 'test "$(cat seed.txt)" = seed && test -z "$(git diff --cached --name-only)"',
  },
  {
    id: "m2-read",
    prompt:
      "Read config.json and write the value of the key \"port\" (just the number) into answer.txt.",
    setup: 'echo \'{"name":"svc","port":4817,"debug":false}\' > config.json',
    check: 'test "$(tr -d "[:space:]" < answer.txt)" = 4817',
  },
  {
    id: "m3-edit",
    prompt:
      "In greet.py the function greet() prints the wrong word. Fix it so running `python3 greet.py` prints exactly: Hello, World",
    setup: 'printf \'def greet():\\n    print("Goodbye, World")\\n\\ngreet()\\n\' > greet.py',
    check: 'test "$(python3 greet.py)" = "Hello, World"',
  },
  {
    id: "m4-shell",
    prompt:
      "Count the lines of every .txt file in the data/ directory and write the total to total.txt (just the number).",
    setup:
      "mkdir data && seq 1 7 > data/a.txt && seq 1 5 > data/b.txt && seq 1 3 > data/c.txt && echo skip > data/d.log",
    check: 'test "$(tr -d "[:space:]" < total.txt)" = 15',
  },
  {
    id: "m5-multistep",
    prompt:
      "The tests in test_calc.py fail. Fix calc.py so `python3 -m unittest test_calc` passes. Do not edit test_calc.py.",
    setup: `cat > calc.py <<'PY'
def add(a, b):
    return a - b

def mul(a, b):
    return a + b
PY
cat > test_calc.py <<'PY'
import unittest
from calc import add, mul

class T(unittest.TestCase):
    def test_add(self):
        self.assertEqual(add(2, 3), 5)
    def test_mul(self):
        self.assertEqual(mul(4, 5), 20)

if __name__ == "__main__":
    unittest.main()
PY`,
    check:
      "python3 -m unittest test_calc >/dev/null 2>&1 && git diff --cached --quiet HEAD -- test_calc.py",
  },
  {
    id: "m6-memory-policy",
    harnesses: ["openhuman"],
    prompt: "Reply with READY.",
    setup: "true",
    check: `case "$BENCH_HARNESS" in openhuman*)
/opt/harness/node/bin/node -e 'const s = require(process.env.RESULT_DIR + "/memory-state.json"); if (s.verified !== true || s.driver !== "null" || s.embedder !== "none" || s.auto_recall !== false || s.auto_capture !== false || s.off_smoke?.learn !== "MEMORY_OFF" || s.off_smoke?.recall !== "MEMORY_OFF") process.exit(1)'
;; esac`,
  },
];

export function writeMicroSuite(outDir) {
  const tasks = [];
  for (const t of MICRO_TASKS) {
    const dir = path.join(outDir, t.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.txt"), `${t.prompt}\n`);
    // git init: the entry diffs the harness's edits against a baseline commit, and checks use that diff
    fs.writeFileSync(path.join(dir, "setup.sh"), `set -e\ngit init -q\n${t.setup}\n`);
    fs.writeFileSync(path.join(dir, "check.sh"), `${t.check}\n`);
    tasks.push({ id: t.id, ...(t.harnesses ? { harnesses: t.harnesses } : {}), image: "bench-micro:latest", workdir: "/work", dir });
  }
  fs.writeFileSync(path.join(outDir, "tasks.json"), JSON.stringify(tasks, null, 2));
  return tasks;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = process.argv[2] ?? "tasks/generated/micro";
  console.log(`wrote ${writeMicroSuite(out).length} micro tasks to ${out}`);
}
