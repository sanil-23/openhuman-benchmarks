# Task contract

Each directory under `parallelism/tasks/` is one benchmark task for one OpenHuman agent.

```
tasks/<id>/
  seed/          the agent's starting working copy (README.md spec, stubs or buggy code, tests/)
  reference/     a full solution overlay: copying it over seed/ makes the suite pass. NEVER shown to the agent.
  check.sh       run from the working copy; exit 0 iff the whole suite passes
  prompt.txt     the instruction the agent receives
```

Rules: Python 3.10 standard library only, no network, no pip. Tests are `unittest`, discovered with
`python3 -m unittest discover -s tests`. Deterministic, no sleeps over 1 s, whole suite under 10 s.
Medium difficulty: 3-4 modules or files, a README spec precise enough that the tests are derivable
from it (every behaviour a test pins is stated in the README), about 15-40 agent tool calls, and no
single-shot solution (at least some edge cases only surface when the tests run). `seed/` must fail
`check.sh`; `seed/` + `reference/` must pass it. The agent must not need the reference to succeed.
