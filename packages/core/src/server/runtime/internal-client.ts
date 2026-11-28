import { ORPCError } from '@orpc/server';
import {
  INTERNAL_API_HEADERS,
  INTERNAL_API_PREFIX,
  parseInternalApiSecrets,
  signInternalRequest,
} from './internal-api.js';

export type InternalApiErrorKind = 'timeout' | 'network' | 'client' | 'server';

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

export function upstreamDownAs503(err: unknown): unknown {
  if (err instanceof InternalApiError && err.kind !== 'client') {
    return new ORPCError('SERVICE_UNAVAILABLE', {
      message: 'A service this route depends on is unavailable',
      cause: err,
    });
  }
  return err;
}

export type InternalClientConfig = {
  baseUrl: string;
  serviceName: string;
  audience: string;
  secrets: string | undefined;
  timeoutMs: number;
};

export type InternalClient = {
  request(method: string, path: string, body?: unknown): Promise<unknown>;
};

function parseReply(text: string): unknown {
  return text === '' ? undefined : JSON.parse(text);
}

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
      let payload = '';
      if (body !== undefined) {
        try {
          payload = JSON.stringify(body);
        } catch (err) {
          throw new InternalApiError(
            'client',
            `Refusing to send an unserializable body to ${path}`,
            {
              cause: err,
            },
          );
        }
      }
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
