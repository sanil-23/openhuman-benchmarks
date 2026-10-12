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


ROWS = {
    'allowed_read_command': ('allow', 2),
    'write_requires_approval': ('require_approval', 2),
    'credential_command_floor': ('deny', 1),
    'allowed_existing_file': ('allow', 1),
    'new_file_parent': ('allow', 1),
    'outside_root': ('deny', 1),
    'symlink_escape': ('deny', 1),
}


def write_measurements(output, enabled, samples=10000, warmup=1000):
    """Write independent deterministic raw and nearest-rank summary fixtures."""
    with (output / 'samples.jsonl').open('w') as raw, (output / 'summary.jsonl').open('w') as summary:
        for row, (decision, calls) in ROWS.items():
            if not enabled and row in {'write_requires_approval', 'outside_root', 'symlink_escape'}:
                decision = 'allow'
            for index in range(samples):
                raw.write(json.dumps({'row': row, 'sample': index, 'elapsed_ns': index + 1,
                                      'decision': decision, 'host_public_calls': calls}) + '\n')
            summary.write(json.dumps({'row': row, 'samples': samples, 'warmup': warmup,
                                      'p50_ns': (50 * samples + 99) // 100,
                                      'p99_ns': (99 * samples + 99) // 100,
                                      'host_public_calls': calls * samples}) + '\n')


class RunnerEvidenceTests(unittest.TestCase):
    def _controlled_run(self, final_busy=False, stale_build_script=False, mutate_corpus=False, corrupt_raw=None, mutate_previous_raw=False):
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
                write_measurements(run_output, args[args.index('--enabled') + 1] == 'true')
                if corrupt_raw:
                    raw_path = run_output / 'samples.jsonl'
                    if corrupt_raw == 'missing':
                        raw_path.unlink()
                    else:
                        lines = raw_path.read_text().splitlines(keepends=True)
                        if corrupt_raw == 'duplicate':
                            lines[1] = lines[0]
                        elif corrupt_raw == 'index':
                            record = json.loads(lines[0])
                            record['sample'] = 10000
                            lines[0] = json.dumps(record) + '\n'
                        elif corrupt_raw == 'truncated':
                            lines.pop()
                        raw_path.write_text(''.join(lines))
                if mutate_previous_raw and invocations == 10:
                    (output / 'repetition-1-enabled-true/samples.jsonl').unlink()
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

    def test_incomplete_raw_evidence_prevents_accepting_first_repetition(self):
        for corruption in ('missing', 'duplicate', 'index', 'truncated'):
            with self.subTest(corruption=corruption):
                invocations, reason, _ = self._controlled_run(corrupt_raw=corruption)
                self.assertEqual(invocations, 1)
                self.assertEqual(reason, 'invalid measurement evidence; run incomplete')

    def test_later_child_cannot_remove_previously_accepted_raw_evidence(self):
        invocations, reason, _ = self._controlled_run(mutate_previous_raw=True)
        self.assertEqual(invocations, 10)
        self.assertEqual(reason, 'invalid measurement evidence; run incomplete')

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


class MeasurementValidationTests(unittest.TestCase):
    """Pin raw integrity independently of producer code and large timing runs."""

    def setUp(self):
        base = SCRIPT.parents[1] / 'target/security-runner-test-fixtures'
        base.mkdir(parents=True, exist_ok=True)
        self.directory = tempfile.TemporaryDirectory(dir=base)
        self.addCleanup(self.directory.cleanup)
        self.output = pathlib.Path(self.directory.name)

    def fixture(self, enabled=True):
        write_measurements(self.output, enabled, samples=5, warmup=2)

    def validate(self, enabled=True):
        runner.validate_measurements(self.output, enabled, samples=5, warmup=2)

    def reject(self):
        with self.assertRaises(SystemExit) as raised:
            self.validate()
        self.assertEqual(str(raised.exception), 'invalid measurement evidence; run incomplete')

    def records(self, name):
        return [json.loads(line) for line in (self.output / name).read_text().splitlines()]

    def rewrite(self, name, records):
        (self.output / name).write_text(''.join(json.dumps(record) + '\n' for record in records))

    def test_both_policy_modes_accept_exact_rows_indices_and_nearest_rank(self):
        for enabled in (True, False):
            with self.subTest(enabled=enabled):
                self.fixture(enabled)
                # Producer ordering is irrelevant to complete sample coverage.
                records = self.records('samples.jsonl')
                self.rewrite('samples.jsonl', records[::-1])
                self.validate(enabled)

    def test_raw_cardinality_and_row_set_must_be_exact(self):
        for corruption in ('missing_file', 'missing_row', 'duplicate_index', 'unknown_row',
                           'extra_record', 'missing_record', 'non_object', 'unknown_field', 'missing_field'):
            with self.subTest(corruption=corruption):
                self.fixture()
                records = self.records('samples.jsonl')
                if corruption == 'missing_file':
                    (self.output / 'samples.jsonl').unlink()
                else:
                    if corruption == 'missing_row':
                        records = records[5:]
                    elif corruption == 'duplicate_index':
                        records[1] = records[0]
                    elif corruption == 'unknown_row':
                        records[0]['row'] = 'unexpected'
                    elif corruption == 'extra_record':
                        records.append(records[0])
                    elif corruption == 'missing_record':
                        records.pop()
                    elif corruption == 'non_object':
                        records[0] = []
                    elif corruption == 'unknown_field':
                        records[0]['extra'] = 1
                    else:
                        del records[0]['decision']
                    self.rewrite('samples.jsonl', records)
                self.reject()

    def test_raw_values_must_match_unsigned_indices_timings_and_actual_branches(self):
        cases = [('sample', value) for value in (-1, 5, True, 1.0, '0', None)]
        cases += [('elapsed_ns', value) for value in (-1, 2**64, True, 1.5, float('nan'), float('inf'), None)]
        cases += [('host_public_calls', value) for value in (0, 1, 3, True, 2.0)]
        cases += [('decision', value) for value in ('deny', 'unknown', None, [])]
        cases += [('row', value) for value in (None, [], {})]
        for key, value in cases:
            with self.subTest(key=key, value=value):
                self.fixture()
                records = self.records('samples.jsonl')
                records[0][key] = value
                self.rewrite('samples.jsonl', records)
                self.reject()
        # Credential floor has one early-return entry; disabled write still has two.
        for enabled, row, decision, calls in ((True, 'credential_command_floor', 'deny', 2),
                                              (False, 'write_requires_approval', 'allow', 1),
                                              (False, 'outside_root', 'deny', 1)):
            with self.subTest(enabled=enabled, row=row):
                self.fixture(enabled)
                records = self.records('samples.jsonl')
                record = next(record for record in records if record['row'] == row)
                record.update(decision=decision, host_public_calls=calls)
                self.rewrite('samples.jsonl', records)
                with self.assertRaises(SystemExit):
                    self.validate(enabled)

    def test_summary_rows_counts_totals_and_percentiles_must_match_raw(self):
        for corruption in ('missing_file', 'duplicate_row', 'unknown_row', 'missing_row', 'extra_row',
                           'unknown_field', 'missing_field', 'samples', 'warmup', 'host_public_calls',
                           'p50_ns', 'p99_ns', 'boolean', 'float', 'non_object'):
            with self.subTest(corruption=corruption):
                self.fixture()
                records = self.records('summary.jsonl')
                if corruption == 'missing_file':
                    (self.output / 'summary.jsonl').unlink()
                else:
                    if corruption == 'duplicate_row':
                        records[1] = records[0]
                    elif corruption == 'unknown_row':
                        records[0]['row'] = 'unexpected'
                    elif corruption == 'missing_row':
                        records.pop()
                    elif corruption == 'extra_row':
                        records.append(records[0])
                    elif corruption == 'unknown_field':
                        records[0]['extra'] = 1
                    elif corruption == 'missing_field':
                        del records[0]['p50_ns']
                    elif corruption == 'boolean':
                        records[0]['p50_ns'] = True
                    elif corruption == 'float':
                        records[0]['p50_ns'] = 3.0
                    elif corruption == 'non_object':
                        records[0] = []
                    else:
                        records[0][corruption] += 1
                    self.rewrite('summary.jsonl', records)
                self.reject()

    def test_malformed_duplicate_fields_and_oversized_input_have_content_free_errors(self):
        for name in ('samples.jsonl', 'summary.jsonl'):
            for data in (b'{"secret":', b'\xff', b'\n', b' ' * 1025,
                         b'[' * 500 + b']' * 500, b'{"secret":1,"secret":2}\n'):
                with self.subTest(name=name, data_length=len(data)):
                    self.fixture()
                    (self.output / name).write_bytes(data)
                    self.reject()

    def test_duplicate_valid_json_fields_are_rejected_in_both_files(self):
        for name, field in (('samples.jsonl', 'elapsed_ns'), ('summary.jsonl', 'p50_ns')):
            with self.subTest(name=name):
                self.fixture()
                path = self.output / name
                lines = path.read_text().splitlines(keepends=True)
                value = json.loads(lines[0])[field]
                lines[0] = lines[0].rstrip()[:-1] + f', "{field}": {value}' + '}\n'
                path.write_text(''.join(lines))
                self.reject()

    def test_nearest_rank_accepts_zero_ties_and_unsigned_maximum(self):
        self.fixture()
        records = self.records('samples.jsonl')
        durations = [2**64 - 1, 0, 9, 9, 1]
        for record in records:
            record['elapsed_ns'] = durations[record['sample']]
        self.rewrite('samples.jsonl', records)
        summaries = self.records('summary.jsonl')
        for record in summaries:
            record.update(p50_ns=9, p99_ns=2**64 - 1)
        self.rewrite('summary.jsonl', summaries)
        self.validate()

    def test_line_and_record_limits_bound_reads(self):
        # A hostile endless stream must be cut off before unbounded parsing.
        class EndlessFile:
            def __enter__(self):
                return self

            def __exit__(self, *args):
                pass

            def readline(self, size):
                self.assert_size(size)
                return b'{}\n'

            def read(self, size):
                self.assert_size(size)
                return b'x'

            def assert_size(self, size):
                if size not in (1, 1025):
                    raise AssertionError('unbounded read')

        with mock.patch.object(pathlib.Path, 'open', return_value=EndlessFile()):
            with self.assertRaises(ValueError):
                list(runner.measurement_records(self.output / 'samples.jsonl', 3))

    def test_invalid_test_count_parameters_cannot_allocate_unbounded_samples(self):
        for samples, warmup in ((0, 2), (10001, 2), (True, 2), (5, 0), (5, 1001)):
            with self.subTest(samples=samples, warmup=warmup):
                with self.assertRaises(SystemExit):
                    runner.validate_measurements(self.output, True, samples, warmup)


if __name__ == '__main__':
    unittest.main()
