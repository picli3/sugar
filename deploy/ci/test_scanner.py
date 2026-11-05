from pathlib import Path
import hashlib
import subprocess
import tempfile
import unittest
import uuid

SCRIPT = Path(__file__).with_name('scan-secrets.py')


class ScannerTests(unittest.TestCase):
    def test_fixture_allowlist_requires_both_path_and_exact_value(self):
        cases = [('.github/workflows/deploy.yml', '0123456789abcdef' * 4, 0),
                 ('fixture.txt', '0123456789abcdef' * 4, 1),
                 ('.github/workflows/deploy.yml', hashlib.sha256(b'synthetic fixture only').hexdigest(), 1),
                 ('api/src/mfa/totp.test.js', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 0),
                 ('api/src/mfa/recovery.test.js', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 0),
                 ('api/src/mfa/migration.integration.test.js', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 0),
                 ('api/src/mfa/service.js', 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', 1),
                 ('api/src/mfa/totp.test.js', hashlib.sha256(b'different synthetic fixture').hexdigest(), 1)]
        for path, value, expected in cases:
            with self.subTest(path=path, expected=expected), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                def git(*args):
                    return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
                git('init', '-q')
                git('config', 'user.name', 'Synthetic fixture')
                git('config', 'user.email', 'fixture@example.invalid')
                file = root / path
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text('AI_ENCRYPTION_KEY=' + value + '\n')
                git('add', '.')
                git('commit', '-qm', 'Synthetic allowlist fixture')
                result = subprocess.run(['python3', str(SCRIPT), '--source', str(root)], capture_output=True)
                self.assertEqual(result.returncode, expected, result.stdout)
                self.assertNotIn(value.encode(), result.stdout + result.stderr)

    def test_clean_untracked_and_historical_secret(self):
        with tempfile.TemporaryDirectory(prefix='sugar-secret-fixture-') as directory:
            root = Path(directory)
            def git(*args):
                return subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)
            git('init', '-q')
            git('config', 'user.name', 'Synthetic fixture')
            git('config', 'user.email', 'fixture@example.invalid')
            (root / 'README.md').write_text('Synthetic fixture only\n')
            git('add', 'README.md')
            git('commit', '-qm', 'Create clean fixture')
            secret = 'ghp_' + uuid.uuid4().hex + 'abcd'
            (root / '.env').write_text('GITHUB_TOKEN=' + secret + ' # gitleaks:allow\n')
            result = subprocess.run(['python3', str(SCRIPT), '--source', str(root)], capture_output=True)
            self.assertEqual(result.returncode, 0, result.stdout)
            self.assertNotIn(secret.encode(), result.stdout + result.stderr)
            git('add', '.env')
            git('commit', '-qm', 'Add synthetic detector fixture')
            git('rm', '.env')
            git('commit', '-qm', 'Remove fixture from working tree')
            result = subprocess.run(['python3', str(SCRIPT), '--source', str(root)], capture_output=True)
            self.assertEqual(result.returncode, 1, result.stdout)
            self.assertIn(b'BLOCKED', result.stdout)
            self.assertNotIn(secret.encode(), result.stdout + result.stderr)

    def test_invalid_source_fails_closed_without_raw_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(['python3', str(SCRIPT), '--source', directory], capture_output=True)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn(directory.encode(), result.stdout + result.stderr)
