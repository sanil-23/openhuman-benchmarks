import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyMemoryOff } from './oh-memory.mjs';

const values = {
  'openhuman.subsystems_status': { subsystems: [{ slot: 'memory', driver: 'null', fell_back_from: null }] },
  'openhuman.memory_engine_get': { engine: null, status: 'off' },
  'openhuman.memory_policy_get': { log_conversations: false, recall: { enabled: false } },
  'openhuman.embeddings_get_settings': { effective_provider: 'none', model: 'embedding-v1' },
};
const rpc = async (method) => structuredClone(values[method]);

test('memory off is verified from runtime RPCs, including wrapped embedding settings', async () => {
  const result = await verifyMemoryOff(async (method) => ({ result: { data: await rpc(method) } }));
  assert.deepEqual(result, {
    mode: 'off', driver: 'null', engine: null, embedder: 'none', embedding_model: 'embedding-v1',
    auto_recall: false, auto_capture: false, verified: true,
  });
});

for (const [method, value] of [
  ['openhuman.subsystems_status', { subsystems: [] }],
  ['openhuman.subsystems_status', { subsystems: [{ slot: 'memory', driver: 'null', fell_back_from: 'tinyhumans' }] }],
  ['openhuman.memory_engine_get', { engine: 'tinyhumans', status: 'off' }],
  ['openhuman.memory_engine_get', { engine: null, status: 'ok' }],
  ['openhuman.memory_policy_get', { log_conversations: true, recall: { enabled: false } }],
  ['openhuman.memory_policy_get', { log_conversations: false, recall: { enabled: true } }],
  ['openhuman.memory_policy_get', {}],
  ['openhuman.embeddings_get_settings', { effective_provider: 'unconfigured' }],
]) {
  test(`setup rejects unexpected memory state: ${method} ${JSON.stringify(value)}`, async () => {
    await assert.rejects(verifyMemoryOff(async (name) => name === method ? value : rpc(name)), /memory off verification failed/);
  });
}

test('unsupported or failed runtime RPCs cannot silently pass verification', async () => {
  await assert.rejects(verifyMemoryOff(async () => { throw new Error('method not found'); }), /method not found/);
});
