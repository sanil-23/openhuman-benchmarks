// memory/.env (git-ignored): settings that route GLM 5.3 Flash to another
// OpenAI-compatible provider. Values are read here and handed to the gateway;
// none of them, the key above all, is ever logged.
import fs from 'node:fs';

/** `KEY=VALUE` lines; blank lines and `#` comments are skipped. A missing file is empty. */
export function loadEnv(file) {
  if (!fs.existsSync(file)) return {};
  const env = {};
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith('#')) continue;
    env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return env;
}

const GLM = 'z-ai/glm-5.3-flash';
export const DEEPSEEK = 'deepseek/deepseek-v4.1-flash';

/**
 * Gateway routes from the Surplus AI settings: `{ 'z-ai/glm-5.3-flash': route }`,
 * or `{}` when the base URL and key are not both set (GLM then stays on
 * OpenRouter). A partly filled file is an error rather than a silent fallback.
 * The optional SURPLUS_DEEPSEEK_* block adds DeepSeek V4.1 Flash on the same
 * endpoint and key, for use as a reader.
 */
export function glmRoutes(env) {
  const base = env.SURPLUS_BASE_URL, key = env.SURPLUS_API_KEY;
  if (!base && !key) return {};
  const missing = ['SURPLUS_BASE_URL', 'SURPLUS_API_KEY', 'SURPLUS_GLM_MODEL', 'SURPLUS_PRICE_INPUT_PER_M',
    'SURPLUS_PRICE_OUTPUT_PER_M', 'SURPLUS_PRICE_CACHED_INPUT_PER_M'].filter(k => !env[k]);
  if (missing.length) throw new Error(`memory/.env: set ${missing.join(', ')}`);
  if (!/^https:\/\/[^\s/]+(\/\S*)?$/.test(base)) throw new Error('memory/.env: SURPLUS_BASE_URL must be an https URL');
  const price = name => {
    const value = Number(env[name]);
    if (!(Number.isFinite(value) && value >= 0)) throw new Error(`memory/.env: ${name} must be a non-negative number`);
    return value / 1e6;
  };
  const route = prefix => ({
    name: 'surplus',
    upstream: base.replace(/\/+$/, ''),
    key,
    model: env[`${prefix}MODEL`],
    reasoningEffort: env[`${prefix}REASONING_EFFORT`] || null,
    prices: { prompt: price(`${prefix}PRICE_INPUT_PER_M`), completion: price(`${prefix}PRICE_OUTPUT_PER_M`),
      cached: price(`${prefix}PRICE_CACHED_INPUT_PER_M`) },
  });
  // The GLM block predates the DeepSeek one and keeps its unprefixed names.
  const glm = route('SURPLUS_');
  glm.model = env.SURPLUS_GLM_MODEL;
  const routes = { [GLM]: glm };
  if (env.SURPLUS_DEEPSEEK_MODEL) {
    const absent = ['PRICE_INPUT_PER_M', 'PRICE_OUTPUT_PER_M', 'PRICE_CACHED_INPUT_PER_M']
      .map(k => `SURPLUS_DEEPSEEK_${k}`).filter(k => !env[k]);
    if (absent.length) throw new Error(`memory/.env: set ${absent.join(', ')}`);
    routes[DEEPSEEK] = route('SURPLUS_DEEPSEEK_');
  }
  return routes;
}

/** What run-meta records about a route: everything but the key. */
export function describeRoutes(routes) {
  return Object.fromEntries(Object.entries(routes).map(([model, r]) => [model,
    { provider: r.name, upstream_host: new URL(r.upstream).host, upstream_model: r.model,
      reasoning_effort: r.reasoningEffort, usd_per_million: { input: r.prices.prompt * 1e6,
        output: r.prices.completion * 1e6, cached_input: r.prices.cached * 1e6 } }]));
}
