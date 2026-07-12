// See ADR-0020.
import { findOneOrThrow, type DrizzleDb } from '@openora/core/server';
import { eq } from 'drizzle-orm';
import { user } from '@openora/core/pam/schema/identity';
import { player } from '@openora/core/pam/schema/profile';
import { wallet, walletTransaction } from '@openora/core/wallet/schema';
import { game } from '@openora/core/casino/schema/gaming';

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
  ['verified', 62],
  ['pending', 26],
  ['rejected', 12],
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

export async function seedDemoData(options: SeedOptions): Promise<SeedResult> {
  const { db, auth, playerCount = 36, windowDays = 90, log = () => {} } = options;
  const admin = options.admin ?? {
    email: 'admin@oss.dev',
    password: 'password123',
    name: 'Platform Admin',
  };
  const playerPassword = options.password ?? 'password123';
  const rng = makeRng(0x5eed);

  log('Clearing existing demo content (player, wallet, transaction, game)...');
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

  for (let i = 0; i < playerCount; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const displayName = `${first} ${last}`;
    const email = `player.${i + 1}@demo.igaming.dev`;
    const [country, currency] = pick(rng, LOCALES);
    const status = weighted(rng, STATUS_WEIGHTS);
    const kycStatus = weighted(rng, KYC_WEIGHTS);
    const level = 1 + Math.floor(rng() * 10);
    const daysAgo = Math.floor(rng() * rng() * windowDays);
    const createdAt = new Date(now - daysAgo * dayMs);
    const isActive = status !== 'suspended' && status !== 'closed';

    const playerUser = await ensureUser(db, auth, {
      email,
      password: playerPassword,
      name: displayName,
      role: 'player',
      isActive,
      createdAt,
    });
    if (!playerUser) {
      continue;
    }
    userCount++;

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
    if (kycStatus === 'verified' && rng() > 0.5) {
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

  return {
    adminEmail: admin.email,
    adminPassword: admin.password,
    playerPassword,
    users: userCount,
    players: playerCount,
    games: GAMES.length,
    transactions: txCount,
  };
}

type EnsureUserInput = {
  email: string;
  password: string;
  name: string;
  role: string;
  isActive: boolean;
  createdAt?: Date;
};

async function ensureUser(
  db: DrizzleDb,
  auth: SeedAuth,
  input: EnsureUserInput,
): Promise<{ id: string } | null> {
  let [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email));
  if (!existing) {
    await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    [existing] = await db.select({ id: user.id }).from(user).where(eq(user.email, input.email));
  }
  if (!existing) {
    return null;
  }
  const patch: Partial<typeof user.$inferInsert> = {
    name: input.name,
    role: input.role,
    isActive: input.isActive,
  };
  if (input.createdAt) {
    patch.createdAt = input.createdAt;
  }
  await db.update(user).set(patch).where(eq(user.id, existing.id));
  return { id: existing.id };
}
