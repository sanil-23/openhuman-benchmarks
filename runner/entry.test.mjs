import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('a failed task setup cannot retain verified memory evidence from an earlier attempt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'entry-memory-'));
  try {
    const stateFile = path.join(dir, 'memory-state.json');
    fs.writeFileSync(stateFile, JSON.stringify({ verified: true, mode: 'off' }));
    const setup = path.join(dir, 'setup.sh');
    fs.writeFileSync(setup, 'exit 1\n');
    const r = spawnSync(process.execPath, [new URL('./entry.mjs', import.meta.url).pathname], {
      cwd: dir,
      env: { ...process.env, BENCH_HARNESS: 'openhuman', BENCH_TASK_ID: 'test',
        WORKDIR: dir, RESULT_DIR: dir, SETUP_SCRIPT: setup, BENCH_CAPTURE_PATCH: '0' },
      encoding: 'utf8',
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /setup failed/);
    assert.equal(fs.existsSync(stateFile), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
