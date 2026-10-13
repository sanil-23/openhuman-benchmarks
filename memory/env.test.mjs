import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeRoutes, glmRoutes, loadEnv } from './env.mjs';

const full = { SURPLUS_BASE_URL: 'https://api.surplus.example/v1/', SURPLUS_API_KEY: 'sk-test', SURPLUS_GLM_MODEL: 'glm-5.3-flash',
  SURPLUS_PRICE_INPUT_PER_M: '0.1', SURPLUS_PRICE_OUTPUT_PER_M: '0.4', SURPLUS_PRICE_CACHED_INPUT_PER_M: '0.02', SURPLUS_REASONING_EFFORT: 'low' };

test('the env file is parsed without comments, quotes or blank values leaking', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-env-'));
  try {
    const file = path.join(dir, '.env');
    fs.writeFileSync(file, '# comment\nSURPLUS_BASE_URL="https://a.example/v1"\n\nSURPLUS_API_KEY=\n  # SURPLUS_GLM_MODEL=x\n');
    assert.deepEqual(loadEnv(file), { SURPLUS_BASE_URL: 'https://a.example/v1', SURPLUS_API_KEY: '' });
    assert.deepEqual(loadEnv(path.join(dir, 'missing')), {});
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('an empty template keeps GLM on OpenRouter; a partial one is refused', () => {
  assert.deepEqual(glmRoutes({}), {});
  assert.deepEqual(glmRoutes({ SURPLUS_BASE_URL: '', SURPLUS_API_KEY: '' }), {});
  assert.throws(() => glmRoutes({ ...full, SURPLUS_GLM_MODEL: '' }), /SURPLUS_GLM_MODEL/);
  assert.throws(() => glmRoutes({ ...full, SURPLUS_BASE_URL: 'http://plain.example/v1' }), /https/);
  assert.throws(() => glmRoutes({ ...full, SURPLUS_PRICE_OUTPUT_PER_M: 'cheap' }), /non-negative/);
});

test('a full file routes GLM with per-token prices, and the record leaves out the key', () => {
  const route = glmRoutes(full)['z-ai/glm-5.3-flash'];
  assert.equal(route.upstream, 'https://api.surplus.example/v1');
  assert.equal(route.model, 'glm-5.3-flash');
  for (const [k, v] of Object.entries({ prompt: 0.1e-6, completion: 0.4e-6, cached: 0.02e-6 })) {
    assert.ok(Math.abs(route.prices[k] - v) < 1e-18, `${k} per token`);
  }
  const described = JSON.stringify(describeRoutes(glmRoutes(full)));
  assert.equal(described.includes('sk-test'), false);
  assert.match(described, /api\.surplus\.example/);
});
