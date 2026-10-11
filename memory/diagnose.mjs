#!/usr/bin/env node
// Summarize server evidence without copying full prompts into the report.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dir = path.resolve(process.argv[2] || 'results/memory27-glm53flash');
const rows = [];
for (const file of fs.readdirSync(dir).filter(f => f.endsWith('-cortex-server.log'))) {
  const raw = fs.readFileSync(path.join(dir, file), 'utf8');
  const indexed = [...raw.matchAll(/bulk_remember: phase1\+2 complete total_chunks=(\d+) memories=(\d+)/g)];
  const phasesComplete = [...raw.matchAll(/bulk_remember: all phases complete/g)].length;
  const salvage = [...raw.matchAll(/batched knowledge extraction missing event indexes;.*?requested=(\d+) returned=(\d+) missing=(\d+)/g)];
  rows.push({ file, sha256: createHash('sha256').update(raw).digest('hex'),
    indexing_batches: indexed.map(m => ({ chunks: Number(m[1]), memories: Number(m[2]) })),
    indexed_memories_including_probe: indexed.reduce((sum, m) => sum + Number(m[2]), 0),
    indexing_batches_completed: phasesComplete,
    extraction_salvage_batches: salvage.length,
    extraction_missing_indexes: salvage.reduce((sum, m) => sum + Number(m[3]), 0),
    note: 'Server indexing counts include probe writes; enrichment counters alone do not certify all turns indexed.' });
}
fs.writeFileSync(path.join(dir, 'server-diagnostics.json'), JSON.stringify(rows, null, 2)+'\n');
console.log(JSON.stringify(rows, null, 2));
