// Typed DI token. A token is a plain Symbol at runtime; the phantom `__token`
// field only carries the resolved type so the composition container can infer
// what `container.get(TOKEN)` returns. No decorators, no reflection - the type
// travels with the symbol. See @oss/core `Container`.

export type Token<T> = symbol & { readonly __token?: T };

export function createToken<T>(description: string): Token<T> {
  return Symbol(description) as Token<T>;
}
