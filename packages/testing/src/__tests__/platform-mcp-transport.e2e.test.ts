import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { DRIZZLE } from '@openora/core/server';
import { player } from '@openora/core/pam/schema/profile';
import { newPlayer, type E2e } from '../index.js';
import {
  JsonRpcSchema,
  ToolsListSchema,
  bootMcpE2e,
  closeE2e,
  issueToken,
  mcpCall,
  newMcpAdmin,
  toolsCall,
} from './support/mcp.js';

let e2e: E2e;

beforeAll(async () => {
  e2e = await bootMcpE2e();
}, 60_000);

afterAll(() => closeE2e(e2e));

async function adminToken() {
  const admin = await newMcpAdmin(e2e);
  return { issued: await issueToken(admin) };
}

describe('MCP player tools', () => {
  it('reports the same canonical KYC status in player summary and KYC standing', async () => {
    const { issued } = await adminToken();
    const { playerId } = await newPlayer(e2e.app, 'mcp-legacy-kyc');
    await e2e.app.container
      .get(DRIZZLE)
      .db.update(player)
      .set({ kycStatus: 'verified' })
      .where(eq(player.id, playerId));

    for (const tool of ['kyc_status', 'player_summary']) {
      const response = await mcpCall(e2e, {
        token: issued.token,
        body: toolsCall(tool, { playerId }),
      });

      expect(response.status).toBe(200);
      expect(JsonRpcSchema.parse(response.body).result).toMatchObject({
        structuredContent: { playerId, kycStatus: 'approved' },
      });
    }
  });

  it('omits personal fields from tool descriptions and output schemas in drop mode', async () => {
    const { issued } = await adminToken();
    const response = await mcpCall(e2e, { token: issued.token });
    expect(response.status).toBe(200);
    const { tools } = ToolsListSchema.parse(JsonRpcSchema.parse(response.body).result);

    const summary = tools.find(({ name }) => name === 'player_summary');
    expect(summary?.description).toContain('KYC status');
    expect(summary?.description).not.toMatch(
      /username|email|\bname\b|date of birth|phone|timezone/i,
    );
    expect(Object.keys(summary?.outputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['playerId', 'kycStatus', 'tags']),
    );
    expect(summary?.outputSchema?.properties).not.toHaveProperty('email');
    expect(summary?.outputSchema?.properties).not.toHaveProperty('timezone');

    const standing = tools.find(({ name }) => name === 'kyc_status');
    expect(standing?.description).toContain('verification');
    expect(standing?.description).not.toMatch(/decision reason/i);
    expect(Object.keys(standing?.outputSchema?.properties ?? {})).toEqual(
      expect.arrayContaining(['basic', 'advanced']),
    );
    expect(standing?.outputSchema?.properties).not.toHaveProperty('basicDecisionReason');
    expect(standing?.outputSchema?.properties).not.toHaveProperty('advancedDecisionReason');
  });
});
