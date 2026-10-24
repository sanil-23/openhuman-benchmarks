import assert from "node:assert/strict";
import test from "node:test";
import { pct, summariseLevel } from "./report.mjs";

test("percentile picks nearest rank", () => {
  assert.equal(pct([1, 2, 3, 4], 50), 2);
  assert.equal(pct([], 50), null);
});

test("summariseLevel derives throughput, cache and memory from rows and timeline", () => {
  const at = (s) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rows = [
    { at: at(10), status: 200, total_ms: 10000, first_token_ms: 1000, prompt_tokens: 1000, cached_tokens: 900, completion_tokens: 90, cost_usd: 0.01 },
    { at: at(20), status: 429, total_ms: 100, prompt_tokens: 0, completion_tokens: 0, error: "rate" },
  ];
  const mb = 2 ** 20;
  const timeline = [
    { t: 0, mem: 100 * mb, anon: 50 * mb, cpu_usec: 0, throttled_usec: 0, oom_kill: 0 },
    { t: 20000, mem: 300 * mb, anon: 200 * mb, cpu_usec: 20e6, throttled_usec: 2e6, oom_kill: 1 },
  ];
  const l = summariseLevel({ n: 2, rows, timeline, par: { wall_ms: 20000 }, agents: [{ check: { passed: true } }, {}], memLimit: 4096 });
  assert.equal(l.passed, 1);
  assert.equal(l.api_errors, 1);
  assert.equal(l.rate_limited, 1);
  assert.equal(l.cache_hit_pct, 90);
  assert.equal(l.peak_anon_mb, 200);
  assert.equal(l.anon_per_agent_mb, 100);
  assert.equal(l.avg_cpu_cores, 1);
  assert.equal(l.oom_kills, 1);
  assert.ok(Math.abs(l.decode_tok_s_p50 - 10) < 1e-9 || l.decode_tok_s_p50 === null);
});
