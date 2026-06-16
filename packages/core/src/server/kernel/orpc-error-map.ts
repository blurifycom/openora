import { ORPCError } from '@orpc/server';

type ORPCCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INTERNAL_SERVER_ERROR';

type ErrorClass = new (...args: never[]) => Error;

export async function mapErrors<T>(
  map: Partial<Record<ORPCCode, ErrorClass | ErrorClass[]>>,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    for (const [code, classes] of Object.entries(map) as [ORPCCode, ErrorClass | ErrorClass[]][]) {
      const list = Array.isArray(classes) ? classes : [classes];
      if (list.some((C) => err instanceof C)) {
        throw new ORPCError(code, { message: (err as Error).message });
      }
    }
    throw err;
  }
}
