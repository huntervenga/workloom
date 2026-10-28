import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { normalizeAvatar } from './image.js';

describe('bounded avatar image processing', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s, crops to a square and strips original metadata', async format => {
    const source = await sharp({ create: { width: 800, height: 400, channels: 3, background: '#bb2233' } })[format]().withExif({ IFD0: { Artist: 'Private name' } }).toBuffer();
    const output = await normalizeAvatar(source), metadata = await sharp(output).metadata();
    expect(metadata).toMatchObject({ format: 'webp', width: 512, height: 512 });
    expect(metadata.exif).toBeUndefined(); expect(metadata.icc).toBeUndefined();
    expect(output.length).toBeLessThan(5_000_000);
  });
  it('rejects active content, falsely named files, truncated images and oversized input', async () => {
    for (const source of [Buffer.alloc(0), Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), Buffer.from('not a photo'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]) {
      await expect(normalizeAvatar(source)).rejects.toMatchObject({ statusCode: 415, code: 'AVATAR_INVALID_IMAGE' });
    }
    await expect(normalizeAvatar(Buffer.alloc(5_000_001))).rejects.toMatchObject({ statusCode: 413 });
  });
  it('rejects pixel bombs before full decode', async () => {
    const image = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: '#ffffff' } }).png().toBuffer();
    await expect(normalizeAvatar(image)).rejects.toMatchObject({ code: 'AVATAR_INVALID_IMAGE' });
  });
});
