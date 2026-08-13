// See ADR-0020.
import { findOneOrThrow, type DrizzleDb } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game } from '@openora/core/casino/schema/gaming';
import {
  chatRoom,
  chatRoomMember,
  chatMessage,
  chatUserBlock,
  chatUserIgnore,
} from '@openora/core/engagement/schema/chat';
import type { ChatRoomCategory } from '@openora/core/engagement/contracts/chat';

export type SeedAuth = {
  api: {
    signUpEmail(args: {
      body: { email: string; password: string; name: string };
    }): Promise<unknown>;
  };
};

export type SeedOptions = {
  db: DrizzleDb;
  auth: SeedAuth;
  admin?: { email: string; password: string; name: string };
  password?: string;
  playerCount?: number;
  windowDays?: number;
  log?: (msg: string) => void;
};

export type SeedResult = {
  adminEmail: string;
  adminPassword: string;
  playerPassword: string;
  users: number;
  players: number;
  games: number;
  transactions: number;
  rooms: number;
};

function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function pick<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)] as T;
}

function weighted<T>(rng: () => number, table: readonly (readonly [T, number])[]): T {
  const total = table.reduce((sum, [, w]) => sum + w, 0);
  let roll = rng() * total;
  for (const [value, w] of table) {
    roll -= w;
    if (roll <= 0) {
      return value;
    }
  }
  const last = table.at(-1);
  if (!last) {
    throw new Error('weighted: table must not be empty');
  }
  return last[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

const FIRST_NAMES = [
  'Alex',
  'Maria',
  'Liam',
  'Sofia',
  'Noah',
  'Emma',
  'Lucas',
  'Olivia',
  'Mateo',
  'Ava',
  'Hugo',
  'Mia',
  'Leon',
  'Elena',
  'Adam',
  'Chloe',
  'Jonas',
  'Nora',
  'Daniel',
  'Lea',
  'Ivan',
  'Sara',
  'Felix',
  'Anna',
  'Oscar',
  'Lina',
  'Theo',
  'Zoe',
  'Max',
  'Iris',
] as const;

const LAST_NAMES = [
  'Novak',
  'Kowalski',
  'Muller',
  'Rossi',
  'Garcia',
  'Andersen',
  'Silva',
  'Dubois',
  'Horvath',
  'Petrov',
  'Nilsson',
  'Fischer',
  'Costa',
  'Larsen',
  'Weber',
  'Romano',
  'Schmidt',
  'Lopez',
  'Jensen',
  'Moreau',
] as const;

const LOCALES = [
  ['DE', 'EUR', 'de'],
  ['GB', 'GBP', 'en'],
  ['CA', 'CAD', 'en'],
  ['SE', 'SEK', 'sv'],
  ['ES', 'EUR', 'es'],
  ['FR', 'EUR', 'fr'],
  ['NO', 'NOK', 'no'],
  ['IT', 'EUR', 'it'],
] as const;

const STATUS_WEIGHTS = [
  ['active', 60],
  ['dormant', 16],
  ['self_excluded', 9],
  ['suspended', 9],
  ['closed', 6],
] as const;

const KYC_WEIGHTS = [
  ['approved', 62],
  ['pending', 26],
  ['rejected', 12],
] as const;

// E.164 phone numbers, one per seeded player slot (index-stable so the same player
// always gets the same number across re-seeds). Country codes align roughly with LOCALES.
const PHONE_NUMBERS = [
  '+4915201234567',
  '+4407911123456',
  '+14165550101',
  '+46701234567',
  '+34612345678',
  '+33612345678',
  '+4791234567',
  '+393331234567',
  '+4915207654321',
  '+4407911654321',
  '+14165550202',
  '+46709876543',
  '+34698765432',
  '+33698765432',
  '+4798765432',
  '+393339876543',
  '+4915209988776',
  '+4407922334455',
  '+14165550303',
  '+46731122334',
  '+34611223344',
  '+33611223344',
  '+4792233445',
  '+393312233445',
  '+4915203344556',
  '+4407933445566',
  '+14165550404',
  '+46744556677',
  '+34633445566',
  '+33644556677',
  '+4793344556',
  '+393323344556',
  '+4915204455667',
  '+4407944556677',
  '+14165550505',
  '+46755667788',
] as const;

const GAMES = [
  ['Gates of Olympus', 'Pragmatic Play', 'slots'],
  ['Sweet Bonanza', 'Pragmatic Play', 'slots'],
  ['Book of Dead', "Play'n GO", 'slots'],
  ['Starburst', 'NetEnt', 'slots'],
  ["Gonzo's Quest", 'NetEnt', 'slots'],
  ['Wanted Dead or a Wild', 'Hacksaw Gaming', 'slots'],
  ['Le Bandit', 'Hacksaw Gaming', 'slots'],
  ['Lightning Roulette', 'Evolution', 'live'],
  ['Crazy Time', 'Evolution', 'live'],
  ['Blackjack VIP', 'Evolution', 'live'],
  ['Mega Ball', 'Evolution', 'live'],
  ['European Roulette', 'NetEnt', 'table'],
  ['Aviator', 'Spribe', 'crash'],
  ['Plinko', 'Spribe', 'crash'],
] as const;

type ChatRoomSeed = {
  slug: string;
  name: string;
  category: ChatRoomCategory;
  isPublic?: boolean;
  joinCode?: string;
  messages: readonly string[];
};

const CHAT_ROOMS: readonly ChatRoomSeed[] = [
  {
    slug: '__global',
    name: 'Global',
    category: 'games-sports',
    messages: [],
  },
  {
    slug: 'sports',
    name: 'Sports',
    category: 'games-sports',
    messages: [
      'Big match tonight - who are you backing?',
      'Odds are looking great on the underdog.',
      'Anyone else watching the derby this weekend?',
      'That live-betting swing was wild.',
    ],
  },
  {
    slug: 'jackpot-wheel',
    name: 'Jackpot Wheel',
    category: 'games-sports',
    messages: [
      'Share your wins here!',
      'Jackpot season has begun!',
      'So close to the wheel bonus, ugh 😅',
      'Congrats on the big spin!',
    ],
  },
  {
    slug: 'latam',
    name: 'LATAM',
    category: 'regions',
    messages: [],
  },
  {
    slug: 'europe',
    name: 'Europe',
    category: 'regions',
    messages: [],
  },
  {
    slug: 'asia',
    name: 'Asia',
    category: 'regions',
    messages: [],
  },
  {
    slug: 'africa',
    name: 'Africa',
    category: 'regions',
    messages: [],
  },
  {
    slug: 'english',
    name: 'English',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'india',
    name: 'India',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'chinese',
    name: 'Chinese',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'spanish',
    name: 'Spanish',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'russian',
    name: 'Russian',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'french',
    name: 'French',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'arabic',
    name: 'Arabic',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'bengali',
    name: 'Bengali',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'portuguese',
    name: 'Portuguese',
    category: 'languages',
    messages: [],
  },
  {
    slug: 'high-rollers-club',
    name: 'High Rollers Club',
    category: 'private-channels',
    isPublic: false,
    joinCode: 'HR7C2P',
    messages: [],
  },
  {
    slug: 'squad-lobby',
    name: 'Squad Lobby',
    category: 'private-channels',
    isPublic: false,
    joinCode: 'SQ8D4M',
    messages: [],
  },
  {
    slug: 'vip-whales',
    name: 'VIP Whales',
    category: 'private-channels',
    isPublic: false,
    joinCode: 'VW9H3K',
    messages: [],
  },
];

// Global chat (roomId: null) - authored by random seeded players, oldest first.
const GLOBAL_CHAT = [
  'Good luck everyone! 🍀',
  'Anyone on the new slots tonight?',
  'Big win on Aviator just now 🚀',
  'gl hf all',
  'Tried Sweet Bonanza today, pretty fun',
  'That Book of Dead session was rough 😅',
  'Lightning Roulette hitting hard tonight ⚡',
  'Remember to set your limits, stay safe out there',
  'Who is up for a Gates of Olympus run?',
  'Cashed out just in time, phew',
] as const;

export async function seedDemoData(options: SeedOptions): Promise<SeedResult> {
  const { db, auth, playerCount = 36, windowDays = 90, log = () => {} } = options;
  const admin = options.admin ?? {
    email: 'admin@oss.dev',
    password: 'password123',
    name: 'Platform Admin',
  };
  const playerPassword = options.password ?? 'password123';
  const rng = makeRng(0x5eed);

  log('Clearing existing demo content (player, wallet, transaction, game, chat)...');
  await db.delete(chatUserBlock);
  await db.delete(chatUserIgnore);
  await db.delete(chatMessage);
  await db.delete(chatRoom);
  await db.delete(walletTransaction);
  await db.delete(wallet);
  await db.delete(player);
  await db.delete(game);

  const adminUser = await ensureUser(db, auth, {
    email: admin.email,
    password: admin.password,
    name: admin.name,
    role: 'admin',
    isActive: true,
  });
  if (adminUser) {
    log(`Admin ready: ${admin.email} / ${admin.password}`);
  }

  await db.insert(game).values(
    GAMES.map(([name, provider, category]) => ({
      name,
      provider,
      category,
      isActive: true,
    })),
  );
  log(`Created ${GAMES.length} games.`);

  let userCount = adminUser ? 1 : 0;
  let txCount = 0;
  const now = Date.now();
  const dayMs = 86_400_000;
  const players: { id: string; displayName: string; role: string; currency: string }[] = [];

  for (let i = 0; i < playerCount; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const displayName = `${first} ${last}`;
    const email = `player.${i + 1}@demo.igaming.dev`;
    const [country] = pick(rng, LOCALES);
    const status = weighted(rng, STATUS_WEIGHTS);
    const kycStatus = weighted(rng, KYC_WEIGHTS);
    const level = 1 + Math.floor(rng() * 10);
    const daysAgo = Math.floor(rng() * rng() * windowDays);
    const createdAt = new Date(now - daysAgo * dayMs);
    const isActive = status !== 'suspended' && status !== 'closed';
    const phoneNumber = PHONE_NUMBERS[i % PHONE_NUMBERS.length] ?? null;
    const phoneVerified = phoneNumber !== null && rng() > 0.25;
    const phoneVerifiedAt = phoneVerified
      ? new Date(createdAt.getTime() + Math.floor(rng() * 7) * dayMs)
      : null;

    const playerUser = await ensureUser(db, auth, {
      email,
      password: playerPassword,
      name: displayName,
      role: 'player',
      isActive,
      createdAt,
      phoneNumber,
      phoneVerified,
      phoneVerifiedAt,
    });
    if (!playerUser) {
      continue;
    }
    userCount++;
    /* Restricted USD and 1 EUR currency picks due to not ready currency conversion */
    const currency =
      playerUser.role === 'admin' || players.some((p) => p.currency === 'EUR') ? 'USD' : 'EUR';
    players.push({ id: playerUser.id, displayName, role: playerUser.role, currency });

    const totalDeposits = round2(rng() * 8000 + (level - 1) * 400);
    const totalWagered = round2(totalDeposits * (1.5 + rng() * 4));
    const lastSeenAt =
      status === 'active'
        ? new Date(now - Math.floor(rng() * 7) * dayMs)
        : status === 'dormant'
          ? new Date(now - (30 + Math.floor(rng() * 60)) * dayMs)
          : null;

    await db.insert(player).values({
      userId: playerUser.id,
      displayName,
      country,
      currency,
      status,
      kycStatus,
      level,
      totalWagered: String(totalWagered),
      totalDeposits: String(totalDeposits),
      lastSeenAt,
      createdAt,
    });

    const walletRow = findOneOrThrow(
      await db
        .insert(wallet)
        .values({
          userId: playerUser.id,
          balance: String(round2(rng() * 1500)),
          currency,
        })
        .returning(),
      new Error('seed: expected the wallet insert to return a row'),
    );

    const deposits = 1 + Math.floor(rng() * 4);
    let depositSum = 0;
    const txRows: (typeof walletTransaction.$inferInsert)[] = [];
    for (let d = 0; d < deposits; d++) {
      const amount = round2(20 + rng() * 600);
      depositSum += amount;
      txRows.push({
        walletId: walletRow.id,
        type: 'deposit',
        amount: String(amount),
        currency,
        status: 'completed',
        createdAt: new Date(createdAt.getTime() + (d + 1) * dayMs),
      });
    }
    if (kycStatus === 'approved' && rng() > 0.5) {
      txRows.push({
        walletId: walletRow.id,
        type: 'withdrawal',
        amount: String(round2(depositSum * (0.2 + rng() * 0.3))),
        currency,
        status: 'completed',
        createdAt: new Date(now - Math.floor(rng() * 14) * dayMs),
      });
    }
    if (txRows.length > 0) {
      await db.insert(walletTransaction).values(txRows);
      txCount += txRows.length;
    }
  }

  log(`Created ${playerCount} players with wallets and ${txCount} transactions.`);

  // Room + global chat messages are authored by the seeded players (falling back to
  // admin only if somehow no player got created), so demo chat reads like real activity.
  const chatAuthors =
    players.length > 0 ? players : adminUser ? [{ id: adminUser.id, displayName: admin.name }] : [];

  let roomCount = 0;
  let chatMessageCount = 0;
  if (adminUser) {
    const insertedRooms = await db
      .insert(chatRoom)
      .values(
        CHAT_ROOMS.map((r) => ({
          name: r.name,
          slug: r.slug,
          category: r.category,
          isPublic: r.isPublic ?? true,
          joinCode: r.joinCode ?? null,
          creatorId: r.category === 'private-channels' ? null : adminUser.id,
        })),
      )
      .returning();
    roomCount = insertedRooms.length;

    const adminOwnedRooms = insertedRooms
      .filter((room) => room.isPublic || room.creatorId === adminUser.id)
      .map((room) => ({ roomId: room.id, userId: adminUser.id, role: 'owner' as const }));
    if (adminOwnedRooms.length > 0) {
      await db.insert(chatRoomMember).values(adminOwnedRooms);
    }

    if (chatAuthors.length > 0) {
      const roomMessageRows: (typeof chatMessage.$inferInsert)[] = insertedRooms.flatMap((room) => {
        const def = CHAT_ROOMS.find((r) => r.slug === room.slug);
        const messages = def?.messages ?? [];
        return messages.map((content, idx) => {
          const author = pick(rng, chatAuthors);
          return {
            roomId: room.id,
            userId: author.id,
            username: author.displayName,
            content,
            createdAt: new Date(now - (messages.length - idx) * 15 * 60_000),
          };
        });
      });

      const globalMessageRows: (typeof chatMessage.$inferInsert)[] = GLOBAL_CHAT.map(
        (content, idx) => {
          const author = pick(rng, chatAuthors);
          return {
            roomId: null,
            userId: author.id,
            username: author.displayName,
            content,
            createdAt: new Date(now - (GLOBAL_CHAT.length - idx) * 10 * 60_000),
          };
        },
      );

      const messageRows = [...roomMessageRows, ...globalMessageRows];
      if (messageRows.length > 0) {
        await db.insert(chatMessage).values(messageRows);
        chatMessageCount = messageRows.length;
      }
    }

    log(`Created ${roomCount} chat rooms and ${chatMessageCount} chat messages.`);
  }

  if (adminUser && players.length >= 2) {
    // Deterministic pick of two distinct players: a random index, then a random
    // non-zero offset (mod length) so the second index can never land on the first.
    const blockedIndex = Math.floor(rng() * players.length);
    const offset = 1 + Math.floor(rng() * (players.length - 1));
    const ignoredIndex = (blockedIndex + offset) % players.length;
    const blocked = players[blockedIndex];
    const ignored = players[ignoredIndex];
    if (blocked && ignored) {
      await db.insert(chatUserBlock).values({ blockerId: adminUser.id, blockedId: blocked.id });
      await db.insert(chatUserIgnore).values({ ignorerId: adminUser.id, ignoredId: ignored.id });
      log(`Admin blocked ${blocked.displayName} and ignored ${ignored.displayName}.`);
    }
  }

  return {
    adminEmail: admin.email,
    adminPassword: admin.password,
    playerPassword,
    users: userCount,
    players: playerCount,
    games: GAMES.length,
    transactions: txCount,
    rooms: roomCount,
  };
}

type EnsureUserInput = {
  email: string;
  password: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt?: Date;
  phoneNumber?: string | null;
  phoneVerified?: boolean;
  phoneVerifiedAt?: Date | null;
};

async function ensureUser(
  db: DrizzleDb,
  auth: SeedAuth,
  input: EnsureUserInput,
): Promise<{ id: string; role: string } | null> {
  let [existing] = await db
    .select({ id: user.id, role: user.role })
    .from(user)
    .where(eq(user.email, input.email));
  if (!existing) {
    await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    [existing] = await db
      .select({ id: user.id, role: user.role })
      .from(user)
      .where(eq(user.email, input.email));
  }
  if (!existing) {
    return null;
  }
  const role = existing.role === 'admin' || input.role === 'admin' ? 'admin' : input.role;
  const patch: Partial<typeof user.$inferInsert> = {
    name: input.name,
    role,
    isActive: input.isActive,
  };
  if (input.createdAt) {
    patch.createdAt = input.createdAt;
  }
  if (input.phoneNumber !== undefined) {
    patch.phoneNumber = input.phoneNumber;
  }
  if (input.phoneVerified !== undefined) {
    patch.phoneVerified = input.phoneVerified;
  }
  if (input.phoneVerifiedAt !== undefined) {
    patch.phoneVerifiedAt = input.phoneVerifiedAt;
  }
  await db.update(user).set(patch).where(eq(user.id, existing.id));
  return { id: existing.id, role };
}
