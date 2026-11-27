import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  generateMcpToken,
  hashMcpToken,
  isMcpTokenFormat,
  mcpTokenAuthentication,
  mcpTokenDisplayPrefix,
  mcpTokenStatus,
} from '../mcp-token.js';

const d = (iso: string) => new Date(iso);
const NOW = d('2026-06-01T12:00:00.000Z');
const plus = (date: Date, ms: number) => new Date(date.getTime() + ms);

const lifecycle = (over: Partial<Parameters<typeof mcpTokenStatus>[0]> = {}) => ({
  expiresAt: plus(NOW, 60_000),
  revokedAt: null,
  ...over,
});

const stored = (over: Partial<NonNullable<Parameters<typeof mcpTokenAuthentication>[0]>> = {}) => ({
  id: '11111111-1111-4111-8111-111111111111',
  adminUserId: '22222222-2222-4222-8222-222222222222',
  createdAt: plus(NOW, -3_600_000),
  expiresAt: plus(NOW, 3_600_000),
  revokedAt: null,
  credentialsChangedAt: null,
  ...over,
});

describe('mcpTokenStatus', () => {
  it('is active before expiry', () => {
    expect(mcpTokenStatus(lifecycle(), NOW)).toBe('active');
  });

  it('is active 1ms before expiresAt', () => {
    expect(mcpTokenStatus(lifecycle({ expiresAt: plus(NOW, 1) }), NOW)).toBe('active');
  });

  it('is expired when expiresAt equals now', () => {
    expect(mcpTokenStatus(lifecycle({ expiresAt: NOW }), NOW)).toBe('expired');
  });

  it('is expired after expiresAt', () => {
    expect(mcpTokenStatus(lifecycle({ expiresAt: plus(NOW, -1) }), NOW)).toBe('expired');
  });

  it('is revoked when revokedAt is set', () => {
    expect(mcpTokenStatus(lifecycle({ revokedAt: plus(NOW, -1000) }), NOW)).toBe('revoked');
  });

  it('reports revoked over expired', () => {
    expect(mcpTokenStatus(lifecycle({ revokedAt: NOW, expiresAt: plus(NOW, -1000) }), NOW)).toBe(
      'revoked',
    );
  });

  it('is revoked even when revokedAt is in the future', () => {
    expect(mcpTokenStatus(lifecycle({ revokedAt: plus(NOW, 1000) }), NOW)).toBe('revoked');
  });
});

describe('mcpTokenAuthentication', () => {
  const subject = { tokenId: stored().id, adminId: stored().adminUserId };

  it('refuses an unknown token', () => {
    expect(mcpTokenAuthentication(undefined, NOW)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('accepts an active token whose admin never changed credentials', () => {
    expect(mcpTokenAuthentication(stored(), NOW)).toEqual({ ok: true, ...subject });
  });

  it('refuses a revoked token', () => {
    expect(mcpTokenAuthentication(stored({ revokedAt: NOW }), NOW)).toEqual({
      ok: false,
      reason: 'revoked',
      ...subject,
    });
  });

  it('refuses a token expiring exactly now', () => {
    expect(mcpTokenAuthentication(stored({ expiresAt: NOW }), NOW)).toEqual({
      ok: false,
      reason: 'expired',
      ...subject,
    });
  });

  it('accepts a token created 1ms after the credentials change', () => {
    const changed = plus(NOW, -1000);
    expect(
      mcpTokenAuthentication(
        stored({ credentialsChangedAt: changed, createdAt: plus(changed, 1) }),
        NOW,
      ).ok,
    ).toBe(true);
  });

  it('refuses a token created exactly at credentialsChangedAt', () => {
    const changed = plus(NOW, -1000);
    expect(
      mcpTokenAuthentication(stored({ credentialsChangedAt: changed, createdAt: changed }), NOW),
    ).toEqual({ ok: false, reason: 'credentials_changed', ...subject });
  });

  it('refuses a token created before the credentials change', () => {
    const changed = plus(NOW, -1000);
    expect(
      mcpTokenAuthentication(
        stored({ credentialsChangedAt: changed, createdAt: plus(changed, -1) }),
        NOW,
      ),
    ).toEqual({ ok: false, reason: 'credentials_changed', ...subject });
  });

  it('reports revoked before credentials_changed', () => {
    const changed = plus(NOW, -1000);
    const result = mcpTokenAuthentication(
      stored({ revokedAt: NOW, credentialsChangedAt: changed, createdAt: plus(changed, -1) }),
      NOW,
    );
    expect(result).toMatchObject({ ok: false, reason: 'revoked' });
  });

  it('reports expired before credentials_changed', () => {
    const changed = plus(NOW, -1000);
    const result = mcpTokenAuthentication(
      stored({ expiresAt: NOW, credentialsChangedAt: changed, createdAt: plus(changed, -1) }),
      NOW,
    );
    expect(result).toMatchObject({ ok: false, reason: 'expired' });
  });

  it('accepts only when created strictly after the change, for any gap', () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000, max: 100_000 }), (gap) => {
        const changed = plus(NOW, -1_000_000);
        const result = mcpTokenAuthentication(
          stored({ credentialsChangedAt: changed, createdAt: plus(changed, gap) }),
          NOW,
        );
        expect(result.ok).toBe(gap > 0);
      }),
    );
  });
});

describe('hashMcpToken', () => {
  it('is the sha256 hex of the token', () => {
    expect(hashMcpToken('abc')).toBe(createHash('sha256').update('abc').digest('hex'));
    expect(hashMcpToken('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('differs for tokens that differ by one character', () => {
    expect(hashMcpToken('ora_mcp_a')).not.toBe(hashMcpToken('ora_mcp_b'));
  });

  it('is 64 lowercase hex characters', () => {
    expect(hashMcpToken(generateMcpToken())).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('isMcpTokenFormat', () => {
  const body = 'A'.repeat(43);

  it('accepts a generated token', () => {
    expect(isMcpTokenFormat(generateMcpToken())).toBe(true);
  });

  it('accepts the prefix plus 43 url-safe characters', () => {
    expect(isMcpTokenFormat(`ora_mcp_${body}`)).toBe(true);
    expect(isMcpTokenFormat(`ora_mcp_${'a-_Z09'.repeat(7)}a`)).toBe(true);
  });

  it.each([
    ['42 characters', `ora_mcp_${'A'.repeat(42)}`],
    ['44 characters', `ora_mcp_${'A'.repeat(44)}`],
    ['no prefix', body],
    ['upper-case prefix', `ORA_MCP_${body}`],
    ['other prefix', `ora_xyz_${body}`],
    ['padding', `ora_mcp_${'A'.repeat(42)}=`],
    ['plus character', `ora_mcp_${'A'.repeat(42)}+`],
    ['slash character', `ora_mcp_${'A'.repeat(42)}/`],
    ['leading space', ` ora_mcp_${body}`],
    ['trailing newline', `ora_mcp_${body}\n`],
    ['empty', ''],
    ['prefix only', 'ora_mcp_'],
  ])('rejects %s', (_name, value) => {
    expect(isMcpTokenFormat(value)).toBe(false);
  });
});

describe('mcpTokenDisplayPrefix', () => {
  it('returns the first 12 characters', () => {
    expect(mcpTokenDisplayPrefix('ora_mcp_abcdefghijkl')).toBe('ora_mcp_abcd');
  });

  it('returns a short token whole', () => {
    expect(mcpTokenDisplayPrefix('ora')).toBe('ora');
  });

  it('never exposes more than 12 characters of a generated token', () => {
    const token = generateMcpToken();
    expect(mcpTokenDisplayPrefix(token)).toHaveLength(12);
    expect(token.startsWith(mcpTokenDisplayPrefix(token))).toBe(true);
  });
});
