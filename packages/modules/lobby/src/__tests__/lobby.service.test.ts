import { describe, it, expect } from 'vitest';
import { LobbyCategoryNotFoundError } from '../service/lobby.service.js';

describe('LobbyService domain errors', () => {
  it('LobbyCategoryNotFoundError carries the slug', () => {
    const err = new LobbyCategoryNotFoundError('slots');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('LobbyCategoryNotFoundError');
    expect(err.message).toContain('slots');
  });
});
