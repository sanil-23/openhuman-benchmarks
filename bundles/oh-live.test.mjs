import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

// Optional live gate: requires a compiled bundle and the bench-micro image.
// It runs an actual core with no external network and no paid model endpoint.
const bundle = process.env.OH_LIVE_TEST_BUNDLE;
const root = new URL('../', import.meta.url).pathname;
for (const smoke of [true, false]) {
  test(smoke ? 'live memory-off write and recall are refused locally' : 'a dummy credential supports a normal turn without an OS keyring', {
    skip: bundle ? false : 'set OH_LIVE_TEST_BUNDLE to a compiled OpenHuman bundle to run the offline Docker gate',
    timeout: 150_000,
  }, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oh-live-'));
    try {
      const task = path.join(dir, 'task');
      const results = path.join(dir, 'results');
      fs.mkdirSync(task);
      fs.mkdirSync(results);
      fs.writeFileSync(path.join(task, 'prompt.txt'), 'Reply READY and do not touch any files.');
      fs.writeFileSync(path.join(task, 'setup.sh'), 'git init -q\necho seed > seed.txt\n');
      fs.writeFileSync(path.join(task, 'check.sh'), 'test "$(cat seed.txt)" = seed\n');
      const mounts = [
        `${path.resolve(bundle)}:/opt/harness:ro`,
        `${root}runner:/opt/bench/runner:ro`,
        `${root}bundles/adapters/openhuman.sh:/opt/harness/adapter.sh:ro`,
        `${root}bundles/oh-turn.mjs:/opt/harness/oh-turn.mjs:ro`,
        `${root}bundles/oh-memory.mjs:/opt/harness/oh-memory.mjs:ro`,
        `${root}bundles/fixtures/mock-chat.mjs:/opt/bench/mock.mjs:ro`,
        `${task}:/bench/task:ro`, `${results}:/results`,
      ];
      const env = {
        BENCH_HARNESS: 'openhuman', BENCH_TASK_ID: smoke ? 'm6-memory-policy' : 'm1-hello',
        RESULT_DIR: '/results', PROMPT_FILE: '/bench/task/prompt.txt', WORKDIR: '/work',
        TASK_TIMEOUT_S: '120', DUMMY_API_KEY: 'bench-dummy-key',
        BENCH_MODEL: 'deepseek/deepseek-v4.1-flash', PROXY_URL: 'http://127.0.0.1:18081',
        DISABLE_TELEMETRY: '1', DISABLE_AUTOUPDATER: '1',
      };
      const r = spawnSync('docker', [
        'run', '--rm', '--network', 'none', '--cpus', '4', '--memory', '8g',
        ...mounts.flatMap((value) => ['-v', value]),
        ...Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]),
        '--entrypoint', 'bash', 'bench-micro:latest', '-lc',
        '/opt/harness/node/bin/node /opt/bench/mock.mjs & /opt/harness/node/bin/node /opt/bench/runner/entry.mjs',
      ], { encoding: 'utf8', timeout: 140_000 });
      assert.equal(r.status, 0, r.stderr);
      const result = JSON.parse(fs.readFileSync(path.join(results, 'result.json')));
      const log = fs.readFileSync(path.join(results, 'harness.log'), 'utf8');
      assert.equal(result.exit_code, 0, log);
      assert.equal(result.check.passed, true);
      const memory = JSON.parse(fs.readFileSync(path.join(results, 'memory-state.json')));
      assert.equal(memory.verified, true);
      assert.equal(memory.embedder, 'none');
      assert.equal(memory.driver, 'null');
      assert.equal(memory.auto_capture, false);
      assert.equal(memory.auto_recall, false);
      assert.ok(fs.statSync(path.join(results, 'core.log')).size > 0);
      const callsFile = path.join(results, 'mock-calls.jsonl');
      const calls = fs.existsSync(callsFile) ? fs.readFileSync(callsFile, 'utf8').trim().split('\n').map(JSON.parse) : [];
      if (smoke) {
        assert.equal(calls.length, 0);
        assert.deepEqual(memory.off_smoke, { learn: 'MEMORY_OFF', recall: 'MEMORY_OFF' });
      } else {
        assert.ok(calls.length > 0, 'the normal turn must reach the local model');
        assert.ok(calls.some((call) => call.path.endsWith('/chat/completions')), JSON.stringify(calls));
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
