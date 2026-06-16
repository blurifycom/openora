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

/**
 * Factories for the domain-error shapes that recur across modules. `entity` is
 * PascalCase (eg 'ChatMessage'), so the produced class name reads naturally
 * (`ChatMessageNotFoundError`). These replace hand-rolled `createDomainError`
 * calls in services; `createDomainError` stays available for bespoke errors.
 */
export const makeNotFoundError = (entity: string) =>
  createDomainError<[id: string]>(`${entity}NotFoundError`, (id) => `${entity} not found: ${id}`);

export const makeOwnershipError = (entity: string) =>
  createDomainError<[]>(`${entity}OwnershipError`, () => `You do not own this ${entity}`);

export const makeConflictError = (name: string, message: string) =>
  createDomainError<[]>(name, () => message);
