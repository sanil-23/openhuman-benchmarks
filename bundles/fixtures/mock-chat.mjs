import http from 'node:http';
import fs from 'node:fs';
http.createServer(async (req, res) => {
  let text = '';
  for await (const chunk of req) text += chunk;
  const body = JSON.parse(text || '{}');
  fs.appendFileSync('/results/mock-calls.jsonl', JSON.stringify({ path: req.url, model: body.model }) + '\n');
  const common = { id: 'memory-26-mock', model: body.model, created: 1 };
  if (body.stream) {
    res.setHeader('content-type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: 'READY' }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ ...common, object: 'chat.completion.chunk', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end('data: [DONE]\n\n');
  } else {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ...common, object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: 'READY' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
  }
}).listen(18081, '127.0.0.1');
