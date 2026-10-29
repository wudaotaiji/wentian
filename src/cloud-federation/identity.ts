import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, verify, type KeyObject } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { FederationError, PROTOCOL, type Envelope, type PublicIdentity } from './contracts.js';

/** JSON表現を正規化し、キー順の違いを署名や再送契約の差にしません。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
  throw new FederationError('署名対象にJSON以外の値は使用できません。');
}
export const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
export function groupIdFor(a: string, b: string): string {
  const hex = digest([a, b].sort()).slice(0, 32);
  return 'group-' + [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20)].join('-');
}
export function publicIdentity(publicKey: string): PublicIdentity {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== 'ed25519') throw new FederationError('Ed25519の公開鍵を指定してください。');
  const normalized = key.export({ type: 'spki', format: 'pem' }).toString();
  return { nodeId: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'), publicKey: normalized };
}
export interface StoredIdentity extends PublicIdentity { protectedKey: string; protection: 'dpapi' | 'file-0600' }
const execute = promisify(execFile);
/** Windows秘密鍵はDPAPIで同一利用者へ束縛し、引数やログへ秘密値を出しません。 */
async function protect(value: string, decrypt = false): Promise<string> {
  if (process.platform !== 'win32') return value;
  const script = decrypt
    ? 'Add-Type -AssemblyName System.Security; [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($env:WENTIAN_FEDERATION_KEY_INPUT),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))'
    : 'Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($env:WENTIAN_FEDERATION_KEY_INPUT),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))';
  const result = await execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 15000, env: { ...process.env, WENTIAN_FEDERATION_KEY_INPUT: value }, encoding: 'utf8' });
  return result.stdout.trim();
}
export async function createIdentity(): Promise<StoredIdentity> {
  const keys = generateKeyPairSync('ed25519');
  return { ...publicIdentity(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString()), protectedKey: await protect(keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()), protection: process.platform === 'win32' ? 'dpapi' : 'file-0600' };
}
export async function unlock(identity: StoredIdentity): Promise<KeyObject> {
  if (identity.protection !== (process.platform === 'win32' ? 'dpapi' : 'file-0600')) throw new FederationError('秘密鍵の保護方式がこのOSと一致しません。');
  const key = createPrivateKey(await protect(identity.protectedKey, true));
  if (publicIdentity(createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString()).nodeId !== identity.nodeId) throw new FederationError('保存した識別鍵が一致しません。');
  return key;
}
export function seal(key: KeyObject, sender: string, recipient: string, path: string, payload: unknown, now = Date.now()): Envelope {
  const unsigned = { protocol: PROTOCOL, sender, recipient, groupId: groupIdFor(sender, recipient), path, timestamp: now, nonce: randomBytes(24).toString('hex'), payload };
  return { ...unsigned, signature: sign(null, Buffer.from(canonical(unsigned)), key).toString('base64') };
}
export function verifyEnvelope(value: Envelope, peer: PublicIdentity, recipient: string, path: string, now = Date.now()): void {
  if (!value || value.protocol !== PROTOCOL || value.sender !== peer.nodeId || value.recipient !== recipient || value.path !== path || !Number.isSafeInteger(value.timestamp) || Math.abs(now - value.timestamp) > 60000 || typeof value.nonce !== 'string' || !/^[a-f0-9]{48}$/.test(value.nonce) || typeof value.signature !== 'string' || value.signature.length > 200) throw new FederationError('署名契約・宛先・有効期限が不正です。', 401);
  if (value.groupId !== groupIdFor(peer.nodeId, recipient)) throw new FederationError('A2Aグループの対応が一致しません。', 401);
  const { signature, ...unsigned } = value;
  if (!verify(null, Buffer.from(canonical(unsigned)), peer.publicKey, Buffer.from(signature, 'base64'))) throw new FederationError('相手の署名を検証できません。', 401);
}
