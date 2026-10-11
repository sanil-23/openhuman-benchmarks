import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { writeMicroSuite } from './micro.mjs';

test('the OpenHuman policy smoke grades runtime evidence and rejects a failed setup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-memory-'));
  try {
    const tasks = writeMicroSuite(dir);
    const smoke = tasks.find((t) => t.id === 'm6-memory-policy');
    assert.deepEqual(smoke.harnesses, ['openhuman']);
    const checkFile = path.join(smoke.dir, 'check.sh');
    // Task images have no Node on PATH; the check uses the bundle's interpreter.
    const script = fs.readFileSync(checkFile, 'utf8');
    assert.match(script, /\/opt\/harness\/node\/bin\/node/);
    fs.writeFileSync(checkFile, script.replace('/opt/harness/node/bin/node', process.execPath));
    const file = path.join(dir, 'memory-state.json');
    const check = () => spawnSync('bash', [path.join(smoke.dir, 'check.sh')], {
      env: { ...process.env, BENCH_HARNESS: 'openhuman', RESULT_DIR: dir },
    }).status;
    assert.notEqual(check(), 0);
    const state = { verified: true, driver: 'null', embedder: 'none', auto_recall: false, auto_capture: false, off_smoke: { learn: "MEMORY_OFF", recall: "MEMORY_OFF" } };
    fs.writeFileSync(file, JSON.stringify(state));
    assert.equal(check(), 0);
    fs.writeFileSync(file, JSON.stringify({ ...state, verified: false }));
    assert.notEqual(check(), 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
