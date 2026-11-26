export function globalStore<T>(
  key: symbol,
  isStore: (value: unknown) => value is T,
  create: () => T,
): T {
  const existing: unknown = Reflect.get(globalThis, key);
  if (isStore(existing)) {
    return existing;
  }
  const created = create();
  Reflect.set(globalThis, key, created);
  return created;
}
