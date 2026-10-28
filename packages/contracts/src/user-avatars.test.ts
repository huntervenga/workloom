import { describe, expect, it } from 'vitest';
import { profilePhotoUrlSchema, safeProfilePhotoUrl, safeUserAvatarUrl, uploadedAvatarUrl } from './profile-photo.js';
const user = '10000000-0000-4000-8000-000000000001', image = '10000000-0000-4000-8000-000000000002';
describe('uploaded avatar URLs', () => {
  it('accepts only the exact authenticated path while provider inputs stay HTTPS-only', () => {
    const url = uploadedAvatarUrl(user, image);
    expect(safeUserAvatarUrl(url)).toBe(url); expect(profilePhotoUrlSchema.parse(url)).toBe(url);
    expect(safeProfilePhotoUrl(url)).toBeNull();
    for (const invalid of [`/${url}`, `${url}?next=https://evil.example`, `${url}#x`, `${url}/../x`, '/api/v1/me', 'javascript:alert(1)', '//evil.com/x']) {
      expect(safeUserAvatarUrl(invalid)).toBeNull();
    }
  });
});
