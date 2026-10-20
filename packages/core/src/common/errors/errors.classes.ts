import { AppError } from './errors.base.js';

export class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 'CONFLICT');
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid input') {
    super(message, 'BAD_REQUEST');
  }
}
