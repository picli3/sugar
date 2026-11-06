#!/usr/bin/env python3
"""Sugar host monitor (#23, stage 3).

One run collects metrics (readiness, disk, newest backup, GitHub sync queue, AI calls, audited
errors/denials), compares them with thresholds and, when the set of firing alerts changes or a
repeat interval passes, POSTs one JSON message to a webhook. Output never contains secrets,
personal data, SQL errors or the webhook URL. Nothing is installed: the operator schedules it.

Exit codes: 0 no alerts, 1 alerts firing, 2 the monitor itself could not run or notify.
"""
import argparse, datetime, json, os, shutil, stat, subprocess, sys, time, urllib.error, urllib.parse, urllib.request

SCHEMA = 'sugar.monitor.v1'
ALERT_SCHEMA = 'sugar.alert.v1'

def metrics_sql(ai_stuck_minutes):
    minutes = int(ai_stuck_minutes)
    return f"""SELECT json_build_object(
 'sync_pending',(SELECT count(*) FROM sync_jobs WHERE status='pending'),
 'sync_oldest_minutes',(SELECT COALESCE(floor(extract(epoch FROM now()-min(created_at))/60),0)::int FROM sync_jobs WHERE status='pending'),
 'sync_failed_24h',(SELECT count(*) FROM sync_jobs WHERE status IN ('failed','blocked') AND created_at>now()-interval '24 hours'),
 'ai_failed_24h',(SELECT count(*) FROM ai_calls WHERE status IN ('failed','uncertain') AND created_at>now()-interval '24 hours'),
 'ai_stuck',(SELECT count(*) FROM ai_calls WHERE status='reserved' AND created_at<now()-make_interval(mins => {minutes})),
 'errors_1h',(SELECT count(*) FROM audit_events WHERE result='error' AND at>now()-interval '1 hour'),
 'denied_1h',(SELECT count(*) FROM audit_events WHERE result='denied' AND at>now()-interval '1 hour'),
 'db_bytes',pg_database_size(current_database()));
"""

METRIC_KEYS = ('sync_pending', 'sync_oldest_minutes', 'sync_failed_24h', 'ai_failed_24h', 'ai_stuck', 'errors_1h', 'denied_1h', 'db_bytes')

def parse_args(argv):
    p = argparse.ArgumentParser(description='Sugar host monitor')
    p.add_argument('--label', default='sugar', help='name shown in alerts (no secrets)')
    p.add_argument('--ready-url', help='readiness URL, e.g. https://example.org/api/ready')
    p.add_argument('--disk', action='append', default=[], help='path whose filesystem is checked (repeatable)')
    p.add_argument('--disk-warn', type=float, default=80.0)
    p.add_argument('--disk-crit', type=float, default=90.0)
    p.add_argument('--backup-dir', help='directory with database dumps')
    p.add_argument('--backup-max-age-hours', type=float, default=0, help='0 disables the age check')
    p.add_argument('--backup-min-bytes', type=int, default=1024)
    p.add_argument('--sql-command', help='JSON array argv that reads SQL on stdin and prints one line (psql -At)')
    p.add_argument('--sql-timeout', type=float, default=20)
    p.add_argument('--sync-pending-max', type=int, default=20)
    p.add_argument('--sync-oldest-minutes', type=int, default=60)
    p.add_argument('--sync-failed-max', type=int, default=0, help='alert when failed/blocked jobs in 24 h exceed this')
    p.add_argument('--ai-failed-max', type=int, default=3)
    p.add_argument('--ai-stuck-minutes', type=int, default=15)
    p.add_argument('--errors-max', type=int, default=5, help='audited 5xx results in the last hour')
    p.add_argument('--denied-max', type=int, default=50, help='audited denied results in the last hour')
    p.add_argument('--db-max-bytes', type=int, default=0, help='0 disables the database size check')
    p.add_argument('--state-file', help='remembers notified alerts to avoid repeats')
    p.add_argument('--repeat-hours', type=float, default=24)
    p.add_argument('--webhook-url-file', help='file (mode 600) holding the https webhook URL')
    p.add_argument('--timeout', type=float, default=10)
    args = p.parse_args(argv)
    if not 0 < args.disk_warn <= args.disk_crit <= 100: p.error('need 0 < --disk-warn <= --disk-crit <= 100')
    return args

def alert(check, severity, value=None, threshold=None):
    item = {'check': check, 'severity': severity}
    if value is not None: item['value'] = value
    if threshold is not None: item['threshold'] = threshold
    return item

def check_ready(url, timeout, opener=urllib.request.urlopen):
    try:
        with opener(urllib.request.Request(url, headers={'User-Agent': 'sugar-monitor'}), timeout=timeout) as response:
            body = json.loads(response.read(64).decode('utf-8', 'replace') or 'null')
            return [] if response.status == 200 and body == {'ok': True} else [alert('ready', 'critical')]
    except Exception:
        return [alert('ready', 'critical')]

def check_disk(paths, warn, crit, usage=shutil.disk_usage):
    found = []
    for index, path in enumerate(paths):
        name = f'disk:{index}'
        try:
            total, used, _free = usage(path)
        except OSError:
            found.append(alert(name, 'critical')); continue
        percent = round(used * 100 / total, 1) if total else 100.0
        if percent >= crit: found.append(alert(name, 'critical', percent, crit))
        elif percent >= warn: found.append(alert(name, 'warning', percent, warn))
    return found

def check_backups(directory, max_age_hours, min_bytes, now=time.time):
    if not directory or not max_age_hours: return []
    try:
        dumps = [entry for entry in os.scandir(directory) if entry.is_file(follow_symlinks=False) and entry.name.endswith(('.dump', '.dump.age'))]
    except OSError:
        return [alert('backup', 'critical')]
    valid = [entry.stat(follow_symlinks=False) for entry in dumps]
    valid = [info for info in valid if info.st_size >= min_bytes]
    if not valid: return [alert('backup', 'critical')]
    age = round((now() - max(info.st_mtime for info in valid)) / 3600, 1)
    return [alert('backup', 'warning', age, max_age_hours)] if age > max_age_hours else []

def collect_metrics(command, sql, timeout, run=subprocess.run):
    try:
        argv = json.loads(command)
        if not isinstance(argv, list) or not argv or not all(isinstance(part, str) for part in argv): raise ValueError
        done = run(argv, input=sql, capture_output=True, text=True, timeout=timeout, check=False)
        if done.returncode != 0: return None
        data = json.loads(done.stdout.strip().splitlines()[-1])
        if not all(isinstance(data.get(key), int) and data[key] >= 0 for key in METRIC_KEYS): return None
        return {key: data[key] for key in METRIC_KEYS}
    except Exception:
        return None

def evaluate_metrics(m, args):
    if m is None: return [alert('metrics', 'critical')]
    rules = [
        ('sync_pending', m['sync_pending'], args.sync_pending_max, 'warning'),
        ('sync_oldest', m['sync_oldest_minutes'], args.sync_oldest_minutes, 'warning'),
        ('sync_failed', m['sync_failed_24h'], args.sync_failed_max, 'warning'),
        ('ai_failed', m['ai_failed_24h'], args.ai_failed_max, 'warning'),
        ('ai_stuck', m['ai_stuck'], 0, 'warning'),
        ('http_errors', m['errors_1h'], args.errors_max, 'critical'),
        ('denied', m['denied_1h'], args.denied_max, 'warning'),
    ]
    if args.db_max_bytes: rules.append(('db_size', m['db_bytes'], args.db_max_bytes, 'warning'))
    return [alert(name, severity, value, limit) for name, value, limit, severity in rules if value > limit]

def load_state(path):
    try:
        with open(path, encoding='utf-8') as handle: state = json.load(handle)
        return state if isinstance(state, dict) and isinstance(state.get('firing'), dict) else {'firing': {}}
    except (OSError, ValueError):
        return {'firing': {}}

def save_state(path, state):
    temporary = path + '.tmp'
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle: json.dump(state, handle)
    os.replace(temporary, path)

def plan_notification(alerts, state, now, repeat_hours):
    """Returns (firing alerts to send, resolved check names, new state). Sends nothing when unchanged."""
    previous = state.get('firing', {})
    current = {item['check']: item['severity'] for item in alerts}
    resolved = sorted(set(previous) - set(current))
    changed = any(previous.get(name, {}).get('severity') != severity for name, severity in current.items())
    due = bool(current) and now - float(state.get('notified_at', 0)) >= repeat_hours * 3600
    send = changed or bool(resolved) or due
    firing = {name: {'severity': severity, 'since': previous.get(name, {}).get('since', now)} for name, severity in current.items()}
    new_state = {'firing': firing, 'notified_at': now if send else state.get('notified_at', 0)}
    return (alerts if send else None), resolved, new_state

def read_webhook(path):
    info = os.stat(path)
    if stat.S_IMODE(info.st_mode) & 0o077: raise PermissionError('webhook file must be mode 600')
    with open(path, encoding='utf-8') as handle: url = handle.read().strip()
    parsed = urllib.parse.urlsplit(url)
    local = parsed.scheme == 'http' and parsed.hostname in ('127.0.0.1', 'localhost', '::1')
    if not (parsed.scheme == 'https' or local) or not parsed.hostname: raise ValueError('webhook must be https')
    return url

def send(url, message, timeout, opener=urllib.request.urlopen):
    body = json.dumps(message).encode()
    request = urllib.request.Request(url, data=body, method='POST', headers={'Content-Type': 'application/json', 'User-Agent': 'sugar-monitor'})
    with opener(request, timeout=timeout) as response:
        if not 200 <= response.status < 300: raise urllib.error.HTTPError(url, response.status, 'rejected', None, None)

def run(argv, now=time.time, opener=urllib.request.urlopen, runner=subprocess.run, usage=shutil.disk_usage):
    args = parse_args(argv)
    alerts = []
    if args.ready_url: alerts += check_ready(args.ready_url, args.timeout, opener)
    alerts += check_disk(args.disk, args.disk_warn, args.disk_crit, usage)
    alerts += check_backups(args.backup_dir, args.backup_max_age_hours, args.backup_min_bytes, now)
    metrics = None
    if args.sql_command:
        metrics = collect_metrics(args.sql_command, metrics_sql(args.ai_stuck_minutes), args.sql_timeout, runner)
        alerts += evaluate_metrics(metrics, args)
    stamp = datetime.datetime.fromtimestamp(now(), datetime.timezone.utc).isoformat(timespec='seconds')
    print(json.dumps({'schema': SCHEMA, 'at': stamp, 'label': args.label, 'alerts': alerts, **({'metrics': metrics} if metrics else {})}))
    code = 1 if alerts else 0
    state = load_state(args.state_file) if args.state_file else {'firing': {}}
    firing, resolved, new_state = plan_notification(alerts, state, now(), args.repeat_hours)
    if args.webhook_url_file and (firing is not None or resolved):
        try:
            send(read_webhook(args.webhook_url_file), {'schema': ALERT_SCHEMA, 'at': stamp, 'label': args.label, 'firing': firing or [], 'resolved': resolved}, args.timeout, opener)
        except Exception as error:
            # Keep the previous state so the next run retries; never print the URL or response.
            print(json.dumps({'schema': SCHEMA, 'notify': 'failed', 'reason': type(error).__name__}), file=sys.stderr)
            return 2
    if args.state_file:
        try: save_state(args.state_file, new_state)
        except OSError:
            print(json.dumps({'schema': SCHEMA, 'state': 'failed'}), file=sys.stderr)
            return 2
    return code

if __name__ == '__main__':
    sys.exit(run(sys.argv[1:]))
