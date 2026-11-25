import { ORPCError } from '@orpc/server';
import { internalProcedureFor, type DrizzleDb } from '@openora/core/server';
import {
  MONEY_PORTS_ROUTE,
  MONEY_REMOTE_PORTS,
  MoneyPortCallWire,
  decodeMoneyWire,
  encodeMoneyWire,
  isMoneyRemotePortName,
} from '@openora/core/contracts';

/**
 * The internal API behind every port in `MONEY_REMOTE_PORTS`, for a platform service that does
 * not load the money modules (ADR-0063). Each call is answered by this process's own binding of
 * the named port, so `resolve` must read the container of the money service, never a remote
 * binding. A method with a `tx` position gets a fresh transaction on a write and this db on a
 * read. Only services named in `callers` (`MONEY_PORTS_CALLERS`) may call; any other signed
 * caller is refused.
 */
export function createInternalMoneyPortsRouter(
  resolve: (token: symbol) => unknown,
  db: DrizzleDb,
  callers: ReadonlySet<string>,
) {
  const procedure = internalProcedureFor(callers, 'This service may not call the money ports');
  return {
    call: procedure
      .route({ method: 'POST', path: MONEY_PORTS_ROUTE })
      .input(MoneyPortCallWire.input)
      .output(MoneyPortCallWire.output)
      .handler(async ({ input }) => {
        if (!isMoneyRemotePortName(input.port)) {
          throw new ORPCError('NOT_FOUND', { message: `no money port ${input.port}` });
        }
        const port = MONEY_REMOTE_PORTS[input.port];
        const spec = Object.hasOwn(port.methods, input.method)
          ? port.methods[input.method]
          : undefined;
        const impl = resolve(port.token);
        const fn: unknown =
          typeof impl === 'object' && impl !== null
            ? (impl as Record<string, unknown>)[input.method]
            : undefined;
        if (!spec || typeof fn !== 'function') {
          throw new ORPCError('NOT_FOUND', {
            message: `${input.port} has no method ${input.method}`,
          });
        }
        const args = decodeMoneyWire(input.args);
        const sent = spec.tx === undefined ? spec.arity : spec.arity - 1;
        if (!Array.isArray(args) || args.length > sent) {
          throw new ORPCError('BAD_REQUEST', { message: 'malformed arguments' });
        }
        const invoke = (txOrDb?: unknown): Promise<unknown> => {
          const full: unknown[] = [...args];
          if (spec.tx !== undefined) {
            full.length = Math.max(full.length, spec.tx);
            full.splice(spec.tx, 0, txOrDb);
          }
          return Promise.resolve(fn.apply(impl, full));
        };
        const result =
          spec.tx === undefined
            ? await invoke()
            : spec.write
              ? await db.transaction((tx) => invoke(tx))
              : await invoke(db);
        return { result: encodeMoneyWire(result) };
      }),
  };
}
