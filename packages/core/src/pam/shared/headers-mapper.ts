import { NodeHeaders } from '@blurifycom/core/server';

export function nodeHeadersToHeaders(nodeHeaders: NodeHeaders): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(nodeHeaders)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(', ') : value);
  }
  return headers;
}
