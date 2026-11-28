import { ORPCError } from '@orpc/server';

const WIRE_BODY = Symbol.for('openora.wireErrorResponse.body');

export type WireErrorBody = Readonly<Record<string, unknown>> | readonly unknown[];

export function wireErrorResponse(
  status: number,
  body: WireErrorBody,
  options: { cause?: unknown } = {},
): ORPCError<'WIRE_ERROR_RESPONSE', unknown> {
  if (!Number.isInteger(status) || status < 400 || status > 599) {
    throw new RangeError(`wireErrorResponse status must be 400-599, got ${status}`);
  }
  return Object.assign(
    new ORPCError('WIRE_ERROR_RESPONSE', {
      status,
      message: `Wire error response ${status}`,
      cause: options.cause,
    }),
    { [WIRE_BODY]: body },
  );
}

export function wireErrorBody(error: unknown): WireErrorBody | null {
  if (!(error instanceof ORPCError) || !Object.hasOwn(error, WIRE_BODY)) {
    return null;
  }
  const body: WireErrorBody = Reflect.get(error, WIRE_BODY);
  return body;
}
