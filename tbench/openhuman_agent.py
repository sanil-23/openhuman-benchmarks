"""OpenHuman as a Harbor agent, for running Terminal-Bench through Harbor itself.

Harbor owns everything Terminal-Bench defines: the task environment (prebuilt image or
Dockerfile), its resources and network, the agent timeout, and the verifier. This agent
only runs the bench's usual in-container entry (runner/entry.mjs: cgroup sampler around
bundles/adapters/openhuman.sh) so every call goes through the metering proxy and the
result has the same shape as the bench's other suites.

The compose overlay written by tbench/run.mjs mounts the OpenHuman bundle at
/opt/harness, the runner at /opt/bench/runner (read-only) and the meter proxy's unix
socket directory at /opt/bench/sock. The task's network is left as Harbor sets it up.
Each call carries a /__tag/<run>/<harness>/<task> path prefix, so the proxy attributes it
to this trial even when trials run concurrently.

Host env (set by tbench/run.mjs):
  BENCH_RUN_ID          results/<run-id>
  BENCH_METER_LOG       host path of meter.jsonl (to report tokens/cost back to Harbor)
  BENCH_HARNESS_VERSION the OpenHuman build (bundle GIT_SHA), reported as the agent version
  BENCH_MODEL, BENCH_REASONING
  OPENHUMAN_AGENT_TURN_TIMEOUT_SECS  OpenHuman's own turn ceiling; unset = the task's agent timeout
                        (task.toml) minus BENCH_TURN_MARGIN_S (default 120), set by runner/turn-budget.mjs;
                        0 = no ceiling, so only Harbor's timeout limits the turn
"""

import json
import os
import shlex
import tomllib
import time
from pathlib import Path
from urllib.parse import quote

from harbor.agents.base import BaseAgent
from harbor.agents.capabilities import AgentCapabilities
from harbor.environments.base import BaseEnvironment
from harbor.models.agent.context import AgentContext

HARNESS = "openhuman"


def task_key(logs_dir: Path) -> str:
    """Trial dirs are named <task>__<suffix>; the agent's logs dir sits inside one."""
    return logs_dir.parent.name.rsplit("__", 1)[0]


def task_budget_secs(key: str) -> str:
    """Resolve Harbor's agent timeout from the task config and job-level timeout settings."""
    cache = Path(os.environ.get("HARBOR_TASK_CACHE", Path.home() / ".cache/harbor/tasks"))
    multiplier = float(os.environ.get("BENCH_AGENT_TIMEOUT_MULTIPLIER", "1"))
    maximum = float(os.environ.get("BENCH_AGENT_TIMEOUT_MAX_S", "0") or 0)
    override = float(os.environ.get("BENCH_AGENT_TIMEOUT_OVERRIDE_S", "0") or 0)
    if override > 0:
        return str(int(min(override, maximum) * multiplier if maximum > 0 else override * multiplier))
    # Two cache layouts exist and both must be read. Harbor's older one is
    # `<dataset-id>/<task>/task.toml`; the newer package layout is
    # `packages/<dataset>/<task>/<content-hash>/task.toml`. Matching only the
    # first silently loses the task's budget, and an empty budget falls through
    # to TASK_TIMEOUT_S (86400) in runner/turn-budget.mjs -- so the turn ceiling
    # became ~24h instead of the task's own. Observed on terminal-bench 4.0
    # `payments-pipeline-fix` (declares 28800s): the turn ran with an 86280s
    # ceiling, so neither the per-call nor the shell timeout had any turn
    # pressure to work from and one `grep -rl /` held the shell for 3575s of a
    # 3906s run.
    tomls = [*cache.glob(f"*/{key}/task.toml"), *cache.glob(f"packages/*/{key}/*/task.toml")]
    budgets = set()
    for toml in tomls:
        try:
            secs = tomllib.loads(toml.read_text(encoding="utf8")).get("agent", {}).get("timeout_sec")
        except (OSError, ValueError):
            continue
        if isinstance(secs, (int, float)) and secs > 0:
            budgets.add(int(min(secs, maximum) * multiplier if maximum > 0 else secs * multiplier))
    if len(budgets) == 1:
        return str(budgets.pop())
    # Harbor's BaseAgent API exposes the trial logs path but not its task config or effective
    # timeout. If cached datasets disagree, do not guess from cache mtimes; Harbor remains the
    # sole timeout authority and the inner ceiling is disabled for this trial.
    return "0" if len(budgets) > 1 else ""


def turn_timeout_setting(explicit: str, budget: str) -> str:
    """Preserve explicit settings and disable the default ceiling for ambiguous task budgets."""
    return explicit or ("0" if budget == "0" else "")


def tag_prefix(tag: dict) -> str:
    """The proxy's per-request tag (meter-proxy/proxy.mjs splitTag)."""
    prefix = "/__tag/" + "/".join(quote(tag[k], safe="") for k in ("run_id", "harness", "task"))
    return f"{prefix}/__attempt/{quote(tag['attempt'], safe='')}" if tag.get("attempt") else prefix


def meter_totals(log: str, tag: dict) -> dict:
    totals = {"calls": 0, "prompt": 0, "cached": 0, "completion": 0, "cost": 0.0}
    try:
        with open(log, encoding="utf8") as f:
            for line in f:
                try:
                    r = json.loads(line)
                except ValueError:
                    continue
                if (r.get("run_id"), r.get("harness"), r.get("task")) != (tag["run_id"], tag["harness"], tag["task"]):
                    continue
                if tag.get("attempt") and r.get("attempt") != tag["attempt"]:
                    continue
                totals["calls"] += 1
                totals["prompt"] += r.get("prompt_tokens") or 0
                totals["cached"] += r.get("cached_tokens") or 0
                totals["completion"] += r.get("completion_tokens") or 0
                totals["cost"] += r.get("cost_usd") or 0.0
    except FileNotFoundError:
        pass
    return totals


class OpenHuman(BaseAgent):
    # Terminal-Bench tasks that ship a skills_dir (baked into the task image) set
    # task.environment.skills_dir; Harbor refuses to start the trial unless the agent
    # declares this capability. OpenHuman has no native skill loader, so run() surfaces
    # the in-container skills path to the model via the prompt (the sanctioned channel).
    capabilities = AgentCapabilities(skills=True)

    @staticmethod
    def name() -> str:
        return HARNESS

    def version(self) -> str | None:
        return os.environ.get("BENCH_HARNESS_VERSION") or None

    async def setup(self, environment: BaseEnvironment) -> None:
        r = await environment.exec(
            "test -x /opt/harness/adapter.sh && test -f /opt/bench/runner/entry.mjs && test -S /opt/bench/sock/meter.sock",
            timeout_sec=30,
        )
        if r.return_code != 0:
            raise RuntimeError("OpenHuman bundle, bench runner or meter socket not mounted (run through tbench/run.mjs)")

    async def run(self, instruction: str, environment: BaseEnvironment, context: AgentContext) -> None:
        key = task_key(self.logs_dir)
        # One id per try; the meter stamps it on every call and run.mjs copies it to the runs.jsonl row.
        tag = {"run_id": os.environ["BENCH_RUN_ID"], "harness": HARNESS, "task": key, "attempt": str(int(time.time() * 1000))}
        (self.logs_dir / "attempt.txt").write_text(tag["attempt"], encoding="utf8")

        # /logs/agent is the host's trial agent dir, mounted into the container.
        skills_dir = getattr(self, "skills_dir", None)
        prompt_text = instruction
        if skills_dir:
            prompt_text += (
                "\n\n---\nReusable skill guides for this environment are available under "
                f"{skills_dir} (each subdirectory holds a SKILL.md describing when and how to use it). "
                "Read any that are relevant to this task before you begin.\n"
            )
        (self.logs_dir / "prompt.txt").write_text(prompt_text, encoding="utf8")
        workdir = (await environment.exec("pwd", timeout_sec=30)).stdout.strip() or "/"
        budget = task_budget_secs(key)
        turn_timeout = turn_timeout_setting(os.environ.get("OPENHUMAN_AGENT_TURN_TIMEOUT_SECS", ""), budget)
        env = {
            "BENCH_HARNESS": HARNESS,
            "BENCH_TASK_ID": key,
            "BENCH_SKILLS_DIR": skills_dir or "",
            "WORKDIR": workdir,
            # Harbor enforces the task's own agent timeout; this is only a backstop.
            "TASK_TIMEOUT_S": os.environ.get("BENCH_TASK_TIMEOUT_S", "86400"),
            "RESULT_DIR": f"{self.environment_logs_dir}/bench",
            "PROMPT_FILE": f"{self.environment_logs_dir}/prompt.txt",
            # Terminal-Bench grades the container itself (some tasks its git history): no baseline commit.
            "BENCH_CAPTURE_PATCH": "0",
            "PROXY_SOCKET": "/opt/bench/sock/meter.sock",
            "BENCH_PROXY_PREFIX": tag_prefix(tag),
            "BENCH_MODEL": os.environ.get("BENCH_MODEL", "deepseek/deepseek-v4.1-flash"),
            "BENCH_REASONING": os.environ.get("BENCH_REASONING", "high"),
            "DUMMY_API_KEY": "bench-dummy-key",
            "OPENHUMAN_COMPACTION_TRIGGER_TOKENS": os.environ.get("OPENHUMAN_COMPACTION_TRIGGER_TOKENS", ""),
            # OpenHuman's default 60 min turn ceiling would cut 8 h Terminal-Bench 4.0 tasks short, so
            # runner/turn-budget.mjs sets it to the task's own agent budget minus a margin.
            "OPENHUMAN_AGENT_TURN_TIMEOUT_SECS": turn_timeout,
            # Per-call ceiling. OpenHuman defaults to 900s, but a Terminal-Bench 2.0
            # turn is 780s (900s task budget - BENCH_TURN_MARGIN_S), so its backstop
            # for "calls that will never return" can never fire: one stalled upstream
            # request consumes the whole task with no retry and no metered row (the
            # proxy logs a call only once it completes). Observed on
            # adaptive-rejection-sampler: 778s of wall clock, zero completions.
            "OPENHUMAN_MODEL_CALL_TIMEOUT_SECS": os.environ.get("OPENHUMAN_MODEL_CALL_TIMEOUT_SECS", ""),
            "BENCH_TURN_MARGIN_S": os.environ.get("BENCH_TURN_MARGIN_S", ""),
            "BENCH_TURN_BUDGET_S": budget,
            "DISABLE_TELEMETRY": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DO_NOT_TRACK": "1",
            "CI": "1",
        }
        cmd = "/opt/harness/node/bin/node /opt/bench/runner/entry.mjs"
        r = await environment.exec(cmd, cwd=workdir, env=env)
        (self.logs_dir / "entry.log").write_text((r.stdout or "") + (r.stderr or ""), encoding="utf8")

        totals = meter_totals(os.environ.get("BENCH_METER_LOG", ""), tag)
        context.n_input_tokens = totals["prompt"]
        context.n_cache_tokens = totals["cached"]
        context.n_output_tokens = totals["completion"]
        context.cost_usd = totals["cost"]
        context.metadata = {"llm_calls": totals["calls"], "entry_exit_code": r.return_code, "workdir": workdir}
        if r.return_code != 0:
            raise RuntimeError(f"bench entry exited {r.return_code}: {shlex.quote((r.stderr or '')[-500:])}")
