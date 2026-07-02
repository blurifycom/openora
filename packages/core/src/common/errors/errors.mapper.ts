import { DatabaseError } from 'pg';
import { ConflictError, ValidationError } from './errors.classes.js';
import { AppError } from './errors.base.js';

export function mapDbError(err: unknown): never {
  if (err instanceof DatabaseError) {
    switch (err.code) {
      case '23505':
        throw new ConflictError('Resource already exists');

      case '23503':
        throw new ValidationError('Referenced resource does not exist');

      case '23502':
        throw new ValidationError('Missing required field');

      case '23514':
        throw new ValidationError('Invalid value');

      default:
        throw new AppError('DB_ERROR', 'Database error', {
          code: err.code,
        });
    }
  }
  throw err;
}
