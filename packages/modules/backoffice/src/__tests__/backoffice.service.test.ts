import { describe, it, expect } from 'vitest';
import { UserNotFoundError } from '../service/backoffice.service.js';

describe('BackofficeService domain errors', () => {
  it('UserNotFoundError carries the userId', () => {
    const err = new UserNotFoundError('user-123');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('UserNotFoundError');
    expect(err.message).toContain('user-123');
  });
});
