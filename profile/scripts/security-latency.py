#!/usr/bin/env python3
"""Run five independent, offline legacy repetitions with provenance and raw ns."""
import argparse
import hashlib
import json
import os
import pathlib
import platform
import subprocess
import time
import threading

ROOT = pathlib.Path(__file__).resolve().parents[2]


def command(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def competing_builds():
    if not pathlib.Path('/proc').exists():
        raise SystemExit('quiet-run observer requires Linux /proc; use the isolated Linux CI job')
    found = []
    for entry in pathlib.Path('/proc').iterdir():
        if entry.name.isdigit():
            try:
                name = (entry / 'comm').read_text().strip()
                if name in {'cargo', 'rustc', 'cc1', 'cc1plus', 'ld.lld', 'rust-lld'}:
                    found.append({'pid': int(entry.name), 'command': name})
            except (FileNotFoundError, PermissionError, ProcessLookupError):
                pass
    return found


class QuietMonitor:
    """Remember observed compiler overlap during a repetition, including transients.

    Polling is bounded at 50ms; receipts identify that observation interval rather
    than claiming perfect detection of every short-lived OS process.
    """
    def __init__(self, receipt):
        self.receipt = receipt
        self.stop = threading.Event()
        self.lock = threading.Lock()
        self.overlaps = []
        self.polls = 0
        self.error = None
        self.thread = threading.Thread(target=self._watch, daemon=True)

    def _observe(self):
        try:
            builds = competing_builds()
            with self.lock:
                self.polls += 1
                if builds:
                    self.overlaps.append({'unix_ns': time.time_ns(), 'builds': builds})
        except BaseException as error:
            with self.lock:
                self.error = str(error)

    def _watch(self):
        while not self.stop.wait(0.05):
            self._observe()

    def check(self):
        self._observe()
        with self.lock:
            if self.error or self.overlaps:
                raise SystemExit(f'compiler overlap or observer failure; run incomplete: {self.error or self.overlaps}')

    def __enter__(self):
        self.check()
        self.thread.start()
        return self

    def __exit__(self, *exception):
        self.stop.set()
        self.thread.join()
        self._observe()
        self.receipt.write_text(json.dumps({'poll_interval_ms': 50, 'polls': self.polls, 'observed_overlap': self.overlaps, 'observer_error': self.error}, indent=2) + '\n')
        if not exception[0]:
            self.check()


# Independent acceptance contract for the seven fixed legacy workloads. Counts
# describe the paired untimed observation, never instrumentation inside timing.
EXPECTED_ROWS = {
    'allowed_read_command': ('allow', 'allow', 2),
    'write_requires_approval': ('require_approval', 'allow', 2),
    'credential_command_floor': ('deny', 'deny', 1),
    'allowed_existing_file': ('allow', 'allow', 1),
    'new_file_parent': ('allow', 'allow', 1),
    'outside_root': ('deny', 'allow', 1),
    'symlink_escape': ('deny', 'allow', 1),
}
MEASUREMENT_ERROR = 'invalid measurement evidence; run incomplete'


def unique_fields(pairs):
    """Reject duplicate JSON field names instead of silently keeping the last."""
    fields = {}
    for key, value in pairs:
        if key in fields:
            raise ValueError
        fields[key] = value
    return fields


def measurement_records(path, limit):
    """Read at most the fixed record budget, with a 1 KiB JSON line ceiling."""
    with path.open('rb') as file:
        for _ in range(limit):
            line = file.readline(1025)
            if not line:
                return
            if len(line) > 1024:
                raise ValueError
            yield json.loads(line, object_pairs_hook=unique_fields)
        if file.read(1):
            raise ValueError


def unsigned(value):
    """Require a JSON integer in the producer's unsigned 64-bit value range."""
    return type(value) is int and 0 <= value <= 2**64 - 1


def validate_measurements(output, enabled, samples=10000, warmup=1000):
    """Check bounded raw coverage, outcomes, observation counts and percentiles.

    Smaller counts support deterministic offline tests. The runner always uses
    the production defaults of 10,000 samples and 1,000 warmups per row.
    Errors deliberately contain neither raw records nor caller corpus content.
    """
    try:
        if (type(enabled) is not bool or type(samples) is not int
                or not 1 <= samples <= 10000 or type(warmup) is not int
                or not 1 <= warmup <= 1000):
            raise ValueError
        timings = {row: [None] * samples for row in EXPECTED_ROWS}
        counts = dict.fromkeys(EXPECTED_ROWS, 0)
        for record in measurement_records(output / 'samples.jsonl', len(EXPECTED_ROWS) * samples):
            if type(record) is not dict or set(record) != {'row', 'sample', 'elapsed_ns', 'decision', 'host_public_calls'}:
                raise ValueError
            row = record['row']
            if type(row) is not str or row not in EXPECTED_ROWS:
                raise ValueError
            index = record['sample']
            elapsed = record['elapsed_ns']
            calls = record['host_public_calls']
            expected = EXPECTED_ROWS[row]
            if (not unsigned(index) or index >= samples or timings[row][index] is not None
                    or not unsigned(elapsed) or not unsigned(calls)
                    or record['decision'] != expected[0 if enabled else 1] or calls != expected[2]):
                raise ValueError
            timings[row][index] = elapsed
            counts[row] += calls
        if any(None in values for values in timings.values()):
            raise ValueError
        for values in timings.values():
            values.sort()
        seen = set()
        for record in measurement_records(output / 'summary.jsonl', len(EXPECTED_ROWS)):
            if type(record) is not dict or set(record) != {'row', 'samples', 'warmup', 'p50_ns', 'p99_ns', 'host_public_calls'}:
                raise ValueError
            row = record['row']
            if type(row) is not str or row not in EXPECTED_ROWS or row in seen:
                raise ValueError
            seen.add(row)
            if any(not unsigned(record[key]) for key in record if key != 'row'):
                raise ValueError
            if (record['samples'] != samples or record['warmup'] != warmup
                    or record['host_public_calls'] != counts[row]
                    or record['p50_ns'] != timings[row][(50 * samples + 99) // 100 - 1]
                    or record['p99_ns'] != timings[row][(99 * samples + 99) // 100 - 1]):
                raise ValueError
        if seen != set(EXPECTED_ROWS):
            raise ValueError
    except (OSError, ValueError, TypeError, RecursionError):
        raise SystemExit(MEASUREMENT_ERROR) from None


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--binary', type=pathlib.Path, required=True)
    parser.add_argument('--output', type=pathlib.Path, default=ROOT / '.security-evidence/legacy-release')
    parser.add_argument('--corpus', type=pathlib.Path)
    parser.add_argument('--build-log', type=pathlib.Path, help='verbose release build log for actual compiler argument provenance')
    args = parser.parse_args()
    binary = args.binary.resolve(strict=True)
    output = args.output.resolve()
    if output.exists():
        raise SystemExit('output already exists: preserve earlier baseline, choose a fresh path')
    builds = competing_builds()
    if builds:
        raise SystemExit(f'wait for competing builds to finish before timing: {builds}')
    host = ROOT / 'vendor/openhuman'
    pin = command('git', 'rev-parse', 'HEAD:vendor/openhuman')
    if command('git', 'rev-parse', 'HEAD', cwd=host) != pin:
        raise SystemExit('OpenHuman checkout does not match unchanged recorded pin')
    submodules = command('git', 'submodule', 'status', '--recursive')
    if any(line[0] in '+-U' for line in submodules.splitlines()):
        raise SystemExit('all recorded recursive submodule pins must be initialized and unchanged')
    if command('git', 'status', '--porcelain', '--untracked-files=no', cwd=host):
        raise SystemExit('OpenHuman source must be clean (including nested submodules)')
    output.mkdir(parents=True)
    # Capture once. The mutable caller path is never reopened for a repetition.
    corpus_bytes = args.corpus.read_bytes() if args.corpus else b'{}'
    corpus_snapshot = output / 'corpus-input.json'
    with corpus_snapshot.open('xb') as file:
        file.write(corpus_bytes)
    expected_snapshot = output / 'corpus-expected.json'
    with expected_snapshot.open('x') as file:
        subprocess.run([str(binary), '--describe-corpus', str(corpus_snapshot)], cwd=ROOT, stdout=file, check=True)
    expected_corpus = json.loads(expected_snapshot.read_text())
    corpus_sha256 = digest(corpus_snapshot)
    expected_sha256 = digest(expected_snapshot)
    source_files = list((ROOT / 'profile/src/bin/security_latency').glob('*.rs'))
    source_files += [ROOT / 'profile/Cargo.toml', ROOT / 'profile/Cargo.lock', ROOT / 'profile/build.rs', pathlib.Path(__file__).resolve()]
    compiler_invocation = None
    if args.build_log:
        lines = args.build_log.read_text().splitlines()
        commands = [line for line in lines if 'Running' in line and '--crate-name security_latency_bench' in line and '--crate-type bin' in line]
        if not commands:
            raise SystemExit('build log lacks an actual security-latency-bench binary compiler invocation')
        compiler_invocation = commands[-1]
    metadata = {
        'mode': 'legacy_public_host', 'host_pin': pin,
        'benchmarks_head': command('git', 'rev-parse', 'HEAD'),
        'benchmarks_diff': command('git', 'diff', 'HEAD', '--', 'profile'),
        'submodule_pins': submodules, 'kernel': platform.platform(),
        'cpu': pathlib.Path('/proc/cpuinfo').read_text() if pathlib.Path('/proc/cpuinfo').exists() else platform.processor(),
        'cpu_count': os.cpu_count(),
        'cpu_affinity': sorted(os.sched_getaffinity(0)) if hasattr(os, 'sched_getaffinity') else None,
        'rustc': command('rustc', '+1.99.0', '-Vv'),
        'requested_profile': 'profile/Cargo.toml [profile.release] (compiled manifest source is verified); actual compiler arguments are not inferred from these requested settings',
        'quiescence_observer': 'Linux /proc compiler-process polling every 50ms plus repetition boundaries and final check',
        'features': '--no-default-features', 'native_module_sha256': None,
        'binary_sha256': digest(binary), 'binary': str(binary),
        'supplied_build_log_bin_compiler_invocation': compiler_invocation,
        'supplied_build_log_artifact_binding': 'unverified; the supplied log is not attested to this executable',
        'build_log_sha256': digest(args.build_log) if args.build_log else None,
        'source_sha256': {str(p.relative_to(ROOT)): digest(p) for p in source_files},
        'corpus_snapshot_sha256': corpus_sha256, 'expected_corpus_sha256': expected_sha256,
        'expected_corpus': expected_corpus,
        'caller_corpus_path': str(args.corpus.resolve()) if args.corpus else None,
        'warmup': 1000, 'samples': 10000, 'independent_repetitions_per_policy': 5,
        'start_unix_ns': time.time_ns(), 'load_average_start': os.getloadavg(),
    }
    metadata_path = output / 'provenance.json'
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')
    # Dependency feature resolution supplements the explicit build flags.
    with (output / 'cargo-metadata.json').open('w') as file:
        subprocess.run(['cargo', '+1.99.0', 'metadata', '--offline', '--locked', '--manifest-path', 'profile/Cargo.toml', '--no-default-features', '--format-version', '1'], cwd=ROOT, stdout=file, check=True)
    for repetition in range(1, 6):
        for enabled in ('true', 'false'):
            if competing_builds():
                raise SystemExit('competing build started; run is incomplete, do not label it baseline')
            run_output = output / f'repetition-{repetition}-enabled-{enabled}'
            invocation = [str(binary), '--output', str(run_output), '--enabled', enabled, '--warmup', '1000', '--samples', '10000']
            invocation += ['--corpus', str(corpus_snapshot)]
            start = time.time_ns()
            with QuietMonitor(output / f'repetition-{repetition}-enabled-{enabled}-observer.json') as monitor:
                with (output / f'repetition-{repetition}-enabled-{enabled}.log').open('w') as file:
                    subprocess.run(invocation, cwd=ROOT, stdout=file, stderr=subprocess.STDOUT, check=True)
                monitor.check()
            if digest(corpus_snapshot) != corpus_sha256 or digest(expected_snapshot) != expected_sha256:
                raise SystemExit('reserved corpus snapshot changed; evidence incomplete')
            run = json.loads((run_output / 'run.json').read_text())
            if run['corpus'] != expected_corpus:
                raise SystemExit('parsed workload differs from frozen expected corpus; evidence incomplete')
            if run['built_host_pin'] != pin or run['built_features'] != '':
                raise SystemExit('binary host pin/features differ from baseline configuration')
            if run['built_rustc'].rstrip(' |') != metadata['rustc'].replace('\n', ' | '):
                raise SystemExit('binary compiler differs from recorded Rust 1.99.0')
            for filename, compiled in run['compiled_sources'].items():
                path = ROOT / 'profile' / filename if filename.startswith('Cargo.') or filename == 'build.rs' else ROOT / 'profile/src/bin/security_latency' / filename
                if path.read_text() != compiled:
                    raise SystemExit(f'binary was built from different source: {filename}')
            metadata.setdefault('compiled_build_environment', run.get('build_environment'))
            metadata.setdefault('compiled_benchmarks_head', run.get('built_benchmarks_head'))
            metadata.setdefault('compiled_benchmarks_status', run.get('built_benchmarks_status'))
            if not run['release']:
                raise SystemExit('debug binary cannot produce a release baseline')
            validate_measurements(run_output, enabled == 'true')
            with (output / 'repetitions.jsonl').open('a') as file:
                file.write(json.dumps({'repetition': repetition, 'enabled': enabled, 'start_unix_ns': start, 'end_unix_ns': time.time_ns(), 'load_average': os.getloadavg(), 'command': invocation}) + '\n')
            print(f'repetition {repetition}, enabled={enabled}: seven verified rows', flush=True)
    # Recheck every accepted repetition in case later child invocations changed it.
    for repetition in range(1, 6):
        for enabled in ('true', 'false'):
            validate_measurements(output / f'repetition-{repetition}-enabled-{enabled}', enabled == 'true')
    metadata['end_unix_ns'] = time.time_ns()
    metadata['artifact_sha256'] = {str(path.relative_to(output)): digest(path) for path in output.rglob('*') if path.is_file() and path != metadata_path}
    if digest(corpus_snapshot) != corpus_sha256 or digest(expected_snapshot) != expected_sha256:
        raise SystemExit('corpus snapshots changed at final check; evidence incomplete')
    if digest(binary) != metadata['binary_sha256'] or any(digest(ROOT / path) != expected for path, expected in metadata['source_sha256'].items()):
        raise SystemExit('binary/source changed during run; evidence incomplete')
    if competing_builds():
        raise SystemExit('compiler active at final check; run incomplete')
    metadata['complete'] = True
    metadata_path.write_text(json.dumps(metadata, indent=2) + '\n')


if __name__ == '__main__':
    main()
