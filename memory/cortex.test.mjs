import { test } from 'node:test';
import assert from 'node:assert/strict';
import { containerEnv } from './cortex.mjs';

test('an experiment overrides defaults, and null removes a variable', () => {
  const defaults = { CORTEX_ENRICHMENT_MODEL: 'glm', CORTEX_ENRICHMENT_URL: 'http://gateway', CORTEX_EMBED: 'small' };
  assert.deepEqual(containerEnv(defaults, { CORTEX_EMBED: 'large', CORTEX_ENRICHMENT_MODEL: null, CORTEX_ENRICHMENT_URL: null }),
    { CORTEX_EMBED: 'large' });
  assert.deepEqual(containerEnv(defaults), defaults);
});
