#!/usr/bin/env node
// Keep full public transcripts on the bench host, matching the repository's
// existing capture policy. Commit metering, wire pins and SHA-addressed links.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
const dir = path.resolve(process.argv[2] || 'results/memory27-glm53flash');
const file = path.join(dir, 'meter.jsonl');
const rows = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const captures = path.join(dir, 'captures/memory');
fs.mkdirSync(captures, { recursive: true });
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const output = rows.map((row, index) => {
  if (!row.request && !row.response) return row;
  const name = `${String(index+1).padStart(6,'0')}.json`;
  fs.writeFileSync(path.join(captures, name), JSON.stringify(row)+'\n');
  const { request, response, ...record } = row;
  const content = response?.choices?.[0]?.message?.content;
  return { ...record, capture_file: `captures/memory/${name}`,
    request_sha256: request ? digest(request) : null,
    response_sha256: response ? digest(response) : null,
    wire: request ? { max_tokens: request.max_tokens, model: request.model,
      reasoning: request.reasoning, provider: request.provider, response_format: request.response_format,
      dimensions: request.dimensions } : null,
    response_summary: response ? { model: response.model, finish_reason: response.choices?.[0]?.finish_reason,
      content_chars: typeof content === 'string' ? content.length : null,
      empty_chat_content: response.choices ? !content : null,
      vectors: response.vectors, error: response.error } : null };
});
fs.writeFileSync(`${file}.new`, output.map(x=>JSON.stringify(x)).join('\n')+'\n');
fs.renameSync(`${file}.new`, file);
console.log(`${rows.length} calls; full captures at ${captures}`);
