"""Monitor tests with a simulated webhook receiver; no real destinations, databases or hosts."""
import contextlib, io, json, os, sys, tempfile, threading, unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from types import SimpleNamespace

sys.path.insert(0, os.path.dirname(__file__))
import check  # noqa: E402

GOOD = {'sync_pending': 0, 'sync_oldest_minutes': 0, 'sync_failed_24h': 0, 'ai_failed_24h': 0, 'ai_stuck': 0, 'errors_1h': 0, 'denied_1h': 0, 'db_bytes': 10_000_000}

class Receiver:
    """Local HTTP server standing in for the alert destination."""
    def __init__(self, status=204):
        received, self.status = [], status
        outer = self
        class Handler(BaseHTTPRequestHandler):
            def do_POST(self):
                received.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                self.send_response(outer.status); self.end_headers()
            def log_message(self, *_): pass
        self.received = received
        self.server = HTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f'http://127.0.0.1:{self.server.server_port}/hook/private-token-value'
    def close(self): self.server.shutdown(); self.server.server_close()

def runner(metrics=GOOD, code=0, stdout=None):
    def run(argv, **kwargs):
        assert 'json_build_object' in kwargs['input']
        return SimpleNamespace(returncode=code, stdout=stdout if stdout is not None else json.dumps(metrics) + '\n', stderr='private sql error detail')
    return run

class MonitorTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory(); self.addCleanup(self.dir.cleanup)
        self.state = os.path.join(self.dir.name, 'state.json')
        self.receiver = Receiver(); self.addCleanup(self.receiver.close)
        self.hook = os.path.join(self.dir.name, 'hook')
        with open(self.hook, 'w') as handle: handle.write(self.receiver.url + '\n')
        os.chmod(self.hook, 0o600)
        self.clock = [1_800_000_000.0]

    def run_monitor(self, *extra, metrics=GOOD, run=None, usage=lambda _path: (100, 10, 90)):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = check.run(['--sql-command', '["psql"]', '--state-file', self.state, '--webhook-url-file', self.hook, '--disk', '/data', *extra],
                             now=lambda: self.clock[0], runner=run or runner(metrics), usage=usage)
        self.assertNotIn('private-token-value', out.getvalue() + err.getvalue())
        self.assertNotIn('private sql error', out.getvalue() + err.getvalue())
        return code, out.getvalue(), err.getvalue()

    def test_healthy_run_sends_nothing(self):
        code, out, _ = self.run_monitor()
        self.assertEqual(code, 0); self.assertEqual(self.receiver.received, [])
        self.assertEqual(json.loads(out)['alerts'], [])

    def test_thresholds_fire_once_repeat_after_interval_and_resolve(self):
        bad = {**GOOD, 'sync_pending': 25, 'errors_1h': 6, 'ai_stuck': 1}
        code, out, _ = self.run_monitor(metrics=bad, usage=lambda _p: (100, 95, 5))
        self.assertEqual(code, 1)
        sent = self.receiver.received[0]
        self.assertEqual(sent['schema'], 'sugar.alert.v1')
        self.assertEqual({(a['check'], a['severity']) for a in sent['firing']}, {('disk:0', 'critical'), ('sync_pending', 'warning'), ('http_errors', 'critical'), ('ai_stuck', 'warning')})
        self.clock[0] += 600
        self.run_monitor(metrics=bad, usage=lambda _p: (100, 95, 5))
        self.assertEqual(len(self.receiver.received), 1, 'unchanged alerts are not repeated within the interval')
        self.clock[0] += 24 * 3600
        self.run_monitor(metrics=bad, usage=lambda _p: (100, 95, 5))
        self.assertEqual(len(self.receiver.received), 2, 'reminder after the repeat interval')
        self.clock[0] += 60
        self.assertEqual(self.run_monitor()[0], 0)
        self.assertEqual(self.receiver.received[-1]['firing'], [])
        self.assertEqual(self.receiver.received[-1]['resolved'], ['ai_stuck', 'disk:0', 'http_errors', 'sync_pending'])

    def test_severity_change_notifies_again(self):
        self.run_monitor(usage=lambda _p: (100, 85, 15))
        self.clock[0] += 60
        self.run_monitor(usage=lambda _p: (100, 92, 8))
        self.assertEqual([r['firing'][0]['severity'] for r in self.receiver.received], ['warning', 'critical'])

    def test_metrics_failure_is_an_alert_without_diagnostics(self):
        for run in (runner(code=1), runner(stdout='not json'), runner(metrics={**GOOD, 'errors_1h': 'x'}), runner(metrics={'sync_pending': 1})):
            code, out, _ = self.run_monitor(run=run)
            self.assertEqual(code, 1); self.assertEqual(json.loads(out)['alerts'], [{'check': 'metrics', 'severity': 'critical'}])

    def test_receiver_failure_exits_2_and_retries_next_run(self):
        self.receiver.status = 500
        code, _, err = self.run_monitor(metrics={**GOOD, 'denied_1h': 99})
        self.assertEqual(code, 2); self.assertIn('"notify": "failed"', err)
        self.assertFalse(os.path.exists(self.state), 'state is not advanced when delivery failed')
        self.receiver.status = 204
        self.clock[0] += 60
        self.assertEqual(self.run_monitor(metrics={**GOOD, 'denied_1h': 99})[0], 1)
        self.assertEqual([r['firing'][0]['check'] for r in self.receiver.received], ['denied', 'denied'])
        self.assertEqual(os.stat(self.state).st_mode & 0o777, 0o600)

    def test_webhook_file_must_be_private_and_https(self):
        os.chmod(self.hook, 0o644)
        self.assertEqual(self.run_monitor(metrics={**GOOD, 'ai_failed_24h': 9})[0], 2)
        os.chmod(self.hook, 0o600)
        with open(self.hook, 'w') as handle: handle.write('http://example.invalid/hook/private-token-value')
        self.assertEqual(self.run_monitor(metrics={**GOOD, 'ai_failed_24h': 9})[0], 2)
        self.assertEqual(self.receiver.received, [])

    def test_backup_age_and_size(self):
        backups = os.path.join(self.dir.name, 'backups'); os.mkdir(backups)
        args = ['--backup-dir', backups, '--backup-max-age-hours', '30']
        self.assertEqual(json.loads(self.run_monitor(*args)[1])['alerts'], [{'check': 'backup', 'severity': 'critical'}])
        path = os.path.join(backups, 'x-before-abc.dump')
        with open(path, 'wb') as handle: handle.write(b'0' * 2048)
        os.utime(path, (self.clock[0] - 3600, self.clock[0] - 3600))
        self.assertEqual(json.loads(self.run_monitor(*args)[1])['alerts'], [])
        os.utime(path, (self.clock[0] - 40 * 3600, self.clock[0] - 40 * 3600))
        self.assertEqual(json.loads(self.run_monitor(*args)[1])['alerts'], [{'check': 'backup', 'severity': 'warning', 'value': 40.0, 'threshold': 30.0}])
        self.assertEqual(json.loads(self.run_monitor('--backup-dir', backups)[1])['alerts'], [], 'age check is opt-in')

    def test_readiness_uses_only_the_minimal_contract(self):
        ready = Receiver()
        self.addCleanup(ready.close)
        # The receiver answers POST only, so a GET fails: readiness must alert, never raise.
        self.assertEqual(json.loads(self.run_monitor('--ready-url', ready.url)[1])['alerts'], [{'check': 'ready', 'severity': 'critical'}])

    def test_sql_is_static_apart_from_an_integer(self):
        self.assertIn('make_interval(mins => 15)', check.metrics_sql(15))
        with self.assertRaises(ValueError): check.metrics_sql('15); DROP TABLE users; --')

if __name__ == '__main__':
    unittest.main()
