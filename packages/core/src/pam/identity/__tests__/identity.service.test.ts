import { describe, it, expect, vi } from 'vitest';
import { IdentityService } from '../service/identity.service.js';
import type { SendEmailPort } from '@blurifycom/core/contracts';

vi.mock('@blurifycom/core/server', () => ({
  createAuth: vi.fn(() => ({
    api: {
      getSession: vi.fn().mockResolvedValue(null),
      signUpEmail: vi.fn(),
      signInEmail: vi.fn(),
      signOut: vi.fn(),
    },
  })),
}));

function makeDrizzle() {
  return { db: {} } as unknown as import('@blurifycom/core/server').DrizzleService;
}

function makeEvents() {
  return { emit: vi.fn(), on: vi.fn() };
}

describe('IdentityService - SendEmailPort seam', () => {
  it('constructs without a SendEmailPort (email delivery silently skipped)', () => {
    const svc = new IdentityService(makeDrizzle(), makeEvents() as never);
    expect(svc).toBeInstanceOf(IdentityService);
  });

  it('constructs with a stub SendEmailPort and exposes it for use', () => {
    const stub: SendEmailPort = { send: vi.fn().mockResolvedValue(undefined) };
    const svc = new IdentityService(makeDrizzle(), makeEvents() as never, stub);
    expect(svc).toBeInstanceOf(IdentityService);
  });

  it('me returns null when no session exists', async () => {
    const svc = new IdentityService(makeDrizzle(), makeEvents() as never);
    const result = await svc.me({});
    expect(result).toBeNull();
  });
});
