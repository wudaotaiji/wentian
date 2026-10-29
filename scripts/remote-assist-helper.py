#!/usr/bin/env python3
"""同意付き遠隔支援のローカル入力プラグイン。標準ライブラリだけで動作します。

会議の映像はブラウザーが共有し、このプラグインは承認済みの入力だけを実行します。
外部インターフェースへは待受せず、指定Origin・一時トークン・操作許可を毎回検証します。
通常権限で実行してください。UACや別権限のデスクトップを迂回しません。
"""
import argparse
import ctypes
from ctypes import wintypes
import hmac
import json
import os
import secrets
import ssl
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse


class ConsentState:
    """OS入力から独立した許可管理。試験ではOSアダプターを模擬します。"""
    def __init__(self, adapter, clock=time.monotonic):
        self.adapter, self.clock = adapter, clock
        self.lock = threading.RLock()
        self.grant = None

    def revoke(self):
        with self.lock:
            self.grant = None
            self.adapter.release()

    def check(self, session):
        with self.lock:
            if self.grant and self.grant['id'] != session:
                raise ValueError('操作許可の識別子が一致しません。')
            if not self.grant or self.grant['expires'] <= self.clock() or self.grant['lease'] <= self.clock():
                self.revoke()
                raise ValueError('操作許可が失効しています。')
            return self.grant

    def approve(self, session, scope, name, origin):
        if not isinstance(session, str) or not 1 <= len(session) <= 100 or not isinstance(name, str) or not 1 <= len(name) <= 100:
            raise ValueError('申請情報が不正です。')
        with self.lock:
            self.revoke()
            choices = self.adapter.scopes()
            chosen = next((item for item in choices if item['id'] == scope), None)
            if not chosen or not self.adapter.confirm(name, chosen['name'], origin):
                raise ValueError('このPCでの操作を承認しませんでした。')
            now = self.clock()
            self.grant = {'id': session, 'scope': scope, 'rect': chosen.get('rect'), 'expires': now + 300, 'lease': now + 6}
            if hasattr(self.adapter, 'activate'): self.adapter.activate(scope)
            return {'approved': True, 'scope': chosen['name'], 'seconds': 300}

    def heartbeat(self, session):
        with self.lock:
            grant = self.check(session)
            grant['lease'] = self.clock() + 6

    def input(self, session, event):
        with self.lock:
            grant = self.check(session)
            if grant['scope'].startswith('screen:'):
                current = next((item for item in self.adapter.scopes() if item['id'] == grant['scope']), None)
                if not current or current.get('rect') != grant['rect']:
                    self.revoke()
                    raise ValueError('画面構成が変わったため、操作許可を解除しました。')
            self.adapter.apply(grant['scope'], event)


class WindowsInput:
    """SendInputで共有対象だけを操作し、押下状態は取消・失効時に解放します。"""
    def __init__(self, language='ja'):
        if os.name != 'nt':
            raise RuntimeError('この入力プラグインはWindows用です。')
        self.api = ctypes.windll.user32
        self.language = language
        try:
            self.api.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
        except (AttributeError, OSError):
            self.api.SetProcessDPIAware()
        self.api.GetForegroundWindow.restype = wintypes.HWND
        self.api.IsWindowVisible.argtypes = [wintypes.HWND]
        self.api.IsIconic.argtypes = [wintypes.HWND]
        self.api.GetWindowTextLengthW.argtypes = [wintypes.HWND]
        self.api.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
        self.api.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
        self.api.SetForegroundWindow.argtypes = [wintypes.HWND]
        self.dwm = ctypes.windll.dwmapi
        self.dwm.DwmGetWindowAttribute.argtypes = [wintypes.HWND, wintypes.DWORD, ctypes.c_void_p, wintypes.DWORD]
        self.api.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
        self.api.GetAncestor.restype = wintypes.HWND
        self.api.WindowFromPoint.argtypes = [wintypes.POINT]
        self.api.WindowFromPoint.restype = wintypes.HWND
        self.keys, self.buttons = set(), set()
        self.last, self.rate = 0, 0

    def scopes(self):
        result = []
        callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HANDLE, wintypes.HDC, ctypes.POINTER(wintypes.RECT), wintypes.LPARAM)
        def monitor(_handle, _dc, rect, _data):
            r = rect.contents
            result.append({'id': 'screen:' + str(len(result)), 'name': {'ja': '画面', 'en': 'Screen', 'zh': '屏幕'}[self.language] + ' ' + str(len(result) + 1) + ' (' + str(r.right-r.left) + '×' + str(r.bottom-r.top) + ')', 'rect': [r.left, r.top, r.right, r.bottom]})
            return True
        self.api.EnumDisplayMonitors(None, None, callback_type(monitor), 0)
        callback_window = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def window(handle, _data):
            if self.api.IsWindowVisible(handle) and not self.api.IsIconic(handle) and self.api.GetWindowTextLengthW(handle):
                title = ctypes.create_unicode_buffer(301)
                self.api.GetWindowTextW(handle, title, 300)
                rect = wintypes.RECT()
                self.api.GetWindowRect(handle, ctypes.byref(rect))
                # 透明なリサイズ枠を除いた実表示領域へ、共有映像の座標を対応させます。
                visible = wintypes.RECT()
                if self.dwm.DwmGetWindowAttribute(handle, 9, ctypes.byref(visible), ctypes.sizeof(visible)) == 0: rect = visible
                if rect.right > rect.left and rect.bottom > rect.top:
                    result.append({'id': 'window:' + str(handle), 'name': title.value, 'rect': [rect.left, rect.top, rect.right, rect.bottom]})
            return True
        self.api.EnumWindows(callback_window(window), 0)
        return result

    def activate(self, scope):
        if scope.startswith('window:'): self.api.SetForegroundWindow(int(scope.split(':')[1]))

    def confirm(self, name, scope, origin):
        words = {
            'ja': ('遠隔操作を許可しますか？', '相手', '会議', '対象', 'ブラウザーで共有した対象と一致することを確認してください。最大5分間。\n緊急停止: Ctrl+Alt+Pause。このPCの操作権限を相手へ渡します。'),
            'en': ('Allow remote control?', 'Controller', 'Meeting', 'Target', 'Confirm that this target matches the shared screen or app. Maximum 5 minutes.\nEmergency stop: Ctrl+Alt+Pause. This grants control of the selected target.'),
            'zh': ('允许远程控制吗？', '操作人', '会议', '目标', '请确认目标与浏览器共享的桌面或应用一致，最长5分钟。\n紧急停止：Ctrl+Alt+Pause。将授予对方所选目标的操作权限。'),
        }[self.language]
        text = words[0]+'\n\n'+words[1]+': '+name+'\n'+words[2]+': '+origin+'\n'+words[3]+': '+scope+'\n\n'+words[4]
        return self.api.MessageBoxW(None, text, 'Wentian', 0x00000004 | 0x00000100 | 0x00040000) == 6

    def send(self, kind, a=0, flags=0, data=0):
        class Mouse(ctypes.Structure):
            _fields_ = [('dx', wintypes.LONG), ('dy', wintypes.LONG), ('mouseData', wintypes.DWORD), ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]
        class Keyboard(ctypes.Structure):
            _fields_ = [('wVk', wintypes.WORD), ('wScan', wintypes.WORD), ('dwFlags', wintypes.DWORD), ('time', wintypes.DWORD), ('dwExtraInfo', ctypes.c_size_t)]
        class Payload(ctypes.Union):
            _fields_ = [('mi', Mouse), ('ki', Keyboard)]
        class Input(ctypes.Structure):
            _fields_ = [('type', wintypes.DWORD), ('payload', Payload)]
        event = Input()
        event.type = kind
        if kind == 1:
            event.payload.ki = Keyboard(0 if flags & 4 else a, a if flags & 4 else 0, flags, 0, 0)
        else:
            event.payload.mi = Mouse(0, 0, data & 0xffffffff, flags, 0, 0)
        if self.api.SendInput(1, ctypes.byref(event), ctypes.sizeof(event)) != 1:
            raise ValueError('入力できませんでした。対象の権限やデスクトップを確認してください。')

    def release(self):
        for key in list(self.keys):
            try: self.send(1, key, 2)
            except ValueError: pass
        for button in list(self.buttons):
            try: self.send(0, flags={0: 4, 1: 0x40, 2: 0x10}[button])
            except ValueError: pass
        self.keys.clear()
        self.buttons.clear()

    def apply(self, scope, event):
        now = time.monotonic()
        if now - self.last >= 1:
            self.last, self.rate = now, 0
        self.rate += 1
        if self.rate > 200 or not isinstance(event, dict):
            raise ValueError('入力の形式または頻度が不正です。')
        selected = next((item for item in self.scopes() if item['id'] == scope), None)
        if not selected:
            raise ValueError('共有対象が閉じられています。')
        handle = int(scope.split(':')[1]) if scope.startswith('window:') else None
        if handle and self.api.GetAncestor(self.api.GetForegroundWindow(), 2) != handle:
            raise ValueError('共有したAPPを手元で前面にしてください。')
        kind = event.get('kind')
        if kind in ('move', 'button', 'wheel'):
            x, y = event.get('x'), event.get('y')
            if isinstance(x, bool) or isinstance(y, bool) or not isinstance(x, (int, float)) or not isinstance(y, (int, float)) or not (0 <= x <= 1 and 0 <= y <= 1):
                raise ValueError('入力位置が不正です。')
            left, top, right, bottom = selected['rect']
            px, py = left + round(x*(right-left-1)), top + round(y*(bottom-top-1))
            if handle and self.api.GetAncestor(self.api.WindowFromPoint(wintypes.POINT(px, py)), 2) != handle:
                raise ValueError('共有対象が別のウィンドウに覆われています。')
            if kind == 'button' and (type(event.get('button')) is not int or event['button'] not in (0, 1, 2) or type(event.get('down')) is not bool):
                raise ValueError('マウス入力が不正です。')
            if kind == 'wheel' and (type(event.get('delta')) is not int or abs(event['delta']) > 1200):
                raise ValueError('スクロール量が不正です。')
            self.api.SetCursorPos(px, py)
            if kind == 'button':
                button, down = event.get('button'), event.get('down')
                if type(button) is not int or button not in (0, 1, 2) or type(down) is not bool:
                    raise ValueError('マウス入力が不正です。')
                self.send(0, flags=({0: 2, 1: 0x20, 2: 8} if down else {0: 4, 1: 0x40, 2: 0x10})[button])
                (self.buttons.add if down else self.buttons.discard)(button)
            elif kind == 'wheel':
                delta = event.get('delta')
                if type(delta) is not int or abs(delta) > 1200: raise ValueError('スクロール量が不正です。')
                self.send(0, flags=0x800, data=delta)
        elif kind == 'key':
            code, down = event.get('code'), event.get('down')
            if handle and (code in ('MetaLeft', 'MetaRight', 'PrintScreen') or code == 'Tab' and self.keys.intersection({164, 165}) or code in ('Escape', 'Delete') and self.keys.intersection({162, 163, 164, 165})):
                raise ValueError('APP共有ではOS全体へのショートカットを許可しません。')
            keys = {'Enter': 13, 'Tab': 9, 'Escape': 27, 'Backspace': 8, 'Delete': 46, 'Space': 32, 'ArrowLeft': 37, 'ArrowUp': 38, 'ArrowRight': 39, 'ArrowDown': 40, 'Home': 36, 'End': 35, 'PageUp': 33, 'PageDown': 34, 'ShiftLeft': 160, 'ShiftRight': 161, 'ControlLeft': 162, 'ControlRight': 163, 'AltLeft': 164, 'AltRight': 165, 'MetaLeft': 91, 'MetaRight': 92, 'Minus': 189, 'Equal': 187, 'Comma': 188, 'Period': 190, 'Slash': 191, 'Semicolon': 186, 'Quote': 222, 'BracketLeft': 219, 'BracketRight': 221, 'Backslash': 220, 'Backquote': 192}
            if isinstance(code, str) and len(code) == 4 and code.startswith('Key') and 'A' <= code[3] <= 'Z': keys[code] = ord(code[3])
            if isinstance(code, str) and len(code) == 6 and code.startswith('Digit') and code[5].isdigit(): keys[code] = ord(code[5])
            keys.update({'F'+str(i): 111+i for i in range(1, 13)})
            keys.update({'Numpad'+str(i): 96+i for i in range(10)})
            keys.update({'CapsLock': 20, 'NumLock': 144, 'ScrollLock': 145, 'Insert': 45, 'PrintScreen': 44, 'Pause': 19, 'NumpadEnter': 13, 'NumpadAdd': 107, 'NumpadSubtract': 109, 'NumpadMultiply': 106, 'NumpadDivide': 111, 'NumpadDecimal': 110, 'IntlBackslash': 226, 'IntlRo': 193, 'IntlYen': 220, 'Convert': 28, 'NonConvert': 29, 'KanaMode': 21})
            if code not in keys or type(down) is not bool: raise ValueError('このキーには対応していません。')
            self.send(1, keys[code], 0 if down else 2)
            (self.keys.add if down else self.keys.discard)(keys[code])
        elif kind == 'text':
            text = event.get('text')
            if not isinstance(text, str) or not 1 <= len(text) <= 64: raise ValueError('文字列は64文字以内で指定してください。')
            encoded = text.encode('utf-16-le')
            for i in range(0, len(encoded), 2):
                unit = int.from_bytes(encoded[i:i+2], 'little')
                self.send(1, unit, 4)
                self.send(1, unit, 6)
        elif kind == 'release': self.release()
        else: raise ValueError('入力の種類が不正です。')


def create_helper_server(origin, port, state, token, certificate=None, key=None):
    """HTTP契約を分離し、試験では実際のOS入力を起動しません。"""
    adapter = state.adapter
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args): pass  # トークンやキー入力をログへ残しません。
        def allowed(self):
            return self.headers.get('Origin') == origin and self.headers.get('Host') in ('127.0.0.1:'+str(port), 'localhost:'+str(port))
        def answer(self, status, data):
            self.send_response(status)
            if self.allowed():
                self.send_header('Access-Control-Allow-Origin', origin)
                self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                self.send_header('Access-Control-Allow-Headers', 'authorization, content-type')
                self.send_header('Access-Control-Allow-Private-Network', 'true')
                self.send_header('Vary', 'Origin')
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            self.wfile.write(json.dumps(data, ensure_ascii=False).encode('utf-8'))
        def do_OPTIONS(self): self.answer(200 if self.allowed() else 403, {})
        def authenticated(self):
            return self.allowed() and hmac.compare_digest(self.headers.get('Authorization', ''), 'Bearer '+token)
        def do_GET(self):
            if not self.authenticated(): return self.answer(403, {'error': '本人用の接続キーを確認してください。'})
            if self.path != '/status': return self.answer(404, {})
            self.answer(200, {'contract': 'wentian-remote-assist/1', 'platform': 'windows', 'scopes': adapter.scopes()})
        def do_POST(self):
            if not self.authenticated(): return self.answer(403, {'error': '接続を許可しませんでした。'})
            try:
                length = int(self.headers.get('Content-Length', 0))
                if not 0 < length <= 8192: raise ValueError('入力容量が不正です。')
                data = json.loads(self.rfile.read(length))
                if self.path == '/approve': result = state.approve(data.get('session'), data.get('scope'), data.get('name'), origin)
                elif self.path == '/heartbeat': state.heartbeat(data.get('session')); result = {'ok': True}
                elif self.path == '/input': state.input(data.get('session'), data.get('event')); result = {'ok': True}
                elif self.path == '/revoke':
                    if state.grant and data.get('session') != state.grant['id']: raise ValueError('操作許可の識別子が一致しません。')
                    state.revoke(); result = {'ok': True}
                else: return self.answer(404, {})
                self.answer(200, result)
            except (ValueError, TypeError, KeyError) as error: self.answer(400, {'error': str(error)})
    server = ThreadingHTTPServer(('127.0.0.1', port), Handler)
    port = server.server_address[1]
    if certificate:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(certificate, key)
        server.socket = context.wrap_socket(server.socket, server_side=True)
    return server


def serve(origin, port, certificate=None, key=None, language='ja'):
    adapter = WindowsInput(language)
    state = ConsentState(adapter)
    token = secrets.token_urlsafe(32)
    server = create_helper_server(origin, port, state, token, certificate, key)
    def expire():
        while True:
            time.sleep(0.1)
            with state.lock:
                emergency = all(adapter.api.GetAsyncKeyState(key) & 0x8000 for key in (17, 18, 19))
                if state.grant and (emergency or state.grant['lease'] <= state.clock() or state.grant['expires'] <= state.clock()): state.revoke()
    threading.Thread(target=expire, daemon=True).start()
    print('Wentian遠隔支援ヘルパーを起動しました。会議画面の本人用接続キーへ次の値を入力してください。', flush=True)
    print(token, flush=True)
    print('許可する会議: '+origin+' / 待受: '+('https' if certificate else 'http')+'://127.0.0.1:'+str(port)+' / 終了: Ctrl+C', flush=True)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: state.revoke(); server.server_close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='本人の同意付きでWindowsの共有対象を遠隔操作します。')
    parser.add_argument('--origin', required=True, help='会議画面のOrigin。例: https://あなたのホスト名')
    parser.add_argument('--port', type=int, default=8791)
    parser.add_argument('--cert', help='任意のローカルHTTPS証明書')
    parser.add_argument('--key', help='HTTPS証明書の秘密鍵')
    parser.add_argument('--language', choices=['ja', 'en', 'zh'], default='ja', help='PC上の確認画面の言語')
    args = parser.parse_args()
    parsed = urlparse(args.origin)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.path or parsed.query or parsed.fragment or parsed.username or not 1024 <= args.port <= 65535 or bool(args.cert) != bool(args.key): parser.error('Origin、ポート、証明書と鍵の組み合わせを確認してください。')
    serve(args.origin, args.port, args.cert, args.key, args.language)
