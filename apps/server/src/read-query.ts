import { z } from 'zod';

// Preserve existing defaults and upper clamps, rejecting NaN/fractions before SQL.
export const readLimit = (fallback: number, max: number, min = 1) => z.coerce.number().int().min(1).max(Number.MAX_SAFE_INTEGER).transform(value => Math.min(Math.max(value, min), max)).default(fallback);
export const readOffset = z.coerce.number().int().min(0).max(1_000_000).default(0);
export const optionalReadId = z.string().uuid().optional();
export const optionalReadProject = z.union([z.string().uuid(), z.literal('none')]).optional();
