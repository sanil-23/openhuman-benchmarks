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
  // `maxLimit` is the authorised ceiling. It stays $10 unless a caller passes
  // the cap recorded on the issue for its phase.
  constructor(file, limit = 10, maxLimit = 10) {
    if (!(limit > 0 && limit <= maxLimit)) throw new Error(`budget must be in (0, $${maxLimit}]`);
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
// OpenHuman agent turns (the integration arm) send tool schemas, stream, and
// carry assistant rows whose content is null beside their tool calls. Those are
// allowed only when the caller opts in; images stay refused either way.
// `price` replaces the model's OpenRouter ceiling when a route serves it
// elsewhere at its own prices; the model must still be on the allowlist.
export function requestBound(body, { allowTools = false, allowStream = false, price = PRICES[body.model] } = {}) {
  if (!PRICES[body.model] || !price) throw new Error(`unapproved model: ${body.model}`);
  if (body.plugins || body.audio || body.images) throw new Error('text-only requests required');
  if ((body.tools && !allowTools) || (body.stream && !allowStream)) throw new Error('text-only nonstream requests required');
  const textOnly = m => typeof m.content === 'string' || (allowTools && m.content == null && m.role === 'assistant');
  if (body.messages?.some(m => !textOnly(m))) throw new Error('text-only messages required');
  if (body.max_completion_tokens !== undefined && body.max_completion_tokens !== body.max_tokens) throw new Error('conflicting output bounds');
  const max = body.model.includes('embedding') ? 0 : Number(body.max_tokens);
  if (!Number.isInteger(max) || max < 0 || max > 16384 || (!body.model.includes('embedding') && max === 0)) throw new Error('bounded max_tokens required');
  return (Buffer.byteLength(JSON.stringify(body)) + 20000) * price.prompt + max * price.completion;
}
/**
 * What a call to a routed provider cost: the charge it reports when it does,
 * else its token counts at the route's prices (per token). `undefined`
 * without usage, which keeps the reservation.
 */
export function routeCost(usage, prices) {
  // Surplus Intelligence reports what it charged, in microdollars; a
  // marketplace price can move away from the configured one, so that wins.
  if (Number.isFinite(usage?.buyer_cost_micro)) return usage.buyer_cost_micro / 1e6;
  if (!usage || !Number.isFinite(usage.prompt_tokens) || !Number.isFinite(usage.completion_tokens)) return undefined;
  const cached = Math.min(usage.prompt_tokens_details?.cached_tokens ?? 0, usage.prompt_tokens);
  return (usage.prompt_tokens - cached) * prices.prompt + cached * prices.cached + usage.completion_tokens * prices.completion;
}
/** The usage block of the last SSE event that carries one. */
export function streamUsage(raw) {
  let usage = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') continue;
    try { usage = JSON.parse(data).usage ?? usage; } catch { /* a partial line is not usage */ }
  }
  return usage;
}
export async function startGateway({ dir, key, port = 0, upstream = 'https://openrouter.ai/api/v1', fetchImpl = fetch,
  limit = 10, maxLimit = 10, glmProvider = 'z-ai', allowTools = false, allowStream = false, routes = {} }) {
  const budget = new Budget(path.join(dir, 'budget.json'), limit, maxLimit);
  const server = http.createServer(async (req, res) => {
    if (req.url === '/budget') return res.end(JSON.stringify(budget.state));
    if (req.method !== 'POST' || !/^\/v1\/(chat\/completions|embeddings)$/.test(req.url)) return res.writeHead(404).end();
    let body, bound, route, wire;
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      body = JSON.parse(Buffer.concat(chunks));
      const p = PRICES[body.model];
      if (!p) throw new Error('unapproved model');
      route = routes[body.model];
      if (route) {
        // Another OpenAI-compatible provider serves this model (memory/.env):
        // its own model id, no OpenRouter routing fields, usage on streams.
        bound = requestBound(body, { allowTools, allowStream, price: route.prices });
        wire = { ...body, model: route.model };
        delete wire.provider; delete wire.usage; delete wire.reasoning;
        if (route.reasoningEffort) wire.reasoning_effort = route.reasoningEffort;
        if (wire.stream) wire.stream_options = { include_usage: true };
      } else {
        body.provider = { allow_fallbacks: false, max_price: { prompt: p.prompt * 1e6, completion: p.completion * 1e6 } };
        if (body.model === 'z-ai/glm-5.3-flash') {
          body.provider.only = [glmProvider];
          body.reasoning = { effort: 'low' };
        }
        body.usage = { include: true };
        bound = requestBound(body, { allowTools, allowStream });
        wire = body;
      }
      budget.reserve(bound);
    } catch (e) { return res.writeHead(402).end(JSON.stringify({ error: e.message })); }
    const started = Date.now();
    try {
      const response = await fetchImpl(`${route ? route.upstream : upstream}${req.url.slice(3)}`, {
        method: 'POST', headers: { authorization: `Bearer ${route ? route.key : key}`, 'content-type': 'application/json' },
        body: JSON.stringify(wire), signal: AbortSignal.timeout(240000),
      });
      if (body.stream) {
        // Pass the stream through as it arrives, so the client's first-event
        // timeout sees the provider's pace, and settle from its final usage.
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'text/event-stream' });
        const decoder = new TextDecoder();
        let raw = '';
        for await (const chunk of response.body) { raw += decoder.decode(chunk, { stream: true }); res.write(chunk); }
        res.end();
        const usage = streamUsage(raw);
        budget.settle(bound, route ? routeCost(usage, route.prices) : usage?.cost);
        fs.appendFileSync(path.join(dir, 'meter.jsonl'), JSON.stringify({ at: new Date().toISOString(),
          phase: req.headers['x-bench-phase'] ?? 'memory-background', model: body.model,
          route: req.url, provider: route?.name ?? 'openrouter', status: response.status, wall_ms: Date.now() - started, stream: true,
          reserved_usd: bound, usage, request: wire, response_chars: raw.length,
        }) + '\n');
        return;
      }
      const raw = await response.text();
      let output;
      try { output = JSON.parse(raw); } catch { output = { raw }; }
      const actual = route ? routeCost(output.usage, route.prices) : output.usage?.cost;
      budget.settle(bound, actual);
      fs.appendFileSync(path.join(dir, 'meter.jsonl'), JSON.stringify({ at: new Date().toISOString(),
        phase: req.headers['x-bench-phase'] ?? 'memory-background', model: body.model,
        route: req.url, provider: route?.name ?? 'openrouter', status: response.status, wall_ms: Date.now() - started,
        reserved_usd: bound, actual_usd: actual ?? null, usage: output.usage ?? null, request: wire,
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
