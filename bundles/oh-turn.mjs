// oh-turn.mjs — run one agent turn against a headless `openhuman-core run`
// over JSON-RPC and exit non-zero on a JSON-RPC error. Waits for /health first.
// Env: OH_PORT OH_TOKEN PROMPT_FILE PWD DUMMY_API_KEY BENCH_MODEL INFERENCE_URL TASK_TIMEOUT_S
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { verifyMemoryOff } from "./oh-memory.mjs";

const base = `http://127.0.0.1:${process.env.OH_PORT}`;
const token = process.env.OH_TOKEN;
const memoryFile = path.join(process.env.RESULT_DIR || "/results", "memory-state.json");
fs.writeFileSync(memoryFile, JSON.stringify({ verified: false, error: "core startup pending" }));
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

// Verify before sending any model request; unsupported older bundles fail setup.
async function rpc(method, params = {}) {
  const response = await fetch(`${base}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`memory RPC ${method}: HTTP ${response.status}`);
  const reply = await response.json();
  if (reply.error) {
    const error = new Error(`memory RPC ${method} failed (code ${reply.error.code})`);
    error.rpcCode = reply.error.data?.code;
    throw error;
  }
  if (!("result" in reply)) throw new Error(`memory RPC ${method}: missing result`);
  return reply.result;
}
const smoke = process.env.BENCH_TASK_ID === "m6-memory-policy";
let memory;
try {
  memory = await verifyMemoryOff(rpc);
  // Exercise both write and recall: off must refuse them locally, with a typed
  // MEMORY_OFF error rather than a provider/authentication failure or success.
  if (smoke) {
    memory.off_smoke = {};
    for (const [action, params] of [
      ["learn", { text: "Benchmark smoke fact: lighthouse code 4817" }],
      ["recall", { question: "What is the lighthouse code?" }],
    ]) {
      try {
        await rpc(`openhuman.memory_${action}`, params);
        throw new Error(`memory off smoke unexpectedly allowed ${action}`);
      } catch (error) {
        if (error.rpcCode !== "MEMORY_OFF") throw error;
        memory.off_smoke[action] = error.rpcCode;
      }
    }
  }
  fs.writeFileSync(memoryFile, JSON.stringify(memory, null, 2));
  console.log(`[openhuman] memory state: ${JSON.stringify(memory)}`);
} catch (error) {
  fs.writeFileSync(memoryFile, JSON.stringify({ ...memory, ...error.state, verified: false, error: error.message }, null, 2));
  console.error(`[openhuman] ${error.message}`);
  process.exit(3);
}
if (smoke) process.exit(0);

// node:http, not fetch: fetch's undici enforces a 5 min headers timeout, and a
// long agent turn holds the response open far longer than that.
const body = JSON.stringify({
  jsonrpc: "2.0",
  id: 1,
  method: "openhuman.inference_agent_chat",
  params: {
    message: fs.readFileSync(process.env.PROMPT_FILE, "utf8"),
    cwd: process.env.PWD,
    inference_url: process.env.INFERENCE_URL,
    api_key: process.env.DUMMY_API_KEY,
    model_override: process.env.BENCH_MODEL,
  },
});
const text = await new Promise((resolve, reject) => {
  const req = http.request(
    `${base}/rpc`,
    {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "content-length": Buffer.byteLength(body) },
    },
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
let json;
try {
  json = JSON.parse(text);
} catch {
  console.error(text);
  process.exit(1);
}
// In full: the reason a turn ended is usually at the end of the reply, and harness.log is
// the only place it is kept.
console.log(JSON.stringify(json));
process.exit(json.error ? 1 : 0);
