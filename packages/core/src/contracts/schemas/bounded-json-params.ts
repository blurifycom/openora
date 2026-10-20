import * as z from 'zod';

export function fitsJsonBytes(value: unknown, maxBytes: number) {
  return new TextEncoder().encode(JSON.stringify(value)).length <= maxBytes;
}

export function createBoundedJsonParamsSchema({
  maxBytes,
  label,
}: {
  maxBytes: number;
  label: string;
}) {
  return z
    .record(z.string().min(1).max(64), z.json())
    .refine((params) => fitsJsonBytes(params, maxBytes), {
      message: `${label} must serialize to at most ${maxBytes} bytes`,
    });
}
