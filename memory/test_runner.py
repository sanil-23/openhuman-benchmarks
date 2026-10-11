import json
import pathlib
import subprocess
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parent

class RunnerTests(unittest.TestCase):
    def test_previous_probe_questions_are_removed_before_the_next_probe(self):
        sentinel = 'quartzcanaryneverstored'
        task = {"id": "test-isolated-probes", "sessions": [{"date": "2023-01-01", "turns": [
            {"role": "user", "text": "My colour is violet."}]}],
            "questions": [{"id": "first", "question": f"What is {sentinel}?"},
                          {"id": "second", "question": f"Do you remember {sentinel}?"}]}
        with tempfile.TemporaryDirectory(dir=ROOT/'target') as directory:
            file = pathlib.Path(directory)/'task.json'
            file.write_text(json.dumps(task))
            result = subprocess.run([str(ROOT/'target/debug/memory-bench'), 'reference', str(file)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        for probe in json.loads(result.stdout)['probes']:
            self.assertNotIn(sentinel, probe['pack'])

    def test_sessions_larger_than_engine_batch_limit_are_ingested(self):
        task = {"id": "test-large-session", "sessions": [{"date": "2023-01-01", "turns": [
            {"role": "user", "text": f"My unique code is violet-{i}."} for i in range(101)]}],
            "questions": [{"id": "probe", "question": "What is my unique code?"}]}
        with tempfile.TemporaryDirectory(dir=ROOT/'target') as directory:
            file = pathlib.Path(directory)/'task.json'
            file.write_text(json.dumps(task))
            result = subprocess.run([str(ROOT/'target/debug/memory-bench'), 'reference', str(file)], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)['stored_turns'], 101)

if __name__ == '__main__':
    unittest.main()
