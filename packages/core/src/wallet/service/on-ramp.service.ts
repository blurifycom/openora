import {
  assertRateLimit,
  createDomainError,
  createLogger,
  isPositiveMoney,
  makeConflictError,
  moneyCompare,
  type DrizzleService,
} from '@openora/core/server';
import {
  makeRateLimitKey,
  OnRampRefusedError,
  RATE_LIMIT_KEYS,
  RgLimitExceededError,
  type AuditWritePort,
  type ClientMeta,
  type GeoCheckCommands,
  type OnRampAdapter,
  type OnRampCheckout,
  type OnRampOptions,
  type OnRampQuote,
  type OnRampWebhookEvent,
  type PlayEligibilityPort,
  type RateLimitKey,
  type RateLimiterAdapter,
  type RgLimitsPort,
  type User,
} from '@openora/core/contracts';
import { and, eq, isNull } from 'drizzle-orm';
import { walletDepositAddress } from '../schema/index.js';
import { assertDepositAllowed, type WalletService } from './wallet.service.js';

const logger = createLogger('wallet-on-ramp');

// Every on-ramp route is a billed vendor call, so it takes the money-mutation throttle.
const ON_RAMP_RATE_LIMIT = { limit: 30, windowMs: 60 * 1000 };

export const OnRampUnavailableError = makeConflictError(
  'OnRampUnavailableError',
  'no on-ramp vendor is configured',
);

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
  paymentMethod?: string;
};

/**
 * Buying crypto with fiat from a third-party vendor that delivers on-chain to the player's own
 * deposit address. Nothing here touches the ledger: the coins arrive like any other deposit and
 * `creditDepositByAddress` credits them, with its own holds and checks. This service only gates
 * who may open a checkout and records what the vendor reports.
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

  constructor(deps: {
    drizzle: DrizzleService;
    wallet: WalletService;
    adapter: OnRampAdapter;
    audit: AuditWritePort;
    playEligibility: PlayEligibilityPort;
    geoCheck?: GeoCheckCommands;
    rgLimits?: RgLimitsPort;
    limiter?: RateLimiterAdapter<RateLimitKey>;
  }) {
    this.drizzle = deps.drizzle;
    this.wallet = deps.wallet;
    this.adapter = deps.adapter;
    this.audit = deps.audit;
    this.playEligibility = deps.playEligibility;
    this.geoCheck = deps.geoCheck;
    this.rgLimits = deps.rgLimits;
    this.limiter = deps.limiter;
  }

  /** The vendor's fiats, and only those of its assets the platform takes deposits in. */
  async options(userId: User['id'], meta: ClientMeta): Promise<OnRampOptions> {
    const country = await this.admit(userId, meta);
    const [options, assets] = await Promise.all([
      this.adapter.getOptions({ country }),
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

  async quote(purchase: OnRampPurchase): Promise<OnRampQuote[]> {
    const country = await this.admit(purchase.userId, purchase.meta);
    await this.assertPurchasable(purchase, country);
    return this.fetchQuotes(purchase, country);
  }

  /**
   * Every gate runs before the vendor opens an order, and the price is re-quoted here rather
   * than taken from the client. The delivery address is always one the platform issued to
   * this player.
   */
  async checkout(
    purchase: OnRampPurchase & { gatewayId: string; idempotencyKey: string },
  ): Promise<OnRampCheckout> {
    const { userId, gatewayId, idempotencyKey } = purchase;
    const country = await this.admit(userId, purchase.meta);
    const assets = await this.assertPurchasable(purchase, country);

    const quotes = await this.fetchQuotes(purchase, country);
    const quote = quotes.find((candidate) => candidate.gatewayId === gatewayId);
    if (!quote) {
      throw new OnRampRefusedError({ reason: 'no_quote' }, `gateway ${gatewayId} has no quote`);
    }
    this.assertAboveDepositMinimum(assets, quote);
    await this.assertWithinDepositLimit(userId, quote.cryptoAmount, purchase.currency);

    const address = await this.wallet.getOrCreateDepositAddress(
      userId,
      purchase.currency,
      purchase.network,
    );
    const checkout = await this.adapter.createCheckout({
      userId,
      gatewayId,
      fiatCurrency: purchase.fiatCurrency,
      fiatAmount: purchase.fiatAmount,
      currency: purchase.currency,
      network: purchase.network,
      paymentMethod: purchase.paymentMethod,
      walletAddress: address.address,
      walletTag: address.tag,
      country,
      idempotencyKey: `${userId}:${idempotencyKey}`,
    });

    await this.audit.record({
      actorType: 'player',
      actorId: userId,
      action: 'wallet.on_ramp.checkout_created',
      resourceType: 'on_ramp_order',
      resourceId: checkout.externalId,
      after: {
        gatewayId,
        fiatAmount: purchase.fiatAmount,
        fiatCurrency: purchase.fiatCurrency,
        currency: purchase.currency,
        network: purchase.network,
        cryptoAmount: quote.cryptoAmount,
        country,
      },
      ...purchase.meta,
    });
    return checkout;
  }

  /**
   * Records a vendor status update against the player who owns the delivery address. An
   * address the platform never issued, or one whose owner is not the customer the vendor
   * names, is logged and dropped - the vendor still gets a success, so a forged or misrouted
   * event learns nothing. Never credits: a `completed` order is paid by the on-chain deposit.
   */
  async recordWebhook(event: OnRampWebhookEvent): Promise<void> {
    const userId = await this.ownerOf(event);
    if (!userId) {
      logger.warn(
        { externalId: event.externalId, status: event.status },
        'on-ramp webhook for an address with no matching owner - ignored',
      );
      return;
    }
    // ponytail: no order table, so a redelivered event writes a second audit row; add a
    // per-order status column when something has to act on the latest state.
    await this.audit.record({
      actorType: 'system',
      action: 'wallet.on_ramp.status_changed',
      resourceType: 'on_ramp_order',
      resourceId: event.externalId,
      after: {
        userId,
        status: event.status,
        currency: event.currency ?? null,
        network: event.network ?? null,
        fiatCurrency: event.fiatCurrency ?? null,
        fiatAmount: event.fiatAmount ?? null,
        cryptoAmount: event.cryptoAmount ?? null,
      },
    });
  }

  /** Throttle, RG restriction, then geo. Returns the country the vendor is told. */
  private async admit(userId: User['id'], meta: ClientMeta): Promise<string | null> {
    await assertRateLimit(
      this.limiter,
      makeRateLimitKey(RATE_LIMIT_KEYS.WALLET_MUTATION, userId),
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

  private async assertPurchasable(purchase: OnRampPurchase, country: string | null) {
    const { fiatCurrency, fiatAmount, currency, network } = purchase;
    const [options, assets] = await Promise.all([
      this.adapter.getOptions({ country }),
      this.wallet.listEnabledWalletAssets(),
    ]);
    const fiat = options.fiats.find((option) => option.code.toUpperCase() === fiatCurrency);
    if (!fiat) {
      throw new OnRampRefusedError({ reason: 'fiat_unsupported' }, `${fiatCurrency} not offered`);
    }
    if (moneyCompare(fiatAmount, fiat.minAmount) < 0) {
      throw new OnRampRefusedError(
        { reason: 'below_minimum', fiatCurrency, minAmount: fiat.minAmount },
        `${fiatAmount} ${fiatCurrency} is below the vendor minimum`,
      );
    }
    if (fiat.maxAmount !== undefined && moneyCompare(fiatAmount, fiat.maxAmount) > 0) {
      throw new OnRampRefusedError(
        { reason: 'above_maximum', fiatCurrency, maxAmount: fiat.maxAmount },
        `${fiatAmount} ${fiatCurrency} is above the vendor maximum`,
      );
    }
    const currencyAssets = assets.filter((asset) => asset.currency === currency);
    assertDepositAllowed(currencyAssets, currency, network);
    return currencyAssets;
  }

  // A delivery under the network's deposit minimum lands on chain but is never credited.
  private assertAboveDepositMinimum(
    assets: readonly { network: string; minDeposit: string }[],
    quote: OnRampQuote,
  ) {
    const asset = assets.find(
      (candidate) => candidate.network.toUpperCase() === quote.network.toUpperCase(),
    );
    if (asset && moneyCompare(quote.cryptoAmount, asset.minDeposit) < 0) {
      throw new OnRampRefusedError(
        {
          reason: 'below_deposit_minimum',
          currency: quote.currency,
          network: asset.network,
          minDeposit: asset.minDeposit,
        },
        `${quote.cryptoAmount} ${quote.currency} is below the ${asset.minDeposit} deposit minimum`,
      );
    }
  }

  // A quote that would deliver nothing is not a quote.
  private async fetchQuotes(
    { userId, fiatCurrency, fiatAmount, currency, network, paymentMethod }: OnRampPurchase,
    country: string | null,
  ): Promise<OnRampQuote[]> {
    const quotes = await this.adapter.getQuotes({
      userId,
      fiatCurrency,
      fiatAmount,
      currency,
      network,
      paymentMethod,
      country,
    });
    return quotes.filter((quote) => isPositiveMoney(quote.cryptoAmount));
  }

  private async assertWithinDepositLimit(userId: User['id'], amount: string, currency: string) {
    if (!this.rgLimits) {
      return;
    }
    const decision = await this.rgLimits.checkDeposit(this.drizzle.db, userId, amount, currency);
    if (!decision.allowed) {
      throw new RgLimitExceededError('deposit_limit_exceeded', decision);
    }
  }

  // A memo chain shares one address across players, so without a tag the address alone
  // must still name exactly one owner.
  private async ownerOf(event: OnRampWebhookEvent): Promise<User['id'] | null> {
    const rows = await this.drizzle.db
      .select({ userId: walletDepositAddress.userId })
      .from(walletDepositAddress)
      .where(
        and(
          eq(walletDepositAddress.address, event.walletAddress),
          event.walletTag === undefined
            ? isNull(walletDepositAddress.tag)
            : eq(walletDepositAddress.tag, event.walletTag),
        ),
      );
    const owners = new Set(rows.map((row) => row.userId));
    if (event.customerId !== undefined) {
      return owners.has(event.customerId) ? event.customerId : null;
    }
    const [only] = owners;
    return owners.size === 1 && only !== undefined ? only : null;
  }
}

const assetKey = (currency: string, network: string) =>
  `${currency.toUpperCase()}:${network.toUpperCase()}`;
