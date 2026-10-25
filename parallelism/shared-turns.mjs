// shared-turns.mjs: the turn driver for shared-core mode. The adapter has already started ONE
// `openhuman-core` (and the loopback forwarder); this fires every agent's turn at that one core
// at once over JSON-RPC, each with its own `cwd` and its own proxy tag, and writes
// /results/<id>/reply.json + turn.json per agent. Replaces bundles/oh-turn.mjs via OH_TURN_SCRIPT.
//
// Env: OH_PORT OH_TOKEN INFERENCE_BASE (http://127.0.0.1:<fwd>) DUMMY_API_KEY BENCH_MODEL
//      PAR_AGENTS (path to agents.json: [{id,dir,prompt_file,tag}]) PAR_STAGGER_S
import fs from "node:fs";
import http from "node:http";
import { verifyMemoryOff } from "/opt/harness/oh-memory.mjs";

const base = `http://127.0.0.1:${process.env.OH_PORT}`;
const token = process.env.OH_TOKEN;
const agents = JSON.parse(fs.readFileSync(process.env.PAR_AGENTS, "utf8"));
const stagger = Number(process.env.PAR_STAGGER_S || 0) * 1000;

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    if ((await fetch(`${base}/health`)).ok) break;
  } catch {
    // not up yet
  }
  if (Date.now() > deadline) {
    console.error("openhuman-core did not become healthy");
    process.exit(3);
  }
  await new Promise((r) => setTimeout(r, 100));
}

async function rpc(method, params = {}) {
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const reply = await response.json();
  if (reply.error) throw new Error(`${method} failed: ${JSON.stringify(reply.error)}`);
  return reply.result;
}
try {
  const memory = await verifyMemoryOff(rpc);
  fs.writeFileSync("/results/memory-state.json", JSON.stringify(memory, null, 2));
} catch (error) {
  fs.writeFileSync("/results/memory-state.json", JSON.stringify({ verified: false, error: error.message }));
  console.error(`[openhuman] ${error.message}`);
  process.exit(3);
}

// node:http, not fetch: undici's 5 min headers timeout would cut a long turn off.
const post = (body) =>
  new Promise((resolve, reject) => {
    const req = http.request(
      `${base}/rpc`,
      { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) } },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(body);
  });

await Promise.all(
  agents.map(async (a, k) => {
    await new Promise((r) => setTimeout(r, k * stagger));
    const t0 = Date.now();
    let text = "";
    let error = null;
    try {
      text = await post(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "openhuman.inference_agent_chat",
          params: {
            message: fs.readFileSync(a.prompt_file, "utf8"),
            cwd: a.dir,
            inference_url: `${process.env.INFERENCE_BASE}${a.tag}/v1`,
            api_key: process.env.DUMMY_API_KEY,
            model_override: process.env.BENCH_MODEL,
          },
        }),
      );
    } catch (e) {
      error = e.message;
    }
    let rpcError = null;
    try {
      rpcError = JSON.parse(text).error ?? null;
    } catch {
      rpcError ??= text ? "unparseable reply" : "no reply";
    }
    fs.mkdirSync(`/results/${a.id}`, { recursive: true });
    fs.writeFileSync(`/results/${a.id}/reply.json`, text);
    fs.writeFileSync(`/results/${a.id}/turn.json`, JSON.stringify({ started_epoch_ms: t0, ended_epoch_ms: Date.now(), error: error ?? rpcError }));
  }),
);
process.exit(0);
