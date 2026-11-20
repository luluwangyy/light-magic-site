"""Exercise the loopback HTTP handler without a network or a desk connection."""

import io
import json
import threading
import unittest

from app import RequestAccess, request_handler


LOCAL_HOST = '127.0.0.1:8765'
SHARED_HOST = 'lights.example.test:9443'
SHARED_ORIGIN = 'https://' + SHARED_HOST
PROXY_KEY = 'a-test-proxy-key-0123456789-abcdefghijk'
SESSION_TOKEN = 'test-session-token'


class MemoryConnection:
    def __init__(self, request):
        self.request = io.BytesIO(request)
        self.response = io.BytesIO()

    def makefile(self, mode, *args):
        assert mode == 'rb'
        return self.request

    def sendall(self, data):
        self.response.write(data)


class FakeController:
    def __init__(self):
        self.lock = threading.RLock()
        self.actions = []

    def state(self):
        return {'armed': False}

    def action(self, action, data, client):
        self.actions.append((action, client))
        return self.state()


class SharedBrowserTests(unittest.TestCase):
    def setUp(self):
        self.controller = FakeController()
        self.access = RequestAccess(8765, SHARED_ORIGIN, PROXY_KEY)

    def request(self, method, path, *headers, access=None, token=SESSION_TOKEN):
        body = b''
        if method == 'POST':
            body = json.dumps({'token': token, 'client': 'test-browser'}).encode('utf-8')
            headers += (('Content-Length', str(len(body))), ('Content-Type', 'application/json'))
        request = [f'{method} {path} HTTP/1.1', 'Connection: close',
                   *(f'{name}: {value}' for name, value in headers), '', '']
        connection = MemoryConnection('\r\n'.join(request).encode('iso-8859-1') + body)
        handler = request_handler(self.controller, SESSION_TOKEN, access or self.access)
        handler(connection, ('127.0.0.1', 50000), None)
        response = connection.response.getvalue()
        raw_headers, _, body = response.partition(b'\r\n\r\n')
        status = int(raw_headers.split(maxsplit=2)[1])
        return status, raw_headers, body

    def test_default_accepts_local_workflow_and_rejects_external_host(self):
        local = RequestAccess(8765, proxy_key=PROXY_KEY)
        status, _, body = self.request('GET', '/api/state', ('Host', LOCAL_HOST), access=local)
        self.assertEqual(status, 200)
        self.assertEqual(json.loads(body)['token'], SESSION_TOKEN)
        for headers in ((), (('Origin', 'http://' + LOCAL_HOST),)):
            status, _, _ = self.request('POST', '/api/heartbeat', ('Host', LOCAL_HOST), *headers, access=local)
            self.assertEqual(status, 200)
        status, _, _ = self.request('POST', '/api/heartbeat', ('Host', LOCAL_HOST),
                                    ('Origin', SHARED_ORIGIN), access=local)
        self.assertEqual(status, 403)
        status, _, body = self.request('GET', '/api/state', ('Host', SHARED_HOST),
                                       ('X-Light-Magic-Proxy-Key', PROXY_KEY), access=local)
        self.assertEqual(status, 403)
        self.assertNotIn(SESSION_TOKEN.encode(), body)
        self.assertEqual(len(self.controller.actions), 2)

    def test_shared_auth_is_required_for_static_files_and_state(self):
        for path in ('/', '/app.js', '/api/state'):
            with self.subTest(path=path):
                headers = (('Host', SHARED_HOST),)
                self.assertEqual(self.request('GET', path, *headers)[0], 403)
                self.assertEqual(self.request('GET', path, *headers, ('X-Light-Magic-Proxy-Key', 'wrong'))[0], 403)
                status, response_headers, body = self.request('GET', path, *headers,
                                                              ('X-Light-Magic-Proxy-Key', PROXY_KEY))
                self.assertEqual(status, 200)
                self.assertIn(b'Cache-Control: no-store', response_headers)
                self.assertNotIn(b'access-control-allow-origin', response_headers.lower())
                self.assertNotIn(PROXY_KEY.encode(), body)
        self.assertEqual(self.controller.actions, [])

    def test_shared_post_requires_exact_origin_and_current_session_token(self):
        headers = (('Host', SHARED_HOST), ('X-Light-Magic-Proxy-Key', PROXY_KEY))
        for origin in (None, 'null', SHARED_ORIGIN + '/', SHARED_ORIGIN + '.other',
                       'http://' + SHARED_HOST, 'https://lights.example.test'):
            with self.subTest(origin=origin):
                provided = (('Origin', origin),) if origin is not None else ()
                self.assertEqual(self.request('POST', '/api/heartbeat', *headers, *provided)[0], 403)
        exact = ('Origin', SHARED_ORIGIN)
        self.assertEqual(self.request('POST', '/api/heartbeat', *headers, exact, token='wrong')[0], 403)
        self.assertEqual(self.request('POST', '/api/heartbeat', *headers, exact, exact)[0], 403)
        self.assertEqual(self.request('POST', '/api/heartbeat', *headers, exact)[0], 200)
        self.assertEqual(self.controller.actions, [('heartbeat', 'test-browser')])

    def test_other_hosts_and_ambiguous_headers_are_denied(self):
        key = ('X-Light-Magic-Proxy-Key', PROXY_KEY)
        for headers in (
            (('Host', SHARED_HOST + '.other'), key),
            (('Host', LOCAL_HOST), key),
            (('Host', SHARED_HOST), ('Host', LOCAL_HOST), key),
            (('Host', SHARED_HOST), key, key),
            (('Host', SHARED_HOST), ('X-Light-Magic-Proxy-Key', 'café')),
            (('Host', 'foreign.example.test'), ('X-Forwarded-Host', SHARED_HOST), key),
        ):
            with self.subTest(headers=headers):
                status, _, body = self.request('GET', '/api/state', *headers)
                self.assertEqual(status, 403)
                self.assertNotIn(SESSION_TOKEN.encode(), body)
                self.assertNotIn(PROXY_KEY.encode(), body)

    def test_shared_mode_preserves_local_access(self):
        status, _, _ = self.request('POST', '/api/heartbeat', ('Host', 'localhost:8765'),
                                    ('Origin', 'http://localhost:8765'))
        self.assertEqual(status, 200)

    def test_requires_valid_https_origin_and_proxy_key(self):
        for origin in ('http://lights.example.test', 'https://lights.example.test/',
                       'https://lights.example.test?mode=live', 'https://lights.example.test#session',
                       'https://operator@lights.example.test', 'https://lights.example.test:65536',
                       'https://lights.example.test:0', 'https://*.example.test',
                       'https://localhost:8765', 'https://lights.example.test\\unsafe'):
            with self.subTest(origin=origin), self.assertRaises(ValueError):
                RequestAccess(8765, origin, PROXY_KEY)
        for key in (None, 'short', PROXY_KEY + '\n'):
            with self.subTest(valid=False), self.assertRaisesRegex(ValueError, 'LIGHT_MAGIC_PROXY_KEY'):
                RequestAccess(8765, SHARED_ORIGIN, key)
        self.assertEqual(RequestAccess(8765, 'https://lights.example.test:443', PROXY_KEY).shared_origin,
                         'https://lights.example.test')
