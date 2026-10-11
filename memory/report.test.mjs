import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('report counts persisted answers when a resumed run has stale coverage metadata', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  fs.mkdirSync(path.join(here, 'target'), { recursive: true });
  const dir = fs.mkdtempSync(path.join(here, 'target/report-test-'));
  try {
    fs.writeFileSync(path.join(dir, 'answers.jsonl'), [0, 1].map(score => JSON.stringify({
      dataset: 'longmemeval', id: `q${score}`, system: 'test-control',
      category: 'temporal', answer: 'test', score, metric: 'official-judge-prompt',
    })).join('\n')+'\n');
    fs.writeFileSync(path.join(dir, 'meter.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify({ expected_scores: 2, completed_scores: 0, complete: false }));
    fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ limit: 10, actual: 0, charged: 0 }));
    execFileSync(process.execPath, [path.join(here, 'report.mjs'), dir]);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'));
    assert.equal(report.coverage.completed_scores, 2);
    assert.equal(report.coverage.complete, true);
    assert.equal(report.scores['longmemeval/test-control/ALL'].mean, .5);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('matched comparisons exclude questions missing from an arm instead of changing the denominator', () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(here, 'target/report-test-'));
  try {
    const rows = [];
    for (const system of ['no-memory', 'full-context', 'reference-memory', 'oh-tinymemory-cortex-direct']) {
      for (const id of system === 'oh-tinymemory-cortex-direct' ? ['q0'] : ['q0', 'q1']) {
        rows.push({ dataset: 'longmemeval', system, id, category: 'temporal', answer: 'test',
          score: system === 'oh-tinymemory-cortex-direct' || id === 'q1' ? 1 : 0, metric: 'official-judge-prompt' });
      }
    }
    fs.writeFileSync(path.join(dir, 'answers.jsonl'), rows.map(JSON.stringify).join('\n')+'\n');
    fs.writeFileSync(path.join(dir, 'meter.jsonl'), '');
    fs.writeFileSync(path.join(dir, 'coverage.json'), JSON.stringify({ expected_scores: 8 }));
    fs.writeFileSync(path.join(dir, 'budget.json'), JSON.stringify({ limit: 10, actual: 0, charged: 0 }));
    execFileSync(process.execPath, [path.join(here, 'report.mjs'), dir]);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'audit.json'), 'utf8'));
    assert.equal(report.matched_scores['longmemeval/full-context'].n, 1);
    assert.equal(report.matched_scores['longmemeval/full-context'].mean, 0);
    assert.equal(report.matched_scores['longmemeval/oh-tinymemory-cortex-direct'].mean, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
