#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
const dir = path.resolve(process.argv[2] || 'results/memory27-glm53flash');
const readLines = name => fs.readFileSync(path.join(dir, name), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const rows = readLines('answers.jsonl');
const unique = new Set(rows.map(r=>`${r.dataset}/${r.system}/${r.id}`));
if (unique.size !== rows.length) throw new Error('duplicate scored questions: refuse inflated totals');
const meter = readLines('meter.jsonl');
const groups = {};
for (const row of rows) {
  for (const category of [String(row.category), 'ALL']) {
    const key = `${row.dataset}/${row.system}/${category}`;
    const g = groups[key] ??= { n: 0, sum: 0, empty_answers: 0, metric: row.metric };
    g.n++; g.sum += row.score; g.empty_answers += !row.answer;
  }
}
for (const g of Object.values(groups)) g.mean = g.sum/g.n;
const arms = ['no-memory', 'full-context', 'reference-memory', 'oh-tinymemory-cortex-direct'];
const matchedScores = {};
for (const dataset of new Set(rows.map(r => r.dataset))) {
  const ids = arms.map(system => new Set(rows.filter(r => r.dataset === dataset && r.system === system).map(r => r.id)));
  const common = new Set([...ids[0]].filter(id => ids.every(set => set.has(id))));
  for (const system of arms) {
    const matched = rows.filter(r => r.dataset === dataset && r.system === system && common.has(r.id));
    if (!matched.length) continue;
    matchedScores[`${dataset}/${system}`] = { n: matched.length, metric: matched[0].metric,
      mean: matched.reduce((sum, r) => sum+r.score, 0)/matched.length };
  }
}
const calls = {};
for (const row of meter) {
  const key = row.phase;
  const g = calls[key] ??= { n: 0, reported_cost_usd: 0, unpriced: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, latencies: [] };
  g.n++; g.errors += !!row.error || row.status !== 200;
  if (typeof row.usage?.cost === 'number') g.reported_cost_usd += row.usage.cost; else g.unpriced++;
  g.prompt_tokens += row.usage?.prompt_tokens || 0;
  g.completion_tokens += row.usage?.completion_tokens || 0;
  if (row.wall_ms !== undefined) g.latencies.push(row.wall_ms);
}
const percentile = (values, p) => values.length ? [...values].sort((a,b)=>a-b)[Math.ceil(values.length*p)-1] : null;
for (const g of Object.values(calls)) {
  g.p50_ms = percentile(g.latencies, .5); g.p95_ms = percentile(g.latencies, .95); delete g.latencies;
}
const retrievals = [];
for (const name of fs.readdirSync(dir).filter(n => /-(reference|cortex)\.json$/.test(n))) {
  const r = JSON.parse(fs.readFileSync(path.join(dir, name)));
  const query = (r.probes || []).map(p=>p.query_ms);
  retrievals.push({ file: name, engine: r.engine, error: r.error || null, stored_turns: r.stored_turns,
    ingest_ms: r.ingest_ms, write_wait: r.write_wait || 'visible writes; enrichment not explicitly settled',
    query_count: query.length, query_p50_ms: percentile(query, .5), query_p95_ms: percentile(query, .95),
    over_core_default_1500ms: query.filter(ms=>ms>1500).length,
    skipped: (r.probes||[]).flatMap(p=>(p.context?.skipped||[]).map(s=>({ id: p.id, ...s }))) });
}
const budget = JSON.parse(fs.readFileSync(path.join(dir, 'budget.json')));
const savedCoverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json')));
const coverage = { ...savedCoverage, completed_scores: rows.length,
  complete: rows.length === savedCoverage.expected_scores };
const report = { coverage, scores: groups, matched_scores: matchedScores, calls, retrievals, budget,
  limitations: ['Smoke subset; no population accuracy claim', 'Direct TinyMemory lifecycle, not desktop/core wiring',
    'Aggregate quiet enrichment polls do not certify complete per-turn enrichment; native scores are snapshots',
    'Reference engine is a deterministic control, not an independent memory product',
    'memory-background costs include ingestion and recall; asynchronous work prevents exact phase attribution',
    'Core deadline comparison is diagnostic; the core timeout hook was not executed',
    'LoCoMo scores are official category-specific F1/abstention, not judge accuracy'] };
fs.writeFileSync(path.join(dir, 'audit.json'), JSON.stringify(report, null, 2)+'\n');
let md = '# Memory audit results\n\n';
md += `Scored comparisons: ${coverage.completed_scores}/${coverage.expected_scores}. ${coverage.complete ? 'All four arms cover the selected questions.' : 'Coverage is partial; compare question counts before interpreting means.'}\n\n`;
md += '| Dataset | System | Questions | Metric | Mean |\n|---|---|---:|---|---:|\n';
for (const [key,g] of Object.entries(groups).filter(([k])=>k.endsWith('/ALL'))) {
  const [dataset, system] = key.split('/'); md += `| ${dataset} | ${system} | ${g.n} | ${g.metric} | ${(g.mean*100).toFixed(1)}% |\n`;
}
md += '\nQuestions scored by every arm (setup failures excluded from all arms here):\n\n';
md += '| Dataset | System | Matched questions | Mean |\n|---|---|---:|---:|\n';
for (const [key, g] of Object.entries(matchedScores)) {
  const [dataset, system] = key.split('/');
  md += `| ${dataset} | ${system} | ${g.n} | ${(g.mean*100).toFixed(1)}% |\n`;
}
md += `\nReported upstream cost: $${budget.actual.toFixed(4)}. Budget charged including uncertain/in-flight reservations: $${budget.charged.toFixed(4)} of $${budget.limit}.\n\n`;
md += report.limitations.map(x=>`- ${x}`).join('\n')+'\n';
fs.writeFileSync(path.join(dir, 'audit.md'), md);
console.log(md);
