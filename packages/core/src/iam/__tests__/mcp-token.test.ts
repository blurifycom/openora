import { describe, expect, it } from 'vitest';
import {
  generateMcpToken,
  hashMcpToken,
  isMcpTokenFormat,
  mcpTokenAuthentication,
  mcpTokenDisplayPrefix,
  mcpTokenStatus,
} from '../shared/mcp-token.js';

const now = new Date('2026-06-01T12:00:00.000Z');
const past = new Date('2026-05-01T12:00:00.000Z');
const future = new Date('2026-07-01T12:00:00.000Z');

function token(overrides: { expiresAt?: Date; revokedAt?: Date | null; createdAt?: Date } = {}) {
  return {
    id: 'tok_1',
    adminUserId: 'adm_1',
    createdAt: overrides.createdAt ?? past,
    expiresAt: overrides.expiresAt ?? future,
    revokedAt: overrides.revokedAt ?? null,
    credentialsChangedAt: null as Date | null,
  };
}

describe('mcpTokenStatus', () => {
  it('a revoked token is revoked even when it is also expired', () => {
    expect(mcpTokenStatus({ expiresAt: past, revokedAt: past }, now)).toBe('revoked');
  });

  it('a token past its expiry is expired', () => {
    expect(mcpTokenStatus({ expiresAt: past, revokedAt: null }, now)).toBe('expired');
  });

  it('a token expiring exactly now is expired', () => {
    expect(mcpTokenStatus({ expiresAt: now, revokedAt: null }, now)).toBe('expired');
  });

  it('a token before expiry and not revoked is active', () => {
    expect(mcpTokenStatus({ expiresAt: future, revokedAt: null }, now)).toBe('active');
  });
});

describe('mcpTokenAuthentication', () => {
  it('an undefined token is refused as unknown', () => {
    expect(mcpTokenAuthentication(undefined, now)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('a revoked or expired token is refused with its status as the reason', () => {
    expect(mcpTokenAuthentication(token({ revokedAt: past }), now)).toEqual({
      ok: false,
      reason: 'revoked',
      tokenId: 'tok_1',
      adminId: 'adm_1',
    });
    expect(mcpTokenAuthentication(token({ expiresAt: past }), now)).toEqual({
      ok: false,
      reason: 'expired',
      tokenId: 'tok_1',
      adminId: 'adm_1',
    });
  });

  it('a token created at or before the credential change is refused as credentials changed', () => {
    const atChange = { ...token({ createdAt: past }), credentialsChangedAt: past };
    const afterChange = { ...token({ createdAt: past }), credentialsChangedAt: now };
    for (const candidate of [atChange, afterChange]) {
      expect(mcpTokenAuthentication(candidate, now)).toEqual({
        ok: false,
        reason: 'credentials_changed',
        tokenId: 'tok_1',
        adminId: 'adm_1',
      });
    }
  });

  it('a token created after the credential change is accepted', () => {
    const issued = { ...token({ createdAt: now }), credentialsChangedAt: past };
    expect(mcpTokenAuthentication(issued, now)).toEqual({
      ok: true,
      tokenId: 'tok_1',
      adminId: 'adm_1',
    });
  });

  it('a token with no credential change is accepted', () => {
    expect(mcpTokenAuthentication(token(), now)).toEqual({
      ok: true,
      tokenId: 'tok_1',
      adminId: 'adm_1',
    });
  });
});

describe('token format and hashing', () => {
  it('a generated token matches the token format check', () => {
    expect(isMcpTokenFormat(generateMcpToken())).toBe(true);
  });

  it('a value without the token prefix does not match the format check', () => {
    const generated = generateMcpToken();
    const withoutPrefix = generated.slice(mcpTokenDisplayPrefix(generated).length);
    expect(isMcpTokenFormat(withoutPrefix)).toBe(false);
    expect(isMcpTokenFormat('')).toBe(false);
  });

  it('the hash is stable for the same token and differs between tokens', () => {
    const first = generateMcpToken();
    const second = generateMcpToken();
    expect(hashMcpToken(first)).toBe(hashMcpToken(first));
    expect(hashMcpToken(first)).not.toBe(hashMcpToken(second));
    expect(hashMcpToken(first)).not.toContain(first);
  });

  it('the display prefix never contains the full secret', () => {
    const generated = generateMcpToken();
    const prefix = mcpTokenDisplayPrefix(generated);
    expect(generated.startsWith(prefix)).toBe(true);
    expect(prefix.length).toBeLessThan(generated.length);
  });
});
