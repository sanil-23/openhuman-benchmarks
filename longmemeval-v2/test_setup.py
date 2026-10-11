import hashlib
import pathlib
import tempfile
import unittest
from unittest.mock import patch

import setup


def sha(value):
    return hashlib.sha256(value).hexdigest()


class DatasetIntegrityTests(unittest.TestCase):
    def fixture(self, folder):
        root = pathlib.Path(folder)
        readme = b'pinned updated documentation'
        data = b'pinned questions'
        stale = sha(b'old documentation')
        manifest = f'{stale}  README.md\n{sha(data)}  questions.jsonl\n'.encode()
        (root / 'README.md').write_bytes(readme)
        (root / 'questions.jsonl').write_bytes(data)
        (root / 'checksums.sha256').write_bytes(manifest)
        pins = {'checksums_sha256': sha(manifest), 'checksum_overrides': {
            'README.md': {'manifest_sha256': stale, 'sha256': sha(readme)}}}
        return root, pins

    def test_pinned_documentation_override_accepts_only_the_released_readme(self):
        with tempfile.TemporaryDirectory() as folder:
            root, pins = self.fixture(folder)
            with patch.object(setup, 'DATA', root), patch.object(setup, 'PINS', pins):
                setup.verify_data()

    def test_changed_questions_are_rejected_even_with_a_documentation_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root, pins = self.fixture(folder)
            (root / 'questions.jsonl').write_bytes(b'corrupt questions')
            with patch.object(setup, 'DATA', root), patch.object(setup, 'PINS', pins):
                with self.assertRaisesRegex(RuntimeError, 'questions.jsonl'):
                    setup.verify_data()

    def test_changed_readme_is_rejected_even_with_a_documentation_override(self):
        with tempfile.TemporaryDirectory() as folder:
            root, pins = self.fixture(folder)
            (root / 'README.md').write_bytes(b'other documentation')
            with patch.object(setup, 'DATA', root), patch.object(setup, 'PINS', pins):
                with self.assertRaisesRegex(RuntimeError, 'README.md'):
                    setup.verify_data()


if __name__ == '__main__':
    unittest.main()
