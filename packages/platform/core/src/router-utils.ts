import { ORPCError } from '@orpc/server';

type RequestLike = { headers: Record<string, string | string[] | undefined> };

function resolveHeader(
  context: unknown,
  header: string,
  errorMessage: string,
): string {
  if (
    typeof context !== 'object' ||
    context === null ||
    !('request' in context) ||
    typeof (context as Record<string, unknown>).request !== 'object'
  ) {
    throw new ORPCError('UNAUTHORIZED', { message: 'Missing request context' });
  }

  const req = (context as { request: RequestLike }).request;
  const value = req.headers[header];
  const resolved = Array.isArray(value) ? value[0] : value;

  if (!resolved) {
    throw new ORPCError('UNAUTHORIZED', { message: errorMessage });
  }

  return resolved;
}

export function getUserId(context: unknown): string {
  return resolveHeader(context, 'x-user-id', 'Missing x-user-id header');
}

export function getTenantId(context: unknown): string {
  return resolveHeader(context, 'x-tenant-id', 'Missing x-tenant-id header');
}
