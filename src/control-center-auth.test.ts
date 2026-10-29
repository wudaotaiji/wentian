import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ControlCenterAuthStore, parseCookie, sessionCookie } from './control-center-auth.js';

test('ユーザーを安全に永続化し、ログインセッションを検証できる', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wentian-auth-'));
  const file = path.join(root, 'users.json');
  try {
    const store = new ControlCenterAuthStore(file);
    await store.initialize();
    const user = await store.createUser({ username: 'admin-user', password: 'long-test-password', role: 'admin' });
    assert.equal(user.role, 'admin');
    const saved = await readFile(file, 'utf8');
    assert.doesNotMatch(saved, /long-test-password/);
    assert.match(saved, /scrypt:/);
    const login = await store.login('admin-user', 'long-test-password');
    assert.ok(login);
    assert.equal(store.authenticate(login.token)?.username, 'admin-user');
    store.logout(login.token);
    assert.equal(store.authenticate(login.token), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('セッションCookieはHttpOnlyかつSameSite Strictである', () => {
  const cookie = sessionCookie('secret-token', 3600, true);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(parseCookie(cookie, 'wentian_session'), 'secret-token');
});
