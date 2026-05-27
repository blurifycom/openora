import { oc } from '@orpc/contract';
import { implement, ORPCError } from '@orpc/server';
import { type OssContext } from '@oss/core';
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
// In-process store (replace with the overlay's own Drizzle tables in production)
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
// ---------------------------------------------------------------------------

const crashContract = {
  startRound: oc.output(CrashRoundSchema),
  placeBet: oc.input(CrashBetInputSchema).output(CrashBetSchema),
  cashOut: oc.input(CrashCashOutInputSchema).output(CrashBetSchema),
  currentRound: oc.output(CrashRoundSchema),
};

function requireUserId(context: OssContext): string {
  const raw = context.request.headers['x-user-id'];
  const userId = Array.isArray(raw) ? raw[0] : raw;
  if (!userId) {
    throw new ORPCError('UNAUTHORIZED', { message: 'x-user-id header is required' });
  }
  return userId;
}

// ---------------------------------------------------------------------------
// Router factory - wires contract handlers to business logic
// ---------------------------------------------------------------------------

export function createCrashRouter() {
  const os = implement(crashContract).$context<OssContext>();

  return os.router({
    // POST /crash/rounds - start a new crash round
    startRound: os.startRound.handler(() => {
      const id = nextId();
      const serverSeed = Math.random().toString(36).slice(2);
      const clientSeed = Math.random().toString(36).slice(2);
      const multiplier = computeCrashMultiplier(serverSeed, clientSeed);
      const round: CrashRound = { id, multiplier, status: 'active', createdAt: nowIso() };
      rounds.set(id, round);
      return round;
    }),

    // POST /crash/bets - place a bet on the current active round
    placeBet: os.placeBet.handler(({ input, context }) => {
      const userId = requireUserId(context);
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
    cashOut: os.cashOut.handler(({ input, context }) => {
      const userId = requireUserId(context);
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
    currentRound: os.currentRound.handler(() => {
      const active = [...rounds.values()].find((r) => r.status === 'active');
      if (!active) {
        throw new ORPCError('NOT_FOUND', { message: 'No active round' });
      }
      return active;
    }),
  });
}

export { crashContract, CrashRoundSchema, CrashBetSchema };
