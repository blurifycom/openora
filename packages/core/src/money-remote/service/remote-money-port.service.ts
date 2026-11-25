import * as z from 'zod';
import {
  MONEY_PORTS_ROUTE,
  MONEY_REMOTE_PORTS,
  MoneyPortCallWire,
  MoneyPortErrorWire,
  decodeMoneyWire,
  encodeMoneyWire,
  moneyPortErrorFromWire,
  type MoneyMethodSpec,
  type MoneyRemotePortName,
} from '@openora/core/contracts';
import { InternalApiError, upstreamDownAs503, type InternalClient } from '@openora/core/server';

// The outcome of these is unknown, so only a write, idempotent at the money service, may try again.
function mayRetry(err: unknown): boolean {
  return err instanceof InternalApiError && err.kind !== 'client';
}

const TypedReply = z.object({ data: MoneyPortErrorWire });

// A 422 carrying a typed port error is that error, thrown again on this side.
function rethrowTyped(err: unknown): void {
  if (err instanceof InternalApiError && err.status === 422) {
    const typed = TypedReply.safeParse(err.body);
    if (typed.success) {
      throw moneyPortErrorFromWire(typed.data.data);
    }
  }
}

async function callRemote(
  client: InternalClient,
  port: MoneyRemotePortName,
  method: string,
  spec: MoneyMethodSpec,
  args: readonly unknown[],
): Promise<unknown> {
  const sent = args.slice(0, spec.arity).filter((_, index) => index !== spec.tx);
  const body = { port, method, args: encodeMoneyWire(sent) };
  const attempt = () => client.request('POST', MONEY_PORTS_ROUTE, body);
  let reply: unknown;
  try {
    reply = await attempt();
  } catch (err) {
    rethrowTyped(err);
    if (!spec.write || !mayRetry(err)) {
      throw upstreamDownAs503(err);
    }
    try {
      reply = await attempt();
    } catch (retryErr) {
      rethrowTyped(retryErr);
      throw upstreamDownAs503(retryErr);
    }
  }
  return decodeMoneyWire(MoneyPortCallWire.output.parse(reply).result);
}

/**
 * The port `name` over the money service's internal API. Never cached, never answered from a
 * guess: a call that times out, is refused, or answers something unreadable throws (a 503 when
 * the money service is unreachable), so a caller never reads a failed call as a balance or a
 * fresh projection. A typed port error (`MoneyPortErrorWire`) is rethrown as its own class and
 * never retried. A write is retried once with the same body on a timeout, network failure or
 * 5xx; a read is not retried. A `tx` argument is never sent: the
 * money service runs the call on its own connection, outside the caller's transaction.
 */
export function remoteMoneyPort<T>(client: InternalClient, name: MoneyRemotePortName): T {
  const { methods, remoteFlag } = MONEY_REMOTE_PORTS[name];
  const binding: Record<string, unknown> = remoteFlag ? { remote: true } : {};
  for (const [method, spec] of Object.entries(methods)) {
    binding[method] = (...args: unknown[]) => callRemote(client, name, method, spec, args);
  }
  // The method table is checked against T where MONEY_REMOTE_PORTS is declared.
  return binding as T;
}
