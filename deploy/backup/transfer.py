#!/usr/bin/env python3
"""Copy an encrypted backup and record it only after verifying the remote bytes."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tempfile


def transfer(directory, name, expected_sha256, config, remote, timeout=900):
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,159}\.age', name):
        raise ValueError('invalid archive name')
    if not re.fullmatch(r'[a-f0-9]{64}', expected_sha256) or not 0 < timeout <= 86400:
        raise ValueError('invalid digest or timeout')
    if not re.fullmatch(r'[A-Za-z0-9_-]+:(?:[A-Za-z0-9_-][A-Za-z0-9_.-]*/)*[A-Za-z0-9_-][A-Za-z0-9_.-]*', remote):
        raise ValueError('expected a named rclone remote and a directory')
    config_info = Path(config).lstat()
    if (not stat.S_ISREG(config_info.st_mode) or config_info.st_uid != os.geteuid()
            or stat.S_IMODE(config_info.st_mode) != 0o600):
        raise ValueError('rclone config must be a private regular file')

    directory_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        info = os.fstat(directory_fd)
        if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
            raise ValueError('archive directory must be owned by caller with mode 0700')
        fcntl.flock(directory_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        anchor = Path(f'/proc/self/fd/{directory_fd}')
        source = anchor / name
        source_info = source.lstat()
        if (not stat.S_ISREG(source_info.st_mode) or source_info.st_uid != os.geteuid()
                or stat.S_IMODE(source_info.st_mode) != 0o600):
            raise ValueError('archive must be a private regular file')
        with source.open('rb') as archive:
            if archive.read(len(b'age-encryption.org/v1\n')) != b'age-encryption.org/v1\n':
                raise ValueError('expected a binary age archive')
            archive.seek(0)
            if hashlib.file_digest(archive, 'sha256').hexdigest() != expected_sha256:
                raise ValueError('archive does not match the digest recorded at creation')

        destination = f'{remote}/{name}'
        record = {'name': name, 'remote': destination, 'sha256': expected_sha256,
                  'bytes': source_info.st_size}
        receipt = anchor / f'{name}.verified.json'
        previous = None
        if receipt.exists():
            previous = json.loads(receipt.read_text())
            if (not isinstance(previous, dict)
                    or any(previous.get(key) != value for key, value in record.items())):
                raise ValueError('existing receipt identifies a different backup')

        args = ['rclone', '--config', str(Path(config).absolute()), '--retries', '1',
                '--low-level-retries', '1']
        options = dict(check=True, timeout=timeout, stdin=subprocess.DEVNULL,
                       stderr=subprocess.DEVNULL)
        subprocess.run([*args, 'copyto', '--ignore-existing', str(source), destination],
                       stdout=subprocess.DEVNULL, pass_fds=(directory_fd,), **options)
        downloaded = subprocess.run([*args, 'hashsum', 'sha256', '--download', '--max-depth', '1', destination],
                                    stdout=subprocess.PIPE, **options).stdout.splitlines()
        if downloaded != [f'{expected_sha256}  {name}'.encode()]:
            raise ValueError('remote archive does not match the recorded digest')

        if previous is not None:
            return previous
        record['verified_at'] = datetime.now(timezone.utc).isoformat()
        with tempfile.NamedTemporaryFile(mode='w', dir=anchor, prefix='.receipt-', delete=False) as file:
            temporary = Path(file.name)
            try:
                json.dump(record, file)
                file.write('\n')
                file.flush()
                os.fsync(file.fileno())
                os.link(temporary, receipt)
                os.fsync(directory_fd)
            finally:
                temporary.unlink()
        return record
    finally:
        os.close(directory_fd)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--directory', required=True)
    parser.add_argument('--name', required=True)
    parser.add_argument('--sha256', required=True, help='digest recorded by create.py')
    parser.add_argument('--config', required=True, help='private rclone configuration')
    parser.add_argument('--remote', required=True, help='named rclone remote and directory')
    parser.add_argument('--timeout', type=int, default=900, help='maximum seconds per rclone command')
    args = parser.parse_args()
    try:
        transfer(args.directory, args.name, args.sha256, args.config, args.remote, args.timeout)
    except (OSError, ValueError, subprocess.SubprocessError):
        print('{"status":"backup_transfer_failed"}')
        return 1
    print('{"status":"backup_verified"}')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
