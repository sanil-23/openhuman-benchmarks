// A fresh CortexDB for one task: its own container and storage on an internal
// Docker network, reached through a loopback relay. Same image, environment
// and readiness check as the library arm in run.mjs, so both arms run on the
// same engine configuration.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CORTEX_IMAGE = 'cortexdb/cortexdb@sha256:636e0ed0b8cd4ae2f307e3a90f99050f7879f73c556b1ccbbabf2d3a383398fc'; // v0.10.4
export const CORTEX_API_KEY = 'memory-bench-local';

/** The CortexDB environment; every model call goes through the gateway at `inference`. */
export function cortexEnv(inference, model) {
  return { CORTEX_API_KEY, CORTEX_DEPLOYMENT_PRESET: 'dev_local', CORTEX_EMBEDDING_URL: inference,
    CORTEX_EMBEDDING_API_KEY: 'dummy', CORTEX_EMBEDDING_MODEL: 'openai/text-embedding-3-small', CORTEX_EMBEDDING_DIMS: '1536',
    OPENAI_API_KEY: 'dummy', CORTEX_LLM_URL: inference, CORTEX_ENTITY_API_KEY: 'dummy', CORTEX_LLM_MODEL: model,
    CORTEX_ENRICHMENT_URL: inference, CORTEX_ENRICHMENT_API_KEY: 'dummy', CORTEX_ENRICHMENT_MODEL: model,
    CORTEX_ENRICHMENT_DELAY_SECONDS: '0', CORTEX_ANSWER_PROVIDER: 'openai', CORTEX_ANSWER_URL: inference,
    CORTEX_ANSWER_API_KEY: 'dummy', CORTEX_ANSWER_MODEL: model, CORTEX_VERIFIER_URL: inference,
    CORTEX_VERIFIER_API_KEY: 'dummy', CORTEX_VERIFIER_MODEL: model, CORTEX_VERIFIER_MAX_TOKENS: '16384',
    CORTEX_ENTITY_GRAPH: '1', CORTEX_V1_LAYERS_AUTO: '1', CORTEX_AUTO_ROUTE: '1', CORTEX_CONSOLIDATION_MIN_AGE_HOURS: '0' };
}

/**
 * Start CortexDB for one task. Returns `{ base, stop }`: `base` is the loopback
 * relay URL, and `stop(logFile)` saves the server log and removes the
 * container, its network and the relay.
 */
export async function startCortex({ name, gatewayPort, model, configFile, out }) {
  const network = `${name}-net`, container = `${name}-cortex`;
  await exec('docker', ['network', 'create', '--internal', network]);
  let relay;
  const stop = async (logFile) => {
    try {
      if (logFile) fs.writeFileSync(logFile, (await exec('docker', ['logs', container], { maxBuffer: 50e6 }).catch(() => ({ stdout: '' }))).stdout);
      await exec('docker', ['rm', '-f', container]).catch(() => {});
    } finally {
      await exec('docker', ['network', 'rm', network]).catch(() => {});
      if (relay) await new Promise(r => relay.close(r));
    }
  };
  try {
    const info = JSON.parse((await exec('docker', ['network', 'inspect', network])).stdout)[0];
    const inference = `http://${info.IPAM.Config[0].Gateway}:${gatewayPort}/v1`;
    const env = cortexEnv(inference, model);
    await exec('docker', ['run', '-d', '--name', container, '--network', network,
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      '-v', `${configFile}:/data/cortex.toml:ro`, CORTEX_IMAGE, '3141', '/data']);
    fs.writeFileSync(path.join(out, `${name}-cortex-config.json`), JSON.stringify({ env, image_ref: CORTEX_IMAGE,
      image: JSON.parse((await exec('docker', ['image', 'inspect', CORTEX_IMAGE])).stdout)[0].Id }, null, 2) + '\n');
    const running = JSON.parse((await exec('docker', ['inspect', container])).stdout)[0];
    const ip = running.NetworkSettings.Networks[network].IPAddress;
    // Internal networks publish no host ports. The loopback relay also meets
    // the core's HTTPS-or-loopback rule for a credentialed engine endpoint.
    relay = http.createServer((req, res) => {
      const forwarded = http.request({ hostname: ip, port: 3141, method: req.method, path: req.url, headers: req.headers }, upstream => {
        res.writeHead(upstream.statusCode, upstream.headers); upstream.pipe(res);
      });
      forwarded.on('error', e => res.writeHead(502).end(e.message));
      req.pipe(forwarded);
    });
    await new Promise(r => relay.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${relay.address().port}`;
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/v1/admin/ready`)).ok) return { base, stop }; } catch {}
      await sleep(1000);
    }
    throw new Error('CortexDB readiness failed');
  } catch (e) {
    await stop();
    throw e;
  }
}
