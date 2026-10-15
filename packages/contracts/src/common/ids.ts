import { z } from 'zod';

/**
 * Opaque entity identifier. Zod's `uuid()` enforces RFC 9562 version and variant bits,
 * so fixture IDs must look like `00000000-0000-4000-8000-000000000001`, not all zeros.
 * Parsed IDs are lowercased so every path, body, cursor and response carries one canonical form.
 */
export const idSchema = z.uuid().toLowerCase();
