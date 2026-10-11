import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

// Fixed upper prices ($/token); OpenRouter's max_price prevents routing to
// anything more expensive. Token bounds deliberately over-reserve the UTF-8
// body plus 20k protocol tokens, including hidden extraction reasoning.
export const PRICES = {
  'z-ai/glm-5.3-flash': { prompt: 0.30e-6, completion: 1e-6 },
  'openai/text-embedding-3-small': { prompt: 0.04e-6, completion: 0 },
  'openai/gpt-4o-mini-2024-07-18': { prompt: 0.30e-6, completion: 1.20e-6 },
};
export class Budget {
  constructor(file, limit = 10) {
    if (!(limit > 0 && limit <= 10)) throw new Error('budget must be in (0, $10]');
    this.file = file;
    this.state = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file)) : { limit, charged: 0, actual: 0, calls: 0 };
    if (this.state.limit !== limit) throw new Error('cannot change existing budget');
  }
  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(`${this.file}.new`, JSON.stringify(this.state, null, 2));
    fs.renameSync(`${this.file}.new`, this.file);
  }
  reserve(amount) {
    if (this.state.price_bound_breached) throw new Error('upstream price bound violated; stop spending');
    if (!Number.isFinite(amount) || amount < 0 || this.state.charged + amount > this.state.limit) throw new Error('budget exhausted');
    this.state.charged += amount;
    this.state.calls += 1;
    this.save(); // crash/restart keeps in-flight reservations charged
  }
  settle(bound, actual) {
    if (Number.isFinite(actual) && actual > bound) {
      this.state.actual += actual;
      this.state.charged += actual-bound;
      this.state.price_bound_breached = true;
      this.save();
      return;
    }
    if (Number.isFinite(actual) && actual >= 0 && actual <= bound) {
      this.state.charged -= bound - actual;
      this.state.actual += actual;
      this.save();
    } // missing cost and failures keep the entire reservation
  }
}
export function requestBound(body) {
  const price = PRICES[body.model];
  if (!price) throw new Error(`unapproved model: ${body.model}`);
  if (body.tools || body.plugins || body.audio || body.images || body.stream) throw new Error('text-only nonstream requests required');
  if (body.messages?.some(m => typeof m.content !== 'string')) throw new Error('text-only messages required');
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== body.max_tokens) throw new Error('conflicting output bounds');
  const max = body.model.includes('embedding') ? 0 : Number(body.max_tokens);
  if (!Number.isInteger(max) || max < 0 || max > 16384 || (!body.model.includes('embedding') && max === 0)) throw new Error('bounded max_tokens required');
  return (Buffer.byteLength(JSON.stringify(body)) + 20000) * price.prompt + max * price.completion;
}
export async function startGateway({ dir, key, port = 0, upstream = 'https://openrouter.ai/api/v1', fetchImpl = fetch }) {
  const budget = new Budget(path.join(dir, 'budget.json'));
  const server = http.createServer(async (req, res) => {
    if (req.url === '/budget') return res.end(JSON.stringify(budget.state));
    if (req.method !== 'POST' || !/^\/v1\/(chat\/completions|embeddings)$/.test(req.url)) return res.writeHead(404).end();
    let body, bound;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks));
      const p = PRICES[body.model];
      if (!p) throw new Error('unapproved model');
      body.provider = { allow_fallbacks: false, max_price: { prompt: p.prompt * 1e6, completion: p.completion * 1e6 } };
      if (body.model === 'z-ai/glm-5.3-flash') {
        body.provider.only = ['z-ai'];
        body.reasoning = { effort: 'low' };
      }
      body.usage = { include: true };
      bound = requestBound(body);
      budget.reserve(bound);
    } catch (e) { return res.writeHead(402).end(JSON.stringify({ error: e.message })); }
    const started = Date.now();
    try {
      const response = await fetchImpl(`${upstream}${req.url.slice(3)}`, {
        method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(240000),
      });
      const raw = await response.text();
      let output;
      try { output = JSON.parse(raw); } catch { output = { raw }; }
      const actual = output.usage?.cost;
      budget.settle(bound, actual);
      fs.appendFileSync(path.join(dir, 'meter.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        phase: req.headers['x-bench-phase'] ?? 'memory-background', model: body.model,
        route: req.url, status: response.status, wall_ms: Date.now() - started,
        reserved_usd: bound, usage: output.usage ?? null, request: body,
        response: req.url.endsWith('embeddings') ? { model: output.model, vectors: output.data?.length, error: output.error } : output,
      }) + '\n');
      res.writeHead(response.status, { 'content-type': 'application/json' }).end(raw);
    } catch (e) {
      fs.appendFileSync(path.join(dir, 'meter.jsonl'), JSON.stringify({ model: body.model, reserved_usd: bound, error: e.message, phase: req.headers['x-bench-phase'] ?? 'memory-background' }) + '\n');
      res.writeHead(502).end(JSON.stringify({ error: e.message }));
    }
  });
  await new Promise(resolve => server.listen(port, '0.0.0.0', resolve));
  return { server, budget, port: server.address().port };
}
