import http from 'node:http';
import fs from 'node:fs';
let step = 0;
const thinkingChain = process.env.MOCK_THINKING_TOOL_CHAIN === '1';
const reasoning = thinkingChain ? 'Use the shell to check the workspace.' : 'x'.repeat(120_000);
http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  if (req.method !== 'POST' || !req.url.endsWith('/chat/completions')) {
    res.writeHead(200).end('ok');
    return;
  }
  const body = JSON.parse(text || '{}');
  step++;
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  const prior = body.messages?.find(m => m.tool_calls?.some(t => t.id === 'call-ping'));
  const reasoningReplayed = prior?.reasoning_content === reasoning;
  fs.appendFileSync('/results/mock-calls.jsonl', JSON.stringify({ path: req.url, step, effort, reasoning_replayed: reasoningReplayed }) + '\n');
  if (effort !== 'high' || (step >= 2 && !reasoningReplayed)) {
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'The reasoning_content in thinking mode must be passed back to the API.' } }));
    return;
  }
  const tool = { tool_calls: [{ index: 0, id: 'call-ping', type: 'function', function: { name: 'shell', arguments: '{"command":"true"}' } }] };
  const delta = step === 1 ? tool : { content: 'READY' };
  const finish = step === 1 ? 'tool_calls' : 'stop';
  const common = { id: `recovery-${step}`, model: body.model, created: 1, object: 'chat.completion.chunk' };
  res.setHeader('content-type', 'text/event-stream');
  if (step === 1) res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: { reasoning }, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ ...common, choices: [{ index: 0, delta: {}, finish_reason: finish }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}).listen(18081, '127.0.0.1');
