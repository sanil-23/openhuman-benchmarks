#!/usr/bin/env python3
"""Exercise the unchanged official harness against a localhost fake reader.

This checks prompt privacy, answer parsing, scoring and metric aggregation.
Its synthetic scores are assertions, never benchmark results.
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from PIL import Image

ROOT = pathlib.Path(__file__).resolve().parent.parent
CODE = ROOT / '.cache/longmemeval-v2'


def main():
    requests = []

    class Reader(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            if self.path != '/v1/chat/completions':
                self.send_error(404)
                return
            body = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            requests.append(body)
            response = json.dumps({
                'id': 'synthetic-local-response', 'object': 'chat.completion',
                'created': 0, 'model': 'local-fixture',
                'choices': [{'index': 0, 'finish_reason': 'stop',
                             'message': {'role': 'assistant', 'content': r'\boxed{alpha}'}}],
                'usage': {'prompt_tokens': 10, 'completion_tokens': 5, 'total_tokens': 15},
            }).encode()
            self.send_response(200)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(response)))
            self.end_headers()
            self.wfile.write(response)

    server = ThreadingHTTPServer(('127.0.0.1', 0), Reader)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        with tempfile.TemporaryDirectory(prefix='lme-v2-smoke-', dir=ROOT / '.cache') as folder:
            folder = pathlib.Path(folder)
            questions = [
                {'id': f'private-id-{index}', 'domain': 'web',
                 'question_type': 'static-environment', 'question': f'Name the landmark {index}.',
                 'answer': answer, 'eval_function': 'norm_phrase_set_match',
                 'metadata': {'hidden': 'private-evaluator-metadata'}}
                for index, answer in enumerate(('alpha', 'beta'))
            ]
            image = folder / 'question.png'
            Image.new('RGB', (2, 2), color='white').save(image)
            questions[1]['question'] = {'text': questions[1]['question'], 'image': str(image)}
            files = {'questions': questions, 'haystack': {q['id']: ['trajectory'] for q in questions},
                     'trajectories': [{'id': 'trajectory', 'domain': 'web', 'goal': 'Inspect the page',
                                       'outcome': 'success', 'start_url': 'https://example.test', 'states': []}]}
            for name, value in files.items():
                (folder / f'{name}.json').write_text(json.dumps(value))
            env = {key: value for key, value in os.environ.items()
                   if 'API_KEY' not in key and 'TOKEN' not in key}
            subprocess.run([
                sys.executable, str(CODE / 'evaluation/harness.py'), '--domain', 'web',
                '--questions-path', str(folder / 'questions.json'),
                '--haystack-path', str(folder / 'haystack.json'),
                '--trajectories-path', str(folder / 'trajectories.json'),
                '--memory-config-path', str(CODE / 'evaluation/memory_configs/no_retrieval.json'),
                '--output-dir', str(folder / 'output'), '--model', 'local-fixture',
                '--base-url', f'http://127.0.0.1:{server.server_port}/v1',
                '--evaluator-base-url', f'http://127.0.0.1:{server.server_port}/v1',
                '--max-completion-tokens', '64', '--reader-max-concurrent-requests', '1',
                '--timeout-seconds', '10',
            ], check=True, env=env, timeout=60)
            records = [json.loads(line) for line in (folder / 'output/per_question.jsonl').read_text().splitlines()]
            assert [r['score'] for r in records] == [1.0, 0.0], records
            metrics = json.loads((folder / 'output/aggregated_metrics.json').read_text())
            assert metrics['overall']['overall_full_set'] == 0.5, metrics
            assert len(requests) == 2, requests
            for request in requests:
                messages = json.dumps(request['messages'])
                assert 'alpha' not in messages
                assert 'beta' not in messages
                assert 'private-id-' not in messages
                assert 'private-evaluator-metadata' not in messages
            assert any('data:image/png;base64,' in json.dumps(r['messages']) for r in requests)
            print(json.dumps({'status': 'passed', 'synthetic_questions': 2,
                              'image_questions': 1, 'paid_requests': 0, 'benchmark_results': False}))
    finally:
        server.shutdown()
        server.server_close()
        thread.join()


if __name__ == '__main__':
    main()
