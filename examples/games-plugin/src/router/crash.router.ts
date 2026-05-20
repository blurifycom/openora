import { Controller } from '@nestjs/common';
import { Implement, implement } from '@orpc/nest';
import { oc } from '@orpc/contract';
import { ORPCError } from '@orpc/server';
import * as z from 'zod';
import { computeCrashMultiplier } from '../game/crash.game.js';
import {
  CrashBetInputSchema,
  CrashCashOutInputSchema,
  CrashRoundSchema,
  CrashBetSchema,
  type CrashRound,
  type CrashBet,
} from '../schemas/crash.schemas.js';

// ---------------------------------------------------------------------------
// In-process store (replace with Prisma + injected PrismaService in production)
// ---------------------------------------------------------------------------

const rounds = new Map<string, CrashRound>();
const bets = new Map<string, CrashBet>();

function nextId(): string {
  return Math.random().toString(36).slice(2);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------------------------------------------------------------------------
// oRPC contract for the Crash game
// Defines the route shapes; the controller below implements them.
// ---------------------------------------------------------------------------

const crashContract = {
  startRound: oc.output(CrashRoundSchema),

  placeBet: oc.input(CrashBetInputSchema).output(CrashBetSchema),

  cashOut: oc.input(CrashCashOutInputSchema).output(CrashBetSchema),

  currentRound: oc.output(CrashRoundSchema),
};

type RequestLike = { headers: Record<string, string | string[] | undefined> };

// ---------------------------------------------------------------------------
// Controller - wires contract handlers to business logic
// ---------------------------------------------------------------------------

@Controller()
export class CrashController {
  @Implement(crashContract)
  crash() {
    return {
      // POST /crash/rounds - start a new crash round
      startRound: implement(crashContract.startRound).handler(() => {
        const id = nextId();
        const serverSeed = Math.random().toString(36).slice(2);
        const clientSeed = Math.random().toString(36).slice(2);
        const multiplier = computeCrashMultiplier(serverSeed, clientSeed);

        const round: CrashRound = {
          id,
          multiplier,
          status: 'active',
          createdAt: nowIso(),
        };

        rounds.set(id, round);
        return round;
      }),

      // POST /crash/bets - place a bet on the current active round
      placeBet: implement(crashContract.placeBet).handler(({ input, context }) => {
        const req = (context as { request: RequestLike }).request;
        const userId = req.headers['x-user-id'];

        if (typeof userId !== 'string' || !userId) {
          throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
        }

        const round = rounds.get(input.roundId);
        if (!round) {
          throw new ORPCError('NOT_FOUND', { message: `Round ${input.roundId} not found` });
        }
        if (round.status !== 'active') {
          throw new ORPCError('BAD_REQUEST', { message: 'Round is not active' });
        }

        const bet: CrashBet = {
          id: nextId(),
          roundId: input.roundId,
          userId,
          betAmount: input.betAmount,
          cashOutAt: null,
          winAmount: 0,
          createdAt: nowIso(),
        };

        bets.set(bet.id, bet);
        return bet;
      }),

      // POST /crash/cash-out - cash out before the round crashes
      cashOut: implement(crashContract.cashOut).handler(({ input, context }) => {
        const req = (context as { request: RequestLike }).request;
        const userId = req.headers['x-user-id'];

        if (typeof userId !== 'string' || !userId) {
          throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
        }

        const bet = bets.get(input.betId);
        if (!bet) {
          throw new ORPCError('NOT_FOUND', { message: `Bet ${input.betId} not found` });
        }
        if (bet.userId !== userId) {
          throw new ORPCError('FORBIDDEN', { message: 'Bet does not belong to this user' });
        }
        if (bet.cashOutAt !== null) {
          throw new ORPCError('BAD_REQUEST', { message: 'Already cashed out' });
        }

        const round = rounds.get(bet.roundId);
        if (!round || round.status !== 'active') {
          throw new ORPCError('BAD_REQUEST', { message: 'Round is no longer active' });
        }

        // Snapshot the current multiplier as the cash-out point
        const cashOutMultiplier = round.multiplier;
        const updated: CrashBet = {
          ...bet,
          cashOutAt: cashOutMultiplier,
          winAmount: bet.betAmount * cashOutMultiplier,
        };

        bets.set(bet.id, updated);
        return updated;
      }),

      // GET /crash/rounds/current - fetch the current active round
      currentRound: implement(crashContract.currentRound).handler(() => {
        const active = [...rounds.values()].find((r) => r.status === 'active');
        if (!active) {
          throw new ORPCError('NOT_FOUND', { message: 'No active round' });
        }
        return active;
      }),
    };
  }
}

// Export the contract so callers can build a typed client
export { crashContract };

// Zod output schemas re-exported for convenience
export { CrashRoundSchema, CrashBetSchema };
