export type AnyToken<T, K extends string = string> = symbol & {
  readonly __token?: T;
  readonly __key?: K;
};

export type TokenCatalogValues = Record<string, unknown>;

export type TokenCatalog<Values extends TokenCatalogValues = TokenCatalogValues> = {
  [K in keyof Values]: AnyToken<Values[K]>;
};

export type TokenValue<T> = T extends AnyToken<infer Value> ? Value : never;

export type Token<T, K extends string = string> = AnyToken<T, K> & {
  readonly __sealed?: never;
};

export function createToken<T, const K extends string = string>(key: K): Token<T, K> {
  return Symbol(key) as Token<T, K>;
}

const SEALED_PREFIX = 'sealed:';

export type SealedToken<T, K extends string = string> = AnyToken<T, K> & {
  readonly __sealed: true;
};

export function createSealedToken<T, const K extends string = string>(key: K): SealedToken<T, K> {
  return Symbol(`${SEALED_PREFIX}${key}`) as SealedToken<T, K>;
}

export function isSealedToken(token: symbol): boolean {
  return token.description?.startsWith(SEALED_PREFIX) === true;
}

export type ClientPageToken<P = unknown> = symbol & {
  readonly __token?: P;
  readonly __clientPage: true;
};

export function createClientPageToken<P = unknown>(description: string): ClientPageToken<P> {
  return Symbol(`page:${description}`) as ClientPageToken<P>;
}
