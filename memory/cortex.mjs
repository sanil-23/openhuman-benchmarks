// A fresh CortexDB for one task: its own container and storage. Both memory
// arms start it here, so they run on the same engine configuration.
//
// Two network modes:
// - `internal` (the default on Linux, and what benchmark results require): an
//   internal Docker network, so CortexDB reaches nothing but the budget
//   gateway; the harness reaches it through a loopback relay.
// - `published` (the default on macOS, a development mode): Docker Desktop
//   cannot route between the Mac and an internal network, so CortexDB sits on
//   an ordinary network with its port published on 127.0.0.1 and reaches the
//   gateway at host.docker.internal. It is not isolated; results from it are
//   smoke tests, and run metadata records the mode.
// MEMORY_CORTEX_NETWORK=internal|published overrides the default.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sleep = ms => new Promise(r => setTimeout(r, ms));
export const CORTEX_IMAGE = 'cortexdb/cortexdb@sha256:636e0ed0b8cd4ae2f307e3a90f99050f7879f73c556b1ccbbabf2d3a383398fc'; // v0.10.4
export const CORTEX_API_KEY = 'memory-bench-local';

/**
 * The CortexDB environment; every model call goes through the gateway at
 * `inference`. `model` builds the store (extraction, graph, query rewriting);
 * `answerModel` writes CortexDB's own answers and checks them, so it is the
 * reader on the recall path and can change without re-indexing.
 */
export function cortexEnv(inference, model, answerModel = model) {
  return { CORTEX_API_KEY, CORTEX_DEPLOYMENT_PRESET: 'dev_local', CORTEX_EMBEDDING_URL: inference,
    CORTEX_EMBEDDING_API_KEY: 'dummy', CORTEX_EMBEDDING_MODEL: 'openai/text-embedding-3-small', CORTEX_EMBEDDING_DIMS: '1536',
    OPENAI_API_KEY: 'dummy', CORTEX_LLM_URL: inference, CORTEX_ENTITY_API_KEY: 'dummy', CORTEX_LLM_MODEL: model,
    CORTEX_ENRICHMENT_URL: inference, CORTEX_ENRICHMENT_API_KEY: 'dummy', CORTEX_ENRICHMENT_MODEL: model,
    CORTEX_ENRICHMENT_DELAY_SECONDS: '0', CORTEX_ANSWER_PROVIDER: 'openai', CORTEX_ANSWER_URL: inference,
    CORTEX_ANSWER_API_KEY: 'dummy', CORTEX_ANSWER_MODEL: answerModel, CORTEX_VERIFIER_URL: inference,
    CORTEX_VERIFIER_API_KEY: 'dummy', CORTEX_VERIFIER_MODEL: answerModel, CORTEX_VERIFIER_MAX_TOKENS: '16384',
    CORTEX_ENTITY_GRAPH: '1', CORTEX_V1_LAYERS_AUTO: '1', CORTEX_AUTO_ROUTE: '1', CORTEX_CONSOLIDATION_MIN_AGE_HOURS: '0' };
}

/** The network mode for this host (see the top of this file). */
export function cortexNetworkMode() {
  const mode = process.env.MEMORY_CORTEX_NETWORK || (process.platform === 'darwin' ? 'published' : 'internal');
  if (mode !== 'internal' && mode !== 'published') throw new Error('MEMORY_CORTEX_NETWORK must be internal or published');
  return mode;
}

/**
 * Start CortexDB for one task. Returns `{ base, stop }`: `base` is the loopback
 * relay URL, and `stop(logFile)` saves the server log, stops the server
 * cleanly and removes the container, its network and the relay.
 *
 * With `dataDir`, the data directory (/data: the store and cortex.toml) lives in that host
 * folder and outlives the container, so it can be snapshotted after a stop
 * and served again by a later container.
 */
/**
 * The container's environment: `defaults` with `extra` laid over them, where
 * a `null` in `extra` removes that variable (how `--no-enrichment` leaves
 * CortexDB without its enrichment model).
 */
export function containerEnv(defaults, extra = {}) {
  return Object.fromEntries(Object.entries({ ...defaults, ...extra }).filter(([, value]) => value !== null));
}

export async function startCortex({ name, gatewayPort, model, answerModel = model, configFile, out, dataDir,
  extraEnv = {}, mode = cortexNetworkMode() }) {
  const network = `${name}-net`, container = `${name}-cortex`;
  // A run stopped part-way leaves its container and network behind, and the
  // next start under the same name would fail on them. The names are this
  // run's and this task's own, so a leftover is removed first.
  await exec('docker', ['rm', '-f', container]).catch(() => {});
  await exec('docker', ['network', 'rm', network]).catch(() => {});
  await exec('docker', ['network', 'create', ...(mode === 'internal' ? ['--internal'] : []), network]);
  let relay;
  const stop = async (logFile) => {
    try {
      // Stop before reading the log or removing: a clean shutdown flushes the
      // store, which a later container may open again.
      await exec('docker', ['stop', '-t', '60', container]).catch(() => {});
      if (logFile) fs.writeFileSync(logFile, (await exec('docker', ['logs', container], { maxBuffer: 50e6 }).catch(() => ({ stdout: '' }))).stdout);
      await exec('docker', ['rm', '-f', container]).catch(() => {});
    } finally {
      await exec('docker', ['network', 'rm', network]).catch(() => {});
      if (relay) await new Promise(r => relay.close(r));
    }
  };
  try {
    let inference;
    if (mode === 'internal') {
      const info = JSON.parse((await exec('docker', ['network', 'inspect', network])).stdout)[0];
      inference = `http://${info.IPAM.Config[0].Gateway}:${gatewayPort}/v1`;
    } else {
      inference = `http://host.docker.internal:${gatewayPort}/v1`;
    }
    // `extraEnv` overrides the defaults for one experiment (integration.mjs
    // --cortex-env, --no-enrichment); a `null` value removes that variable.
    const env = containerEnv(cortexEnv(inference, model, answerModel), extraEnv);
    if (dataDir) {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.copyFileSync(configFile, path.join(dataDir, 'cortex.toml'));
    }
    await exec('docker', ['run', '-d', '--name', container, '--network', network,
      ...(mode === 'published' ? ['-p', '127.0.0.1::3141'] : []),
      // Docker Desktop resolves host.docker.internal to the Mac itself; mapping
      // it to host-gateway there points into Docker's VM instead. Only Linux
      // needs the mapping.
      ...(mode === 'published' && process.platform !== 'darwin' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
      ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
      // CortexDB keeps everything under its data directory (/data); with a
      // host folder the config is copied in beside the store.
      ...(dataDir ? ['-v', `${path.resolve(dataDir)}:/data`] : ['-v', `${configFile}:/data/cortex.toml:ro`]),
      CORTEX_IMAGE, '3141', '/data']);
    fs.writeFileSync(path.join(out, `${name}-cortex-config.json`), JSON.stringify({ network_mode: mode, data_dir: dataDir ? path.resolve(dataDir) : null, env, image_ref: CORTEX_IMAGE,
      image: JSON.parse((await exec('docker', ['image', 'inspect', CORTEX_IMAGE])).stdout)[0].Id }, null, 2) + '\n');
    let base;
    if (mode === 'internal') {
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
      base = `http://127.0.0.1:${relay.address().port}`;
    } else {
      const published = (await exec('docker', ['port', container, '3141/tcp'])).stdout.trim().split('\n')[0];
      base = `http://127.0.0.1:${published.split(':').pop()}`;
    }
    for (let i = 0; i < 120; i++) {
      try { if ((await fetch(`${base}/v1/admin/ready`, { signal: AbortSignal.timeout(5000) })).ok) return { base, stop, mode }; } catch {}
      await sleep(1000);
    }
    throw new Error('CortexDB readiness failed');
  } catch (e) {
    await stop();
    throw e;
  }
}
