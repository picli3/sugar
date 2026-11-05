import copy
import unittest
from check import validate


class PolicyTests(unittest.TestCase):
    def config(self):
        return {'services': {'api': {
            'user': '1000:1000', 'init': True, 'read_only': True, 'cap_drop': ['ALL'],
            'security_opt': ['no-new-privileges:true'], 'pids_limit': 128,
            'tmpfs': ['/tmp:rw,noexec,nosuid,nodev,size=16m,mode=1777'],
        }}}

    def test_expected_policy(self):
        self.assertEqual(validate(self.config()), [])

    def test_missing_policy(self):
        self.assertTrue(validate({}))

    def test_reject_regressions(self):
        changes = {'user': '0:0', 'read_only': False, 'init': False, 'cap_drop': [],
                   'cap_add': ['SYS_ADMIN'], 'security_opt': [], 'pids_limit': -1,
                   'privileged': True, 'pid': 'host', 'ipc': 'host', 'network_mode': 'host',
                   'volumes': [{'target': '/app', 'read_only': False}], 'tmpfs': ['/tmp:size=1g']}
        for name, value in changes.items():
            with self.subTest(name=name):
                config = copy.deepcopy(self.config())
                config['services']['api'][name] = value
                self.assertTrue(validate(config))

    def test_shared_github_credentials_are_rejected(self):
        config = self.config()
        config['services']['api'].setdefault('environment', {})['GITHUB_PRIVATE_KEY'] = 'synthetic-unused'
        self.assertTrue(validate(config))
