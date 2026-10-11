// Runtime evidence for the benchmark's explicit memory-off policy.
function unwrap(value) {
  while (value && typeof value === 'object' && ('result' in value || 'data' in value)) {
    value = value.result ?? value.data;
  }
  return value;
}

/** Read the running core's binding, lifecycle policy and effective embedder. */
export async function verifyMemoryOff(rpc) {
  const slots = unwrap(await rpc('openhuman.subsystems_status'));
  const engine = unwrap(await rpc('openhuman.memory_engine_get'));
  const policy = unwrap(await rpc('openhuman.memory_policy_get'));
  const embeddings = unwrap(await rpc('openhuman.embeddings_get_settings'));
  const memory = slots?.subsystems?.find((row) => row.slot === 'memory');
  const state = {
    mode: 'off',
    driver: memory?.driver ?? null,
    engine: engine?.engine ?? null,
    embedder: embeddings?.effective_provider ?? null,
    embedding_model: embeddings?.model ?? null,
    auto_recall: policy?.recall?.enabled ?? null,
    auto_capture: policy?.log_conversations ?? null,
    verified: false,
  };
  if (memory?.driver !== 'null' || memory.fell_back_from != null ||
      engine?.engine !== null || engine?.status !== 'off' ||
      state.embedder !== 'none' || state.auto_recall !== false || state.auto_capture !== false) {
    const error = new Error('memory off verification failed');
    error.state = state;
    throw error;
  }
  return { ...state, verified: true };
}
