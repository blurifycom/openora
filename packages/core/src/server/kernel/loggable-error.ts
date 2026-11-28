function errorCode(err: unknown) {
  if (typeof err !== 'object' || err === null || !('code' in err)) {
    return undefined;
  }
  const { code } = err;
  return typeof code === 'string' || typeof code === 'number' ? String(code) : undefined;
}

export function loggableError(err: unknown) {
  if (!(err instanceof Error)) {
    return { name: typeof err };
  }
  const code = errorCode(err) ?? errorCode(err.cause);
  return code === undefined ? { name: err.name } : { name: err.name, code };
}
