"""Exercise real web Nginx framing policy, including the SPA internal redirect."""
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
import uuid

ROOT = Path(__file__).resolve().parents[2]


class EmbedHeadersTests(unittest.TestCase):
    def test_only_standalone_viewer_can_be_framed(self):
        name = 'sugar-embed-headers-' + uuid.uuid4().hex[:10]
        with tempfile.TemporaryDirectory(prefix=name) as temporary:
            folder = Path(temporary)
            folder.chmod(0o755)
            (folder / 'index.html').write_text('<!doctype html><title>Synthetic Sugar</title>')
            (folder / 'security-headers.conf').write_text((ROOT / 'web/security-headers.conf').read_text())
            config = (ROOT / 'web/nginx.conf').read_text().replace(
                '/etc/nginx/snippets/security-headers.conf', '/checks/security-headers.conf'
            ).replace('/usr/share/nginx/html', '/checks')
            (folder / 'nginx.conf').write_text('events {}\nhttp {\n' + config + '\n}\n')
            try:
                subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none',
                                '--mount', f'type=bind,src={folder},dst=/checks,readonly',
                                'nginx:1.30.6-alpine', 'nginx', '-g', 'daemon off;', '-c', '/checks/nginx.conf'],
                               check=True, stdout=subprocess.DEVNULL)
                for _ in range(30):
                    ready = subprocess.run(['docker', 'exec', name, 'wget', '-q', '-O', '/dev/null',
                                            'http://127.0.0.1/'], capture_output=True, timeout=10)
                    if ready.returncode == 0:
                        break
                    time.sleep(0.1)
                else:
                    logs = subprocess.run(['docker', 'logs', name], capture_output=True)
                    self.fail('Nginx fixture not ready: ' + logs.stderr.decode())
                public = '/embed/public/01234567-89ab-cdef-0123-456789abcdef'
                for path in ['/', '/login', '/?public=example', '/?privacy', '/?share=secret',
                             '/login?next=' + public, '/embed/public/bad-id', '/embed/shared/extra',
                             '/embed/shared/../login', '/embed/public/01234567-89ab-cdef-0123-456789abcdef%2f..%2flogin']:
                    headers = self.headers(name, path)
                    self.assertIn('frame-ancestors \'none\'', headers, path)
                    self.assertIn('x-frame-options: deny', headers, path)
                for path in [public, public + '?lang=en&theme=dark', '/embed/shared?token=synthetic', '/embed/shared']:
                    headers = self.headers(name, path)
                    self.assertIn('200 ok', headers, path)
                    self.assertIn('frame-ancestors *;', headers, path)
                    self.assertNotIn('x-frame-options:', headers, path)
                    self.assertIn('referrer-policy: no-referrer', headers, path)
                    self.assertIn('cache-control: private, no-store', headers, path)
                    self.assertIn("frame-src 'none'", headers, path)
            finally:
                subprocess.run(['docker', 'rm', '-f', name], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def headers(self, name, path):
        result = subprocess.run(['docker', 'exec', name, 'wget', '-S', '-O', '/dev/null',
                                 'http://127.0.0.1' + path], capture_output=True, timeout=10)
        return result.stderr.decode().lower()
