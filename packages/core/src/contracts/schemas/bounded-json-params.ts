import * as z from 'zod';

export function createBoundedJsonParamsSchema({
  maxBytes,
  label,
}: {
  maxBytes: number;
  label: string;
}) {
  return z
    .record(z.string().min(1).max(64), z.json())
    .refine((params) => new TextEncoder().encode(JSON.stringify(params)).length <= maxBytes, {
      message: `${label} must serialize to at most ${maxBytes} bytes`,
    });
}
