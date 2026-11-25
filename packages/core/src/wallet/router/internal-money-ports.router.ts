import { ORPCError } from '@orpc/server';
import { sql } from 'drizzle-orm';
import { internalProcedureFor, type DrizzleDb } from '@openora/core/server';
import {
  MONEY_PORTS_ROUTE,
  MONEY_REMOTE_PORTS,
  MoneyPortCallWire,
  decodeMoneyWire,
  encodeMoneyWire,
  isMoneyRemotePortName,
  moneyPortErrorWireOf,
} from '@openora/core/contracts';

const REMOTE_WRITE_LOCK_TIMEOUT = '1500ms';

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
          typeof impl === 'object' && impl !== null && spec
            ? (impl as Record<string, unknown>)[spec.served ?? input.method]
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
        try {
          const result =
            spec.tx === undefined
              ? await invoke()
              : spec.write
                ? await db.transaction(async (tx) => {
                    await tx.execute(
                      sql.raw(`SET LOCAL lock_timeout = '${REMOTE_WRITE_LOCK_TIMEOUT}'`),
                    );
                    return invoke(tx);
                  })
                : await invoke(db);
          return { result: encodeMoneyWire(result) };
        } catch (err) {
          const typed = moneyPortErrorWireOf(err);
          if (!typed) {
            throw err;
          }
          throw new ORPCError('UNPROCESSABLE_CONTENT', {
            status: 422,
            message: typed.code,
            data: typed,
          });
        }
      }),
  };
}
