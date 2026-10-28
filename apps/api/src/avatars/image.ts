import { AVATAR_SIZE, MAX_AVATAR_BYTES } from '@workloom/contracts';
import { HttpError } from '../http/errors.js';

/** Buffer-only processing, with bounded decode size; original metadata is not carried into the avatar. */
export async function normalizeAvatar(input: Buffer): Promise<Buffer> {
  if (!input.length) throw new HttpError(415, 'AVATAR_INVALID_IMAGE', 'Choose a valid JPEG, PNG or WebP image.');
  if (input.length > MAX_AVATAR_BYTES) throw new HttpError(413, 'AVATAR_TOO_LARGE', 'Choose an image no larger than 5 MB.');
  // Check the binary signature before invoking a decoder. SVG/XML and other formats never reach libvips.
  const jpeg = input[0] === 0xff && input[1] === 0xd8 && input[2] === 0xff;
  const png = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const webp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
  if (!jpeg && !png && !webp) throw new HttpError(415, 'AVATAR_INVALID_IMAGE', 'Choose a valid JPEG, PNG or WebP image.');
  try {
    const { default: sharp } = await import('sharp');
    const image = sharp(input, { limitInputPixels: 16_777_216, failOn: 'warning', pages: 1 });
    const metadata = await image.metadata();
    if (!['jpeg', 'png', 'webp'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) throw new Error('Unsupported avatar.');
    return await image.rotate().resize(AVATAR_SIZE, AVATAR_SIZE, { fit: 'cover', position: 'centre' }).webp({ quality: 85 }).timeout({ seconds: 10 }).toBuffer();
  } catch { throw new HttpError(415, 'AVATAR_INVALID_IMAGE', 'Choose a valid JPEG, PNG or WebP image up to 16 megapixels.'); }
}
