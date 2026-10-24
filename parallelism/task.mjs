// Materialises the benchmark task (a medium multi-file Python feature with a test suite) as a
// bench task dir: prompt.txt, check.sh and seed/ (the starting working copy). The reference
// solution under task/reference is never copied, it only proves the task is solvable.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const PROMPT = `You are working in a Python project at the current working directory (a plain directory, standard library only, Python 3.10, no network or pip installs).

Read README.md: it specifies four small modules under csvstats/ that are currently stubs raising NotImplementedError. Implement all of them so that the specification is met and the whole test suite passes (\`python3 -m unittest discover -s tests\`). Do not modify the tests. Run the tests as you go and fix what fails. When the suite is green, stop.
`;

export function writeTask(out) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(out, { recursive: true });
  fs.cpSync(path.join(here, "task", "seed"), path.join(out, "seed"), { recursive: true });
  fs.copyFileSync(path.join(here, "task", "check.sh"), path.join(out, "check.sh"));
  fs.writeFileSync(path.join(out, "prompt.txt"), PROMPT);
  return out;
}
