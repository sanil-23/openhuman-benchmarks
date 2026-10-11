import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root = new URL('../', import.meta.url);
test('Harbor conversion retains core logs and runtime memory evidence, including reconversion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harbor-memory-'));
  try {
    fs.mkdirSync(path.join(dir, 'tbench'), { recursive: true });
    for (const file of ['tbench/run.mjs', 'quiet-host.mjs', 'run-meta.mjs']) {
      fs.copyFileSync(new URL(file, root), path.join(dir, file));
    }
    const bundle = path.join(dir, '.cache/harness/openhuman');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'adapter.sh'), '');
    const trial = path.join(dir, '.cache/harbor-jobs/test/openhuman-tb2/example__123');
    const bench = path.join(trial, 'agent/bench');
    fs.mkdirSync(bench, { recursive: true });
    fs.writeFileSync(path.join(trial, 'result.json'), JSON.stringify({ task_name: 'example', started_at: '2026-10-11T00:00:00Z', finished_at: '2026-10-11T00:01:00Z', agent_info: { version: 'abc123' } }));
    fs.writeFileSync(path.join(bench, 'core.log'), 'memory off\n');
    fs.writeFileSync(path.join(bench, 'harness.log'), 'setup\n');
    const state = { verified: true, driver: 'null', embedder: 'none', auto_recall: false, auto_capture: false };
    fs.writeFileSync(path.join(bench, 'memory-state.json'), JSON.stringify(state));
    const convert = () => {
      const r = spawnSync(process.execPath, [path.join(dir, 'tbench/run.mjs'), '--bench', '2', '--run-id', 'test', '--convert-only'], { encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(fs.readFileSync(path.join(dir, 'results/test/runs.jsonl'), 'utf8').trim());
    };
    assert.deepEqual(convert().memory, state);
    assert.equal(fs.readFileSync(path.join(dir, 'results/test/openhuman/example/core.log'), 'utf8'), 'memory off\n');
    fs.rmSync(path.join(bench, 'memory-state.json'));
    assert.deepEqual(convert().memory, { verified: false, error: 'memory-state.json missing' });
    assert.equal(fs.existsSync(path.join(dir, 'results/test/openhuman/example/memory-state.json')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
