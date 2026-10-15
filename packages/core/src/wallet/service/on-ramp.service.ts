import {
  assertRateLimit,
  createDomainError,
  createLogger,
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyAdd,
  moneyCompare,
  withAdvisoryXactLock,
  type DrizzleService,
  type DrizzleTx,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  OnRampCheckoutResultSchema,
  OnRampOptionsSchema,
  OnRampQuoteSchema,
  OnRampRefusedError,
  OnRampStatusSchema,
  OnRampVendorUnavailableError,
  OnRampWebhookEventSchema,
  RATE_LIMIT_KEYS,
  RgLimitExceededError,
  UuidSchema,
  type AuditWritePort,
  type CacheAdapter,
  type ClientMeta,
  type GeoCheckCommands,
  type OnRampAdapter,
  type OnRampCheckout,
  type OnRampOptions,
  type OnRampQuote,
  type OnRampStatus,
  type OnRampWebhookEvent,
  type PlayEligibilityPort,
  type RateLimitKey,
  type RateLimiterAdapter,
  type RgLimitsPort,
  type User,
} from '@openora/core/contracts';
import { and, eq, gt, isNull, or, sql } from 'drizzle-orm';
import type { OnRampCheckoutResponse, OnRampOrder } from '../contract/index.js';
import { walletOnRampOrder, type WalletOnRampOrder } from '../schema/index.js';
import {
  assertDepositAllowed,
  DepositDisabledError,
  IdempotencyKeyReuseError,
  type WalletService,
} from './wallet.service.js';

const logger = createLogger('wallet-on-ramp');

const ON_RAMP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const ON_RAMP_STATUS_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

const OPTIONS_TTL_MS = 60 * 1000;
const UNOPENED_CHECKOUT_HOLD = '15 minutes';
// However fast the client polls, the vendor is asked about an order at most this often.
const STATUS_TTL_MS = 10 * 1000;

const OPEN_STATUSES: readonly OnRampStatus[] = ['pending', 'processing'];

const NEXT_STATUSES: Record<OnRampStatus, readonly OnRampStatus[]> = {
  pending: ['processing', 'completed', 'failed', 'cancelled', 'expired'],
  processing: ['completed', 'failed', 'cancelled', 'expired', 'refunded'],
  completed: ['refunded'],
  failed: [],
  cancelled: [],
  expired: [],
  refunded: [],
};

export const OnRampUnavailableError = makeConflictError(
  'OnRampUnavailableError',
  'buying crypto is unavailable',
);

export const OnRampOrderNotFoundError = makeNotFoundError('OnRampOrder');

export const OnRampRestrictedError = createDomainError<[]>(
  'OnRampRestrictedError',
  () => 'player is restricted from depositing',
  { code: 'RG_BLOCKED' },
);

export const OnRampGeoBlockedError = createDomainError<[]>(
  'OnRampGeoBlockedError',
  () => 'buying crypto is not available in this region',
  { code: 'GEO_BLOCKED' },
);

type OnRampPurchase = {
  userId: User['id'];
  meta: ClientMeta;
  fiatCurrency: string;
  fiatAmount: string;
  currency: string;
  network: string;
};

/**
 * Buying crypto with fiat on a vendor's hosted checkout, delivered on-chain to the player's own
 * deposit address. Nothing here touches the ledger: the coins arrive like any other deposit and
 * `creditDepositByAddress` credits them, with its own holds and checks. This service gates who
 * may open a checkout, keeps the order row, and records what the vendor reports.
 */
export class OnRampService {
  private readonly drizzle: DrizzleService;
  private readonly wallet: WalletService;
  private readonly adapter: OnRampAdapter;
  private readonly audit: AuditWritePort;
  private readonly playEligibility: PlayEligibilityPort;
  private readonly geoCheck?: GeoCheckCommands;
  private readonly rgLimits?: RgLimitsPort;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly cache?: CacheAdapter;

  constructor(deps: {
    drizzle: DrizzleService;
    wallet: WalletService;
    adapter: OnRampAdapter;
    audit: AuditWritePort;
    playEligibility: PlayEligibilityPort;
    geoCheck?: GeoCheckCommands;
    rgLimits?: RgLimitsPort;
    limiter?: RateLimiterAdapter<RateLimitKey>;
    cache?: CacheAdapter;
  }) {
    this.drizzle = deps.drizzle;
    this.wallet = deps.wallet;
    this.adapter = deps.adapter;
    this.audit = deps.audit;
    this.playEligibility = deps.playEligibility;
    this.geoCheck = deps.geoCheck;
    this.rgLimits = deps.rgLimits;
    this.limiter = deps.limiter;
    this.cache = deps.cache;
  }

  /** The vendor's fiats, and only those of its assets the platform takes deposits in. */
  async options(userId: User['id'], meta: ClientMeta): Promise<OnRampOptions> {
    const country = await this.admit(userId, meta);
    const [options, assets] = await Promise.all([
      this.vendorOptions(country),
      this.wallet.listEnabledWalletAssets(),
    ]);
    const depositable = new Map(
      assets
        .filter((asset) => asset.depositEnabled)
        .map((asset) => [assetKey(asset.currency, asset.network), asset]),
    );
    // Answered in the catalog's own spelling of the pair, whatever case the vendor used.
    return {
      fiats: options.fiats,
      assets: options.assets.flatMap((offered) => {
        const asset = depositable.get(assetKey(offered.currency, offered.network));
        return asset ? [{ currency: asset.currency, network: asset.network }] : [];
      }),
    };
  }

  /** Estimates only, possibly none: the vendor's checkout page sets the price. */
  async quote(purchase: OnRampPurchase): Promise<OnRampQuote[]> {
    const country = await this.admit(purchase.userId, purchase.meta);
    await this.assertPurchasable(purchase, country);
    return this.fetchQuotes(purchase, country);
  }

  /**
   * Every gate runs before the vendor opens an order, and the player gates run before a replay,
   * so a player restricted since the first attempt cannot fetch its checkout again. The deposit
   * limit is checked and the order row inserted under one per-player lock, so concurrent
   * checkouts are counted against each other. The delivery address is always one the platform
   * issued to this player, and the order row exists before the vendor is called, so a webhook
   * can always find it. A replayed key returns the original checkout.
   */
  async checkout(
    purchase: OnRampPurchase & { idempotencyKey: string },
  ): Promise<OnRampCheckoutResponse> {
    const { userId, idempotencyKey } = purchase;
    const country = await this.admit(userId, purchase.meta);
    const replayed = await this.replay(purchase);
    if (replayed) {
      return replayed;
    }
    const assets = await this.assertPurchasable(purchase, country);
    await this.assertAboveDepositMinimum(purchase, assets, country);

    const address = await this.wallet.getOrCreateDepositAddress(
      userId,
      purchase.currency,
      purchase.network,
    );
    const purchaseId = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, checkoutLockKey(userId), async () => {
        await this.assertWithinDepositLimit(tx, purchase);
        const [order] = await tx
          .insert(walletOnRampOrder)
          .values({
            userId,
            idempotencyKey,
            fiatAmount: purchase.fiatAmount,
            fiatCurrency: purchase.fiatCurrency,
            currency: purchase.currency,
            network: purchase.network,
            walletAddress: address.address,
            walletTag: address.tag || null,
          })
          .onConflictDoNothing()
          .returning({ id: walletOnRampOrder.id });
        if (!order) {
          throw new IdempotencyKeyReuseError();
        }
        return order.id;
      }),
    );

    try {
      const checkout = await this.openCheckout({
        userId,
        purchaseId,
        fiatCurrency: purchase.fiatCurrency,
        fiatAmount: purchase.fiatAmount,
        currency: purchase.currency,
        network: purchase.network,
        walletAddress: address.address,
        walletTag: address.tag || undefined,
        country,
        idempotencyKey: `${userId}:${idempotencyKey}`,
      });
      await this.drizzle.db.transaction(async (tx) => {
        await tx
          .update(walletOnRampOrder)
          .set({
            externalId: checkout.externalId,
            checkoutUrl: checkout.checkoutUrl,
            expiresAt: new Date(checkout.expiresAt),
          })
          .where(eq(walletOnRampOrder.id, purchaseId));
        await this.audit.recordInTransaction(tx, {
          actorType: 'player',
          actorId: userId,
          action: 'wallet.on_ramp.checkout_created',
          resourceType: 'on_ramp_order',
          resourceId: purchaseId,
          after: {
            purchaseId,
            externalId: checkout.externalId,
            fiatAmount: purchase.fiatAmount,
            fiatCurrency: purchase.fiatCurrency,
            currency: purchase.currency,
            network: purchase.network,
            walletAddress: address.address,
            country,
            expiresAt: checkout.expiresAt,
            acknowledged: true,
            idempotencyKey,
          },
          ...purchase.meta,
        });
      });
      return { purchaseId, checkoutUrl: checkout.checkoutUrl };
    } catch (err) {
      await this.failCheckout(purchase, purchaseId, err);
      throw err;
    }
  }

  /**
   * The player's own order, refreshed from the vendor while it is still open. Another
   * player's order answers exactly like an unknown one. A vendor failure answers the stored
   * status rather than failing the read.
   */
  async getOrder(userId: User['id'], purchaseId: WalletOnRampOrder['id']): Promise<OnRampOrder> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.ON_RAMP_STATUS, userId),
      ON_RAMP_STATUS_RATE_LIMIT,
    );
    const [order] = await this.drizzle.db
      .select()
      .from(walletOnRampOrder)
      .where(and(eq(walletOnRampOrder.id, purchaseId), eq(walletOnRampOrder.userId, userId)));
    if (!order) {
      throw new OnRampOrderNotFoundError(purchaseId);
    }
    let status = order.status;
    if (OPEN_STATUSES.includes(status) && order.externalId !== null) {
      try {
        const reported = await this.vendorStatus(order.id, order.externalId);
        if (reported !== null) {
          status = await this.transition(order.id, { status: reported });
        }
      } catch (err) {
        logger.warn({ err, purchaseId }, 'on-ramp status refresh failed - answering stored status');
      }
    }
    return {
      purchaseId: order.id,
      status,
      fiatAmount: order.fiatAmount,
      fiatCurrency: order.fiatCurrency,
      currency: order.currency,
      network: order.network,
    };
  }

  /**
   * Records a vendor status update on its order. An unknown order, or one whose customer or
   * delivery address disagrees with the event, is logged and dropped - the vendor still gets a
   * success, so a forged or misrouted event learns nothing. So is an event the adapter parsed
   * into something malformed: refusing it would only have the vendor redeliver it forever. A
   * redelivery writes nothing. Never credits: a `completed` order is paid by the on-chain deposit.
   */
  async recordWebhook(parsed: OnRampWebhookEvent): Promise<void> {
    const valid = OnRampWebhookEventSchema.safeParse(parsed);
    if (!valid.success) {
      logger.warn({ issues: valid.error.issues }, 'on-ramp webhook event is malformed - ignored');
      return;
    }
    const event = valid.data;
    const order = await this.findWebhookOrder(event);
    if (!order) {
      logger.warn(
        { externalId: event.externalId, status: event.status },
        'on-ramp webhook for an unknown order - ignored',
      );
      return;
    }
    const mismatch = webhookMismatch(order, event);
    if (mismatch) {
      logger.warn(
        { purchaseId: order.id, externalId: event.externalId, mismatch },
        'on-ramp webhook disagrees with its order - ignored',
      );
      await this.audit.record({
        actorType: 'system',
        action: 'wallet.on_ramp.webhook_mismatch',
        resourceType: 'on_ramp_order',
        resourceId: order.id,
        after: { mismatch, externalId: event.externalId, status: event.status },
      });
      return;
    }
    await this.transition(order.id, {
      status: event.status,
      txHash: event.txHash,
      gatewayId: event.gatewayId,
      cryptoAmount: event.cryptoAmount,
    });
  }

  /**
   * Applies a vendor report to the order under a row lock and audits it, in one transaction. The
   * status only moves forward along `NEXT_STATUSES`; a report of the current status still records
   * the delivery details it adds. Anything else is out of order and writes nothing. Returns the
   * order's status afterwards.
   */
  private async transition(
    purchaseId: WalletOnRampOrder['id'],
    next: Pick<OnRampWebhookEvent, 'status' | 'txHash' | 'gatewayId' | 'cryptoAmount'>,
  ): Promise<OnRampStatus> {
    const result = await this.drizzle.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(walletOnRampOrder)
        .where(eq(walletOnRampOrder.id, purchaseId))
        .for('update');
      if (!locked) {
        throw new OnRampOrderNotFoundError(purchaseId);
      }
      const moves = NEXT_STATUSES[locked.status].includes(next.status);
      if (!moves && next.status !== locked.status) {
        logger.warn(
          { purchaseId, from: locked.status, to: next.status },
          'on-ramp status change out of order - ignored',
        );
        return { status: locked.status, written: false };
      }
      if (!moves && !addsDeliveryDetails(locked, next)) {
        logger.info({ purchaseId, status: locked.status }, 'on-ramp status redelivered - ignored');
        return { status: locked.status, written: false };
      }
      const [updated] = await tx
        .update(walletOnRampOrder)
        .set({
          status: next.status,
          txHash: next.txHash ?? locked.txHash,
          gatewayId: next.gatewayId ?? locked.gatewayId,
          cryptoAmount: next.cryptoAmount ?? locked.cryptoAmount,
        })
        .where(eq(walletOnRampOrder.id, purchaseId))
        .returning();
      if (!updated) {
        throw new OnRampOrderNotFoundError(purchaseId);
      }
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        action: moves ? 'wallet.on_ramp.status_changed' : 'wallet.on_ramp.order_updated',
        resourceType: 'on_ramp_order',
        resourceId: purchaseId,
        before: {
          status: locked.status,
          txHash: locked.txHash,
          gatewayId: locked.gatewayId,
          cryptoAmount: locked.cryptoAmount,
        },
        after: {
          userId: updated.userId,
          from: locked.status,
          to: updated.status,
          txHash: updated.txHash,
          gatewayId: updated.gatewayId,
          cryptoAmount: updated.cryptoAmount,
        },
      });
      return { status: updated.status, written: true };
    });
    if (result.written) {
      await this.cache?.delete(statusCacheKey(purchaseId));
    }
    return result.status;
  }

  /**
   * Opens the vendor checkout and validates what comes back. A malformed answer, a non-https
   * URL above all, is a vendor fault: the client would be sent to it.
   */
  private async openCheckout(
    input: Parameters<OnRampAdapter['createCheckout']>[0],
  ): Promise<OnRampCheckout> {
    const result = OnRampCheckoutResultSchema.safeParse(await this.adapter.createCheckout(input));
    if (!result.success) {
      throw new OnRampVendorUnavailableError({ cause: result.error });
    }
    return result.data;
  }

  // Only the error's class reaches the audit log; the vendor's message stays in the logs.
  private async failCheckout(
    purchase: OnRampPurchase & { idempotencyKey: string },
    purchaseId: WalletOnRampOrder['id'],
    err: unknown,
  ) {
    logger.warn({ err, purchaseId }, 'on-ramp checkout failed at the vendor');
    await this.drizzle.db.transaction(async (tx) => {
      await tx
        .update(walletOnRampOrder)
        .set({ status: 'failed' })
        .where(and(eq(walletOnRampOrder.id, purchaseId), eq(walletOnRampOrder.status, 'pending')));
      await this.audit.recordInTransaction(tx, {
        actorType: 'player',
        actorId: purchase.userId,
        action: 'wallet.on_ramp.checkout_failed',
        resourceType: 'on_ramp_order',
        resourceId: purchaseId,
        after: {
          purchaseId,
          fiatAmount: purchase.fiatAmount,
          fiatCurrency: purchase.fiatCurrency,
          currency: purchase.currency,
          network: purchase.network,
          idempotencyKey: purchase.idempotencyKey,
          error: err instanceof Error ? err.name : 'unknown',
        },
        ...purchase.meta,
      });
    });
  }

  /**
   * The vendor's status for an order, cached briefly per order so polling cannot spend the
   * vendor's quota. An answer outside the status set is logged and treated as unknown.
   */
  private async vendorStatus(
    purchaseId: WalletOnRampOrder['id'],
    externalId: NonNullable<WalletOnRampOrder['externalId']>,
  ): Promise<OnRampStatus | null> {
    const key = statusCacheKey(purchaseId);
    const cached = await this.cache?.get<{ status: OnRampStatus | null }>(key);
    if (cached) {
      return cached.status;
    }
    const reported: unknown = await this.adapter.getStatus(externalId);
    const parsed = OnRampStatusSchema.nullable().safeParse(reported);
    if (!parsed.success) {
      logger.warn({ purchaseId }, 'on-ramp vendor answered an unknown status - ignored');
    }
    const status = parsed.success ? parsed.data : null;
    await this.cache?.set(key, { status }, { ttlMs: STATUS_TTL_MS });
    return status;
  }

  private async findWebhookOrder(event: OnRampWebhookEvent) {
    const byPurchaseId = UuidSchema.safeParse(event.purchaseId).success
      ? eq(walletOnRampOrder.id, event.purchaseId ?? '')
      : undefined;
    const [order] = await this.drizzle.db
      .select()
      .from(walletOnRampOrder)
      .where(byPurchaseId ?? eq(walletOnRampOrder.externalId, event.externalId));
    if (order || !byPurchaseId) {
      return order;
    }
    const [byExternalId] = await this.drizzle.db
      .select()
      .from(walletOnRampOrder)
      .where(eq(walletOnRampOrder.externalId, event.externalId));
    return byExternalId;
  }

  // An earlier attempt under the same key: its checkout again, never a second order.
  private async replay(
    purchase: OnRampPurchase & { idempotencyKey: string },
  ): Promise<OnRampCheckoutResponse | null> {
    const [order] = await this.drizzle.db
      .select()
      .from(walletOnRampOrder)
      .where(
        and(
          eq(walletOnRampOrder.userId, purchase.userId),
          eq(walletOnRampOrder.idempotencyKey, purchase.idempotencyKey),
        ),
      );
    if (!order) {
      return null;
    }
    const samePurchase =
      order.fiatCurrency === purchase.fiatCurrency &&
      moneyCompare(order.fiatAmount, purchase.fiatAmount) === 0 &&
      order.currency === purchase.currency &&
      order.network === purchase.network;
    // A failed or still-opening attempt has no checkout to hand back; the client retries
    // under a fresh key.
    if (!samePurchase || order.checkoutUrl === null) {
      throw new IdempotencyKeyReuseError();
    }
    return { purchaseId: order.id, checkoutUrl: order.checkoutUrl };
  }

  /** Throttle, RG restriction, then geo. Returns the country the vendor is told. */
  private async admit(userId: User['id'], meta: ClientMeta): Promise<string | null> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.ON_RAMP, userId),
      ON_RAMP_RATE_LIMIT,
    );
    if (await this.playEligibility.isRestricted(userId)) {
      throw new OnRampRestrictedError();
    }
    if (!this.geoCheck) {
      return null;
    }
    const access = await this.geoCheck.checkAccess(meta.ip);
    if (!access.allowed) {
      throw new OnRampGeoBlockedError();
    }
    return access.countryCode;
  }

  private async vendorOptions(country: string | null): Promise<OnRampOptions> {
    const key = `wallet:on-ramp:options:${country ?? '-'}`;
    const cached = await this.cache?.get<OnRampOptions>(key);
    if (cached) {
      return cached;
    }
    const parsed = OnRampOptionsSchema.safeParse(await this.adapter.getOptions({ country }));
    if (!parsed.success) {
      throw new OnRampVendorUnavailableError({ cause: parsed.error });
    }
    await this.cache?.set(key, parsed.data, { ttlMs: OPTIONS_TTL_MS });
    return parsed.data;
  }

  private async assertPurchasable(purchase: OnRampPurchase, country: string | null) {
    const { fiatCurrency, fiatAmount, currency, network } = purchase;
    const [options, assets] = await Promise.all([
      this.vendorOptions(country),
      this.wallet.listEnabledWalletAssets(),
    ]);
    const fiat = options.fiats.find((option) => option.code.toUpperCase() === fiatCurrency);
    if (!fiat) {
      throw new OnRampRefusedError({ reason: 'fiat_unsupported' });
    }
    if (moneyCompare(fiatAmount, fiat.minAmount) < 0) {
      throw new OnRampRefusedError({
        reason: 'below_minimum',
        fiatCurrency,
        minAmount: fiat.minAmount,
      });
    }
    if (fiat.maxAmount !== undefined && moneyCompare(fiatAmount, fiat.maxAmount) > 0) {
      throw new OnRampRefusedError({
        reason: 'above_maximum',
        fiatCurrency,
        maxAmount: fiat.maxAmount,
      });
    }
    const currencyAssets = assets.filter((asset) => asset.currency === currency);
    assertDepositAllowed(currencyAssets, currency, network);
    const wanted = assetKey(currency, network);
    if (!options.assets.some((offered) => assetKey(offered.currency, offered.network) === wanted)) {
      throw new DepositDisabledError(currency, network.toUpperCase());
    }
    return currencyAssets;
  }

  /**
   * A delivery under the network's deposit minimum lands on chain but is never credited. Judged on
   * the best estimate; with no estimate, or none the vendor could give, the checkout goes ahead.
   */
  private async assertAboveDepositMinimum(
    purchase: OnRampPurchase,
    assets: readonly { network: string; minDeposit: string }[],
    country: string | null,
  ) {
    const [best] = await this.fetchQuotes(purchase, country).catch((err: unknown) => {
      logger.warn(
        { err, userId: purchase.userId, currency: purchase.currency, network: purchase.network },
        'on-ramp estimate failed - checking out without one',
      );
      return [];
    });
    const asset = assets.find(
      (candidate) => candidate.network.toUpperCase() === purchase.network.toUpperCase(),
    );
    if (best && asset && moneyCompare(best.cryptoAmount, asset.minDeposit) < 0) {
      throw new OnRampRefusedError({
        reason: 'below_deposit_minimum',
        currency: purchase.currency,
        network: asset.network,
        minDeposit: asset.minDeposit,
      });
    }
  }

  // A quote that would deliver nothing is not a quote.
  private async fetchQuotes(
    { userId, fiatCurrency, fiatAmount, currency, network }: OnRampPurchase,
    country: string | null,
  ): Promise<OnRampQuote[]> {
    const parsed = OnRampQuoteSchema.array().safeParse(
      await this.adapter.getQuotes({
        userId,
        fiatCurrency,
        fiatAmount,
        currency,
        network,
        country,
      }),
    );
    if (!parsed.success) {
      throw new OnRampVendorUnavailableError({ cause: parsed.error });
    }
    return parsed.data.filter((quote) => isPositiveMoney(quote.cryptoAmount));
  }

  /**
   * Checked on the fiat amount plus this player's still-open orders in the same fiat: processing
   * ones of any age, pending ones until their checkout expires, and pending ones the vendor has
   * not opened yet for `UNOPENED_CHECKOUT_HOLD` after they were recorded. Open orders in other
   * fiats are not counted. The gate converts to the limit's currency. Runs under the caller's
   * per-player lock.
   */
  private async assertWithinDepositLimit(
    tx: DrizzleTx,
    { userId, fiatAmount, fiatCurrency }: OnRampPurchase,
  ) {
    if (!this.rgLimits) {
      return;
    }
    const [open] = await tx
      .select({
        total: sql<string>`coalesce(sum(${walletOnRampOrder.fiatAmount}), 0)::text`,
      })
      .from(walletOnRampOrder)
      .where(
        and(
          eq(walletOnRampOrder.userId, userId),
          eq(walletOnRampOrder.fiatCurrency, fiatCurrency),
          or(
            eq(walletOnRampOrder.status, 'processing'),
            and(
              eq(walletOnRampOrder.status, 'pending'),
              or(
                gt(walletOnRampOrder.expiresAt, sql`now()`),
                and(
                  isNull(walletOnRampOrder.expiresAt),
                  gt(walletOnRampOrder.createdAt, sql`now() - ${UNOPENED_CHECKOUT_HOLD}::interval`),
                ),
              ),
            ),
          ),
        ),
      );
    const openTotal = open?.total ?? '0';
    const decision = await this.rgLimits.checkDeposit(
      tx,
      userId,
      moneyAdd(fiatAmount, openTotal),
      fiatCurrency,
    );
    if (decision.allowed) {
      return;
    }
    const usedIsSpend =
      decision.currency === fiatCurrency && moneyCompare(decision.used, decision.limit) !== 0;
    throw new RgLimitExceededError(
      'deposit_limit_exceeded',
      usedIsSpend ? { ...decision, used: moneyAdd(decision.used, openTotal) } : decision,
    );
  }
}

type WebhookMismatch = 'customer' | 'wallet';

function webhookMismatch(
  order: WalletOnRampOrder,
  event: OnRampWebhookEvent,
): WebhookMismatch | null {
  if (event.externalCustomerId !== undefined && event.externalCustomerId !== order.userId) {
    return 'customer';
  }
  if (
    (event.walletAddress !== undefined && event.walletAddress !== order.walletAddress) ||
    (event.walletTag !== undefined && (event.walletTag || null) !== (order.walletTag || null))
  ) {
    return 'wallet';
  }
  return null;
}

function addsDeliveryDetails(
  order: WalletOnRampOrder,
  next: Pick<OnRampWebhookEvent, 'txHash' | 'gatewayId' | 'cryptoAmount'>,
): boolean {
  return (
    (next.txHash !== undefined && next.txHash !== order.txHash) ||
    (next.gatewayId !== undefined && next.gatewayId !== order.gatewayId) ||
    (next.cryptoAmount !== undefined &&
      (order.cryptoAmount === null || moneyCompare(next.cryptoAmount, order.cryptoAmount) !== 0))
  );
}

const checkoutLockKey = (userId: User['id']) => `wallet:on-ramp:checkout:${userId}`;

const statusCacheKey = (purchaseId: WalletOnRampOrder['id']) =>
  `wallet:on-ramp:status:${purchaseId}`;

const assetKey = (currency: string, network: string) =>
  `${currency.toUpperCase()}:${network.toUpperCase()}`;
