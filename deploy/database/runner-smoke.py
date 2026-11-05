#!/usr/bin/env python3
"""Run the actual root release script in a disposable container with fake IO only."""
import copy
import json
from pathlib import Path
import subprocess

if not Path('/test/runner-fixture-only').is_file() or Path('/var/run/docker.sock').exists():
    raise SystemExit('Run only inside Dockerfile.test-runner without a Docker socket.')

ROOT = Path('/srv/sugar')
NEW, OLD = 'a' * 40, 'b' * 40
IDS = {name: 'sha256:' + value * 64 for name, value in [('api', '1'), ('web', '2'), ('database', '3')]}
OLD_ID = 'sha256:' + 'd' * 64
DESCRIPTOR = {'version': 2, 'commit': NEW, 'images': {name + '-image': {'id': value} for name, value in IDS.items()}}
(ROOT / '.env').write_text('synthetic-unused-environment\n')
(ROOT / '.env').chmod(0o600)


def scenario(fail='', access='runtime-v1', descriptor=None, has_db=True, first=False, invalid_old_id=None, stopped=False, previous_commit=OLD, containerd=False):
    release = ROOT / 'release.env'
    original = 'IMAGE_TAG=' + previous_commit + ('\nDATABASE_ACCESS=runtime-v1' if access else '') + '\n'
    if first: release.unlink(missing_ok=True)
    else:
        release.write_text(original)
        release.chmod(0o600)
    state = dict(new=NEW, ids=IDS, fail=fail, has_db=has_db, current_db=OLD_ID,
                 current_app=previous_commit, commands=[], data_marker='unchanged-synthetic-rows', invalid_old_id=invalid_old_id, stopped=stopped,
                 old_ids={'db': OLD_ID, 'api': 'sha256:' + 'e' * 64, 'web': 'sha256:' + 'c' * 64},
                 current_api_image='sha256:' + 'e' * 64, current_web_image='sha256:' + 'c' * 64)
    state['local_ids'] = {name: 'sha256:' + value * 64 for name, value in [('api', '4'), ('web', '5'), ('database', '6')]} if containerd else IDS
    target = Path('/tmp/runtime-fixture.json')
    target.write_text(json.dumps(state))
    payload = json.dumps(DESCRIPTOR if descriptor is None else descriptor, separators=(',', ':'))
    result = subprocess.run(['bash', str(ROOT / 'deploy.sh'), NEW],
                            input='synthetic-registry-token\n' + payload + '\n', text=True, capture_output=True, timeout=20)
    state = json.loads(target.read_text())
    assert 'synthetic-registry-token' not in result.stdout + result.stderr
    assert state['data_marker'] == 'unchanged-synthetic-rows'
    return result, state, release.read_text() if release.exists() else None, original


for first, stopped in ((False, False), (False, True), (True, False)):
    result, state, record, _ = scenario(first=first, has_db=not first, stopped=stopped)
    assert result.returncode == 0, 'valid release failed'
    assert state['current_db'] == IDS['database'] and state['current_app'] == NEW
    assert state['current_api_image'] == IDS['api'] and state['current_web_image'] == IDS['web']
    assert 'DATABASE_IMAGE=' + IDS['database'] in record and 'API_IMAGE=' + IDS['api'] in record
    assert (ROOT / 'release.env').stat().st_mode & 0o777 == 0o600
    commands = state['commands']
    stop_index = next(i for i,c in enumerate(commands) if 'stop' in c)
    migrated = next(i for i,c in enumerate(commands) if 'migrate' in c)
    assert stop_index < migrated and commands[stop_index][-1] == 'api'
    assert any('pull' in call and call[-3:] == ['api', 'web', 'db'] for call in commands)
    if not first and not stopped:
        assert next(i for i, call in enumerate(commands) if 'exec' in call) < next(i for i, call in enumerate(commands) if 'run' in call)
    else:
        assert not any('exec' in call for call in commands)

for access in ('runtime-v1', ''):
    for fail in ('stop', 'pull', 'identity-api', 'identity-web', 'identity-database', 'db', 'migration', 'api', 'health'):
        result, state, record, original = scenario(fail, access)
        assert result.returncode != 0 and record == original, 'failure changed the release record'
        assert state['current_db'] == OLD_ID and state['current_app'] == OLD, 'previous image identity not restored'
        assert state['current_api_image'] == state['old_ids']['api'] and state['current_web_image'] == state['old_ids']['web']
        if fail == 'pull' or fail.startswith('identity-'):
            assert not any('up' in call or 'run' in call for call in state['commands'])
        else:
            assert state['legacy_override'] == (access == ''), 'wrong database-credential rollback mode'

for change in ('commit', 'version', 'missing', 'image', 'long'):
    descriptor = copy.deepcopy(DESCRIPTOR)
    if change == 'commit': descriptor['commit'] = OLD
    if change == 'version': descriptor['version'] = 1
    if change == 'missing': del descriptor['images']['database-image']
    if change == 'image': descriptor['images']['database-image']['id'] = 'untrusted:latest'
    if change == 'long': descriptor['extra'] = 'x' * 5000
    result, state, record, original = scenario(descriptor=descriptor)
    assert result.returncode != 0 and not state['commands'] and record == original

result, state, record, original = scenario('health', previous_commit=NEW)
assert result.returncode != 0 and record == original
assert state['current_db'] == OLD_ID and state['current_api_image'] == state['old_ids']['api']
assert state['current_web_image'] == state['old_ids']['web'], 'same-SHA rerun restored a mutable tag instead of the old image'

for has_db, invalid in [(False, None), (True, 'untrusted:latest')]:
    result, state, record, original = scenario(has_db=has_db, invalid_old_id=invalid)
    assert result.returncode != 0 and record == original
    assert not any('up' in call or 'pull' in call for call in state['commands'])

for fail in ('', 'identity-api', 'identity-web', 'identity-database', 'manifest', 'manifest-format', 'migration', 'health'):
    result, state, record, original = scenario(fail, containerd=True)
    if not fail:
        assert result.returncode == 0
        assert state['current_db'] == state['local_ids']['database']
        assert state['current_api_image'] == state['local_ids']['api']
        assert 'DATABASE_CONFIG=' + IDS['database'] in record
        calls = [call for call in state['commands'] if call[:3] == ['docker', 'manifest', 'inspect']]
        assert len(calls) == 3 and all('@sha256:' in call[-1] for call in calls)
    else:
        assert result.returncode != 0 and record == original
        assert state['current_db'] == OLD_ID and state['current_api_image'] == state['old_ids']['api']
        if fail.startswith(('identity', 'manifest')): assert not any('up' in call for call in state['commands'])

print('PASS: release descriptor, identity/pull rejection, immutable DB, legacy/runtime rollback, unchanged data and state')
