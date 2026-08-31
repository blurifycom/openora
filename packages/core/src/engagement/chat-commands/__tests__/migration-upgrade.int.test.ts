import { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { createTestDb } from '@openora/core/testing';
import { migrate } from '../migrate.js';

const STRIPED_TRAUMA_HASH = 'a58ec63c81a4cbd62603a8381da61c5c6d85b57af5d56ba79839d090fbcf0708';

async function migratePreviousHead(databaseUrl: string) {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    await pool.query(`
      CREATE TABLE "chat_command_config" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
        "key" text NOT NULL,
        "enabled" boolean DEFAULT true NOT NULL,
        "label" text NOT NULL,
        "description" text,
        "config" jsonb,
        "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
        CONSTRAINT "chat_command_config_key_unique" UNIQUE("key")
      )
    `);
    await pool.query('CREATE SCHEMA drizzle');
    await pool.query(`
      CREATE TABLE drizzle.__drizzle_migrations_chat_commands (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      )
    `);
    await pool.query(
      `INSERT INTO drizzle.__drizzle_migrations_chat_commands (hash, created_at)
       VALUES ($1, $2)`,
      [STRIPED_TRAUMA_HASH, 1787729046139],
    );
  } finally {
    await pool.end();
  }
}

describe('chat-command migration upgrades', () => {
  it('accepts a database migrated by the previous striped-trauma baseline', async () => {
    const db = await createTestDb([migratePreviousHead, migrate]);
    const pool = new Pool({ connectionString: db.url });
    try {
      const relations = await pool.query<{ config: string | null; gift: string | null }>(
        `SELECT
          to_regclass('public.chat_command_config')::text AS config,
          to_regclass('public.chat_gift')::text AS gift`,
      );

      expect(relations.rows[0]).toEqual({ config: 'chat_command_config', gift: null });
    } finally {
      await pool.end();
      await db.drop();
    }
  });
});
