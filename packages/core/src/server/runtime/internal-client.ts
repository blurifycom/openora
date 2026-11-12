import {
  INTERNAL_API_HEADERS,
  INTERNAL_API_PREFIX,
  parseInternalApiSecrets,
  signInternalRequest,
} from './internal-api.js';

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
  /** The called service's `SERVICE_NAME`. A call signed for one service is refused by another. */
  audience: string;
  /** The `INTERNAL_API_SECRETS` value as set in the environment; its first secret signs. */
  secrets: string | undefined;
  timeoutMs: number;
};

export type InternalClient = {
  /**
   * Calls `<baseUrl>/internal/v1<path>` once, without a retry, and resolves the JSON reply
   * (`undefined` for an empty one). `path` is sent as given: it starts with `/` and has no dot
   * segment, query or fragment, and percent-encoding any segment is the caller's job. Inputs go
   * in `body`, so a route that takes any is a POST. The reply is untrusted input: parse it with
   * its schema. A call that moves money puts its idempotency key in `body`, which is signed.
   */
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

function parseReply(text: string): unknown {
  return text === '' ? undefined : JSON.parse(text);
}

// The URL parser resolves `.` and `..` (also percent-encoded) and splits off `?` and `#`, so a
// path it would change is one the caller did not mean to send.
function isPlainPath(path: string, url: URL): boolean {
  return (
    path.startsWith('/') &&
    !path.includes('?') &&
    !path.includes('#') &&
    url.pathname === `${INTERNAL_API_PREFIX}${path}`
  );
}

export function createInternalClient(config: InternalClientConfig): InternalClient {
  const [secret] = parseInternalApiSecrets(config.secrets);
  if (secret === undefined) {
    throw new Error(
      'createInternalClient: INTERNAL_API_SECRETS is unset, so no call can be signed',
    );
  }
  return {
    async request(method, path, body) {
      const url = new URL(`${INTERNAL_API_PREFIX}${path}`, config.baseUrl);
      if (!isPlainPath(path, url)) {
        throw new InternalApiError('client', `Refusing to call ${JSON.stringify(path)}`);
      }
      const payload = body === undefined ? '' : JSON.stringify(body);
      const contentType = payload === '' ? '' : 'application/json';
      const timestamp = String(Date.now());
      const signature = signInternalRequest(
        {
          service: config.serviceName,
          audience: config.audience,
          timestamp,
          method,
          pathAndQuery: url.pathname,
          contentType,
          body: new TextEncoder().encode(payload),
        },
        secret,
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
            ...(contentType === '' ? {} : { 'content-type': contentType }),
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
