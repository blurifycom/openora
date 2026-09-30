export function createDomainError<T extends unknown[]>(
  name: string,
  buildMessage: (...args: T) => string,
  data?: Record<string, string>,
): new (...args: T) => Error & { data?: Record<string, string> } {
  return class extends Error {
    data?: Record<string, string>;
    constructor(...args: T) {
      super(buildMessage(...args));
      this.name = name;
      this.data = data;
    }
  };
}

/** Shared factories for recurrent domain-error shapes. `createDomainError` stays available for bespoke errors. */
export const makeNotFoundError = (entity: string) =>
  createDomainError<[id: string]>(`${entity}NotFoundError`, (id) => `${entity} not found: ${id}`);

export const makeOwnershipError = (entity: string) =>
  createDomainError<[]>(`${entity}OwnershipError`, () => `You do not own this ${entity}`);

export const makeConflictError = (name: string, message: string, data?: Record<string, string>) =>
  createDomainError<[]>(name, () => message, data);

export const alreadyInUseError = (entity: string) =>
  createDomainError<[]>(`${entity}AlreadyInUseError`, () => `${entity} is already in use`);
