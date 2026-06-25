import { AppError } from './errors.base.js';

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super('CONFLICT', message);
  }
}

export class NotFoundError extends AppError {
  constructor(message = 'Not found') {
    super('NOT_FOUND', message);
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super('BAD_REQUEST', message);
  }
}
