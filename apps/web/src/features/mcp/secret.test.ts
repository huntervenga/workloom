// @vitest-environment node
import { expect, it } from 'vitest';
import { encodeCredentialSecret } from './secret';
it('matches the canonical browser/bridge v1 hash and unpadded base64url public vector', async () => {
  const result = await encodeCredentialSecret('10000000-0000-4000-8000-000000000001', Uint8Array.from({ length: 32 }, (_, index) => index), globalThis.crypto.subtle);
  expect(result.secretHash).toBe('95ab16b90eaedb9f791d0a5e5f38fb8e551a58555e039771026539a5181356ac');
  expect(result.token).toBe('wlm_local_v1_10000000-0000-4000-8000-000000000001.AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8');
  expect(result.hashVersion).toBe(1);
});
