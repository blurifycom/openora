import type { PrismaClient } from '@oss/persistence';

/**
 * Minimal structural shape of a better-auth instance - just the server-side
 * sign-up call the seeder needs. Typed structurally so this package does not
 * have to depend on @oss/auth (which would create a cycle through persistence).
 */
export type SeedAuth = {
  api: {
    signUpEmail(args: {
      body: { email: string; password: string; name: string };
    }): Promise<unknown>;
  };
};

export type SeedOptions = {
  prisma: PrismaClient;
  auth: SeedAuth;
  /** Admin account to create / promote. Defaults to admin@oss.dev. */
  admin?: { email: string; password: string; name: string };
  /** Shared password for the generated demo player logins. */
  password?: string;
  /** How many demo players (and matching player-role users) to create. */
  playerCount?: number;
  /** Spread player registration dates across this many trailing days. */
  windowDays?: number;
  /** Tenant the demo rows belong to. */
  tenantId?: string;
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

// Deterministic LCG so re-running the seed produces the identical dataset.
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
    if (roll <= 0) return value;
  }
  return table[table.length - 1]![0];
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

/**
 * Populate the database with a coherent, deterministic demo dataset so the
 * platform's backoffice (dashboard, users, players, games) has something
 * realistic to render. Idempotent: it wipes the demo content tables it owns
 * (player, wallet, wallet_transaction, game) and rebuilds them every run, and
 * upserts the auth users by email. Intended for local/dev databases only.
 */
export async function seedDemoData(options: SeedOptions): Promise<SeedResult> {
  const {
    prisma,
    auth,
    playerCount = 36,
    windowDays = 90,
    tenantId = 'default',
    log = () => {},
  } = options;
  const admin = options.admin ?? {
    email: 'admin@oss.dev',
    password: 'password123',
    name: 'Platform Admin',
  };
  const playerPassword = options.password ?? 'password123';
  // oxlint-disable-next-line typescript/no-explicit-any
  const db = prisma as any;
  const rng = makeRng(0x5eed);

  log('Clearing existing demo content (player, wallet, transaction, game)...');
  await db.walletTransaction.deleteMany({ where: { tenantId } });
  await db.wallet.deleteMany({ where: { tenantId } });
  await db.player.deleteMany({ where: { tenantId } });
  await db.game.deleteMany({ where: { tenantId } });

  // --- Admin (operator) ---
  const adminUser = await ensureUser(prisma, auth, {
    email: admin.email,
    password: admin.password,
    name: admin.name,
    role: 'admin',
    isActive: true,
  });
  if (adminUser) log(`Admin ready: ${admin.email} / ${admin.password}`);

  // --- Games catalog ---
  await db.game.createMany({
    data: GAMES.map(([name, provider, category]) => ({
      tenantId,
      name,
      provider,
      category,
      isActive: true,
    })),
  });
  log(`Created ${GAMES.length} games.`);

  // --- Players (each backed by a player-role user) ---
  let userCount = adminUser ? 1 : 0;
  let txCount = 0;
  const now = Date.now();
  const dayMs = 86_400_000;

  for (let i = 0; i < playerCount; i++) {
    const first = pick(rng, FIRST_NAMES);
    const last = pick(rng, LAST_NAMES);
    const displayName = `${first} ${last}`;
    const email = `player.${i + 1}@demo.casino.dev`;
    const [country, currency, language] = pick(rng, LOCALES);
    const status = weighted(rng, STATUS_WEIGHTS);
    const kycStatus = weighted(rng, KYC_WEIGHTS);
    const level = 1 + Math.floor(rng() * 10);
    // Square the roll so registrations skew recent -> upward chart trend.
    const daysAgo = Math.floor(rng() * rng() * windowDays);
    const createdAt = new Date(now - daysAgo * dayMs);
    const isActive = status !== 'suspended' && status !== 'closed';

    const user = await ensureUser(prisma, auth, {
      email,
      password: playerPassword,
      name: displayName,
      role: 'player',
      isActive,
      createdAt,
    });
    if (!user) continue;
    userCount++;

    const totalDeposits = round2(rng() * 8000 + (level - 1) * 400);
    const totalWagered = round2(totalDeposits * (1.5 + rng() * 4));
    const lastSeenAt =
      status === 'active'
        ? new Date(now - Math.floor(rng() * 7) * dayMs)
        : status === 'dormant'
          ? new Date(now - (30 + Math.floor(rng() * 60)) * dayMs)
          : null;

    await db.player.create({
      data: {
        userId: user.id,
        displayName,
        country,
        currency,
        language,
        status,
        kycStatus,
        level,
        totalWagered,
        totalDeposits,
        lastSeenAt,
        tenantId,
        createdAt,
      },
    });

    const wallet = await db.wallet.create({
      data: {
        userId: user.id,
        tenantId,
        balance: round2(rng() * 1500),
        currency,
      },
    });

    // Deposits (completed) so dashboard deposit totals are non-zero.
    const deposits = 1 + Math.floor(rng() * 4);
    let depositSum = 0;
    for (let d = 0; d < deposits; d++) {
      const amount = round2(20 + rng() * 600);
      depositSum += amount;
      await db.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId,
          type: 'deposit',
          amount,
          currency,
          status: 'completed',
          createdAt: new Date(createdAt.getTime() + (d + 1) * dayMs),
        },
      });
      txCount++;
    }
    // Some verified players withdraw a slice back.
    if (kycStatus === 'verified' && rng() > 0.5) {
      await db.walletTransaction.create({
        data: {
          walletId: wallet.id,
          tenantId,
          type: 'withdrawal',
          amount: round2(depositSum * (0.2 + rng() * 0.3)),
          currency,
          status: 'completed',
          createdAt: new Date(now - Math.floor(rng() * 14) * dayMs),
        },
      });
      txCount++;
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
  prisma: PrismaClient,
  auth: SeedAuth,
  input: EnsureUserInput,
): Promise<{ id: string } | null> {
  // oxlint-disable-next-line typescript/no-explicit-any
  const db = prisma as any;
  let user = await db.user.findUnique({ where: { email: input.email } });
  if (!user) {
    // better-auth owns password hashing (scrypt) and the linked account row.
    await auth.api.signUpEmail({
      body: { email: input.email, password: input.password, name: input.name },
    });
    user = await db.user.findUnique({ where: { email: input.email } });
  }
  if (!user) return null;
  await db.user.update({
    where: { id: user.id },
    data: {
      name: input.name,
      role: input.role,
      isActive: input.isActive,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
  return { id: user.id };
}
