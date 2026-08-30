import type { DrizzleDb } from '@openora/core/server';
import { chatCommandConfig } from '../schema/index.js';

export async function seedChatCommands(db: DrizzleDb): Promise<void> {
  await db
    .insert(chatCommandConfig)
    .values([
      {
        key: 'mention',
        enabled: true,
        label: 'Mention',
        description: 'Mention an online user with @username',
      },
      {
        key: 'profile',
        enabled: true,
        label: 'Profile',
        description: "Look up a player's profile",
      },
      {
        key: 'gift',
        enabled: true,
        label: 'Gift',
        description: 'Send tokens to another player',
        config: { minAmount: { USD: '1.00000000' } },
      },
      {
        key: 'rain',
        enabled: true,
        label: 'Rain',
        description: 'Split tokens among online room members',
        config: { minAmount: { USD: '1.00000000' }, maxRecipients: 50 },
      },
      {
        key: 'donate',
        enabled: true,
        label: 'Donate',
        description: 'Send a direct tip to a specific player',
        config: { minAmount: { USD: '1.00000000' } },
      },
      {
        key: 'block',
        enabled: true,
        label: 'Block',
        description: 'Block a player — their messages will be hidden from you',
      },
      {
        key: 'unblock',
        enabled: true,
        label: 'Unblock',
        description: 'Unblock a player — their messages will be visible to you again',
      },
      {
        key: 'ignore',
        enabled: true,
        label: 'Ignore',
        description: 'Ignore a player — their messages will be hidden from you',
      },
      {
        key: 'unignore',
        enabled: true,
        label: 'Unignore',
        description: 'Unignore a player — their messages will be visible to you again',
      },
    ])
    .onConflictDoNothing();
}
