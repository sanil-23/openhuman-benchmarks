import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('archiving preserves metering and verifiable captures across repeated runs', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  fs.mkdirSync(path.join(here, 'target'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(here, 'target/archive-test-'));
  try {
    const row = { model: 'test', usage: { cost: .001 }, reserved_usd: .02,
      request: { model: 'test', messages: [{ role: 'user', content: 'private transcript' }], max_tokens: 10 },
      response: { choices: [{ message: { content: 'answer' }, finish_reason: 'stop' }] } };
    fs.writeFileSync(path.join(dir, 'meter.jsonl'), JSON.stringify(row)+'\n');
    const archive = () => execFileSync(process.execPath, [path.join(here, 'archive-captures.mjs'), dir]);
    archive();
    const first = fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8');
    const saved = JSON.parse(first);
    assert.deepEqual(saved.usage, row.usage);
    assert.equal(saved.reserved_usd, row.reserved_usd);
    assert.equal(saved.request, undefined);
    assert.equal(saved.response, undefined);
    assert.equal(first.includes('private transcript'), false);
    const captured = JSON.parse(fs.readFileSync(path.join(dir, saved.capture_file), 'utf8'));
    assert.deepEqual(captured, row);
    assert.equal(saved.request_sha256, createHash('sha256').update(JSON.stringify(captured.request)).digest('hex'));
    assert.equal(saved.response_sha256, createHash('sha256').update(JSON.stringify(captured.response)).digest('hex'));
    archive();
    assert.equal(fs.readFileSync(path.join(dir, 'meter.jsonl'), 'utf8'), first);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, saved.capture_file), 'utf8')), row);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
