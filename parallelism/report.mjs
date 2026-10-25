#!/usr/bin/env node
// parallelism/report.mjs <group>: merge the proxy's per-call rows (results/meter.jsonl), the
// container's cgroup timeline and each agent's check result into one table per concurrency level.
//   node parallelism/report.mjs par-2026-...   -> results/<group>/parallelism.{json,md}
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

/** Summarise one level from its meter rows, cgroup timeline, par.json and per-agent results. */
export function summariseLevel({ n, rows, timeline, par, agents, memLimit }) {
  const ok = rows.filter((r) => r.status === 200 && !r.error);
  const prompt = sum(rows.map((r) => r.prompt_tokens ?? 0));
  const cached = sum(rows.map((r) => r.cached_tokens ?? 0));
  const completion = sum(rows.map((r) => r.completion_tokens ?? 0));
  const ends = rows.map((r) => Date.parse(r.at));
  const starts = rows.map((r, i) => ends[i] - (r.total_ms ?? 0));
  const activeS = rows.length ? (Math.max(...ends) - Math.min(...starts)) / 1000 : 0;
  // Decode speed of one call: tokens after the first one over the time after the first token.
  const decode = ok
    .filter((r) => r.completion_tokens > 20 && r.total_ms > r.first_token_ms)
    .map((r) => (r.completion_tokens / (r.total_ms - (r.first_token_ms ?? 0))) * 1000);
  const t = timeline;
  const dt = t.length > 1 ? (t.at(-1).t - t[0].t) / 1000 : 0;
  const peakMem = Math.max(0, ...t.map((s) => s.mem ?? 0));
  const peakAnon = Math.max(0, ...t.map((s) => s.anon ?? 0));
  const wall = par ? par.wall_ms / 1000 : dt;
  const passed = agents.filter((a) => a.check?.passed).length;
  const finished = agents.filter((a) => a.exit === 0 || a.check).length;
  const cost = sum(rows.map((r) => r.cost_usd ?? 0));
  const apiErrors = rows.filter((r) => r.status !== 200 || r.error);
  return {
    agents: n,
    finished,
    passed,
    wall_s: wall,
    agent_wall_p50_s: pct(agents.map((a) => (a.wall_ms ?? 0) / 1000).filter(Boolean), 50),
    agent_wall_max_s: Math.max(0, ...agents.map((a) => (a.wall_ms ?? 0) / 1000)),
    llm_calls: rows.length,
    api_errors: apiErrors.length,
    rate_limited: apiErrors.filter((r) => r.status === 429).length,
    prompt_tokens: prompt,
    completion_tokens: completion,
    cache_hit_pct: prompt ? (100 * cached) / prompt : null,
    cost_usd: cost,
    cost_per_pass_usd: passed ? cost / passed : null,
    // Throughput over the window in which any call was in flight.
    agg_completion_tok_s: activeS ? completion / activeS : null,
    agg_prompt_tok_s: activeS ? prompt / activeS : null,
    per_agent_completion_tok_s: activeS ? completion / activeS / n : null,
    calls_per_min: activeS ? (rows.length / activeS) * 60 : null,
    decode_tok_s_p50: pct(decode, 50),
    decode_tok_s_p10: pct(decode, 10),
    ttft_p50_ms: pct(ok.map((r) => r.first_token_ms).filter((v) => v != null), 50),
    ttft_p95_ms: pct(ok.map((r) => r.first_token_ms).filter((v) => v != null), 95),
    call_p50_ms: pct(ok.map((r) => r.total_ms), 50),
    call_p95_ms: pct(ok.map((r) => r.total_ms), 95),
    peak_mem_mb: peakMem / 2 ** 20,
    peak_anon_mb: peakAnon / 2 ** 20,
    // openhuman-core resident memory (summed over all core processes) at its peak, and how many ran.
    core_rss_peak_mb: Math.max(0, ...t.map((s) => s.core_rss ?? 0)) / 2 ** 20,
    core_procs_peak: Math.max(0, ...t.map((s) => s.cores ?? 0)),
    anon_per_agent_mb: peakAnon / 2 ** 20 / n,
    by_task: byTask(agents, rows),
    mem_limit_mb: memLimit,
    avg_cpu_cores: dt && t.at(-1).cpu_usec != null ? (t.at(-1).cpu_usec - t[0].cpu_usec) / 1e6 / dt : null,
    cpu_throttled_s: t.length ? (t.at(-1).throttled_usec - t[0].throttled_usec) / 1e6 : null,
    peak_mem_pressure: Math.max(0, ...t.map((s) => s.mem_pressure_avg10 ?? 0)),
    oom_kills: t.length ? t.at(-1).oom_kill - t[0].oom_kill : null,
  };
}

/** Per-task pass rate, agent wall and LLM calls (rows are tagged .../a<i>). */
export function byTask(agents, rows) {
  const out = {};
  for (const a of agents) {
    const t = (out[a.task ?? "?"] ??= { agents: 0, passed: 0, walls: [], calls: 0 });
    t.agents += 1;
    if (a.check?.passed) t.passed += 1;
    if (a.wall_ms) t.walls.push(a.wall_ms / 1000);
    t.calls += rows.filter((r) => r.task === a.id).length;
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { agents: v.agents, passed: v.passed, wall_p50_s: pct(v.walls, 50), calls_per_agent: v.agents ? v.calls / v.agents : null }]));
}

const fmt = (v, d = 1) => (v == null ? "n/a" : typeof v === "number" ? v.toFixed(d) : String(v));

export function renderMarkdown(group, config, levels) {
  const cols = [
    ["agents", (l) => l.agents],
    ["passed", (l) => `${l.passed}/${l.agents}`],
    ["wall s", (l) => fmt(l.wall_s, 0)],
    ["agent wall p50 s", (l) => fmt(l.agent_wall_p50_s, 0)],
    ["LLM calls", (l) => l.llm_calls],
    ["errors (429)", (l) => `${l.api_errors} (${l.rate_limited})`],
    ["out tok/s total", (l) => fmt(l.agg_completion_tok_s)],
    ["out tok/s / agent", (l) => fmt(l.per_agent_completion_tok_s, 2)],
    ["decode tok/s p50", (l) => fmt(l.decode_tok_s_p50)],
    ["in tok/s total", (l) => fmt(l.agg_prompt_tok_s, 0)],
    ["calls/min", (l) => fmt(l.calls_per_min, 0)],
    ["TTFT p50/p95 ms", (l) => `${fmt(l.ttft_p50_ms, 0)}/${fmt(l.ttft_p95_ms, 0)}`],
    ["cache %", (l) => fmt(l.cache_hit_pct)],
    ["cost $", (l) => fmt(l.cost_usd, 3)],
    ["$ / pass", (l) => fmt(l.cost_per_pass_usd, 3)],
    ["peak RAM MB (anon)", (l) => `${fmt(l.peak_mem_mb, 0)} (${fmt(l.peak_anon_mb, 0)})`],
    ["anon MB / agent", (l) => fmt(l.anon_per_agent_mb, 0)],
    ["core RSS MB (procs)", (l) => `${fmt(l.core_rss_peak_mb, 0)} (${l.core_procs_peak})`],
    ["CPU cores", (l) => fmt(l.avg_cpu_cores, 2)],
    ["throttled s", (l) => fmt(l.cpu_throttled_s, 0)],
    ["OOM kills", (l) => l.oom_kills ?? "n/a"],
  ];
  const head = `| ${cols.map((c) => c[0]).join(" | ")} |\n|${cols.map(() => "---").join("|")}|\n`;
  const body = levels.map((l) => `| ${cols.map((c) => c[1](l)).join(" | ")} |`).join("\n");
  const tasks = [...new Set(levels.flatMap((l) => Object.keys(l.by_task ?? {})))].sort();
  const taskHead = `| agents | ${tasks.join(" | ")} |\n|---|${tasks.map(() => "---").join("|")}|\n`;
  const taskBody = levels.map((l) => `| ${l.agents} | ${tasks.map((t) => (l.by_task?.[t] ? `${l.by_task[t].passed}/${l.by_task[t].agents}, ${fmt(l.by_task[t].wall_p50_s, 0)}s, ${fmt(l.by_task[t].calls_per_agent, 0)} calls` : "")).join(" | ")} |`).join("\n");
  return `# OpenHuman parallelism: ${group}\n\n${config.levels?.join(", ")} agents per container (${config.mode ?? "isolated"} mode: ${config.mode === "shared" ? "ONE openhuman-core serving all agents" : "one openhuman-core per agent"}), task pool ${(config.tasks ?? ["csvstats"]).join(", ")} assigned round-robin, ${config.mem} RAM (no swap), ${config.cpus} CPUs, bundle \`${config.bundle}\`, stagger ${config.stagger}s.\n\n${head}${body}\n\nPer task (passed/agents, p50 agent wall, LLM calls per agent):\n\n${taskHead}${taskBody}\n\nTokens/s are measured over the window in which at least one inference call was in flight; decode tok/s is per call (completion tokens over the time after the first token). RAM is the cgroup's \`memory.current\` (incl. page cache) and \`anon\` (process memory), sampled at 1 Hz.\n`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const group = process.argv[2];
  if (!group) throw new Error("usage: report.mjs <group>");
  const groupDir = path.join(root, "results", group);
  const config = JSON.parse(fs.readFileSync(path.join(groupDir, "parallelism.config.json"), "utf8"));
  const meter = readJsonl(path.join(root, "results", "meter.jsonl"));
  const memLimit = (Number.parseFloat(config.mem) * (/g/i.test(config.mem) ? 1024 : 1)) || null;
  const levels = [];
  for (const lv of readJsonl(path.join(groupDir, "levels.jsonl"))) {
    const dir = path.join(root, "results", lv.run_id, "openhuman", "par");
    const par = fs.existsSync(path.join(dir, "par.json")) ? JSON.parse(fs.readFileSync(path.join(dir, "par.json"), "utf8")) : null;
    const agents = (par?.agents ?? []).map((a) => {
      const f = path.join(dir, a.id, "result.json");
      const r = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : {};
      return { ...a, wall_ms: r.wall_ms, check: r.check, timed_out: r.timed_out };
    });
    levels.push({ run_id: lv.run_id, rep: lv.rep, ...summariseLevel({ n: lv.n, rows: meter.filter((r) => r.run_id === lv.run_id), timeline: readJsonl(path.join(dir, "timeline.jsonl")), par, agents, memLimit }) });
  }
  fs.writeFileSync(path.join(groupDir, "parallelism.json"), JSON.stringify({ group, config, levels }, null, 2));
  const md = renderMarkdown(group, config, levels);
  fs.writeFileSync(path.join(groupDir, "parallelism.md"), md);
  process.stdout.write(md);
}
