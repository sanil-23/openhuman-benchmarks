#!/usr/bin/env python3
"""Install and validate the pinned official V2 artifact without paid inference."""
import argparse
import hashlib
import json
import pathlib
import subprocess

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parent
PINS = json.loads((HERE / 'pins.json').read_text())
CODE = ROOT / '.cache/longmemeval-v2'
DATA = ROOT / '.cache/lme-v2-data'
PYTHON = ROOT / '.cache/lme-v2-venv/bin/python'


def run(*args, cwd=ROOT):
    subprocess.run([str(arg) for arg in args], cwd=cwd, check=True)


def digest(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()


def verify_code():
    revision = subprocess.check_output(['git', '-C', str(CODE), 'rev-parse', 'HEAD'], text=True).strip()
    dirty = subprocess.check_output(['git', '-C', str(CODE), 'status', '--porcelain', '--untracked-files=no'], text=True)
    if revision != PINS['code_revision'] or dirty:
        raise RuntimeError('Official checkout must match the pin with no tracked edits')


def verify_data():
    manifest = DATA / 'checksums.sha256'
    if digest(manifest) != PINS['checksums_sha256']:
        raise RuntimeError('Dataset checksum manifest does not match the pinned revision')
    count = 0
    overrides = []
    for line in manifest.read_text().splitlines():
        expected, name = line.split(maxsplit=1)
        override = PINS.get('checksum_overrides', {}).get(name)
        if override:
            if name != 'README.md' or override['manifest_sha256'] != expected:
                raise RuntimeError(f'Invalid documentation checksum override: {name}')
            expected = override['sha256']
            overrides.append(name)
        path = (DATA / name).resolve()
        if not path.is_relative_to(DATA.resolve()) or digest(path) != expected:
            raise RuntimeError(f'Dataset checksum mismatch: {name}')
        count += 1
    print(json.dumps({'verified_dataset_files': count, 'pinned_documentation_overrides': overrides}))


def bootstrap():
    CODE.parent.mkdir(exist_ok=True)
    if not CODE.exists():
        run('git', 'clone', PINS['repository'], CODE)
        run('git', '-C', CODE, 'checkout', '--detach', PINS['code_revision'])
    verify_code()
    if not PYTHON.exists():
        run('uv', 'venv', '--python', '3.11', PYTHON.parent.parent)
    run('uv', 'pip', 'sync', '--python', PYTHON, HERE / 'requirements.lock',
        '--extra-index-url', 'https://download.pytorch.org/whl/cpu',
        '--index-strategy', 'unsafe-best-match')
    run(PYTHON, '-m', 'unittest', 'discover', '-s', 'tests', '-v', cwd=CODE)
    run(PYTHON, '-m', 'unittest', 'discover', '-s', HERE, '-p', 'test_*.py', '-v')
    run(PYTHON, CODE / 'evaluation/harness.py', '--help')


def download():
    verify_code()
    # Always resume the entire immutable snapshot. The official downloader's
    # already-present shortcut only checks the two JSONL files, not screenshots.
    run(PYTHON, '-c',
        'from huggingface_hub import snapshot_download; import sys; '
        'snapshot_download(repo_id=sys.argv[1], repo_type="dataset", '
        'revision=sys.argv[2], local_dir=sys.argv[3])',
        PINS['dataset'], PINS['data_revision'], DATA)
    verify_data()
    run(PYTHON, CODE / 'data/prepare_data.py', '--data-root', DATA, '--mode', 'symlink')
    for tier in ('small', 'medium'):
        run(PYTHON, CODE / 'data/validate_data.py', '--data-root', DATA, '--tier', tier)


def inventory():
    """Summarize questions without loading the 1.2 GB trajectory file."""
    rows = [json.loads(line) for line in (DATA / 'questions.jsonl').read_text().splitlines() if line.strip()]
    result = {}
    for row in rows:
        domain = result.setdefault(row['domain'], {'questions': 0, 'image_questions': 0, 'categories': {}})
        domain['questions'] += 1
        domain['image_questions'] += bool(row.get('image'))
        categories = domain['categories']
        categories[row['question_type']] = categories.get(row['question_type'], 0) + 1
    print(json.dumps(result, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('action', choices=['bootstrap', 'data', 'check', 'inventory', 'smoke'])
    action = parser.parse_args().action
    if action == 'bootstrap':
        bootstrap()
    elif action == 'data':
        download()
    elif action == 'check':
        verify_code()
        verify_data()
        for tier in ('small', 'medium'):
            run(PYTHON, CODE / 'data/validate_data.py', '--data-root', DATA, '--tier', tier)
    elif action == 'inventory':
        inventory()
    else:
        verify_code()
        run(PYTHON, HERE / 'smoke.py')


if __name__ == '__main__':
    main()
