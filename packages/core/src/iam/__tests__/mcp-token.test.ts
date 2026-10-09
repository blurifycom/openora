import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  generateMcpToken,
  hashMcpToken,
  isMcpTokenFormat,
  mcpTokenAuthentication,
  mcpTokenDisplayPrefix,
  mcpTokenStatus,
} from '../shared/mcp-token.js';

const NOW = new Date('2026-10-06T12:00:00.000Z');
const BEFORE_NOW = new Date('2026-10-06T11:59:59.999Z');
const AFTER_NOW = new Date('2026-10-06T12:00:00.001Z');
const SECRET_43 = 'A'.repeat(43);
const SHA256_OF_ABC = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';

const ISSUED_AT = new Date('2026-10-01T09:00:00.000Z');
const BEFORE_ISSUE = new Date('2026-10-01T08:59:59.999Z');
const AFTER_ISSUE = new Date('2026-10-01T09:00:00.001Z');

const lifecycle = (over: { expiresAt?: Date; revokedAt?: Date | null } = {}) => ({
  expiresAt: AFTER_NOW,
  revokedAt: null,
  ...over,
});

const stored = ({
  credentialsChangedAt = null,
  ...over
}: { expiresAt?: Date; revokedAt?: Date | null; credentialsChangedAt?: Date | null } = {}) => ({
  id: randomUUID(),
  adminUserId: randomUUID(),
  createdAt: ISSUED_AT,
  credentialsChangedAt,
  ...lifecycle(over),
});

describe('generateMcpToken', () => {
  it('issues the ora_mcp_ scheme followed by 43 base64url characters', () => {
    const token = generateMcpToken();

    expect(token).toMatch(/^ora_mcp_[A-Za-z0-9_-]{43}$/);
    expect(isMcpTokenFormat(token)).toBe(true);
  });

  it('never issues the same token twice', () => {
    const tokens = new Set(Array.from({ length: 50 }, generateMcpToken));

    expect(tokens.size).toBe(50);
  });
});

describe('isMcpTokenFormat', () => {
  it('accepts the scheme with a 43-character base64url secret', () => {
    expect(isMcpTokenFormat(`ora_mcp_${SECRET_43}`)).toBe(true);
    expect(isMcpTokenFormat(`ora_mcp_${'a_-9'.repeat(10)}xyz`)).toBe(true);
  });

  it.each([
    ['an empty string', ''],
    ['the bare scheme', 'ora_mcp_'],
    ['another scheme', `ora_api_${SECRET_43}`],
    ['an upper-case scheme', `ORA_MCP_${SECRET_43}`],
    ['a secret one character short', `ora_mcp_${'A'.repeat(42)}`],
    ['a secret one character long', `ora_mcp_${'A'.repeat(44)}`],
    ['standard base64 characters', `ora_mcp_${'A'.repeat(41)}+/`],
    ['base64 padding', `ora_mcp_${'A'.repeat(42)}=`],
    ['surrounding whitespace', ` ora_mcp_${SECRET_43} `],
    ['a Bearer prefix', `Bearer ora_mcp_${SECRET_43}`],
  ])('rejects %s', (_case, value) => {
    expect(isMcpTokenFormat(value)).toBe(false);
  });
});

describe('hashMcpToken', () => {
  it('is the lowercase hex SHA-256 of the UTF-8 token', () => {
    expect(hashMcpToken('abc')).toBe(SHA256_OF_ABC);
  });

  it('gives a 64-character digest that differs from the token and between tokens', () => {
    const token = generateMcpToken();

    expect(hashMcpToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashMcpToken(token)).not.toBe(token);
    expect(hashMcpToken(token)).not.toBe(hashMcpToken(generateMcpToken()));
  });
});

describe('mcpTokenDisplayPrefix', () => {
  it('keeps the scheme and the first four secret characters', () => {
    expect(mcpTokenDisplayPrefix(`ora_mcp_WXYZ${'A'.repeat(39)}`)).toBe('ora_mcp_WXYZ');
  });
});

describe('mcpTokenStatus', () => {
  it('is active until the expiry instant', () => {
    expect(mcpTokenStatus(lifecycle({ expiresAt: AFTER_NOW }), NOW)).toBe('active');
  });

  it('is expired from the expiry instant on', () => {
    expect(mcpTokenStatus(lifecycle({ expiresAt: NOW }), NOW)).toBe('expired');
    expect(mcpTokenStatus(lifecycle({ expiresAt: BEFORE_NOW }), NOW)).toBe('expired');
  });

  it('is revoked once revoked, whether or not it has expired', () => {
    expect(mcpTokenStatus(lifecycle({ revokedAt: BEFORE_NOW }), NOW)).toBe('revoked');
    expect(mcpTokenStatus(lifecycle({ revokedAt: BEFORE_NOW, expiresAt: BEFORE_NOW }), NOW)).toBe(
      'revoked',
    );
  });
});

describe('mcpTokenAuthentication', () => {
  it('answers unknown when no token is on file', () => {
    expect(mcpTokenAuthentication(undefined, NOW)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('accepts an active token and names its admin', () => {
    const token = stored();

    expect(mcpTokenAuthentication(token, NOW)).toEqual({
      ok: true,
      tokenId: token.id,
      adminId: token.adminUserId,
    });
  });

  it('refuses an expired token, still naming it and its admin', () => {
    const token = stored({ expiresAt: NOW });

    expect(mcpTokenAuthentication(token, NOW)).toEqual({
      ok: false,
      reason: 'expired',
      tokenId: token.id,
      adminId: token.adminUserId,
    });
  });

  it('refuses a revoked token as revoked even after it has expired', () => {
    const token = stored({ revokedAt: BEFORE_NOW, expiresAt: BEFORE_NOW });

    expect(mcpTokenAuthentication(token, NOW)).toEqual({
      ok: false,
      reason: 'revoked',
      tokenId: token.id,
      adminId: token.adminUserId,
    });
  });

  it("refuses an unrevoked token issued before its admin's latest credential change", () => {
    const token = stored({ credentialsChangedAt: AFTER_ISSUE });

    expect(mcpTokenAuthentication(token, NOW)).toEqual({
      ok: false,
      reason: 'credentials_changed',
      tokenId: token.id,
      adminId: token.adminUserId,
    });
  });

  it('refuses a token issued at the very instant of the credential change', () => {
    expect(mcpTokenAuthentication(stored({ credentialsChangedAt: ISSUED_AT }), NOW)).toMatchObject({
      ok: false,
      reason: 'credentials_changed',
    });
  });

  it('accepts a token issued after the latest credential change, or for an admin without one', () => {
    expect(
      mcpTokenAuthentication(stored({ credentialsChangedAt: BEFORE_ISSUE }), NOW),
    ).toMatchObject({ ok: true });
    expect(mcpTokenAuthentication(stored({ credentialsChangedAt: null }), NOW)).toMatchObject({
      ok: true,
    });
  });

  it('reports a revoked or expired token as such even when it predates a credential change', () => {
    const revoked = stored({ revokedAt: BEFORE_NOW, credentialsChangedAt: AFTER_ISSUE });
    const expired = stored({ expiresAt: NOW, credentialsChangedAt: AFTER_ISSUE });

    expect(mcpTokenAuthentication(revoked, NOW)).toMatchObject({ reason: 'revoked' });
    expect(mcpTokenAuthentication(expired, NOW)).toMatchObject({ reason: 'expired' });
  });
});
