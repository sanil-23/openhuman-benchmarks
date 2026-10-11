import importlib.util
import json
import pathlib
import sys
import tempfile
import threading
import unittest
from unittest import mock

SCRIPT = pathlib.Path(__file__).with_name('security-latency.py')
spec = importlib.util.spec_from_file_location('security_latency', SCRIPT)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class RunnerEvidenceTests(unittest.TestCase):
    def _controlled_run(self, final_busy=False, stale_build_script=False, mutate_corpus=False):
        # Fixture source and fake executable keep this observer test offline.
        base = SCRIPT.parents[1] / 'target/security-runner-test-fixtures'
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            root = pathlib.Path(directory)
            for relative in ('profile/Cargo.toml', 'profile/Cargo.lock', 'profile/build.rs',
                             'profile/scripts/security-latency.py',
                             'profile/src/bin/security_latency/main.rs',
                             'profile/src/bin/security_latency/harness.rs',
                             'profile/src/bin/security_latency/workload.rs'):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text('fixture source\n')
            binary = root / 'fake-executable'
            binary.write_text('fixture artifact')
            output = root / 'evidence'
            original_build_script = (root / 'profile/build.rs').read_text()
            if stale_build_script:
                (root / 'profile/build.rs').write_text('changed build script after binary compilation\n')
            caller_corpus = root / 'caller-corpus.json'
            caller_corpus.write_text(json.dumps({'existing_file': 'first/read.txt'}))
            workloads = []
            defaults = {'existing_file': 'existing.txt', 'new_file': 'new/deep/file.txt', 'outside_file': 'outside.txt'}
            active = False
            invocations = 0
            pin = '1' * 40
            rustc = 'rustc 1.99.0\nLLVM version: 24.0.0'

            def command(*args, **kwargs):
                if args[0] == 'rustc':
                    return rustc
                if args[1:3] == ('status', '--porcelain'):
                    return ''
                if args[1:3] == ('submodule', 'status'):
                    return ' ' + pin + ' vendor/openhuman'
                if args[1:3] == ('diff', 'HEAD'):
                    return ''
                return pin

            def fake_run(args, **kwargs):
                nonlocal active, invocations
                if args[0] == 'cargo':
                    kwargs['stdout'].write('{}')
                    return
                if '--describe-corpus' in args:
                    corpus = defaults | json.loads(pathlib.Path(args[args.index('--describe-corpus') + 1]).read_text())
                    kwargs['stdout'].write(json.dumps(corpus))
                    return
                invocations += 1
                corpus = defaults.copy()
                if '--corpus' in args:
                    corpus.update(json.loads(pathlib.Path(args[args.index('--corpus') + 1]).read_text()))
                workloads.append(corpus)
                if mutate_corpus and invocations == 1:
                    caller_corpus.write_text(json.dumps({'existing_file': 'changed/read.txt'}))
                run_output = pathlib.Path(args[args.index('--output') + 1])
                run_output.mkdir()
                compiled = {}
                for name in ('main.rs', 'harness.rs', 'workload.rs', 'Cargo.toml', 'Cargo.lock', 'build.rs'):
                    path = root / 'profile' / name if name.startswith('Cargo.') or name == 'build.rs' else root / 'profile/src/bin/security_latency' / name
                    compiled[name] = original_build_script if name == 'build.rs' else path.read_text()
                (run_output / 'run.json').write_text(json.dumps({
                    'release': True, 'built_host_pin': pin, 'built_features': '',
                    'built_rustc': rustc.replace('\n', ' | ') + ' | ', 'compiled_sources': compiled, 'corpus': corpus,
                }))
                (run_output / 'summary.jsonl').write_text('\n'.join(json.dumps({'samples': 10000, 'warmup': 1000}) for _ in range(7)))
                if final_busy and invocations == 10:
                    active = True

            def observer():
                return [{'pid': 42, 'command': 'rustc'}] if active else []

            with mock.patch.object(runner, 'ROOT', root), \
                 mock.patch.object(runner, '__file__', str(root / 'profile/scripts/security-latency.py')), \
                 mock.patch.object(runner, 'command', command), \
                 mock.patch.object(runner.platform, 'platform', return_value='test kernel'), \
                 mock.patch.object(runner, 'competing_builds', observer), \
                 mock.patch.object(runner.subprocess, 'run', fake_run), \
                 mock.patch.object(sys, 'argv', [str(SCRIPT), '--binary', str(binary), '--output', str(output)] + (['--corpus', str(caller_corpus)] if mutate_corpus else [])):
                if mutate_corpus:
                    runner.main()
                    reason = None
                else:
                    with self.assertRaises(SystemExit) as raised:
                        runner.main()
                    reason = str(raised.exception)
            receipt = json.loads((output / 'provenance.json').read_text())
            if mutate_corpus:
                self.assertTrue(receipt.get('complete', False))
            else:
                self.assertFalse(receipt.get('complete', False), 'rejected run cannot be marked complete')
            return invocations, reason, workloads

    def test_compiler_starting_at_final_repetition_prevents_complete_receipt(self):
        invocations, reason, _ = self._controlled_run(final_busy=True)
        self.assertEqual(invocations, 10)
        self.assertIn('compiler overlap', reason)

    def test_stale_binary_is_rejected_after_only_build_script_source_changes(self):
        invocations, reason, _ = self._controlled_run(stale_build_script=True)
        self.assertEqual(invocations, 1)
        self.assertIn('different source: build.rs', reason)

    def test_caller_corpus_mutation_cannot_change_the_frozen_workload_between_repetitions(self):
        invocations, reason, workloads = self._controlled_run(mutate_corpus=True)
        self.assertIsNone(reason)
        self.assertEqual(invocations, 10)
        self.assertEqual(len(workloads), 10)
        self.assertTrue(all(corpus['existing_file'] == 'first/read.txt' for corpus in workloads), 'repetitions observed mutable caller input instead of one frozen corpus')

    def test_transient_compiler_overlap_remains_denied_after_process_disappears(self):
        base = SCRIPT.parents[1] / 'target/security-runner-test-fixtures'
        base.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=base) as directory:
            pulse = threading.Event()
            observed = threading.Event()
            saw_busy = False

            def observer():
                nonlocal saw_busy
                # A subsequent poll begins only after the preceding poll has
                # recorded its overlap. Signal that completion, not observation.
                if saw_busy:
                    observed.set()
                if pulse.is_set():
                    saw_busy = True
                    return [{'pid': 42, 'command': 'rustc'}]
                return []

            receipt = pathlib.Path(directory) / 'observer.json'
            with mock.patch.object(runner, 'competing_builds', observer):
                with self.assertRaises(SystemExit):
                    with runner.QuietMonitor(receipt) as monitor:
                        pulse.set()
                        self.assertTrue(observed.wait(5), 'observer did not see controlled compiler pulse')
                        pulse.clear()
                        monitor.check()
            evidence = json.loads(receipt.read_text())
            self.assertTrue(evidence['observed_overlap'])
            self.assertIsNone(evidence['observer_error'])


if __name__ == '__main__':
    unittest.main()
