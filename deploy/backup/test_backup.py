import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

from create import create
from transfer import transfer


def run(*args, **kwargs):
    return subprocess.run(args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **kwargs)


class BackupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.identity = self.root / 'identity.txt'
        run('age-keygen', '-o', str(self.identity))
        self.recipient = run('age-keygen', '-y', str(self.identity)).stdout.decode().strip()

    def decrypt(self, archive, identity=None):
        return run('age', '-d', '-i', str(identity or self.identity), str(archive)).stdout

    def transfer_to_disposable_remote(self, name, digest):
        remote = self.root / 'destination'
        config = self.root / 'rclone.conf'
        if not config.exists():
            with os.fdopen(os.open(config, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600), 'w') as file:
                file.write(f'[disposable]\ntype = alias\nremote = {remote}\n')
        receipt = transfer(self.root, name, digest, config, 'disposable:sugar')
        return remote / 'sugar' / name, receipt

    def test_transfer_verifies_remote_bytes_and_keeps_existing_objects(self):
        name = 'test.age'
        local = self.root / name
        record = create(self.root, name, [self.recipient], ['printf', 'synthetic payload'])
        digest = record['sha256']
        remote, receipt = self.transfer_to_disposable_remote(name, digest)
        receipt_file = self.root / f'{name}.verified.json'
        self.assertEqual(receipt, json.loads(receipt_file.read_text()))
        self.assertEqual(receipt_file.stat().st_mode & 0o777, 0o600)
        self.assertEqual(receipt['bytes'], record['bytes'])
        self.assertEqual(self.decrypt(remote), b'synthetic payload')
        self.assertEqual(self.transfer_to_disposable_remote(name, digest)[1], receipt)

        archive = local.read_bytes()
        corrupt = archive[:-1] + bytes([archive[-1] ^ 1])
        remote.write_bytes(corrupt)
        receipt_file.unlink()
        with self.assertRaisesRegex(ValueError, 'remote archive does not match'):
            self.transfer_to_disposable_remote(name, digest)
        self.assertEqual(remote.read_bytes(), corrupt)
        self.assertFalse(receipt_file.exists())
        remote.unlink()
        local.write_bytes(corrupt)
        with self.assertRaisesRegex(ValueError, 'recorded at creation'):
            self.transfer_to_disposable_remote(name, digest)
        self.assertFalse(remote.exists())

    def test_roundtrip_private_atomic_no_overwrite(self):
        result = create(self.root, 'test.age', [self.recipient], ['printf', 'synthetic payload'])
        self.assertEqual(self.decrypt(self.root / 'test.age'), b'synthetic payload')
        self.assertEqual((self.root / 'test.age').stat().st_mode & 0o777, 0o600)
        self.assertGreater(result['bytes'], 0)
        self.assertEqual(len(result['sha256']), 64)
        with self.assertRaises(FileExistsError):
            create(self.root, 'test.age', [self.recipient], ['printf', 'replacement'])
        self.assertEqual(self.decrypt(self.root / 'test.age'), b'synthetic payload')
        self.assertFalse(list(self.root.glob('.partial-*')))

    def test_producer_failure_timeout_and_no_secret_logs(self):
        for script in ['printf partial; echo private-diagnostic >&2; exit 1', 'sleep 10']:
            with self.assertRaises((RuntimeError, subprocess.TimeoutExpired)):
                create(self.root, 'fail.age', [self.recipient], ['sh', '-c', script], 1)
            self.assertFalse((self.root / 'fail.age').exists())
            self.assertFalse(list(self.root.glob('.partial-*')))
        result = subprocess.run(['python3', str(Path(__file__).with_name('create.py')),
                                 '--directory', str(self.root), '--name', 'fail.age',
                                 '--recipient', self.recipient, '--', 'sh', '-c',
                                 'echo private-diagnostic >&2; exit 1'], capture_output=True)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(json.loads(result.stdout), {'status': 'backup_failed'})
        self.assertNotIn(b'private-diagnostic', result.stderr + result.stdout)

    def test_reject_unsafe_targets_and_invalid_recipients(self):
        for name in ['../escape.age', '/tmp/escape.age', 'dump.sql']:
            with self.assertRaises(ValueError):
                create(self.root, name, [self.recipient], ['true'])
        with self.assertRaises(ValueError):
            create(self.root, 'test.age', ['not-a-recipient'], ['true'])
        self.root.chmod(0o755)
        with self.assertRaises(ValueError):
            create(self.root, 'test.age', [self.recipient], ['true'])
        self.root.chmod(0o700)
        link = self.root / 'link'
        link.symlink_to(self.root, target_is_directory=True)
        with self.assertRaises(OSError):
            create(link, 'test.age', [self.recipient], ['true'])
        target = self.root / 'target'
        target.write_bytes(b'keep')
        (self.root / 'test.age').symlink_to(target)
        with self.assertRaises(FileExistsError):
            create(self.root, 'test.age', [self.recipient], ['printf', 'replacement'])
        self.assertEqual(target.read_bytes(), b'keep')

    def test_wrong_identity_tampering_and_truncation(self):
        create(self.root, 'test.age', [self.recipient], ['printf', 'synthetic payload'])
        wrong = self.root / 'wrong.txt'
        run('age-keygen', '-o', str(wrong))
        with self.assertRaises(subprocess.CalledProcessError):
            self.decrypt(self.root / 'test.age', wrong)
        content = (self.root / 'test.age').read_bytes()
        for data in [content[:-1], content[:-1] + bytes([content[-1] ^ 1])]:
            (self.root / 'bad.age').write_bytes(data)
            with self.assertRaises(subprocess.CalledProcessError):
                self.decrypt(self.root / 'bad.age')

    def test_encryptor_failure_leaves_no_archive(self):
        with self.assertRaises(RuntimeError):
            create(self.root, 'fail.age', ['age1' + 'a' * 58], ['printf', 'payload'])
        self.assertFalse((self.root / 'fail.age').exists())
        self.assertFalse(list(self.root.glob('.partial-*')))

    @unittest.skipUnless(os.environ.get('BACKUP_TEST_DATABASE_HOST'), 'disposable PostgreSQL required')
    def test_real_database_restore(self):
        env = dict(os.environ)
        host = env['BACKUP_TEST_DATABASE_HOST']
        env.update(PGHOST=host, PGUSER='designer', PGPASSWORD='synthetic-only-password',
                   ADMIN_EMAIL='recovery@example.invalid', ADMIN_PASSWORD='synthetic-recovery-password',
                   AI_ENCRYPTION_KEY='0123456789abcdef' * 4)
        manifest = str(self.root / 'expected.json')
        fixture = str(Path(__file__).with_name('fixture.mjs'))
        env['DATABASE_URL'] = f'postgres://designer:synthetic-only-password@{host}/source'
        run('node', fixture, 'seed', manifest, env=env)
        # create inherits PG* only in this test process, not a real installation.
        previous = dict(os.environ)
        try:
            os.environ.update(env)
            record = create(self.root, 'database.age', [self.recipient],
                            ['pg_dump', '--no-password', '-Fc', '--no-owner', '--no-acl', '-d', 'source'])
        finally:
            os.environ.clear()
            os.environ.update(previous)
        remote, _ = self.transfer_to_disposable_remote('database.age', record['sha256'])
        (self.root / 'database.age').unlink()
        # Authenticate the entire archive BEFORE giving a consumer any plaintext.
        plaintext = self.decrypt(remote)
        self.assertTrue(plaintext.startswith(b'PGDMP'))
        run('createdb', '--no-password', 'restored', env=env)
        run('pg_restore', '--no-password', '--single-transaction', '--exit-on-error',
            '--no-owner', '--no-acl', '-d', 'restored', input=plaintext, env=env)
        env['DATABASE_URL'] = f'postgres://designer:synthetic-only-password@{host}/restored'
        run('node', fixture, 'verify', manifest, env=env)
        # The external encryption key is necessary; the DB dump cannot recreate it.
        env['AI_ENCRYPTION_KEY'] = 'fedcba9876543210' * 4
        with self.assertRaises(subprocess.CalledProcessError):
            run('node', fixture, 'verify', manifest, env=env)
