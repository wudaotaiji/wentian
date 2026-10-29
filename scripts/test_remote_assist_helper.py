"""模擬OSアダプターだけを使い、許可・失効・HTTP認証を隔離試験します。"""
import importlib.util
import json
from pathlib import Path
import threading
import unittest
import urllib.error
import urllib.request

spec = importlib.util.spec_from_file_location('remote_assist', Path(__file__).with_name('remote-assist-helper.py'))
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class Adapter:
    def __init__(self): self.confirmed = True; self.events = []; self.releases = 0; self.rect = [0, 0, 100, 100]
    def scopes(self): return [{'id': 'screen:0', 'name': '試験画面', 'rect': self.rect}]
    def confirm(self, *_args): return self.confirmed
    def apply(self, scope, event): self.events.append((scope, event))
    def release(self): self.releases += 1


class ConsentTests(unittest.TestCase):
    def setUp(self):
        self.adapter = Adapter(); self.now = 0
        self.state = module.ConsentState(self.adapter, lambda: self.now)

    def test_本人承認より前と拒否後の入力を許可しない(self):
        with self.assertRaises(ValueError): self.state.input('s', {})
        self.adapter.confirmed = False
        with self.assertRaises(ValueError): self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test')
        self.assertEqual(self.adapter.events, [])

    def test_対象と申請IDを検証し有効な許可だけで入力する(self):
        with self.assertRaises(ValueError): self.state.approve('s', 'unknown', '試験担当', 'https://meeting.test')
        self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test')
        with self.assertRaises(ValueError): self.state.input('wrong', {})
        self.state.input('s', {'kind': 'move', 'x': 0.5, 'y': 0.5})
        self.assertEqual(len(self.adapter.events), 1)

    def test_ハートビート途絶と絶対期限で許可と押下状態を解除する(self):
        self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test')
        self.now = 5; self.state.heartbeat('s'); self.now = 12
        with self.assertRaises(ValueError): self.state.input('s', {})
        self.assertIsNone(self.state.grant)
        self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test')
        self.now = 313
        with self.assertRaises(ValueError): self.state.heartbeat('s')
        self.assertGreater(self.adapter.releases, 1)

    def test_画面の配置変更と取消で入力を停止する(self):
        self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test')
        self.adapter.rect = [100, 0, 200, 100]
        with self.assertRaises(ValueError): self.state.input('s', {})
        self.assertIsNone(self.state.grant)
        self.state.approve('s', 'screen:0', '試験担当', 'https://meeting.test'); self.state.revoke()
        with self.assertRaises(ValueError): self.state.input('s', {})

    def test_HTTPはループバックでOriginと一時接続キーを要求する(self):
        server = module.create_helper_server('https://meeting.test', 0, self.state, 'isolated-token')
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        address = 'http://127.0.0.1:' + str(server.server_address[1])
        try:
            for headers in [{}, {'Origin': 'https://foreign.test', 'Authorization': 'Bearer isolated-token'}, {'Origin': 'https://meeting.test', 'Authorization': 'Bearer wrong'}]:
                with self.assertRaises(urllib.error.HTTPError) as error: urllib.request.urlopen(urllib.request.Request(address+'/status', headers=headers))
                self.assertEqual(error.exception.code, 403)
            headers = {'Origin': 'https://meeting.test', 'Authorization': 'Bearer isolated-token', 'Content-Type': 'application/json'}
            with urllib.request.urlopen(urllib.request.Request(address+'/status', headers=headers)) as response:
                self.assertEqual(response.headers['Access-Control-Allow-Origin'], 'https://meeting.test')
                self.assertNotIn('isolated-token', response.read().decode())
            data = json.dumps({'session': 's', 'scope': 'screen:0', 'name': '試験担当'}).encode()
            with urllib.request.urlopen(urllib.request.Request(address+'/approve', data=data, headers=headers)) as response: self.assertTrue(json.load(response)['approved'])
            data = json.dumps({'session': 's', 'event': {'kind': 'move'}}).encode()
            with urllib.request.urlopen(urllib.request.Request(address+'/input', data=data, headers=headers)) as response: self.assertTrue(json.load(response)['ok'])
        finally: server.shutdown(); server.server_close(); thread.join()

    def test_Windows入力の変換と不正入力の拒否は実際のOSへ入力しない(self):
        adapter = module.WindowsInput.__new__(module.WindowsInput)
        adapter.keys, adapter.buttons, adapter.last, adapter.rate = set(), set(), 0, 0
        moved, sent = [], []
        class Api:
            def SetCursorPos(self, x, y): moved.append((x, y))
            def GetForegroundWindow(self): return 1
            def GetAncestor(self, handle, _kind): return handle
        adapter.api = Api()
        adapter.scopes = lambda: [{'id': 'screen:0', 'name': '試験', 'rect': [100, 200, 300, 400]}]
        adapter.send = lambda *args, **kwargs: sent.append((args, kwargs))
        adapter.apply('screen:0', {'kind': 'move', 'x': 0.5, 'y': 0.5})
        self.assertEqual(moved, [(200, 300)])
        with self.assertRaises(ValueError): adapter.apply('screen:0', {'kind': 'button', 'x': 0.1, 'y': 0.2, 'button': 8, 'down': True})
        with self.assertRaises(ValueError): adapter.apply('screen:0', {'kind': 'move', 'x': 2, 'y': 0})
        self.assertEqual(len(moved), 1)
        adapter.apply('screen:0', {'kind': 'key', 'code': 'ControlLeft', 'down': True})
        self.assertIn(162, adapter.keys)
        adapter.apply('screen:0', {'kind': 'text', 'text': '記'})
        self.assertTrue(any(item[0] == (1, ord('記'), 4) for item in sent))
        adapter.release(); self.assertEqual(adapter.keys, set())
        adapter.scopes = lambda: [{'id': 'window:1', 'name': '試験APP', 'rect': [100, 200, 300, 400]}]
        before = len(sent)
        with self.assertRaises(ValueError): adapter.apply('window:1', {'kind': 'key', 'code': 'MetaLeft', 'down': True})
        self.assertEqual(len(sent), before)


if __name__ == '__main__': unittest.main(verbosity=2)
