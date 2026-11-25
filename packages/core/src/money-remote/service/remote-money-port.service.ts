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

function mayRetry(err: unknown): boolean {
  return err instanceof InternalApiError && err.kind !== 'client';
}

const TypedReply = z.object({ data: MoneyPortErrorWire });

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

export function remoteMoneyPort<T>(client: InternalClient, name: MoneyRemotePortName): T {
  const { methods, remoteFlag } = MONEY_REMOTE_PORTS[name];
  const binding: Record<string, unknown> = remoteFlag ? { remote: true } : {};
  for (const [method, spec] of Object.entries(methods)) {
    binding[method] = (...args: unknown[]) => callRemote(client, name, method, spec, args);
  }
  return binding as T;
}
