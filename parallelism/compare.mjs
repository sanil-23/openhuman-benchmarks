#!/usr/bin/env node
// parallelism/compare.mjs <isolatedGroup> <sharedGroup>: the two modes side by side per level
// (reads results/<group>/parallelism.json written by report.mjs). Prints and writes
// results/<sharedGroup>/compare-<isolatedGroup>.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (g) => JSON.parse(fs.readFileSync(path.join(root, "results", g, "parallelism.json"), "utf8"));
const f = (v, d = 0) => (v == null ? "n/a" : v.toFixed(d));

export function compareTable(iso, shared) {
  const cols = [
    ["passed", (l) => `${l.passed}/${l.agents}`],
    ["wall s", (l) => f(l.wall_s)],
    ["out tok/s", (l) => f(l.agg_completion_tok_s)],
    ["peak anon MB", (l) => f(l.peak_anon_mb)],
    ["core RSS MB (procs)", (l) => `${f(l.core_rss_peak_mb)} (${l.core_procs_peak})`],
    ["anon MB / agent", (l) => f(l.anon_per_agent_mb)],
    ["peak total MB", (l) => f(l.peak_mem_mb)],
    ["CPU cores", (l) => f(l.avg_cpu_cores, 2)],
    ["OOM", (l) => l.oom_kills ?? "n/a"],
    ["$", (l) => f(l.cost_usd, 2)],
  ];
  const head = `| agents | ${cols.map(([c]) => `${c} iso | ${c} shared`).join(" | ")} |\n|---|${cols.map(() => "---|---").join("|")}|\n`;
  const rows = iso.levels.map((a) => {
    const b = shared.levels.find((l) => l.agents === a.agents);
    return `| ${a.agents} | ${cols.map(([, g]) => `${g(a)} | ${b ? g(b) : "n/a"}`).join(" | ")} |`;
  });
  return head + rows.join("\n") + "\n";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [gi, gs] = process.argv.slice(2);
  if (!gi || !gs) throw new Error("usage: compare.mjs <isolatedGroup> <sharedGroup>");
  const md = `# Isolated cores vs one shared core\n\niso = ${gi}, shared = ${gs}\n\n${compareTable(load(gi), load(gs))}`;
  fs.writeFileSync(path.join(root, "results", gs, `compare-${gi}.md`), md);
  process.stdout.write(md);
}
