#!/usr/bin/python3
"""Test-container executable only. Models Docker/curl; never contacts a daemon."""
import json
import os
from pathlib import Path
import sys

path = Path('/tmp/runtime-fixture.json')
state = json.loads(path.read_text())
args = sys.argv[1:]
name = Path(sys.argv[0]).name
state['commands'].append([name, *args])
code, output = 0, ''
new = state['new']
old_id = 'sha256:' + 'd' * 64

if name == 'curl':
    code = int(state['fail'] == 'health')
elif args[0] == 'login':
    if sys.stdin.read().strip() != 'synthetic-registry-token': raise SystemExit(2)
elif args[0] == 'inspect':
    component = args[-1].split('-')[-1]
    output = (state.get('invalid_old_id') if component == 'db' else None) or state['old_ids'][component]
elif args[:2] == ['image', 'inspect']:
    if '--format' in args:
        component = args[-1].split('sugar-')[-1].split(':')[0]
        if '.RepoDigests' in args[args.index('--format') + 1]:
            output = json.dumps([args[-1].split(':')[0] + '@' + state['local_ids'][component]])
        else:
            output = 'sha256:' + 'f' * 64 if state['fail'] == 'identity-' + component else state['local_ids'][component]
elif args[:2] == ['manifest', 'inspect']:
    component = args[-1].split('sugar-')[-1].split('@')[0]
    config = 'sha256:' + 'f' * 64 if state['fail'] == 'identity-' + component else state['ids'][component]
    output = json.dumps({'schemaVersion': 2, 'config': {'digest': config}})
    if state['fail'] == 'manifest': code = 1
    if state['fail'] == 'manifest-format': output = '{"schemaVersion":2,"manifests":[]}'
elif args[0] == 'compose':
    if 'config' in args: pass
    elif 'ps' in args:
        if '-q' in args: output = 'synthetic-old-' + args[-1] if state['has_db'] and ('-a' in args or not state.get('stopped')) else ''
        else: output = 'db' if state['has_db'] and not state.get('stopped') else ''
    elif 'pull' in args: code = int(state['fail'] == 'pull')
    elif 'exec' in args: output = 'synthetic-pg-dump'
    elif 'stop' in args: code = int(state['fail'] == 'stop')
    elif 'run' in args: code = int(state['fail'] == 'migration')
    elif 'up' in args:
        is_new = os.environ.get('DATABASE_IMAGE') == state['local_ids']['database']
        if is_new and state['fail'] == ('db' if args[-1] == 'db' else 'api'):
            code = 1
        else:
            state['current_db'] = os.environ['DATABASE_IMAGE']
            if args[-1] != 'db':
                state['current_app'] = os.environ['IMAGE_TAG']
                state['current_api_image'] = os.environ['API_IMAGE']
                state['current_web_image'] = os.environ['WEB_IMAGE']
                state['legacy_override'] = '/srv/sugar/legacy-rollback.yaml' in args
    else: raise SystemExit(3)
else: raise SystemExit(3)
path.write_text(json.dumps(state))
print(output)
raise SystemExit(code)
