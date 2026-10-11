#!/usr/bin/env node
// Diagnostic repro: exits 1 when own-agent turns appear in the section whose
// documented contract is "other agents' turns". No provider calls are made.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
const here = path.dirname(fileURLToPath(import.meta.url));
const directory = fs.mkdtempSync(path.join(here, 'target/team-repro-'));
try {
  const task = { id: 'own-team-repro', sessions: [{ date: '2023-01-01', turns: Array.from({length: 12}, (_,i)=>({role:'user',text:`My canary memory fact number ${i} is violet.`})) }],
    questions: [{id:'probe', question:'What are my canary memory facts?'}] };
  const file = path.join(directory, 'task.json'); fs.writeFileSync(file, JSON.stringify(task));
  const r = JSON.parse(execFileSync(path.join(here, 'target/debug/memory-bench'), ['reference', file], {stdio:['ignore','pipe','pipe']}).toString());
  const probe = r.probes[0];
  const team = probe.context.sections.find(s=>s.heading==='Team conversations');
  const own = team?.hits.filter(h=>h.meta.agent_id==='benchmark') || [];
  const evidence = { contract:'Team conversations contains other agents\' turns', agents_ingested:['benchmark'],
    own_turns_in_team:own.length, pack:probe.pack, team_hits:team?.hits };
  if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify(evidence,null,2)+'\n');
  console.log(JSON.stringify(evidence,null,2));
  process.exitCode = own.length ? 1 : 0;
} finally { fs.rmSync(directory,{recursive:true}); }
