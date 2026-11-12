import { INTERNAL_API_HEADERS, INTERNAL_API_PREFIX, signInternalRequest } from './internal-api.js';

export type InternalApiErrorKind = 'timeout' | 'network' | 'client' | 'server';

/**
 * A failed internal call. `timeout` and `network` leave the outcome unknown: the request may
 * have been applied. A money caller fails closed on every kind and retries only with the same
 * idempotency key.
 */
export class InternalApiError extends Error {
  readonly kind: InternalApiErrorKind;
  readonly status: number | undefined;
  readonly body: unknown;

  constructor(
    kind: InternalApiErrorKind,
    message: string,
    details: { status?: number; body?: unknown; cause?: unknown } = {},
  ) {
    super(message, { cause: details.cause });
    this.name = 'InternalApiError';
    this.kind = kind;
    this.status = details.status;
    this.body = details.body;
  }
}

export type InternalClientConfig = {
  /** The origin of the service called, eg `http://wallet:3001`. A path on it is ignored. */
  baseUrl: string;
  /** This process's `SERVICE_NAME`, which the called route allow-lists. */
  serviceName: string;
  /** The first entry of `INTERNAL_API_SECRETS`. */
  secret: string;
  timeoutMs: number;
};

export type InternalClient = {
  /**
   * Calls `<baseUrl>/internal/v1<path>` once, without a retry, and resolves the JSON reply
   * (`undefined` for an empty one). The reply is untrusted input: parse it with its schema. Put
   * an idempotency key in `body`, which is signed, not in a header.
   */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

function parseReply(text: string): unknown {
  return text === '' ? undefined : JSON.parse(text);
}

export function createInternalClient(config: InternalClientConfig): InternalClient {
  return {
    async request(method, path, body) {
      const url = new URL(`${INTERNAL_API_PREFIX}${path}`, config.baseUrl);
      const payload = body === undefined ? '' : JSON.stringify(body);
      const timestamp = String(Date.now());
      const signature = signInternalRequest(
        {
          service: config.serviceName,
          timestamp,
          method,
          pathAndQuery: `${url.pathname}${url.search}`,
          body: new TextEncoder().encode(payload),
        },
        config.secret,
      );
      const target = `${method.toUpperCase()} ${url.pathname}`;

      let status: number;
      let text: string;
      try {
        const res = await fetch(url, {
          method,
          headers: {
            [INTERNAL_API_HEADERS.service]: config.serviceName,
            [INTERNAL_API_HEADERS.timestamp]: timestamp,
            [INTERNAL_API_HEADERS.signature]: signature,
            ...(payload === '' ? {} : { 'content-type': 'application/json' }),
          },
          ...(payload === '' ? {} : { body: payload }),
          // A redirect would change the signed path anyway; surface it rather than follow it.
          redirect: 'error',
          signal: AbortSignal.timeout(config.timeoutMs),
        });
        status = res.status;
        text = await res.text();
      } catch (err) {
        if (err instanceof DOMException && err.name === 'TimeoutError') {
          throw new InternalApiError('timeout', `${target} timed out after ${config.timeoutMs}ms`, {
            cause: err,
          });
        }
        throw new InternalApiError('network', `${target} failed before a reply`, { cause: err });
      }

      let reply: unknown;
      try {
        reply = parseReply(text);
      } catch (err) {
        // A proxy's HTML error page keeps its status class; only a 2xx must be valid JSON.
        if (status < 400) {
          throw new InternalApiError('server', `${target} answered ${status} with invalid JSON`, {
            status,
            cause: err,
          });
        }
        reply = text;
      }
      if (status >= 500) {
        throw new InternalApiError('server', `${target} answered ${status}`, {
          status,
          body: reply,
        });
      }
      if (status >= 400) {
        throw new InternalApiError('client', `${target} answered ${status}`, {
          status,
          body: reply,
        });
      }
      return reply;
    },
  };
}
