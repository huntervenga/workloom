import { t } from '../../i18n';
import { localMcpSecretPreimage } from '@workloom/contracts';
/** Side-effect-free local MCP v1 encoding. The returned token belongs only in private UI memory. */
export interface CredentialSecret {
  id: string;
  token: string;
  secretHash: string;
  hashVersion: 1;
}
export async function encodeCredentialSecret(id: string, bytes: Uint8Array<ArrayBuffer>, subtle: SubtleCrypto): Promise<CredentialSecret> {
  const canonicalId = id.toLowerCase();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(canonicalId) || bytes.length !== 32) throw new Error('Invalid local credential material.');
  const input = Uint8Array.from(localMcpSecretPreimage(canonicalId, bytes));
  const digest = new Uint8Array(await subtle.digest('SHA-256', input));
  const secret = btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join('')).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
  return { id: canonicalId, token: `wlm_local_v1_${canonicalId}.${secret}`, secretHash: Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''), hashVersion: 1 };
}
export async function generateCredentialSecret(): Promise<CredentialSecret> {
  if (!globalThis.crypto?.subtle || !globalThis.crypto.randomUUID || !globalThis.crypto.getRandomValues) throw new Error(t('mcp.thisBrowserCannotSecurelyGenerateALocalCredential'));
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try { return await encodeCredentialSecret(globalThis.crypto.randomUUID(), bytes, globalThis.crypto.subtle); }
  finally { bytes.fill(0); }
}
