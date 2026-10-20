import {
  assertRateLimit,
  createDomainError,
  createLogger,
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyCompare,
  withAdvisoryXactLock,
  type DrizzleService,
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
  type User,
} from '@openora/core/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import type { OnRampCheckoutResponse, OnRampOrder } from '../contract/index.js';
import { walletOnRampOrder, type WalletOnRampOrder } from '../schema/index.js';
import {
  assertDepositAllowed,
  depositSlotKey,
  DepositDisabledError,
  IdempotencyKeyReuseError,
  type WalletService,
} from './wallet.service.js';

const logger = createLogger('wallet-on-ramp');

const ON_RAMP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };
const ON_RAMP_STATUS_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

const OPTIONS_TTL_MS = 60 * 1000;
// However fast the client polls, the vendor is asked about an order at most this often.
const STATUS_TTL_MS = 10 * 1000;

const OPEN_STATUSES: readonly OnRampStatus[] = ['pending', 'processing'];
const DELIVERY_DETAILS = ['txHash', 'gatewayId', 'cryptoAmount'] as const;

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
  private readonly geoCheck: GeoCheckCommands;
  private readonly limiter?: RateLimiterAdapter<RateLimitKey>;
  private readonly cache?: CacheAdapter;

  constructor(deps: {
    drizzle: DrizzleService;
    wallet: WalletService;
    adapter: OnRampAdapter;
    audit: AuditWritePort;
    playEligibility: PlayEligibilityPort;
    geoCheck: GeoCheckCommands;
    limiter?: RateLimiterAdapter<RateLimitKey>;
    cache?: CacheAdapter;
  }) {
    this.drizzle = deps.drizzle;
    this.wallet = deps.wallet;
    this.adapter = deps.adapter;
    this.audit = deps.audit;
    this.playEligibility = deps.playEligibility;
    this.geoCheck = deps.geoCheck;
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
   * limit is checked and the order row inserted under the player's deposit lock, so concurrent
   * checkouts and deposits are counted against each other. The delivery address is always one the platform
   * issued to this player, and the order row exists before the vendor is called, so a webhook
   * can always find it. The order fails only when the vendor does not open the checkout; once
   * it has, a failure to record that leaves the order pending for the vendor's webhook. A
   * replayed key returns the original checkout, asking the vendor for it again if it was never
   * recorded.
   */
  async checkout(
    purchase: OnRampPurchase & { idempotencyKey: string },
  ): Promise<OnRampCheckoutResponse> {
    const { userId, idempotencyKey } = purchase;
    const country = await this.admit(userId, purchase.meta);
    const replayed = await this.replay(purchase);
    if (replayed?.checkoutUrl) {
      return { purchaseId: replayed.id, checkoutUrl: replayed.checkoutUrl };
    }
    if (replayed) {
      return this.openAndRecordCheckout(purchase, replayed, country);
    }
    const assets = await this.assertPurchasable(purchase, country);
    await this.assertAboveDepositMinimum(purchase, assets, country);

    const address = await this.wallet.getOrCreateDepositAddress(
      userId,
      purchase.currency,
      purchase.network,
    );
    const purchaseId = await this.drizzle.db.transaction((tx) =>
      withAdvisoryXactLock(tx, depositSlotKey(userId), async () => {
        await this.wallet.assertWithinRgDepositLimit(
          tx,
          userId,
          purchase.fiatAmount,
          purchase.fiatCurrency,
        );
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
        await this.audit.recordInTransaction(tx, {
          actorType: 'player',
          actorId: userId,
          action: 'wallet.on_ramp.checkout_requested',
          resourceType: 'on_ramp_order',
          resourceId: order.id,
          after: {
            purchaseId: order.id,
            fiatAmount: purchase.fiatAmount,
            fiatCurrency: purchase.fiatCurrency,
            currency: purchase.currency,
            network: purchase.network,
            walletAddress: address.address,
            country,
            idempotencyKey,
          },
          ...purchase.meta,
        });
        return order.id;
      }),
    );
    return this.openAndRecordCheckout(
      purchase,
      { id: purchaseId, walletAddress: address.address, walletTag: address.tag || null },
      country,
    );
  }

  /**
   * Asks the vendor to open the order's checkout and records it. The vendor dedupes on the
   * idempotency key, so a retry gets the checkout an earlier attempt opened; only the first
   * attempt to record it writes and audits.
   */
  private async openAndRecordCheckout(
    purchase: OnRampPurchase & { idempotencyKey: string },
    order: Pick<WalletOnRampOrder, 'id' | 'walletAddress' | 'walletTag'>,
    country: string | null,
  ): Promise<OnRampCheckoutResponse> {
    const { userId, idempotencyKey } = purchase;
    const purchaseId = order.id;
    let checkout: OnRampCheckout;
    try {
      checkout = await this.openCheckout({
        userId,
        purchaseId,
        fiatCurrency: purchase.fiatCurrency,
        fiatAmount: purchase.fiatAmount,
        currency: purchase.currency,
        network: purchase.network,
        walletAddress: order.walletAddress,
        walletTag: order.walletTag ?? undefined,
        country,
        idempotencyKey: `${userId}:${idempotencyKey}`,
      });
    } catch (err) {
      await this.failCheckout(purchase, purchaseId, err);
      throw err;
    }
    await this.drizzle.db.transaction(async (tx) => {
      const [recorded] = await tx
        .update(walletOnRampOrder)
        .set({
          externalId: checkout.externalId,
          checkoutUrl: checkout.checkoutUrl,
          expiresAt: new Date(checkout.expiresAt),
        })
        .where(and(eq(walletOnRampOrder.id, purchaseId), isNull(walletOnRampOrder.checkoutUrl)))
        .returning({ id: walletOnRampOrder.id });
      if (!recorded) {
        return;
      }
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
          walletAddress: order.walletAddress,
          country,
          expiresAt: checkout.expiresAt,
          acknowledged: true,
          idempotencyKey,
        },
        ...purchase.meta,
      });
    });
    return { purchaseId, checkoutUrl: checkout.checkoutUrl };
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
   * Records a vendor status update on its order. An unknown order, or one whose vendor id,
   * customer or delivery address disagrees with the event, is logged and dropped - the vendor
   * still gets a success, so a forged or misrouted event learns nothing. So is an event the
   * adapter parsed into something malformed: refusing it would only have the vendor redeliver it
   * forever. A redelivery writes nothing. Never credits: a `completed` order is paid by the
   * on-chain deposit.
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
   * the delivery details the order is still missing, never replacing one, so a late redelivery
   * cannot overwrite a newer one. Anything else is out of order and writes nothing. Returns the
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
      if (!moves && !fillsDeliveryDetails(locked, next)) {
        logger.info({ purchaseId, status: locked.status }, 'on-ramp status redelivered - ignored');
        return { status: locked.status, written: false };
      }
      const pick = <K extends (typeof DELIVERY_DETAILS)[number]>(detail: K) =>
        moves ? (next[detail] ?? locked[detail]) : (locked[detail] ?? next[detail]);
      const [updated] = await tx
        .update(walletOnRampOrder)
        .set({
          status: next.status,
          txHash: pick('txHash'),
          gatewayId: pick('gatewayId'),
          cryptoAmount: pick('cryptoAmount'),
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

  /**
   * The order an earlier attempt under the same key opened, never a second one. A pending order
   * with no checkout recorded is handed back to be opened again; a failed one has nothing to hand
   * back, and the client retries under a fresh key.
   */
  private async replay(
    purchase: OnRampPurchase & { idempotencyKey: string },
  ): Promise<WalletOnRampOrder | null> {
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
    if (!samePurchase || (order.checkoutUrl === null && order.status !== 'pending')) {
      throw new IdempotencyKeyReuseError();
    }
    return order;
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
   * the best estimate. With a minimum to meet and no estimate to judge it on - the vendor failed,
   * answered garbage or had none - buying is unavailable rather than unchecked.
   */
  private async assertAboveDepositMinimum(
    purchase: OnRampPurchase,
    assets: readonly { network: string; minDeposit: string }[],
    country: string | null,
  ) {
    const asset = assets.find(
      (candidate) => candidate.network.toUpperCase() === purchase.network.toUpperCase(),
    );
    if (!asset || !isPositiveMoney(asset.minDeposit)) {
      return;
    }
    const [best] = await this.fetchQuotes(purchase, country);
    if (!best) {
      throw new OnRampVendorUnavailableError();
    }
    if (moneyCompare(best.cryptoAmount, asset.minDeposit) < 0) {
      throw new OnRampRefusedError({
        reason: 'below_deposit_minimum',
        currency: purchase.currency,
        network: asset.network,
        minDeposit: asset.minDeposit,
      });
    }
  }

  // A quote that would deliver nothing, or for another purchase than the one asked, is not a quote.
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
    const wanted = assetKey(currency, network);
    return parsed.data.filter(
      (quote) =>
        isPositiveMoney(quote.cryptoAmount) &&
        quote.fiatCurrency.toUpperCase() === fiatCurrency.toUpperCase() &&
        moneyCompare(quote.fiatAmount, fiatAmount) === 0 &&
        assetKey(quote.currency, quote.network) === wanted,
    );
  }
}

type WebhookMismatch = 'order' | 'customer' | 'wallet';

function webhookMismatch(
  order: WalletOnRampOrder,
  event: OnRampWebhookEvent,
): WebhookMismatch | null {
  if (order.externalId !== null && order.externalId !== event.externalId) {
    return 'order';
  }
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

function fillsDeliveryDetails(
  order: WalletOnRampOrder,
  next: Pick<OnRampWebhookEvent, (typeof DELIVERY_DETAILS)[number]>,
): boolean {
  return DELIVERY_DETAILS.some((detail) => order[detail] === null && next[detail] !== undefined);
}

const statusCacheKey = (purchaseId: WalletOnRampOrder['id']) =>
  `wallet:on-ramp:status:${purchaseId}`;

const assetKey = (currency: string, network: string) =>
  `${currency.toUpperCase()}:${network.toUpperCase()}`;
