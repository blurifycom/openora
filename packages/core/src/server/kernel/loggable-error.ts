function errorCode(err: unknown) {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

/**
 * Never the message or stack: a drizzle query error's message carries the query parameters,
 * such as a token hash or a player's data.
 */
export function loggableError(err: unknown) {
  if (!(err instanceof Error)) {
    return { name: typeof err };
  }
  const code = errorCode(err) ?? errorCode(err.cause);
  return code === undefined ? { name: err.name } : { name: err.name, code };
}
