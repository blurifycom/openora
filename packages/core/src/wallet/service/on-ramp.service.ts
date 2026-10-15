import {
  assertRateLimit,
  createDomainError,
  createLogger,
  isPositiveMoney,
  makeConflictError,
  makeNotFoundError,
  moneyAdd,
  moneyCompare,
  type DrizzleService,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  OnRampRefusedError,
  RATE_LIMIT_KEYS,
  RgLimitExceededError,
  UuidSchema,
  type AuditWritePort,
  type CacheAdapter,
  type ClientMeta,
  type GeoCheckCommands,
  type OnRampAdapter,
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
import { and, eq, gt, or, sql } from 'drizzle-orm';
import { walletOnRampOrder, type WalletOnRampOrder } from '../schema/index.js';
import {
  assertDepositAllowed,
  IdempotencyKeyReuseError,
  type WalletService,
} from './wallet.service.js';

const logger = createLogger('wallet-on-ramp');

// Every on-ramp route is a billed vendor call. Its own bucket, so browsing prices never eats
// into the throttle a withdrawal answers to.
const ON_RAMP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

const OPTIONS_TTL_MS = 60 * 1000;

// A checkout the player opened but never paid stops counting toward the deposit limit after this.
const PENDING_ORDER_WINDOW = sql`interval '30 minutes'`;

const OPEN_STATUSES: readonly OnRampStatus[] = ['pending', 'processing'];

// Same message as a vendor outage: the client cannot tell an unbound vendor from a down one.
export const OnRampUnavailableError = makeConflictError(
  'OnRampUnavailableError',
  'buying crypto is unavailable',
);

export const OnRampOrderNotFoundError = makeNotFoundError('OnRampOrder');

// Same refusal vocabulary the login gate answers with, so a client handles both alike.
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

export type OnRampOrderView = {
  purchaseId: WalletOnRampOrder['id'];
  status: OnRampStatus;
  fiatAmount: string;
  fiatCurrency: string;
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
   * Every gate runs before the vendor opens an order. The delivery address is always one the
   * platform issued to this player, and the order row exists before the vendor is called, so a
   * webhook can always find it. A replayed key returns the original checkout.
   */
  async checkout(
    purchase: OnRampPurchase & { idempotencyKey: string },
  ): Promise<{ purchaseId: string; checkoutUrl: string }> {
    const { userId, idempotencyKey } = purchase;
    await this.throttle(userId);
    const replayed = await this.replay(purchase);
    if (replayed) {
      return replayed;
    }
    const country = await this.admitThrottled(userId, purchase.meta);
    const assets = await this.assertPurchasable(purchase, country);
    await this.assertAboveDepositMinimum(purchase, assets, country);
    await this.assertWithinDepositLimit(purchase);

    const address = await this.wallet.getOrCreateDepositAddress(
      userId,
      purchase.currency,
      purchase.network,
    );
    const [order] = await this.drizzle.db
      .insert(walletOnRampOrder)
      .values({
        userId,
        idempotencyKey,
        fiatAmount: purchase.fiatAmount,
        fiatCurrency: purchase.fiatCurrency,
        currency: purchase.currency,
        network: purchase.network,
        walletAddress: address.address,
        walletTag: address.tag ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: walletOnRampOrder.id });
    if (!order) {
      // A concurrent request with the same key won the insert.
      throw new IdempotencyKeyReuseError();
    }

    const checkout = await this.adapter
      .createCheckout({
        userId,
        purchaseId: order.id,
        fiatCurrency: purchase.fiatCurrency,
        fiatAmount: purchase.fiatAmount,
        currency: purchase.currency,
        network: purchase.network,
        walletAddress: address.address,
        walletTag: address.tag,
        country,
        idempotencyKey: `${userId}:${idempotencyKey}`,
      })
      .catch(async (err: unknown) => {
        logger.warn({ err, purchaseId: order.id }, 'on-ramp checkout failed at the vendor');
        await this.drizzle.db
          .update(walletOnRampOrder)
          .set({ status: 'failed' })
          .where(eq(walletOnRampOrder.id, order.id));
        throw err;
      });

    await this.drizzle.db
      .update(walletOnRampOrder)
      .set({ externalId: checkout.externalId, checkoutUrl: checkout.checkoutUrl })
      .where(eq(walletOnRampOrder.id, order.id));
    await this.audit.record({
      actorType: 'player',
      actorId: userId,
      action: 'wallet.on_ramp.checkout_created',
      resourceType: 'on_ramp_order',
      resourceId: order.id,
      after: {
        purchaseId: order.id,
        externalId: checkout.externalId,
        fiatAmount: purchase.fiatAmount,
        fiatCurrency: purchase.fiatCurrency,
        currency: purchase.currency,
        network: purchase.network,
        walletAddress: address.address,
        country,
        acknowledged: true,
        idempotencyKey,
      },
      ...purchase.meta,
    });
    return { purchaseId: order.id, checkoutUrl: checkout.checkoutUrl };
  }

  /**
   * The player's own order, refreshed from the vendor while it is still open. Another
   * player's order answers exactly like an unknown one. A vendor failure answers the stored
   * status rather than failing the read.
   */
  async getOrder(
    userId: User['id'],
    purchaseId: WalletOnRampOrder['id'],
  ): Promise<OnRampOrderView> {
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
        const reported = await this.adapter.getStatus(order.externalId);
        if (reported !== null && (await this.transition(order, { status: reported }))) {
          status = reported;
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
   * success, so a forged or misrouted event learns nothing. A redelivery writes nothing. Never
   * credits: a `completed` order is paid by the on-chain deposit.
   */
  async recordWebhook(event: OnRampWebhookEvent): Promise<void> {
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
    await this.transition(order, {
      status: event.status,
      txHash: event.txHash,
      gatewayId: event.gatewayId,
      cryptoAmount: event.cryptoAmount,
    });
  }

  /**
   * Moves the order to `next.status` and audits it, in one transaction. Conditional on the
   * status read, so a redelivery or a racing refresh writes nothing. A terminal order never
   * moves back to an open status - that is an out-of-order delivery.
   */
  private async transition(
    order: WalletOnRampOrder,
    next: Pick<OnRampWebhookEvent, 'status' | 'txHash' | 'gatewayId' | 'cryptoAmount'>,
  ): Promise<boolean> {
    if (
      next.status === order.status ||
      (!OPEN_STATUSES.includes(order.status) && OPEN_STATUSES.includes(next.status))
    ) {
      return false;
    }
    return this.drizzle.db.transaction(async (tx) => {
      const [moved] = await tx
        .update(walletOnRampOrder)
        .set({
          status: next.status,
          txHash: next.txHash ?? order.txHash,
          gatewayId: next.gatewayId ?? order.gatewayId,
          cryptoAmount: next.cryptoAmount ?? order.cryptoAmount,
        })
        .where(and(eq(walletOnRampOrder.id, order.id), eq(walletOnRampOrder.status, order.status)))
        .returning();
      if (!moved) {
        return false;
      }
      await this.audit.recordInTransaction(tx, {
        actorType: 'system',
        action: 'wallet.on_ramp.status_changed',
        resourceType: 'on_ramp_order',
        resourceId: order.id,
        before: { status: order.status },
        after: {
          userId: order.userId,
          from: order.status,
          to: moved.status,
          txHash: moved.txHash,
          gatewayId: moved.gatewayId,
        },
      });
      return true;
    });
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
  ): Promise<{ purchaseId: string; checkoutUrl: string } | null> {
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

  private throttle(userId: User['id']) {
    return assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.ON_RAMP, userId),
      ON_RAMP_RATE_LIMIT,
    );
  }

  /** Throttle, RG restriction, then geo. Returns the country the vendor is told. */
  private async admit(userId: User['id'], meta: ClientMeta): Promise<string | null> {
    await this.throttle(userId);
    return this.admitThrottled(userId, meta);
  }

  private async admitThrottled(userId: User['id'], meta: ClientMeta): Promise<string | null> {
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

  // The vendor's offer changes rarely and every route reads it, so it is cached per country.
  private async vendorOptions(country: string | null): Promise<OnRampOptions> {
    const key = `wallet:on-ramp:options:${country ?? '-'}`;
    const cached = await this.cache?.get<OnRampOptions>(key);
    if (cached) {
      return cached;
    }
    const options = await this.adapter.getOptions({ country });
    await this.cache?.set(key, options, { ttlMs: OPTIONS_TTL_MS });
    return options;
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
    return currencyAssets;
  }

  // A delivery under the network's deposit minimum lands on chain but is never credited.
  // Best effort: the estimate is not the final price, and no estimate at all lets it through.
  private async assertAboveDepositMinimum(
    purchase: OnRampPurchase,
    assets: readonly { network: string; minDeposit: string }[],
    country: string | null,
  ) {
    const [best] = await this.fetchQuotes(purchase, country);
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
    const quotes = await this.adapter.getQuotes({
      userId,
      fiatCurrency,
      fiatAmount,
      currency,
      network,
      country,
    });
    return quotes.filter((quote) => isPositiveMoney(quote.cryptoAmount));
  }

  /**
   * Checked on the fiat amount plus this player's still-open orders in the same fiat; the
   * gate converts to the limit's currency.
   */
  private async assertWithinDepositLimit({ userId, fiatAmount, fiatCurrency }: OnRampPurchase) {
    if (!this.rgLimits) {
      return;
    }
    // ponytail: open orders in other fiats are ignored; convert and sum them when a player
    // is seen splitting purchases across fiats.
    // ponytail: unlocked read, so two concurrent checkouts can both pass; take a per-player
    // advisory lock around the sum and the insert if that is ever exploited.
    const [open] = await this.drizzle.db
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
              gt(walletOnRampOrder.createdAt, sql`now() - ${PENDING_ORDER_WINDOW}`),
            ),
          ),
        ),
      );
    const attempted = moneyAdd(fiatAmount, open?.total ?? '0');
    const decision = await this.rgLimits.checkDeposit(
      this.drizzle.db,
      userId,
      attempted,
      fiatCurrency,
    );
    if (!decision.allowed) {
      throw new RgLimitExceededError('deposit_limit_exceeded', decision);
    }
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
    (event.walletTag !== undefined && event.walletTag !== order.walletTag)
  ) {
    return 'wallet';
  }
  return null;
}

const assetKey = (currency: string, network: string) =>
  `${currency.toUpperCase()}:${network.toUpperCase()}`;
