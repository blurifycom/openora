import { DatabaseError } from 'pg';
import { ConflictError, ValidationError } from './errors.classes.js';
import { AppError } from './errors.base.js';

function databaseErrorOf(err: unknown): DatabaseError | undefined {
  const seen = new Set<unknown>();
  let current = err;
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof DatabaseError) {
      return current;
    }
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

export function mapDbError(err: unknown): never {
  const dbError = databaseErrorOf(err);
  if (dbError) {
    switch (dbError.code) {
      case '23505':
        throw new ConflictError('Resource already exists');

      case '23503':
        throw new ValidationError('Referenced resource does not exist');

      case '23502':
        throw new ValidationError('Missing required field');

      case '23514':
        throw new ValidationError('Invalid value');

      default:
        throw new AppError('Database error', 'DB_ERROR', {
          code: dbError.code,
        });
    }
  }
  throw err;
}
