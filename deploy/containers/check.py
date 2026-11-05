"""Check the API's container policy without printing configuration values."""
import json
import sys


def validate(config):
    api = config.get('services', {}).get('api', {})
    errors = []
    if any(name in api.get('environment', {}) for name in ['GITHUB_APP_ID','GITHUB_INSTALLATION_ID','GITHUB_PRIVATE_KEY','GITHUB_PRIVATE_KEY_FILE']):
        errors.append('API must not receive shared GitHub installation credentials')
    if api.get('user') != '1000:1000':
        errors.append('API must run as UID/GID 1000')
    if api.get('read_only') is not True or api.get('init') is not True:
        errors.append('API needs a read-only root and an init process')
    if 'ALL' not in api.get('cap_drop', []) or api.get('cap_add'):
        errors.append('API must drop all capabilities without adding others')
    if 'no-new-privileges:true' not in api.get('security_opt', []):
        errors.append('API must forbid privilege escalation')
    if not isinstance(api.get('pids_limit'), int) or not 0 < api['pids_limit'] <= 128:
        errors.append('API must limit process count')
    if api.get('privileged') or api.get('pid') or api.get('ipc') or api.get('network_mode'):
        errors.append('API must not share privileged host namespaces')
    if api.get('volumes'):
        errors.append('API policy does not allow persistent writable or host mounts')
    temporary = api.get('tmpfs', [])
    if temporary != ['/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777']:
        errors.append('API must use only its bounded temporary filesystem')
    return errors


if __name__ == '__main__':
    errors = validate(json.load(sys.stdin))
    for error in errors:
        print('FAIL: ' + error)
    if not errors:
        print('PASS: API container privilege policy')
    raise SystemExit(bool(errors))
