export function createDomainError<T extends unknown[]>(
  name: string,
  buildMessage: (...args: T) => string,
): new (...args: T) => Error {
  return class extends Error {
    constructor(...args: T) {
      super(buildMessage(...args));
      this.name = name;
    }
  };
}
