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
        description: "View a player's public profile",
      },
      {
        key: 'gift',
        enabled: true,
        label: 'Gift',
        description: 'Send tokens to another player',
      },
      {
        key: 'rain',
        enabled: true,
        label: 'Rain',
        description: 'Split tokens among online room members',
      },
    ])
    .onConflictDoNothing();
}
